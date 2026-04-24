"""Task 1.3 dummy fixture smoke test.

Async 移行で追加する moto extras (sns/sqs) と boto3 クライアントが
テスト環境から正しく import/起動できることを確認する。

観測可能条件:
    ``pytest lambda/batch-runner/tests -k dummy_fixture``
    がフィクスチャ読み込み OK で collection 成功し、実行も green になる。

本ファイルは Task 3 系の AsyncInvoker テストに先立つ pre-flight であり、
実際のロジックテストは別ファイル (例: ``test_async_invoker.py``) で記述する。
"""

from __future__ import annotations

import boto3
import pytest
from moto import mock_aws


@pytest.fixture
def dummy_sns_sqs_fixture() -> dict[str, str]:
    """moto で SNS Topic → SQS Queue サブスクリプションを 1 本張るだけの pre-flight。"""
    with mock_aws():
        sns = boto3.client("sns", region_name="ap-northeast-1")
        sqs = boto3.client("sqs", region_name="ap-northeast-1")

        topic_arn = sns.create_topic(Name="async-success")["TopicArn"]
        queue = sqs.create_queue(QueueName="async-success-queue")
        queue_url = queue["QueueUrl"]
        queue_arn = sqs.get_queue_attributes(
            QueueUrl=queue_url, AttributeNames=["QueueArn"]
        )["Attributes"]["QueueArn"]

        sns.subscribe(TopicArn=topic_arn, Protocol="sqs", Endpoint=queue_arn)

        yield {
            "topic_arn": topic_arn,
            "queue_url": queue_url,
            "queue_arn": queue_arn,
        }


def test_dummy_fixture_imports(dummy_sns_sqs_fixture: dict[str, str]) -> None:
    """Extras が揃っていることを最低限確認する。"""
    assert dummy_sns_sqs_fixture["topic_arn"].startswith("arn:aws:sns:")
    assert dummy_sns_sqs_fixture["queue_arn"].startswith("arn:aws:sqs:")
    assert "/async-success-queue" in dummy_sns_sqs_fixture["queue_url"]
