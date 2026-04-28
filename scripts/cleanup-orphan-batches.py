#!/usr/bin/env python3
"""Orphan / GSI 乖離した META アイテムを検出して修復するメンテナンス CLI.

発見済の 4 種類の整合性不具合を一括で棚卸しする:

1. **GSI 乖離**: META の ``status`` と ``GSI1PK`` (= ``STATUS#{status}#{YYYYMM}``)
   が不一致。Step Functions の ``MarkFailedForced`` / ``MarkCompleted`` 等は
   ``DynamoUpdateItem`` で ``SET #s = :s`` のみ実行して GSI1PK を更新しないため
   生じる。``/batches?status=X`` が status 値と一致しないバッチを返す原因。
2. **停滞 PROCESSING**: ``status=PROCESSING`` のまま終端に到達していないバッチ。
   ``BATCH_TASK_TIMEOUT_SECONDS (7200s)`` + 安全幅 1800s を超えて PROCESSING で
   残留している場合は、SFN が失敗通知を捕捉し損ねて orphan 化したとみなす。
3. **FAILED の totals 不整合**: ``status=FAILED`` だが
   ``totals.succeeded + totals.failed < totals.total``。runner が
   ``finalize_batch_status`` 前に異常終了し、SFN ``MarkFailedForced`` が status
   のみ更新して ``totals`` を初期値 (failed=0) のまま放置した場合に発生。
   ``GET /batches/{id}`` で「FAILED なのに失敗件数 0」が観測される。
4. **ControlTable heartbeat 孤児 + ACTIVE#COUNT drift**: runner が
   ``delete_heartbeat`` を呼ばずに終了した場合、``BATCH_IN_FLIGHT#{id}`` 行が
   残置され ``ACTIVE#COUNT`` が +1 のまま下がらない。BatchTable META の status が
   既に終端 (COMPLETED/PARTIAL/FAILED/CANCELLED) のものは安全に削除可能で、
   削除と同時に count を再計算 (実在 BATCH_IN_FLIGHT 行数 = count) する。

モード:
  - ``--dry-run`` (既定): 検出件数と各アイテムを表示するだけ
  - ``--fix-gsi``: GSI1PK を現 status に合わせて ``SET`` で上書き
  - ``--force-fail``: 停滞 PROCESSING を ``status=FAILED`` に強制遷移し、
    ``GSI1PK`` も同時に更新する
  - ``--fix-failed-totals``: FAILED の ``totals`` を
    ``failed = total - succeeded``, ``inProgress = 0`` に補正する
  - ``--reap-control-table``: ControlTable の孤児 heartbeat を削除し
    ``ACTIVE#COUNT`` を実在数に揃える (要 ``--control-table`` 引数)

使い方:
  python3 scripts/cleanup-orphan-batches.py --dry-run
  python3 scripts/cleanup-orphan-batches.py --fix-gsi
  python3 scripts/cleanup-orphan-batches.py --force-fail --older-than 3h
  python3 scripts/cleanup-orphan-batches.py --fix-failed-totals
  python3 scripts/cleanup-orphan-batches.py --reap-control-table \
      --control-table <ControlTableName>

必要な IAM: ``dynamodb:Scan`` と ``dynamodb:UpdateItem`` を BatchTable に対して。
``--reap-control-table`` 利用時はさらに ControlTable に対する ``Scan`` /
``GetItem`` / ``DeleteItem`` / ``UpdateItem`` が必要。
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

import boto3


STATUSES_TERMINAL = {"COMPLETED", "PARTIAL", "FAILED", "CANCELLED"}

# BATCH_TASK_TIMEOUT_SECONDS (7200) + 30 分の安全幅
DEFAULT_STALE_THRESHOLD_SECONDS = 7200 + 1800


def parse_duration(spec: str) -> int:
    """``2h`` / ``30m`` / ``9000s`` などを秒数に変換する。"""
    match = re.fullmatch(r"(\d+)(s|m|h|d)?", spec.strip())
    if not match:
        raise ValueError(f"invalid duration spec: {spec!r}")
    value, unit = int(match.group(1)), match.group(2) or "s"
    multiplier = {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]
    return value * multiplier


def yyyymm(iso: str) -> str:
    """``"2026-04-23T11:30:44.541Z"`` → ``"202604"``."""
    return iso[:4] + iso[5:7]


def expected_gsi1pk(status: str, created_at: str) -> str:
    return f"STATUS#{status}#{yyyymm(created_at)}"


def scan_meta_items(table: Any) -> Iterator[dict[str, Any]]:
    """``SK = "META"`` で FilterExpression した Scan を逐次 yield する。"""
    kwargs: dict[str, Any] = {
        "FilterExpression": "SK = :meta",
        "ExpressionAttributeValues": {":meta": "META"},
    }
    while True:
        res = table.scan(**kwargs)
        for item in res.get("Items", []):
            yield item
        last = res.get("LastEvaluatedKey")
        if not last:
            return
        kwargs["ExclusiveStartKey"] = last


def _totals_count(totals: dict[str, Any] | None, key: str) -> int | None:
    """``totals[key]`` を int で取り出す (DDB は Decimal なので int へ丸める)."""
    if not totals or key not in totals:
        return None
    try:
        return int(totals[key])
    except (TypeError, ValueError):
        return None


def classify(
    item: dict[str, Any],
    stale_threshold_sec: int,
    now: datetime,
) -> tuple[list[str], str | None]:
    """アイテムを分類し、(理由リスト, 推奨アクション) を返す."""
    reasons: list[str] = []
    recommend: str | None = None

    status = item.get("status")
    created_at = item.get("createdAt")
    updated_at = item.get("updatedAt")
    gsi1pk = item.get("GSI1PK")

    if not status or not created_at:
        reasons.append("missing core attrs")
        return reasons, None

    expected = expected_gsi1pk(status, created_at)
    if gsi1pk != expected:
        reasons.append(f"GSI1PK mismatch (actual={gsi1pk} expected={expected})")
        recommend = "fix-gsi"

    if status == "PROCESSING":
        try:
            updated_dt = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
        except Exception:
            updated_dt = None
        if updated_dt is not None and (now - updated_dt) > timedelta(
            seconds=stale_threshold_sec,
        ):
            elapsed = (now - updated_dt).total_seconds()
            reasons.append(
                f"stale PROCESSING (updatedAt {int(elapsed)}s ago, threshold {stale_threshold_sec}s)",
            )
            recommend = "force-fail"

    # FAILED の totals 不整合: succeeded + failed < total なら未確定分が残置
    # されている (= MarkFailedForced が totals を補正せず status だけ更新した
    # 痕跡)。fix-gsi より優先したい固有の修復なので recommend を上書きする。
    if status == "FAILED":
        totals = item.get("totals")
        total = _totals_count(totals, "total")
        succeeded = _totals_count(totals, "succeeded")
        failed = _totals_count(totals, "failed")
        if (
            total is not None
            and succeeded is not None
            and failed is not None
            and total > 0
            and succeeded + failed < total
        ):
            reasons.append(
                f"FAILED totals mismatch (total={total} succeeded={succeeded} "
                f"failed={failed} → expected failed={total - succeeded})",
            )
            recommend = "fix-failed-totals"

    return reasons, recommend


def fix_gsi(table: Any, item: dict[str, Any]) -> None:
    """META の ``GSI1PK`` を実 status に合わせて上書きする."""
    status = item["status"]
    created_at = item["createdAt"]
    new_gsi1pk = expected_gsi1pk(status, created_at)
    table.update_item(
        Key={"PK": item["PK"], "SK": item["SK"]},
        UpdateExpression="SET #gsi1pk = :gsi1pk",
        ExpressionAttributeNames={"#gsi1pk": "GSI1PK"},
        ExpressionAttributeValues={":gsi1pk": new_gsi1pk},
    )


def force_fail(table: Any, item: dict[str, Any], now: datetime) -> None:
    """停滞 PROCESSING を FAILED に強制遷移し、GSI1PK も揃える."""
    created_at = item["createdAt"]
    iso_now = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
    new_gsi1pk = expected_gsi1pk("FAILED", created_at)
    table.update_item(
        Key={"PK": item["PK"], "SK": item["SK"]},
        UpdateExpression=(
            "SET #status = :failed, #updatedAt = :now, #gsi1pk = :gsi1pk"
        ),
        ConditionExpression="#status = :processing",
        ExpressionAttributeNames={
            "#status": "status",
            "#updatedAt": "updatedAt",
            "#gsi1pk": "GSI1PK",
        },
        ExpressionAttributeValues={
            ":failed": "FAILED",
            ":processing": "PROCESSING",
            ":now": iso_now,
            ":gsi1pk": new_gsi1pk,
        },
    )


def fix_failed_totals(table: Any, item: dict[str, Any]) -> None:
    """FAILED の ``totals`` を ``failed = total - succeeded``, ``inProgress = 0`` に補正する.

    DDB の ``UpdateExpression`` で ``#t.#failed = #t.#total - #t.#succeeded`` を
    使い、項目読み取り時の値ではなく書き込み時点の値を基準に算術する (同時更新が
    起きてもインプレースで一貫した結果になる)。``status = FAILED`` を
    ``ConditionExpression`` で要求して、PROCESSING 中の他経路と衝突しないように
    する。
    """
    table.update_item(
        Key={"PK": item["PK"], "SK": item["SK"]},
        UpdateExpression=(
            "SET #t.#failed = #t.#total - #t.#succeeded, #t.#inProgress = :zero"
        ),
        ConditionExpression="#status = :failed",
        ExpressionAttributeNames={
            "#status": "status",
            "#t": "totals",
            "#failed": "failed",
            "#total": "total",
            "#succeeded": "succeeded",
            "#inProgress": "inProgress",
        },
        ExpressionAttributeValues={
            ":failed": "FAILED",
            ":zero": 0,
        },
    )


BATCH_IN_FLIGHT_PREFIX = "BATCH_IN_FLIGHT#"
ACTIVE_COUNT_KEY = "ACTIVE#COUNT"


def scan_in_flight_items(control_table: Any) -> Iterator[dict[str, Any]]:
    """ControlTable から ``BATCH_IN_FLIGHT#`` で始まる lock_key の行を yield する."""
    kwargs: dict[str, Any] = {
        "FilterExpression": "begins_with(lock_key, :p)",
        "ExpressionAttributeValues": {":p": BATCH_IN_FLIGHT_PREFIX},
    }
    while True:
        res = control_table.scan(**kwargs)
        for item in res.get("Items", []):
            yield item
        last = res.get("LastEvaluatedKey")
        if not last:
            return
        kwargs["ExclusiveStartKey"] = last


def is_terminal(meta: dict[str, Any] | None) -> bool:
    """META の status が終端 (COMPLETED/PARTIAL/FAILED/CANCELLED) かを判定."""
    if not meta:
        return False
    status = meta.get("status")
    return status in STATUSES_TERMINAL


def _classify_in_flight(
    *,
    batch_table: Any,
    control_table: Any,
) -> tuple[int, list[dict[str, Any]], list[dict[str, Any]]]:
    """ControlTable を 1 周 scan し (in_flight_total, terminal, active) を返す.

    純関数 (副作用は scan / get_item の read のみ)。``reap_control_table`` から
    複数回呼ばれて diff/再カウントを行う。
    """
    in_flight_total = 0
    orphans_terminal: list[dict[str, Any]] = []
    orphans_active: list[dict[str, Any]] = []
    for hb in scan_in_flight_items(control_table):
        in_flight_total += 1
        batch_job_id = hb.get("batchJobId") or hb["lock_key"][
            len(BATCH_IN_FLIGHT_PREFIX) :
        ]
        meta_res = batch_table.get_item(
            Key={"PK": f"BATCH#{batch_job_id}", "SK": "META"},
        )
        meta = meta_res.get("Item")
        if is_terminal(meta):
            orphans_terminal.append(hb)
        else:
            orphans_active.append(hb)
    return in_flight_total, orphans_terminal, orphans_active


def reap_control_table(
    *,
    batch_table: Any,
    control_table: Any,
    apply: bool,
) -> dict[str, int]:
    """ControlTable の孤児 heartbeat を削除し ACTIVE#COUNT を再計算する.

    手順 (Codex M1 対応で「削除後に再 scan」方式に変更):
      1. 1 周目の scan: ``BATCH_IN_FLIGHT#*`` を列挙し、対応 META が終端の
         heartbeat を削除候補に分類
      2. 終端済 heartbeat を ``ConditionalDelete`` (attribute_exists(lock_key))
         で削除する。**ACTIVE#COUNT は同時に減算する** ため
         ``TransactWriteItems`` を使い、heartbeat 行が既に消えている場合は
         transaction が cancel されて二重 decrement を防ぐ。
      3. 削除完了後に **2 周目の scan** で実在 BATCH_IN_FLIGHT 行数を再カウントし、
         ``ACTIVE#COUNT`` の値と乖離があれば ``SET`` で再較正する。
         この再 scan により「削除中に新規登録された heartbeat」も実カウントに
         算入され、quiesce 不要で安全に補正できる。
      4. それでも race で N±1 ズレる可能性は残るが、再実行で収束する
         (新規登録は ACTIVE#COUNT を ADD +1 するため scan/SET の race window が
         極小化されている点に依拠)。

    Returns:
        ``{"in_flight_total": int, "orphans_terminal": int,
            "orphans_active": int, "active_count_before": int,
            "active_count_after": int, "in_flight_after_delete": int}``
    """
    in_flight_total, orphans_terminal, orphans_active = _classify_in_flight(
        batch_table=batch_table,
        control_table=control_table,
    )

    for hb in orphans_terminal:
        batch_job_id = hb.get("batchJobId") or hb["lock_key"][
            len(BATCH_IN_FLIGHT_PREFIX) :
        ]
        print(f"- ORPHAN heartbeat: batchJobId={batch_job_id}")
    for hb in orphans_active:
        batch_job_id = hb.get("batchJobId") or hb["lock_key"][
            len(BATCH_IN_FLIGHT_PREFIX) :
        ]
        print(f"- skip heartbeat (non-terminal): batchJobId={batch_job_id}")

    # ACTIVE#COUNT 現在値
    count_res = control_table.get_item(Key={"lock_key": ACTIVE_COUNT_KEY})
    count_item = count_res.get("Item") or {}
    active_count_before = int(count_item.get("count", 0))

    if not apply:
        return {
            "in_flight_total": in_flight_total,
            "orphans_terminal": len(orphans_terminal),
            "orphans_active": len(orphans_active),
            "active_count_before": active_count_before,
            "active_count_after": active_count_before,
            "in_flight_after_delete": in_flight_total,
        }

    # 終端済 heartbeat を TransactWriteItems で「Delete + ACTIVE#COUNT -1」する。
    # 既に runner が削除済の heartbeat に対しては ConditionExpression で
    # transaction 全体が cancel され、ACTIVE#COUNT も減算されない (二重 decrement
    # 防止)。
    client = boto3.client("dynamodb", region_name=control_table.meta.client.meta.region_name)
    table_name = control_table.name
    actually_deleted = 0
    for hb in orphans_terminal:
        try:
            client.transact_write_items(
                TransactItems=[
                    {
                        "Delete": {
                            "TableName": table_name,
                            "Key": {"lock_key": {"S": hb["lock_key"]}},
                            "ConditionExpression": "attribute_exists(lock_key)",
                        },
                    },
                    {
                        "Update": {
                            "TableName": table_name,
                            "Key": {"lock_key": {"S": ACTIVE_COUNT_KEY}},
                            "UpdateExpression": "ADD #c :minus",
                            "ConditionExpression":
                                "attribute_exists(#c) AND #c > :zero",
                            "ExpressionAttributeNames": {"#c": "count"},
                            "ExpressionAttributeValues": {
                                ":minus": {"N": "-1"},
                                ":zero": {"N": "0"},
                            },
                        },
                    },
                ],
            )
            actually_deleted += 1
        except client.exceptions.TransactionCanceledException:
            # heartbeat が既に消えている / count が 0 以下のいずれか。
            # 二重 decrement 防止が機能しているので無視。
            print(
                f"  (skip {hb['lock_key']}: already removed or count==0)",
            )

    # **2 周目の scan**: 削除中に新規登録された heartbeat も含めて再カウントする。
    # 削除直後の最終 count は「再 scan で見える実在 BATCH_IN_FLIGHT 行数」に揃える。
    in_flight_after_delete, _, _ = _classify_in_flight(
        batch_table=batch_table,
        control_table=control_table,
    )
    # 現在の ACTIVE#COUNT を再取得し、実在数と乖離があれば SET で較正する。
    count_after_res = control_table.get_item(Key={"lock_key": ACTIVE_COUNT_KEY})
    count_after_item = count_after_res.get("Item") or {}
    current_count = int(count_after_item.get("count", 0))

    new_count = current_count
    if current_count != in_flight_after_delete:
        # 過去の drift / TransactWrite でうまく減算できなかった分などを
        # 実カウントに揃える。新規登録は別経路で ADD +1 されているため、
        # SET 直後に増減する race window はあるが運用一括補修としては許容。
        control_table.update_item(
            Key={"lock_key": ACTIVE_COUNT_KEY},
            UpdateExpression="SET #c = :c",
            ExpressionAttributeNames={"#c": "count"},
            ExpressionAttributeValues={":c": in_flight_after_delete},
        )
        new_count = in_flight_after_delete

    return {
        "in_flight_total": in_flight_total,
        "orphans_terminal": len(orphans_terminal),
        "orphans_active": len(orphans_active),
        "active_count_before": active_count_before,
        "active_count_after": new_count,
        "in_flight_after_delete": in_flight_after_delete,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--table",
        default=os.environ.get("BATCH_TABLE_NAME"),
        help="DynamoDB BatchTable 名 (env BATCH_TABLE_NAME と同義)",
    )
    parser.add_argument(
        "--control-table",
        default=os.environ.get("CONTROL_TABLE_NAME"),
        help="DynamoDB ControlTable 名 (--reap-control-table モード時に必須)",
    )
    parser.add_argument("--region", default="ap-northeast-1")
    parser.add_argument(
        "--older-than",
        default=f"{DEFAULT_STALE_THRESHOLD_SECONDS}s",
        help="PROCESSING を stale とみなす更新経過時間 (既定: 2h30m)",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="検出のみ (既定)")
    mode.add_argument("--fix-gsi", action="store_true", help="GSI1PK のみ補正")
    mode.add_argument(
        "--force-fail", action="store_true", help="停滞 PROCESSING を FAILED 化",
    )
    mode.add_argument(
        "--fix-failed-totals",
        action="store_true",
        help="FAILED の totals.failed/inProgress を補正",
    )
    mode.add_argument(
        "--reap-control-table",
        action="store_true",
        help="ControlTable の孤児 heartbeat 削除 + ACTIVE#COUNT 再計算",
    )
    args = parser.parse_args()

    if not args.table:
        print(
            "ERROR: BatchTable 名を --table または BATCH_TABLE_NAME で指定してください",
            file=sys.stderr,
        )
        return 2

    stale_sec = parse_duration(args.older_than)
    ddb = boto3.resource("dynamodb", region_name=args.region)
    table = ddb.Table(args.table)
    now = datetime.now(tz=timezone.utc)

    # ControlTable リーパは META スキャンを使わない独立処理
    if args.reap_control_table:
        if not args.control_table:
            print(
                "ERROR: --reap-control-table には --control-table または "
                "CONTROL_TABLE_NAME 環境変数が必要です",
                file=sys.stderr,
            )
            return 2
        control_table = ddb.Table(args.control_table)
        print(f"Reaping ControlTable: {args.control_table}")
        result = reap_control_table(
            batch_table=table,
            control_table=control_table,
            apply=True,
        )
        print()
        print(f"Scanned BATCH_IN_FLIGHT items: {result['in_flight_total']}")
        print(f"  終端済 (削除候補):       {result['orphans_terminal']}")
        print(f"  非終端 (温存):           {result['orphans_active']}")
        print(
            f"  削除後の再 scan 件数:    {result['in_flight_after_delete']}",
        )
        print(
            f"  ACTIVE#COUNT: "
            f"{result['active_count_before']} → {result['active_count_after']}",
        )
        return 0

    total = 0
    fixable_gsi: list[dict[str, Any]] = []
    force_failable: list[dict[str, Any]] = []
    failed_totals_fixable: list[dict[str, Any]] = []

    for item in scan_meta_items(table):
        total += 1
        reasons, action = classify(item, stale_sec, now)
        if not reasons:
            continue
        print(
            f"- batchJobId={item.get('batchJobId','?'):36s} "
            f"status={item.get('status','?'):<11s} "
            f"gsi1pk={item.get('GSI1PK','?')}"
        )
        for r in reasons:
            print(f"    * {r}")
        if action == "fix-gsi":
            fixable_gsi.append(item)
        elif action == "force-fail":
            force_failable.append(item)
        elif action == "fix-failed-totals":
            failed_totals_fixable.append(item)

    print()
    print(f"Scanned META items: {total}")
    print(f"  GSI1PK 乖離:           {len(fixable_gsi)}")
    print(f"  停滞 PROCESSING:       {len(force_failable)}")
    print(f"  FAILED totals 不整合:  {len(failed_totals_fixable)}")

    if args.fix_gsi:
        for item in fixable_gsi:
            fix_gsi(table, item)
        print(f"fix-gsi applied: {len(fixable_gsi)}")
    elif args.force_fail:
        # force-fail 対象は GSI1PK も一緒に直るので fixable_gsi は除外しない
        for item in force_failable:
            force_fail(table, item, now)
        print(f"force-fail applied: {len(force_failable)}")
    elif args.fix_failed_totals:
        for item in failed_totals_fixable:
            fix_failed_totals(table, item)
        print(f"fix-failed-totals applied: {len(failed_totals_fixable)}")
    else:
        print(
            "dry-run: no changes written. "
            "--fix-gsi / --force-fail / --fix-failed-totals で適用",
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
