"""Tests for endpoint-control Lambda."""

from __future__ import annotations

from unittest.mock import MagicMock

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

REGION = "ap-northeast-1"
TABLE_NAME = "test-control-table"


@pytest.fixture
def dynamodb_setup():
    """moto で DynamoDB テーブルを作成する。"""
    with mock_aws():
        dynamodb = boto3.resource("dynamodb", region_name=REGION)
        table = dynamodb.create_table(
            TableName=TABLE_NAME,
            KeySchema=[{"AttributeName": "lock_key", "KeyType": "HASH"}],
            AttributeDefinitions=[
                {"AttributeName": "lock_key", "AttributeType": "S"}
            ],
            BillingMode="PAY_PER_REQUEST",
        )

        import index

        index.dynamodb = dynamodb
        index.table = dynamodb.Table(TABLE_NAME)

        yield {"dynamodb": dynamodb, "table": table}


@pytest.fixture
def sqs_setup():
    """moto で SQS キューを作成する。"""
    with mock_aws():
        sqs = boto3.client("sqs", region_name=REGION)
        response = sqs.create_queue(QueueName="test-queue")
        queue_url = response["QueueUrl"]

        import index

        index.sqs = sqs
        index.QUEUE_URL = queue_url

        yield {"sqs": sqs, "queue_url": queue_url}


@pytest.fixture
def mock_sagemaker():
    """SageMaker クライアントをモックする。"""
    mock_client = MagicMock()

    import index

    original = index.sagemaker
    index.sagemaker = mock_client
    yield mock_client
    index.sagemaker = original


# --- handler routing ---


class TestHandlerRouting:
    """handler: action に応じた関数にルーティングする。"""

    def test_raises_on_missing_action(self):
        from index import handler

        with pytest.raises(ValueError, match="Missing 'action'"):
            handler({}, None)

    def test_raises_on_unknown_action(self):
        from index import handler

        with pytest.raises(ValueError, match="Unknown action"):
            handler({"action": "unknown_action"}, None)

    def test_routes_to_acquire_lock(self, dynamodb_setup):
        from index import handler

        result = handler(
            {"action": "acquire_lock", "execution_id": "test-123"}, None
        )
        assert result["lock_acquired"] is True


# --- create_endpoint ---


class TestCreateEndpoint:
    """create_endpoint: SageMaker CreateEndpoint API を呼び出す。"""

    def test_calls_sagemaker_create_endpoint(self, dynamodb_setup, mock_sagemaker):
        from index import create_endpoint

        result = create_endpoint({})

        mock_sagemaker.create_endpoint.assert_called_once_with(
            EndpointName="test-endpoint",
            EndpointConfigName="test-config",
        )
        assert result["endpoint_status"] == "Creating"

    def test_updates_state_to_creating(self, dynamodb_setup, mock_sagemaker):
        from index import create_endpoint

        create_endpoint({})

        item = dynamodb_setup["table"].get_item(
            Key={"lock_key": "endpoint_control"}
        )["Item"]
        assert item["endpoint_state"] == "CREATING"


# --- delete_endpoint ---


class TestDeleteEndpoint:
    """delete_endpoint: SageMaker DeleteEndpoint API を呼び出す。"""

    def test_calls_sagemaker_delete_endpoint(self, dynamodb_setup, mock_sagemaker):
        from index import delete_endpoint

        result = delete_endpoint({})

        mock_sagemaker.delete_endpoint.assert_called_once_with(
            EndpointName="test-endpoint",
        )
        assert result["endpoint_status"] == "Deleting"

    def test_updates_state_to_deleting(self, dynamodb_setup, mock_sagemaker):
        from index import delete_endpoint

        delete_endpoint({})

        item = dynamodb_setup["table"].get_item(
            Key={"lock_key": "endpoint_control"}
        )["Item"]
        assert item["endpoint_state"] == "DELETING"


# --- check_endpoint_status ---


class TestCheckEndpointStatus:
    """check_endpoint_status: DescribeEndpoint API でステータスを返す。"""

    def test_returns_in_service(self, dynamodb_setup, mock_sagemaker):
        from index import check_endpoint_status

        mock_sagemaker.describe_endpoint.return_value = {
            "EndpointStatus": "InService"
        }

        result = check_endpoint_status({})
        assert result["endpoint_status"] == "InService"

    def test_returns_creating(self, dynamodb_setup, mock_sagemaker):
        from index import check_endpoint_status

        mock_sagemaker.describe_endpoint.return_value = {
            "EndpointStatus": "Creating"
        }

        result = check_endpoint_status({})
        assert result["endpoint_status"] == "Creating"

    def test_returns_not_found_on_missing_endpoint(self, mock_sagemaker):
        from index import check_endpoint_status

        mock_sagemaker.describe_endpoint.side_effect = ClientError(
            {
                "Error": {
                    "Code": "ValidationException",
                    "Message": "Could not find endpoint 'test-endpoint'",
                }
            },
            "DescribeEndpoint",
        )

        result = check_endpoint_status({})
        assert result["endpoint_status"] == "NOT_FOUND"

    def test_updates_state_on_in_service(self, dynamodb_setup, mock_sagemaker):
        from index import check_endpoint_status

        mock_sagemaker.describe_endpoint.return_value = {
            "EndpointStatus": "InService"
        }

        check_endpoint_status({})

        item = dynamodb_setup["table"].get_item(
            Key={"lock_key": "endpoint_control"}
        )["Item"]
        assert item["endpoint_state"] == "IN_SERVICE"

    def test_reraises_unexpected_error(self, mock_sagemaker):
        from index import check_endpoint_status

        mock_sagemaker.describe_endpoint.side_effect = ClientError(
            {
                "Error": {
                    "Code": "InternalError",
                    "Message": "Something went wrong",
                }
            },
            "DescribeEndpoint",
        )

        with pytest.raises(ClientError):
            check_endpoint_status({})


# --- check_queue_status ---


class TestCheckQueueStatus:
    """check_queue_status: SQS キューのメッセージ数を返す。"""

    def test_empty_queue(self, sqs_setup):
        from index import check_queue_status

        result = check_queue_status({})

        assert result["messages"] == 0
        assert result["messages_not_visible"] == 0
        assert result["queue_empty"] is True

    def test_queue_with_messages(self, sqs_setup):
        from index import check_queue_status

        # メッセージを投入
        sqs_setup["sqs"].send_message(
            QueueUrl=sqs_setup["queue_url"], MessageBody="test"
        )

        result = check_queue_status({})

        assert result["messages"] >= 1
        assert result["queue_empty"] is False


# --- acquire_lock ---


class TestAcquireLock:
    """acquire_lock: DynamoDB 条件付き更新でロックを取得する。"""

    def test_succeeds_on_new_item(self, dynamodb_setup):
        """アイテムが存在しない場合（attribute_not_exists）にロック取得成功。"""
        from index import acquire_lock

        result = acquire_lock({"execution_id": "exec-001"})

        assert result["lock_acquired"] is True
        item = dynamodb_setup["table"].get_item(
            Key={"lock_key": "endpoint_control"}
        )["Item"]
        assert item["endpoint_state"] == "CREATING"
        assert item["execution_id"] == "exec-001"

    def test_succeeds_on_idle_state(self, dynamodb_setup):
        """endpoint_state が IDLE の場合にロック取得成功。"""
        from index import acquire_lock

        dynamodb_setup["table"].put_item(
            Item={"lock_key": "endpoint_control", "endpoint_state": "IDLE"}
        )

        result = acquire_lock({"execution_id": "exec-002"})

        assert result["lock_acquired"] is True

    def test_fails_when_already_locked(self, dynamodb_setup):
        """endpoint_state が CREATING の場合にロック取得失敗。"""
        from index import acquire_lock

        dynamodb_setup["table"].put_item(
            Item={
                "lock_key": "endpoint_control",
                "endpoint_state": "CREATING",
                "execution_id": "exec-other",
            }
        )

        result = acquire_lock({"execution_id": "exec-003"})

        assert result["lock_acquired"] is False

    def test_fails_when_in_service(self, dynamodb_setup):
        """endpoint_state が IN_SERVICE の場合にもロック取得失敗。"""
        from index import acquire_lock

        dynamodb_setup["table"].put_item(
            Item={
                "lock_key": "endpoint_control",
                "endpoint_state": "IN_SERVICE",
            }
        )

        result = acquire_lock({"execution_id": "exec-004"})

        assert result["lock_acquired"] is False


# --- release_lock ---


class TestReleaseLock:
    """release_lock: ロックを解放し IDLE に戻す。"""

    def test_sets_state_to_idle(self, dynamodb_setup):
        from index import release_lock

        dynamodb_setup["table"].put_item(
            Item={
                "lock_key": "endpoint_control",
                "endpoint_state": "IN_SERVICE",
            }
        )

        result = release_lock({})

        assert result["lock_released"] is True
        item = dynamodb_setup["table"].get_item(
            Key={"lock_key": "endpoint_control"}
        )["Item"]
        assert item["endpoint_state"] == "IDLE"
        assert "updated_at" in item
