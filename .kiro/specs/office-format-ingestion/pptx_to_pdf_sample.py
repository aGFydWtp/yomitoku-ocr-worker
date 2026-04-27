"""
PPTX → PDF 変換 Lambda ハンドラー

EventBridge (S3 Object Created) 経由で呼び出され、
input/ プレフィックスの .pptx ファイルを LibreOffice で PDF に変換して
output/ プレフィックスに保存する。

ベースイメージ: public.ecr.aws/shelf/lambda-libreoffice-base:25.8-python3.14-x86_64
"""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

import boto3

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

INPUT_PREFIX = "input/"
OUTPUT_PREFIX = "output/"
# ベースイメージに含まれる LibreOffice 25.8 のバイナリ名
LIBREOFFICE_CMD = "libreoffice25.8"


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:  # noqa: ARG001
    """Lambda エントリポイント。

    EventBridge の S3 Object Created イベント形式:
    {
        "detail": {
            "bucket": {"name": "..."},
            "object": {"key": "input/foo.pptx"}
        }
    }
    """
    bucket_name = os.environ.get("BUCKET_NAME") or event["detail"]["bucket"]["name"]
    key: str = event["detail"]["object"]["key"]

    if not key.startswith(INPUT_PREFIX):
        raise ValueError(f"Unexpected key prefix: {key!r}")
    if ".." in key:
        raise ValueError(f"Invalid key (path traversal detected): {key!r}")
    if not key.lower().endswith(".pptx"):
        raise ValueError(f"Unsupported file extension: {key!r}")

    logger.info("Processing: s3://%s/%s", bucket_name, key)

    s3: S3Client = boto3.client("s3")
    _convert(s3, bucket_name, key)

    return {"statusCode": 200}


def _convert(s3: Any, bucket: str, input_key: str) -> None:
    """PPTX ファイルを PDF に変換して S3 に保存する。"""
    # input/ プレフィックスを除いた相対パスを保持して output/ に対応させる
    # e.g. "input/demo/test.pptx" -> relative="demo/test.pptx" -> output_key="output/demo/test.pdf"
    relative = input_key[len(INPUT_PREFIX):]  # e.g. "demo/test.pptx"
    filename = Path(relative).name  # e.g. "test.pptx"
    stem = Path(filename).stem  # e.g. "test"
    output_key = OUTPUT_PREFIX + str(Path(relative).with_suffix(".pdf"))  # e.g. "output/demo/test.pdf"

    with tempfile.TemporaryDirectory() as tmp:
        pptx_path = os.path.join(tmp, filename)
        pdf_path = os.path.join(tmp, stem + ".pdf")

        # S3 から PPTX をダウンロード
        s3.download_file(bucket, input_key, pptx_path)
        logger.info("Downloaded: %s", pptx_path)

        # LibreOffice で PDF に変換
        _run_libreoffice(pptx_path, tmp)

        pdf = Path(pdf_path)
        if not pdf.exists() or pdf.stat().st_size == 0:
            raise RuntimeError(
                f"LibreOffice exited successfully but PDF was not generated: {pdf_path}"
            )
        logger.info("Converted: %s (size=%d bytes)", pdf_path, pdf.stat().st_size)

        # S3 に PDF をアップロード
        s3.upload_file(pdf_path, bucket, output_key)
        logger.info("Uploaded: s3://%s/%s", bucket, output_key)


def _run_libreoffice(input_path: str, output_dir: str) -> None:
    """LibreOffice を subprocess で実行して PDF に変換する。"""
    cmd = [
        LIBREOFFICE_CMD,
        "--headless",
        "--invisible",
        "--nodefault",
        "--nofirststartwizard",
        "--norestore",
        "--convert-to",
        "pdf",
        "--outdir",
        output_dir,
        input_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=240, check=False)  # noqa: S603

    logger.info("LibreOffice stdout: %s", result.stdout)
    if result.returncode != 0:
        logger.error("LibreOffice stderr: %s", result.stderr)
        raise RuntimeError(
            f"LibreOffice conversion failed (exit={result.returncode})"
        )

