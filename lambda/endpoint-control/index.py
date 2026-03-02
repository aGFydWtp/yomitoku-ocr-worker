"""YomiToku-Pro endpoint control Lambda for Step Functions."""

from __future__ import annotations

import os
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

sagemaker = boto3.client("sagemaker")
sqs = boto3.client("sqs")
dynamodb = boto3.resource("dynamodb")

ENDPOINT_NAME = os.environ.get("ENDPOINT_NAME", "")
ENDPOINT_CONFIG_NAME = os.environ.get("ENDPOINT_CONFIG_NAME", "")
QUEUE_URL = os.environ.get("QUEUE_URL", "")
CONTROL_TABLE_NAME = os.environ.get("CONTROL_TABLE_NAME", "")
table = dynamodb.Table(CONTROL_TABLE_NAME)

ACTIONS = {
    "create_endpoint",
    "delete_endpoint",
    "check_endpoint_status",
    "check_queue_status",
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


def check_queue_status(event: dict) -> dict:
    """Check SQS queue for pending messages."""
    response = sqs.get_queue_attributes(
        QueueUrl=QUEUE_URL,
        AttributeNames=[
            "ApproximateNumberOfMessages",
            "ApproximateNumberOfMessagesNotVisible",
        ],
    )
    attrs = response["Attributes"]
    messages = int(attrs.get("ApproximateNumberOfMessages", "0"))
    not_visible = int(attrs.get("ApproximateNumberOfMessagesNotVisible", "0"))
    return {
        "messages": messages,
        "messages_not_visible": not_visible,
        "queue_empty": messages == 0 and not_visible == 0,
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
