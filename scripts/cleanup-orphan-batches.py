#!/usr/bin/env python3
"""Orphan / GSI 乖離した META アイテムを検出して修復するメンテナンス CLI.

発見済の 3 種類の整合性不具合を一括で棚卸しする:

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

モード:
  - ``--dry-run`` (既定): 検出件数と各アイテムを表示するだけ
  - ``--fix-gsi``: GSI1PK を現 status に合わせて ``SET`` で上書き
  - ``--force-fail``: 停滞 PROCESSING を ``status=FAILED`` に強制遷移し、
    ``GSI1PK`` も同時に更新する
  - ``--fix-failed-totals``: FAILED の ``totals`` を
    ``failed = total - succeeded``, ``inProgress = 0`` に補正する

使い方:
  python3 scripts/cleanup-orphan-batches.py --dry-run
  python3 scripts/cleanup-orphan-batches.py --fix-gsi
  python3 scripts/cleanup-orphan-batches.py --force-fail --older-than 3h
  python3 scripts/cleanup-orphan-batches.py --fix-failed-totals

必要な IAM: ``dynamodb:Scan`` と ``dynamodb:UpdateItem`` を BatchTable に対して。
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--table",
        default=os.environ.get("BATCH_TABLE_NAME"),
        help="DynamoDB BatchTable 名 (env BATCH_TABLE_NAME と同義)",
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
