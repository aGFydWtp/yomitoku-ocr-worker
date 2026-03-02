"""Tests for SQS message parsing in handler."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from index import extract_file_key, handler


class TestExtractFileKey:
    """extract_file_key: SQS レコードから S3 オブジェクトキーを取得する。"""

    def test_direct_s3_event(self):
        """S3 イベント通知が直接 SQS に入るケース。"""
        record = {
            "body": json.dumps(
                {
                    "Records": [
                        {
                            "s3": {
                                "bucket": {"name": "test-bucket"},
                                "object": {"key": "input/test.pdf"},
                            }
                        }
                    ]
                }
            )
        }
        assert extract_file_key(record) == "input/test.pdf"

    def test_sns_wrapped_s3_event(self):
        """S3 → SNS → SQS 経由のケース（Message フィールドにラップ）。"""
        s3_event = {
            "Records": [
                {
                    "s3": {
                        "bucket": {"name": "test-bucket"},
                        "object": {"key": "input/document.pdf"},
                    }
                }
            ]
        }
        record = {
            "body": json.dumps({"Message": json.dumps(s3_event)})
        }
        assert extract_file_key(record) == "input/document.pdf"

    def test_url_encoded_key(self):
        """S3 キーが URL エンコードされているケース。"""
        record = {
            "body": json.dumps(
                {
                    "Records": [
                        {
                            "s3": {
                                "bucket": {"name": "test-bucket"},
                                "object": {"key": "input/%E3%83%86%E3%82%B9%E3%83%88.pdf"},
                            }
                        }
                    ]
                }
            )
        }
        assert extract_file_key(record) == "input/テスト.pdf"

    def test_key_with_plus_as_space(self):
        """S3 キーで '+' がスペースに変換されるケース。"""
        record = {
            "body": json.dumps(
                {
                    "Records": [
                        {
                            "s3": {
                                "bucket": {"name": "test-bucket"},
                                "object": {"key": "input/my+file.pdf"},
                            }
                        }
                    ]
                }
            )
        }
        assert extract_file_key(record) == "input/my file.pdf"


class TestHandler:
    """handler: SQS イベントの各レコードを process_file に渡す。"""

    @patch("index.process_file", new_callable=AsyncMock)
    def test_calls_process_file_for_each_record(self, mock_process_file):
        """各レコードに対して process_file が呼ばれる。"""
        event = {
            "Records": [
                {
                    "body": json.dumps(
                        {
                            "Records": [
                                {
                                    "s3": {
                                        "bucket": {"name": "b"},
                                        "object": {"key": "input/a.pdf"},
                                    }
                                }
                            ]
                        }
                    )
                },
                {
                    "body": json.dumps(
                        {
                            "Records": [
                                {
                                    "s3": {
                                        "bucket": {"name": "b"},
                                        "object": {"key": "input/b.pdf"},
                                    }
                                }
                            ]
                        }
                    )
                },
            ]
        }
        handler(event, None)

        assert mock_process_file.call_count == 2
        mock_process_file.assert_any_call("input/a.pdf")
        mock_process_file.assert_any_call("input/b.pdf")

    @patch("index.process_file", new_callable=AsyncMock)
    def test_returns_batch_item_failures(self, mock_process_file):
        """process_file が例外を投げたレコードを batchItemFailures で返す。"""
        mock_process_file.side_effect = [None, RuntimeError("OCR failed")]
        event = {
            "Records": [
                {
                    "messageId": "msg-1",
                    "body": json.dumps(
                        {
                            "Records": [
                                {
                                    "s3": {
                                        "bucket": {"name": "b"},
                                        "object": {"key": "input/ok.pdf"},
                                    }
                                }
                            ]
                        }
                    ),
                },
                {
                    "messageId": "msg-2",
                    "body": json.dumps(
                        {
                            "Records": [
                                {
                                    "s3": {
                                        "bucket": {"name": "b"},
                                        "object": {"key": "input/fail.pdf"},
                                    }
                                }
                            ]
                        }
                    ),
                },
            ]
        }
        result = handler(event, None)

        assert result == {
            "batchItemFailures": [{"itemIdentifier": "msg-2"}]
        }

    @patch("index.process_file", new_callable=AsyncMock)
    def test_returns_empty_failures_on_success(self, mock_process_file):
        """全レコード成功時は空の batchItemFailures を返す。"""
        event = {
            "Records": [
                {
                    "messageId": "msg-1",
                    "body": json.dumps(
                        {
                            "Records": [
                                {
                                    "s3": {
                                        "bucket": {"name": "b"},
                                        "object": {"key": "input/ok.pdf"},
                                    }
                                }
                            ]
                        }
                    ),
                }
            ]
        }
        result = handler(event, None)
        assert result == {"batchItemFailures": []}
