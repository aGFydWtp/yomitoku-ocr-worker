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
    error_category: str | None = None,
) -> bool:
    """FILE アイテムを条件付き更新する。既に COMPLETED の場合はスキップし False を返す。

    Args:
        table: boto3 DynamoDB Table resource
        batch_job_id: 対象バッチ
        file_key: `batches/{id}/input/{filename}` 形式
        status: "COMPLETED" | "FAILED"
        dpi/processing_time_ms/result_key/error_message: 追加属性
        error_category: 変換 / OCR 失敗の機械可読カテゴリ
            (`"CONVERSION_FAILED"` | `"OCR_FAILED"`)。
            None の場合は DDB の `errorCategory` 属性を一切更新しない
            (UpdateExpression の SET 句に含めない)。明示的に値を渡したときのみ
            `SET` で書き込まれる。これにより既存 FILE アイテムの旧データを
            意図せず上書きするリスクを避ける (TS 側 `lambda/api/lib/batch-store.ts`
            の `errorCategory` と同名 attribute / 同じ契約)。

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
    # errorCategory: 明示時のみ SET (None なら属性を触らない)。
    # attribute 名 ``errorCategory`` は TS 側 (`lambda/api/lib/batch-store.ts`)
    # と共有 (R4.2 / R4.3)。
    if error_category is not None:
        ean["#errorCategory"] = "errorCategory"
        eav[":errorCategory"] = error_category
        set_exprs.append("#errorCategory = :errorCategory")

    try:
        # ConditionExpression 2 段:
        # 1. attribute_exists(PK): defense-in-depth — 存在しない FILE への
        #    upsert を防ぐ。`apply_process_log` の converted_filename_map が
        #    PPTX→PDF 名解決を担うが、将来のフォーマット追加や mapping 漏れで
        #    filename mismatch が再発した場合に silent な orphan 行が作られる
        #    のを防ぐため、明示的に既存行のみ更新する契約に固定。
        # 2. #status <> :completed: 既存の冪等性ガード (再実行で完了済を上書きしない)。
        # どちらが原因の `ConditionalCheckFailedException` でも、本関数は False を
        # 返してスキップ扱いとし、apply_process_log 側で集計する `skipped` に計上される。
        table.update_item(
            Key={
                "PK": f"BATCH#{batch_job_id}",
                "SK": f"FILE#{file_key}",
            },
            UpdateExpression="SET " + ", ".join(set_exprs),
            ConditionExpression=(
                "attribute_exists(PK) AND #status <> :completed"
            ),
            ExpressionAttributeNames=ean,
            ExpressionAttributeValues=eav,
        )
        return True
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            logger.info(
                "update_file_result skipped (already COMPLETED or FILE not found): %s / %s",
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
    converted_filename_map: dict[str, str] | None = None,
) -> dict[str, int]:
    """ProcessLogEntry のシーケンスを FILE アイテムに反映し totals を集計する。

    Bug 001 fix (filename mismatch): Office → PDF 変換が成功した場合、
    yomitoku-client は変換後 PDF (例: ``deck.pdf``) のパスを ``process_log.jsonl``
    に書く。一方で API 側が seed する DDB FILE アイテムの SK は **原本ファイル名**
    (例: ``deck.pptx``) のままなので、``filename`` をそのまま FILE PK に使うと
    ``deck.pdf`` 名で別アイテムを upsert してしまい、原本 ``deck.pptx`` の
    PENDING アイテムが残置される (= phantom FILE 行 + R3.3 totals 整合性違反)。

    呼び出し側 (``main.py``) が変換成功 1 件ごとに
    ``{converted_pdf_basename: original_filename}`` (例:
    ``{"deck.pdf": "deck.pptx"}``) のマップを渡すと、ここで FILE PK のみ
    原本名に書き戻して既存アイテムを更新する。``resultKey`` は引き続き実 S3
    出力 (``batches/{id}/output/<stem>.json``) を指す: そちらは変換後 stem
    ベースで生成されるため上書きしない。

    Args:
        converted_filename_map: ``{converted_pdf_basename: original_filename}``
            None または空なら従来挙動 (filename をそのまま使う)。

    Returns:
        {"succeeded": int, "failed": int, "skipped": int}
    """
    succeeded = 0
    failed = 0
    skipped = 0
    cf_map = converted_filename_map or {}

    for entry in entries:
        filename = entry.filename or Path(entry.file_path).name
        if not filename:
            logger.warning("process_log entry without filename, skip: %s", entry)
            skipped += 1
            continue

        # Bug 001: 変換後 PDF 名 → 原本 Office ファイル名に書き戻す。
        # マップ未登録なら従来挙動 (filename そのまま)。``resultKey`` は影響なし
        # (S3 出力は変換後 stem ベースで生成されるため別経路で渡される)。
        original = cf_map.get(filename)
        if original:
            logger.info(
                "apply_process_log: rewriting filename for FILE PK lookup: "
                "%s -> %s (batch=%s)",
                filename,
                original,
                batch_job_id,
            )
            filename = original

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
            # errorCategory 派生規則 (R4.2 / R4.3):
            #   - entry.error_category が明示されていればそのまま採用
            #     (例: 変換層が `"CONVERSION_FAILED"` を書いている)
            #   - None の場合は OCR 由来失敗とみなして `"OCR_FAILED"` に正規化
            #     (yomitoku-client は error_category を出力しないため Py 側で導出)
            error_category = (
                entry.error_category if entry.error_category is not None
                else "OCR_FAILED"
            )
            updated = update_file_result(
                table=table,
                batch_job_id=batch_job_id,
                file_key=file_key,
                status="FAILED",
                error_message=entry.error,
                error_category=error_category,
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
