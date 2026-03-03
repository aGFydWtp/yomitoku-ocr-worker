"""Tests for process_file: OCR processing logic."""

from __future__ import annotations

import json
import os
from unittest.mock import AsyncMock, MagicMock, call, patch

import boto3
import pytest
from moto import mock_aws

# Environment variables must be set before importing index
os.environ.setdefault("ENDPOINT_NAME", "test-endpoint")
os.environ.setdefault("BUCKET_NAME", "test-bucket")
os.environ.setdefault("STATUS_TABLE_NAME", "test-status-table")
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-1")


BUCKET_NAME = "test-bucket"
TABLE_NAME = "test-status-table"
JOB_ID = "550e8400-e29b-41d4-a716-446655440000"
FILE_KEY = f"input/{JOB_ID}/sample.pdf"


@pytest.fixture
def aws_setup(tmp_path):
    """moto で S3 バケットと DynamoDB テーブルを作成する。"""
    with mock_aws():
        region = "ap-northeast-1"

        # S3
        s3 = boto3.client("s3", region_name=region)
        s3.create_bucket(
            Bucket=BUCKET_NAME,
            CreateBucketConfiguration={"LocationConstraint": region},
        )
        s3.put_object(Bucket=BUCKET_NAME, Key=FILE_KEY, Body=b"%PDF-1.4 fake")

        # DynamoDB
        dynamodb = boto3.resource("dynamodb", region_name=region)
        table = dynamodb.create_table(
            TableName=TABLE_NAME,
            KeySchema=[{"AttributeName": "job_id", "KeyType": "HASH"}],
            AttributeDefinitions=[
                {"AttributeName": "job_id", "AttributeType": "S"}
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        table.put_item(
            Item={
                "job_id": JOB_ID,
                "file_key": FILE_KEY,
                "status": "PENDING",
                "created_at": "2026-01-01T00:00:00",
            }
        )

        # Patch module-level clients in index
        import index

        index.s3 = s3
        index.dynamodb = dynamodb
        index.table = dynamodb.Table(TABLE_NAME)
        index.BUCKET_NAME = BUCKET_NAME
        index.STATUS_TABLE = TABLE_NAME

        yield {
            "s3": s3,
            "dynamodb": dynamodb,
            "table": table,
        }


class TestExtractJobId:
    """extract_job_id: S3 キーから job_id (UUID) を抽出する。"""

    def test_extracts_uuid_from_standard_key(self):
        """input/{uuid}/{filename} から UUID を抽出する。"""
        from index import extract_job_id

        assert extract_job_id(f"input/{JOB_ID}/sample.pdf") == JOB_ID

    def test_extracts_uuid_from_japanese_filename(self):
        """日本語ファイル名でも UUID が正しく抽出される。"""
        from index import extract_job_id

        assert extract_job_id(f"input/{JOB_ID}/請求書.pdf") == JOB_ID

    def test_extracts_uuid_from_nested_path(self):
        """パスに追加のセグメントがあっても2番目を抽出する。"""
        from index import extract_job_id

        assert extract_job_id(f"input/{JOB_ID}/sub/file.pdf") == JOB_ID

    def test_raises_on_flat_key(self):
        """スラッシュなしのキーで ValueError が発生する。"""
        from index import extract_job_id

        with pytest.raises(ValueError, match="Unexpected S3 key format"):
            extract_job_id("file.pdf")

    def test_raises_on_legacy_two_segment_key(self):
        """旧形式 input/file.pdf で ValueError が発生する。"""
        from index import extract_job_id

        with pytest.raises(ValueError, match="Unexpected S3 key format"):
            extract_job_id("input/file.pdf")

    def test_raises_on_empty_string(self):
        """空文字で ValueError が発生する。"""
        from index import extract_job_id

        with pytest.raises(ValueError, match="Unexpected S3 key format"):
            extract_job_id("")


def _to_json_side_effect(path, **kwargs):
    """to_json のモック: 実際にファイルを書き出す。"""
    with open(path, "w") as f:
        f.write('{"pages": {}}')


def _mock_yomitoku(mock_client_cls):
    """YomitokuClient のモックを構成する共通ヘルパー。"""
    mock_parsed = MagicMock()
    mock_parsed.to_json = MagicMock(side_effect=_to_json_side_effect)

    mock_instance = AsyncMock()
    mock_instance.analyze_async = AsyncMock(return_value={"pages": {}})
    mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
    mock_instance.__aexit__ = AsyncMock(return_value=False)
    mock_client_cls.return_value = mock_instance

    return mock_instance, mock_parsed


class TestProcessFileIdempotency:
    """DynamoDB 条件付き更新による冪等性テスト。"""

    @pytest.mark.asyncio
    async def test_pending_to_processing_succeeds(self, aws_setup):
        """PENDING → PROCESSING → COMPLETED への遷移が成功する。"""
        from index import process_file

        with (
            patch("index.YomitokuClient") as MockClient,
            patch("index.parse_pydantic_model") as mock_parse,
        ):
            mock_instance, mock_parsed = _mock_yomitoku(MockClient)
            mock_parse.return_value = mock_parsed

            await process_file(FILE_KEY)

        # COMPLETED に遷移していること
        item = aws_setup["table"].get_item(Key={"job_id": JOB_ID})["Item"]
        assert item["status"] == "COMPLETED"
        assert "output_key" in item
        assert "processing_time_ms" in item

    @pytest.mark.asyncio
    async def test_duplicate_processing_is_skipped(self, aws_setup):
        """既に PROCESSING のレコードは ConditionalCheckFailedException でスキップ。"""
        from index import process_file

        # ステータスを PROCESSING に変更
        aws_setup["table"].update_item(
            Key={"job_id": JOB_ID},
            UpdateExpression="SET #s = :s",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": "PROCESSING"},
        )

        # process_file はスキップして正常終了する（例外なし）
        await process_file(FILE_KEY)

        # ステータスは PROCESSING のまま
        item = aws_setup["table"].get_item(Key={"job_id": JOB_ID})["Item"]
        assert item["status"] == "PROCESSING"

    @pytest.mark.asyncio
    async def test_completed_record_is_skipped(self, aws_setup):
        """既に COMPLETED のレコードもスキップされる。"""
        from index import process_file

        aws_setup["table"].update_item(
            Key={"job_id": JOB_ID},
            UpdateExpression="SET #s = :s",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": "COMPLETED"},
        )

        await process_file(FILE_KEY)

        item = aws_setup["table"].get_item(Key={"job_id": JOB_ID})["Item"]
        assert item["status"] == "COMPLETED"


class TestProcessFileS3Operations:
    """S3 ダウンロード・アップロードのテスト。"""

    @pytest.mark.asyncio
    async def test_downloads_from_input_and_uploads_to_output(self, aws_setup):
        """input/ からダウンロードし、output/ に JSON をアップロードする。"""
        from index import process_file

        with (
            patch("index.YomitokuClient") as MockClient,
            patch("index.parse_pydantic_model") as mock_parse,
        ):
            mock_instance, mock_parsed = _mock_yomitoku(MockClient)
            mock_parse.return_value = mock_parsed

            await process_file(FILE_KEY)

        # output/ に JSON が保存されていること
        output_key = f"output/{JOB_ID}/sample.json"
        response = aws_setup["s3"].get_object(Bucket=BUCKET_NAME, Key=output_key)
        body = response["Body"].read().decode()
        assert len(body) > 0


class TestProcessFileYomitokuClient:
    """yomitoku-client 呼び出しのテスト。"""

    @pytest.mark.asyncio
    async def test_calls_analyze_async_with_tmp_path(self, aws_setup):
        """analyze_async が /tmp のパスで呼ばれる。"""
        from index import process_file

        with (
            patch("index.YomitokuClient") as MockClient,
            patch("index.parse_pydantic_model") as mock_parse,
        ):
            mock_instance, mock_parsed = _mock_yomitoku(MockClient)
            mock_parse.return_value = mock_parsed

            await process_file(FILE_KEY)

        mock_instance.analyze_async.assert_called_once_with("/tmp/sample.pdf")

    @pytest.mark.asyncio
    async def test_ocr_failure_sets_status_to_failed(self, aws_setup):
        """OCR 処理が失敗したら FAILED に更新し、例外を再送出する。"""
        from index import process_file

        with patch("index.YomitokuClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.analyze_async = AsyncMock(
                side_effect=RuntimeError("SageMaker timeout")
            )
            mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
            mock_instance.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_instance

            with pytest.raises(RuntimeError, match="SageMaker timeout"):
                await process_file(FILE_KEY)

        item = aws_setup["table"].get_item(Key={"job_id": JOB_ID})["Item"]
        assert item["status"] == "FAILED"
        assert "SageMaker timeout" in item["error_message"]


class TestProcessFileTmpCleanup:
    """/tmp ファイルの後始末テスト。"""

    @pytest.mark.asyncio
    async def test_tmp_files_cleaned_on_success(self, aws_setup):
        """正常終了時に /tmp ファイルが削除される。"""
        from index import process_file

        with (
            patch("index.YomitokuClient") as MockClient,
            patch("index.parse_pydantic_model") as mock_parse,
        ):
            mock_instance, mock_parsed = _mock_yomitoku(MockClient)
            mock_parse.return_value = mock_parsed

            await process_file(FILE_KEY)

        # 正常終了後、/tmp にファイルが残っていないこと
        assert not os.path.exists("/tmp/sample.pdf")
        assert not os.path.exists("/tmp/sample.json")

    @pytest.mark.asyncio
    async def test_tmp_files_cleaned_on_failure(self, aws_setup):
        """異常終了時でも /tmp ファイルが削除される。"""
        from index import process_file

        with patch("index.YomitokuClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.analyze_async = AsyncMock(
                side_effect=RuntimeError("fail")
            )
            mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
            mock_instance.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_instance

            with pytest.raises(RuntimeError):
                await process_file(FILE_KEY)

        # 異常終了後でも /tmp にファイルが残っていないこと
        assert not os.path.exists("/tmp/sample.pdf")
