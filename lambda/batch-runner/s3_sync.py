"""S3 入出力同期層 (Task 3.2)。

BatchRunner タスクは以下の 3 つの同期処理を提供する:

1. `download_inputs`: `s3://{bucket}/batches/{id}/input/*` を
   ローカル `input_dir` にダウンロードする。
2. `verify_input_parity`: DDB FILE アイテムの期待キー集合と S3 実在
   オブジェクトを `HeadObject` で照合し、欠損キーのリストを返す。
3. `upload_outputs`: ローカル `output_dir` 配下の成果物を拡張子で
   分類し、`batches/{id}/{output,results,visualizations,logs}/`
   プレフィックスへアップロードする。`ProcessingStack` の
   lifecycle tagFilter (`batch-content-type`) に整合するタグを付与する。

すべての関数は `s3_client` 引数で boto3 S3 クライアントを受け取るので、
テストでは moto クライアントを注入し、本番では `boto3.client('s3')` を渡す。
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

# -----------------------------------------------------------------------------
# 拡張子 → (プレフィックスカテゴリ, ライフサイクルタグ値) マッピング
# -----------------------------------------------------------------------------
# ProcessingStack の lifecycle rule は tag key = "batch-content-type" でフィルタ:
#   - "log"          : 365 日保管
#   - "visualization": 30 日保管
#   - "result"       : 30 日保管
#   - output/*.json はタグなし (長期保持)
_EXT_TO_CATEGORY: dict[str, tuple[str, str | None]] = {
    ".json": ("output", None),
    ".md": ("results", "result"),
    ".csv": ("results", "result"),
    ".html": ("results", "result"),
    ".pdf": ("results", "result"),
    ".jpg": ("visualizations", "visualization"),
    ".jpeg": ("visualizations", "visualization"),
    ".png": ("visualizations", "visualization"),
}
# process_log.jsonl は特別扱い (logs/)
_LOG_FILENAMES = {"process_log.jsonl"}
_TAG_KEY = "batch-content-type"


# -----------------------------------------------------------------------------
# download_inputs
# -----------------------------------------------------------------------------


def download_inputs(
    *,
    bucket: str,
    batch_job_id: str,
    input_dir: str,
    s3_client: Any,
) -> list[str]:
    """`batches/{batch_job_id}/input/*` 配下のオブジェクトをローカルへダウンロードする。

    サブディレクトリ (`input/sub/*`) は無視する (設計上存在しないが防御)。
    """
    prefix = f"batches/{batch_job_id}/input/"
    downloaded: list[str] = []
    paginator = s3_client.get_paginator("list_objects_v2")
    Path(input_dir).mkdir(parents=True, exist_ok=True)
    input_base = Path(input_dir).resolve()

    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key: str = obj["Key"]
            # サブディレクトリをスキップ (prefix 直下のみ)
            relative = key[len(prefix):]
            if "/" in relative or not relative:
                continue
            # Path traversal 防御: relative に .. が含まれる、または
            # 解決後のパスが input_dir 配下に収まらない場合はスキップ
            local_path = (input_base / relative).resolve()
            try:
                local_path.relative_to(input_base)
            except ValueError:
                logger.warning(
                    "download_inputs: skipping path-traversal attempt: %s", key
                )
                continue
            logger.debug("downloading s3://%s/%s → %s", bucket, key, local_path)
            s3_client.download_file(bucket, key, str(local_path))
            downloaded.append(key)

    logger.info(
        "download_inputs: %d file(s) from s3://%s/%s",
        len(downloaded), bucket, prefix,
    )
    return downloaded


# -----------------------------------------------------------------------------
# verify_input_parity
# -----------------------------------------------------------------------------


def verify_input_parity(
    *,
    bucket: str,
    expected_keys: list[str],
    s3_client: Any,
) -> list[str]:
    """DDB FILE アイテム期待集合と S3 実在集合を HeadObject で照合する。

    Returns:
        欠損している S3 キーのリスト (空なら全件一致)。
    """
    missing: list[str] = []
    for key in expected_keys:
        try:
            s3_client.head_object(Bucket=bucket, Key=key)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            if code in ("404", "NoSuchKey", "NotFound"):
                missing.append(key)
                continue
            raise
    if missing:
        logger.warning(
            "verify_input_parity: %d key(s) missing out of %d expected",
            len(missing), len(expected_keys),
        )
    return missing


# -----------------------------------------------------------------------------
# upload_outputs
# -----------------------------------------------------------------------------


def _categorize(filename: str) -> tuple[str, str | None]:
    """ファイル名から (カテゴリ, ライフサイクルタグ値) を返す。"""
    if filename in _LOG_FILENAMES:
        return ("logs", "log")
    ext = os.path.splitext(filename)[1].lower()
    return _EXT_TO_CATEGORY.get(ext, ("output", None))


def upload_outputs(
    *,
    bucket: str,
    batch_job_id: str,
    output_dir: str,
    s3_client: Any,
) -> dict[str, int]:
    """ローカル `output_dir` の成果物をカテゴリ別プレフィックスへアップロードする。

    Returns:
        {"output": int, "results": int, "visualizations": int, "logs": int}
    """
    counts: dict[str, int] = {
        "output": 0,
        "results": 0,
        "visualizations": 0,
        "logs": 0,
    }
    out_path = Path(output_dir)
    if not out_path.exists():
        return counts

    for entry in sorted(out_path.iterdir()):
        if not entry.is_file():
            continue
        category, tag_value = _categorize(entry.name)
        s3_key = f"batches/{batch_job_id}/{category}/{entry.name}"
        extra_args: dict[str, Any] = {}
        if tag_value is not None:
            # URL エンコード形式で tag を付与 (key=value&...)
            extra_args["Tagging"] = f"{_TAG_KEY}={tag_value}"
        logger.debug("uploading %s → s3://%s/%s", entry, bucket, s3_key)
        s3_client.upload_file(str(entry), bucket, s3_key, ExtraArgs=extra_args or None)
        counts[category] += 1

    logger.info(
        "upload_outputs: output=%d results=%d visualizations=%d logs=%d",
        counts["output"], counts["results"],
        counts["visualizations"], counts["logs"],
    )
    return counts
