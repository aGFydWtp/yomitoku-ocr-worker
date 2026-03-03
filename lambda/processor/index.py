"""YomiToku-Pro OCR processing worker Lambda."""

from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime, timezone
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


def extract_job_id(file_key: str) -> str:
    """Extract job_id (UUID) from S3 key: input/{job_id}/{filename}."""
    parts = file_key.split("/")
    if len(parts) < 3 or parts[0] != "input" or not parts[1]:
        raise ValueError(f"Unexpected S3 key format, cannot extract job_id: {file_key!r}")
    return parts[1]


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

        # 5. Update DynamoDB: COMPLETED
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

    except Exception as e:
        # 6. Update DynamoDB: FAILED and re-raise for SQS retry
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
        raise

    finally:
        # 7. Cleanup /tmp files
        for path in [tmp_path, tmp_output]:
            if os.path.exists(path):
                os.remove(path)
