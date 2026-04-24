"""BatchTable 更新ヘルパー (Task 3.4)。

TypeScript 側 `lambda/api/lib/batch-store.ts` の BatchStore と同じスキーマで
FILE/META アイテムを更新する。Python バッチランナーは process_log.jsonl を
読み込み、このモジュール経由で DDB に書き戻す。

機能:
    - update_file_result: FILE#<fileKey> を条件付き更新 (既存が COMPLETED ならスキップ)
    - transition_batch_status: META の status を expectedCurrent チェック付きで遷移
    - apply_process_log: ProcessLogEntry のシーケンスを一括適用し totals を返す
    - finalize_batch_status: 集計結果から遷移先 (COMPLETED/PARTIAL/FAILED) を判定し遷移

DynamoDB 例外は boto3 ClientError で上がるため
`ConditionalCheckFailedException` を検出して `ConflictError` に変換する。
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from botocore.exceptions import ClientError

from process_log_reader import ProcessLogEntry

logger = logging.getLogger(__name__)


class ConflictError(Exception):
    """楽観ロック衝突 (expectedCurrent と DDB 上の status が一致しない)。"""


# ---------------------------------------------------------------------------
# ヘルパー
# ---------------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _iso(now: datetime) -> str:
    # TS 側と同じ ISO 文字列 (ミリ秒精度 + Z)。
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _gsi1pk(status: str, now: datetime) -> str:
    return f"STATUS#{status}#{now.strftime('%Y%m')}"


def build_file_key(batch_job_id: str, filename: str) -> str:
    """TS buildFileKey 相当。"""
    return f"batches/{batch_job_id}/input/{filename}"


# ---------------------------------------------------------------------------
# update_file_result
# ---------------------------------------------------------------------------


def update_file_result(
    *,
    table,
    batch_job_id: str,
    file_key: str,
    status: str,
    dpi: int | None = None,
    processing_time_ms: int | None = None,
    result_key: str | None = None,
    error_message: str | None = None,
) -> bool:
    """FILE アイテムを条件付き更新する。既に COMPLETED の場合はスキップし False を返す。

    Args:
        table: boto3 DynamoDB Table resource
        batch_job_id: 対象バッチ
        file_key: `batches/{id}/input/{filename}` 形式
        status: "COMPLETED" | "FAILED"
        dpi/processing_time_ms/result_key/error_message: 追加属性

    Returns:
        True: 更新実行, False: 既に COMPLETED でスキップ
    """
    iso = _iso(_now())

    ean: dict[str, str] = {"#status": "status", "#updatedAt": "updatedAt"}
    eav: dict[str, object] = {
        ":new": status,
        ":now": iso,
        ":completed": "COMPLETED",
    }
    set_exprs = ["#status = :new", "#updatedAt = :now"]

    if dpi is not None:
        ean["#dpi"] = "dpi"
        eav[":dpi"] = dpi
        set_exprs.append("#dpi = :dpi")
    if processing_time_ms is not None:
        ean["#proc"] = "processingTimeMs"
        eav[":proc"] = processing_time_ms
        set_exprs.append("#proc = :proc")
    if result_key is not None:
        ean["#resultKey"] = "resultKey"
        eav[":resultKey"] = result_key
        set_exprs.append("#resultKey = :resultKey")
    if error_message is not None:
        ean["#errMsg"] = "errorMessage"
        eav[":errMsg"] = error_message
        set_exprs.append("#errMsg = :errMsg")

    try:
        table.update_item(
            Key={
                "PK": f"BATCH#{batch_job_id}",
                "SK": f"FILE#{file_key}",
            },
            UpdateExpression="SET " + ", ".join(set_exprs),
            ConditionExpression="#status <> :completed",
            ExpressionAttributeNames=ean,
            ExpressionAttributeValues=eav,
        )
        return True
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            logger.info(
                "update_file_result skipped (already COMPLETED): %s / %s",
                batch_job_id, file_key,
            )
            return False
        raise


# ---------------------------------------------------------------------------
# transition_batch_status
# ---------------------------------------------------------------------------


def transition_batch_status(
    *,
    table,
    batch_job_id: str,
    new_status: str,
    expected_current: str,
    totals: dict | None = None,
) -> None:
    """META.status を expected_current チェック付きで遷移する。

    - `#status = :new`, `#updatedAt = :now`, `#GSI1PK = :newGSI1PK` を SET
    - `totals` が与えられた場合は `#totals = :totals` も SET
    - `new_status != PENDING` なら TTL を REMOVE
    """
    now = _now()
    iso = _iso(now)

    ean: dict[str, str] = {
        "#status": "status",
        "#updatedAt": "updatedAt",
        "#GSI1PK": "GSI1PK",
        "#ttl": "ttl",
    }
    eav: dict[str, object] = {
        ":new": new_status,
        ":expected": expected_current,
        ":now": iso,
        ":newGSI1PK": _gsi1pk(new_status, now),
    }
    set_exprs = [
        "#status = :new",
        "#updatedAt = :now",
        "#GSI1PK = :newGSI1PK",
    ]

    if totals is not None:
        ean["#totals"] = "totals"
        eav[":totals"] = totals
        set_exprs.append("#totals = :totals")

    update_expr = "SET " + ", ".join(set_exprs)
    if new_status != "PENDING":
        update_expr += " REMOVE #ttl"

    try:
        table.update_item(
            Key={"PK": f"BATCH#{batch_job_id}", "SK": "META"},
            UpdateExpression=update_expr,
            ConditionExpression="#status = :expected",
            ExpressionAttributeNames=ean,
            ExpressionAttributeValues=eav,
        )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            raise ConflictError(
                f"Batch {batch_job_id} is not in status {expected_current}"
            ) from exc
        raise


# ---------------------------------------------------------------------------
# apply_process_log
# ---------------------------------------------------------------------------


def apply_process_log(
    *,
    table,
    batch_job_id: str,
    entries: Iterable[ProcessLogEntry],
) -> dict[str, int]:
    """ProcessLogEntry のシーケンスを FILE アイテムに反映し totals を集計する。

    Returns:
        {"succeeded": int, "failed": int, "skipped": int}
    """
    succeeded = 0
    failed = 0
    skipped = 0

    for entry in entries:
        filename = entry.filename or Path(entry.file_path).name
        if not filename:
            logger.warning("process_log entry without filename, skip: %s", entry)
            skipped += 1
            continue

        file_key = build_file_key(batch_job_id, filename)

        if entry.success:
            updated = update_file_result(
                table=table,
                batch_job_id=batch_job_id,
                file_key=file_key,
                status="COMPLETED",
                dpi=entry.dpi,
                processing_time_ms=entry.processing_time_ms,
                result_key=(
                    f"batches/{batch_job_id}/output/{Path(entry.output_path).name}"
                    if entry.output_path else None
                ),
            )
            if updated:
                succeeded += 1
            else:
                skipped += 1
        else:
            updated = update_file_result(
                table=table,
                batch_job_id=batch_job_id,
                file_key=file_key,
                status="FAILED",
                error_message=entry.error,
            )
            if updated:
                failed += 1
            else:
                skipped += 1

    return {"succeeded": succeeded, "failed": failed, "skipped": skipped}


# ---------------------------------------------------------------------------
# finalize_batch_status
# ---------------------------------------------------------------------------


def finalize_batch_status(
    *,
    table,
    batch_job_id: str,
    total_files: int,
    succeeded: int,
    failed: int,
    expected_current: str = "PROCESSING",
) -> str:
    """集計値から遷移先 (COMPLETED/PARTIAL/FAILED) を判定し META を更新する。

    判定ロジック:
        - succeeded == total_files かつ failed == 0  → COMPLETED
        - succeeded > 0 かつ failed > 0             → PARTIAL
        - それ以外 (all failed / all zero)           → FAILED

    Raises:
        ValueError: succeeded + failed が total_files を超える場合
            (skipped の考慮漏れや呼び出し側のバグを早期検出)。
    """
    if succeeded < 0 or failed < 0 or total_files < 0:
        raise ValueError(
            f"finalize_batch_status requires non-negative counts, "
            f"got total={total_files}, succeeded={succeeded}, failed={failed}"
        )
    if succeeded + failed > total_files:
        raise ValueError(
            f"succeeded+failed ({succeeded + failed}) exceeds total_files "
            f"({total_files}) for batch {batch_job_id}"
        )
    in_progress = max(total_files - succeeded - failed, 0)

    if total_files > 0 and succeeded == total_files and failed == 0:
        new_status = "COMPLETED"
    elif succeeded > 0 and failed > 0:
        new_status = "PARTIAL"
    else:
        new_status = "FAILED"

    transition_batch_status(
        table=table,
        batch_job_id=batch_job_id,
        new_status=new_status,
        expected_current=expected_current,
        totals={
            "total": total_files,
            "succeeded": succeeded,
            "failed": failed,
            "inProgress": in_progress,
        },
    )
    return new_status
