"""YomiToku-Pro endpoint control Lambda for Step Functions.

Task 4.3 以降は旧 SQS 深度チェック (``check_queue_status``) を廃止し、
ControlTable の ``ACTIVE#COUNT`` カウンタを参照する
``check_batch_in_flight`` を提供する。バッチランナー側の
``lambda/batch-runner/control_table.py`` が ``TransactWriteItems`` で
カウンタをアトミックに増減させているため、GetItem 単発でアイドル判定できる。
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

sagemaker = boto3.client("sagemaker")
dynamodb = boto3.resource("dynamodb")

ENDPOINT_NAME = os.environ.get("ENDPOINT_NAME", "")
ENDPOINT_CONFIG_NAME = os.environ.get("ENDPOINT_CONFIG_NAME", "")
CONTROL_TABLE_NAME = os.environ.get("CONTROL_TABLE_NAME", "")
table = dynamodb.Table(CONTROL_TABLE_NAME)

# ``lambda/batch-runner/control_table.py`` と一致する lock_key
ACTIVE_COUNT_KEY = "ACTIVE#COUNT"

ACTIONS = {
    "create_endpoint",
    "delete_endpoint",
    "check_endpoint_status",
    "check_batch_in_flight",
    "acquire_lock",
    "release_lock",
}


def handler(event: dict, context: object) -> dict:
    """Route to the appropriate action handler."""
    action = event.get("action")
    if action is None:
        raise ValueError("Missing 'action' in event")
    if action not in ACTIONS:
        raise ValueError(f"Unknown action: {action}")

    fn = globals()[action]
    return fn(event)


def create_endpoint(event: dict) -> dict:
    """Create SageMaker endpoint."""
    sagemaker.create_endpoint(
        EndpointName=ENDPOINT_NAME,
        EndpointConfigName=ENDPOINT_CONFIG_NAME,
    )
    _update_endpoint_state("CREATING")
    return {"endpoint_status": "Creating"}


def delete_endpoint(event: dict) -> dict:
    """Delete SageMaker endpoint."""
    sagemaker.delete_endpoint(EndpointName=ENDPOINT_NAME)
    _update_endpoint_state("DELETING")
    return {"endpoint_status": "Deleting"}


def check_endpoint_status(event: dict) -> dict:
    """Check SageMaker endpoint status."""
    try:
        response = sagemaker.describe_endpoint(EndpointName=ENDPOINT_NAME)
        status = response["EndpointStatus"]
        if status == "InService":
            _update_endpoint_state("IN_SERVICE")
        return {"endpoint_status": status}
    except ClientError as e:
        if "Could not find endpoint" in e.response["Error"].get("Message", ""):
            return {"endpoint_status": "NOT_FOUND"}
        raise


def check_batch_in_flight(event: dict) -> dict:
    """Check concurrent batch count via ControlTable ``ACTIVE#COUNT``.

    バッチランナーが ``register_heartbeat`` / ``delete_heartbeat`` で
    トランザクション更新しているカウンタを GetItem で参照し、
    in-flight バッチが 0 件かどうかを返す。
    """
    response = table.get_item(Key={"lock_key": ACTIVE_COUNT_KEY})
    item = response.get("Item") or {}
    raw = item.get("count", 0)
    # DynamoDB resource layer returns ``Decimal`` for numeric attributes;
    # cast to ``int`` so downstream Step Functions Choices can compare directly.
    count = int(raw) if raw is not None else 0
    return {
        "in_flight_count": count,
        "in_flight": count > 0,
    }


def acquire_lock(event: dict) -> dict:
    """Acquire exclusive lock for endpoint control."""
    execution_id = event.get("execution_id", "")
    now = datetime.now(timezone.utc).isoformat()
    try:
        table.update_item(
            Key={"lock_key": "endpoint_control"},
            UpdateExpression=(
                "SET endpoint_state = :creating, "
                "updated_at = :t, "
                "execution_id = :e"
            ),
            ConditionExpression=(
                "endpoint_state = :idle "
                "OR attribute_not_exists(endpoint_state)"
            ),
            ExpressionAttributeValues={
                ":creating": "CREATING",
                ":idle": "IDLE",
                ":t": now,
                ":e": execution_id,
            },
        )
        return {"lock_acquired": True}
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return {"lock_acquired": False}
        raise


def release_lock(event: dict) -> dict:
    """Release exclusive lock for endpoint control."""
    now = datetime.now(timezone.utc).isoformat()
    table.update_item(
        Key={"lock_key": "endpoint_control"},
        UpdateExpression="SET endpoint_state = :idle, updated_at = :t",
        ExpressionAttributeValues={
            ":idle": "IDLE",
            ":t": now,
        },
    )
    return {"lock_released": True}


def _update_endpoint_state(state: str) -> None:
    """Update endpoint state in DynamoDB."""
    now = datetime.now(timezone.utc).isoformat()
    table.update_item(
        Key={"lock_key": "endpoint_control"},
        UpdateExpression="SET endpoint_state = :s, updated_at = :t",
        ExpressionAttributeValues={
            ":s": state,
            ":t": now,
        },
    )
