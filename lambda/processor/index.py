"""YomiToku-Pro OCR processing worker Lambda."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote_plus

import boto3
from botocore.exceptions import ClientError
from yomitoku_client import YomitokuClient, parse_pydantic_model
from yomitoku_client.client import CircuitConfig, RequestConfig

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

ENDPOINT_NAME = os.environ.get("ENDPOINT_NAME", "")
BUCKET_NAME = os.environ.get("BUCKET_NAME", "")
STATUS_TABLE = os.environ.get("STATUS_TABLE_NAME", "")
REGION = os.environ.get("AWS_DEFAULT_REGION", "ap-northeast-1")
table = dynamodb.Table(STATUS_TABLE)


def extract_file_key(record: dict) -> str:
    """Extract S3 object key from an SQS record (direct or SNS-wrapped)."""
    body = json.loads(record["body"])
    s3_event = json.loads(body["Message"]) if "Message" in body else body
    raw_key = s3_event["Records"][0]["s3"]["object"]["key"]
    return unquote_plus(raw_key)


_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def extract_job_id(file_key: str) -> str:
    """Extract job_id (UUID) from S3 key.

    Supports both formats:
      - input/{job_id}/{filename}
      - input/{basePath...}/{job_id}/{filename}
    """
    parts = file_key.split("/")
    if len(parts) < 3 or parts[0] != "input":
        raise ValueError(f"Unexpected S3 key format, cannot extract job_id: {file_key!r}")
    for part in parts[1:]:
        if _UUID_RE.match(part):
            return part
    raise ValueError(f"Unexpected S3 key format, cannot extract job_id: {file_key!r}")


def _generate_and_upload_visualizations(
    parsed,
    tmp_path: str,
    file_key: str,
    job_id: str,
) -> tuple[str, int]:
    """Generate layout/ocr visualization images and upload to S3.

    Uses low-level DocumentResult.visualize(img, mode) per page
    so the PDF is rendered to images only once.

    Returns (visualization_prefix, num_pages).
    """
    import cv2
    from yomitoku_client.models import correct_rotation_image
    from yomitoku_client.utils import load_pdf

    if not file_key.startswith("input/"):
        raise ValueError(f"Unexpected file_key format: {file_key!r}")

    images = load_pdf(tmp_path, dpi=200)
    basename = Path(tmp_path).stem
    viz_prefix = "visualizations/" + file_key[len("input/"):].rsplit("/", 1)[0] + "/"
    viz_dir = f"/tmp/viz_{job_id}"
    os.makedirs(viz_dir, exist_ok=True)

    try:
        num_pages = len(images)
        for idx, img in enumerate(images):
            page_result = parsed.pages[idx]
            corrected = correct_rotation_image(
                img, angle=page_result.preprocess.get("angle", 0)
            )

            for mode in ("layout", "ocr"):
                vis_img = page_result.visualize(corrected, mode=mode)
                filename = f"{basename}_{mode}_page_{idx}.jpg"
                local_path = os.path.join(viz_dir, filename)
                if not cv2.imwrite(local_path, vis_img):
                    raise RuntimeError(f"cv2.imwrite failed for {local_path}")

                s3_key = f"{viz_prefix}{filename}"
                s3.upload_file(local_path, BUCKET_NAME, s3_key)
                os.remove(local_path)

        return viz_prefix, num_pages
    finally:
        shutil.rmtree(viz_dir, ignore_errors=True)


def handler(event: dict, context: object) -> dict:
    """SQS event handler for OCR processing.

    Uses reportBatchItemFailures to report per-record failures.
    """
    batch_item_failures: list[dict[str, str]] = []

    for record in event["Records"]:
        file_key = extract_file_key(record)
        try:
            asyncio.run(process_file(file_key))
        except Exception:
            batch_item_failures.append(
                {"itemIdentifier": record["messageId"]}
            )

    return {"batchItemFailures": batch_item_failures}


async def process_file(file_key: str) -> None:
    """Download PDF from S3, run OCR, and upload result."""
    job_id = extract_job_id(file_key)
    now = datetime.now(timezone.utc).isoformat()

    # 1. Idempotency: conditional update PENDING → PROCESSING
    try:
        table.update_item(
            Key={"job_id": job_id},
            UpdateExpression="SET #s = :processing, updated_at = :t",
            ConditionExpression="#s = :pending",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":processing": "PROCESSING",
                ":pending": "PENDING",
                ":t": now,
            },
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return  # Already processing or completed
        raise

    tmp_path = f"/tmp/{os.path.basename(file_key)}"
    output_key = file_key.replace("input/", "output/").replace(".pdf", ".json")
    tmp_output = f"/tmp/{os.path.basename(output_key)}"

    try:
        # 2. Download PDF from S3
        obj = s3.get_object(Bucket=BUCKET_NAME, Key=file_key)
        with open(tmp_path, "wb") as f:
            f.write(obj["Body"].read())

        # 2.5. Validate PDF magic number
        with open(tmp_path, "rb") as f:
            header = f.read(5)
            if header != b"%PDF-":
                raise ValueError("Uploaded file is not a valid PDF")

        # 3. Run OCR with yomitoku-client
        start = time.time()

        async with YomitokuClient(
            endpoint=ENDPOINT_NAME,
            region=REGION,
            max_workers=2,
            request_config=RequestConfig(
                read_timeout=60,
                connect_timeout=10,
                max_retries=3,
            ),
            circuit_config=CircuitConfig(
                threshold=5,
                cooldown_time=30,
            ),
        ) as client:
            result = await client.analyze_async(tmp_path)

        elapsed = int((time.time() - start) * 1000)

        # 4. Convert result and upload to S3
        parsed = parse_pydantic_model(result)
        parsed.to_json(tmp_output)

        with open(tmp_output, "r") as f:
            json_content = f.read()

        s3.put_object(
            Bucket=BUCKET_NAME,
            Key=output_key,
            Body=json_content,
            ContentType="application/json",
        )

        # 5. Update DynamoDB: COMPLETED (before visualization to prevent OOM stalling)
        table.update_item(
            Key={"job_id": job_id},
            UpdateExpression="SET #s = :s, updated_at = :t, output_key = :o, processing_time_ms = :p",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":s": "COMPLETED",
                ":t": datetime.now(timezone.utc).isoformat(),
                ":o": output_key,
                ":p": elapsed,
            },
        )

        # 6. Generate visualization images (best-effort, after COMPLETED)
        try:
            viz_prefix, num_pages = _generate_and_upload_visualizations(
                parsed, tmp_path, file_key, job_id
            )
            table.update_item(
                Key={"job_id": job_id},
                UpdateExpression="SET visualization_prefix = :vp, num_pages = :np, updated_at = :t",
                ExpressionAttributeValues={
                    ":vp": viz_prefix,
                    ":np": num_pages,
                    ":t": datetime.now(timezone.utc).isoformat(),
                },
            )
        except Exception as viz_err:
            print(f"[WARN] job_id={job_id} visualization failed (non-fatal): {viz_err}")

    except Exception as e:
        # 7. Update DynamoDB: FAILED — do NOT re-raise.
        # The same PDF will produce the same error on retry, so SQS retry is pointless.
        # Letting the message be deleted avoids blocking the queue for up to
        # VisibilityTimeout × maxReceiveCount (potentially hours).
        table.update_item(
            Key={"job_id": job_id},
            UpdateExpression="SET #s = :s, updated_at = :t, error_message = :e",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":s": "FAILED",
                ":t": datetime.now(timezone.utc).isoformat(),
                ":e": str(e),
            },
        )
        print(f"[ERROR] job_id={job_id} failed: {e}")

    finally:
        # 8. Cleanup /tmp files
        for path in [tmp_path, tmp_output]:
            if os.path.exists(path):
                os.remove(path)
