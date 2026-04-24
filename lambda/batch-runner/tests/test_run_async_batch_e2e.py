"""run_async_batch の E2E smoke (Task 5.3)。

AsyncInvoker / runner を通貫してテストする。moto で S3 / SQS を立ち上げ、
sagemaker-runtime は ``botocore.stub.Stubber`` で ``invoke_endpoint_async``
のシグネチャのみを捕捉する。

検証ポイント (tasks.md Task 5.3):
1. 1 成功 + 1 失敗の混在バッチで ``process_log.jsonl`` が per-file で正しい
2. 別バッチ宛ての SQS メッセージが共通 Queue に混在しても誤消費しない
3. deadline 早期切り上げで ``in_flight_timeout`` と timeout ログ行が出る
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import boto3
import pytest
from botocore.stub import Stubber
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).parent.parent))

from async_invoker import AsyncInvoker  # noqa: E402
from runner import run_async_batch  # noqa: E402


REGION = "ap-northeast-1"
BUCKET = "yomitoku-bucket-e2e"
BATCH_JOB_ID = "batch-e2e-001"


def _sns_wrap(inner: dict) -> str:
    return json.dumps(
        {
            "Type": "Notification",
            "MessageId": "00000000-0000-0000-0000-000000000000",
            "TopicArn": "arn:aws:sns:ap-northeast-1:123456789012:AsyncSuccess",
            "Message": json.dumps(inner),
            "Timestamp": "2026-04-23T00:00:00.000Z",
        }
    )


def _success_body(batch_job_id: str, stem: str) -> dict:
    return {
        "awsRegion": REGION,
        "invocationStatus": "Completed",
        "requestParameters": {
            "endpointName": "yomitoku-async",
            "inputLocation": (
                f"s3://{BUCKET}/batches/_async/inputs/{batch_job_id}/{stem}.pdf"
            ),
        },
        "responseParameters": {
            "contentType": "application/json",
            "outputLocation": f"s3://{BUCKET}/batches/_async/outputs/{stem}.out",
        },
        "inferenceId": f"{batch_job_id}:{stem}",
    }


def _failure_body(batch_job_id: str, stem: str, reason: str) -> dict:
    return {
        "awsRegion": REGION,
        "invocationStatus": "Failed",
        "requestParameters": {
            "endpointName": "yomitoku-async",
            "inputLocation": (
                f"s3://{BUCKET}/batches/_async/inputs/{batch_job_id}/{stem}.pdf"
            ),
        },
        "failureLocation": f"s3://{BUCKET}/batches/_async/errors/{stem}.out",
        "failureReason": reason,
        "inferenceId": f"{batch_job_id}:{stem}",
    }


def _put_dummy_output(s3: Any, stem: str, payload: dict | None = None) -> None:
    body = json.dumps(payload or {"pages": [], "stem": stem}).encode("utf-8")
    s3.put_object(
        Bucket=BUCKET,
        Key=f"batches/_async/outputs/{stem}.out",
        Body=body,
        ContentType="application/json",
    )


def _settings(input_prefix: str = "batches/_async/inputs") -> SimpleNamespace:
    return SimpleNamespace(
        batch_job_id=BATCH_JOB_ID,
        bucket_name=BUCKET,
        batch_table_name="BatchTable",
        control_table_name="ControlTable",
        endpoint_name="yomitoku-async",
        success_queue_url="",  # 後で上書き
        failure_queue_url="",
        async_input_prefix=input_prefix,
        async_output_prefix="batches/_async/outputs",
        async_error_prefix="batches/_async/errors",
        async_max_concurrent=4,
        max_file_concurrency=2,
        max_page_concurrency=2,
        max_retries=3,
        read_timeout=60.0,
        circuit_threshold=5,
        circuit_cooldown=30.0,
        batch_max_duration_sec=7200,
        extra_formats=[],
    )


@pytest.fixture
def e2e_env(monkeypatch):
    """moto + Stubber を準備し、AsyncInvoker 内部 client を全て注入差し替えする。

    runner 側が ``from async_invoker import AsyncInvoker`` で取り込んでいる
    クラスを直接 monkeypatch することで、``run_async_batch`` から素直に
    生成される AsyncInvoker にもモック client が伝播する。
    """
    with mock_aws():
        s3 = boto3.client("s3", region_name=REGION)
        s3.create_bucket(
            Bucket=BUCKET,
            CreateBucketConfiguration={"LocationConstraint": REGION},
        )
        sqs = boto3.client("sqs", region_name=REGION)
        success_url = sqs.create_queue(QueueName="async-success-e2e")["QueueUrl"]
        failure_url = sqs.create_queue(QueueName="async-failure-e2e")["QueueUrl"]
        sagemaker = boto3.client("sagemaker-runtime", region_name=REGION)
        stubber = Stubber(sagemaker)

        original_init = AsyncInvoker.__init__

        def patched_init(self: AsyncInvoker, **kwargs: Any) -> None:
            kwargs.setdefault("sagemaker_client", sagemaker)
            kwargs.setdefault("sqs_client", sqs)
            kwargs.setdefault("s3_client", s3)
            kwargs.setdefault("poll_wait_seconds", 0)
            original_init(self, **kwargs)

        monkeypatch.setattr(AsyncInvoker, "__init__", patched_init)

        try:
            yield SimpleNamespace(
                s3=s3,
                sqs=sqs,
                sagemaker=sagemaker,
                stubber=stubber,
                success_url=success_url,
                failure_url=failure_url,
            )
        finally:
            stubber.deactivate()


def _write_pdf(input_dir: Path, stem: str) -> Path:
    p = input_dir / f"{stem}.pdf"
    p.write_bytes(b"%PDF-1.4\n%stub\n")
    return p


def _read_log(log_path: Path) -> list[dict]:
    if not log_path.exists():
        return []
    return [
        json.loads(line)
        for line in log_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def test_e2e_mixed_success_and_failure_produces_correct_process_log(
    e2e_env, tmp_path
):
    """1 成功 + 1 失敗の混在バッチで output と process_log.jsonl が per-file で揃う。"""
    settings = _settings()
    settings.success_queue_url = e2e_env.success_url
    settings.failure_queue_url = e2e_env.failure_url

    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    input_dir.mkdir()

    _write_pdf(input_dir, "ok")
    _write_pdf(input_dir, "bad")

    _put_dummy_output(e2e_env.s3, "ok", payload={"pages": [{"idx": 0}]})
    e2e_env.sqs.send_message(
        QueueUrl=e2e_env.success_url,
        MessageBody=_sns_wrap(_success_body(BATCH_JOB_ID, "ok")),
    )
    e2e_env.sqs.send_message(
        QueueUrl=e2e_env.failure_url,
        MessageBody=_sns_wrap(
            _failure_body(BATCH_JOB_ID, "bad", "ModelError: invalid PDF")
        ),
    )

    stubber = e2e_env.stubber
    for stem in ("bad", "ok"):
        # sorted() 順で invoke されるので bad → ok の順に expect
        stubber.add_response(
            "invoke_endpoint_async",
            {"InferenceId": f"{BATCH_JOB_ID}:{stem}", "OutputLocation": "s3://x/y"},
        )
    stubber.activate()

    log_path = output_dir / "process_log.jsonl"
    result = asyncio.run(
        run_async_batch(
            settings=settings,
            input_dir=input_dir,
            output_dir=output_dir,
            log_path=log_path,
            deadline_seconds=30.0,
        )
    )

    assert result.succeeded_files == ["ok"]
    assert len(result.failed_files) == 1
    fail_stem, fail_reason = result.failed_files[0]
    assert fail_stem == "bad"
    assert "ModelError" in fail_reason
    assert result.in_flight_timeout == []

    ok_json = output_dir / "ok.json"
    assert ok_json.exists()
    assert json.loads(ok_json.read_text()) == {"pages": [{"idx": 0}]}

    records = _read_log(log_path)
    by_stem = {Path(r["file_path"]).stem: r for r in records}
    assert by_stem["ok"]["success"] is True
    assert by_stem["ok"]["output_path"].endswith("ok.json")
    assert by_stem["bad"]["success"] is False
    assert "ModelError" in by_stem["bad"]["error"]
    stubber.assert_no_pending_responses()


def test_e2e_ignores_other_batch_messages_in_shared_queue(e2e_env, tmp_path):
    """共通 SuccessQueue に他バッチ分のメッセージが混在しても誤消費しない。"""
    settings = _settings()
    settings.success_queue_url = e2e_env.success_url
    settings.failure_queue_url = e2e_env.failure_url

    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    input_dir.mkdir()
    _write_pdf(input_dir, "ok")

    other_batch = "batch-e2e-999"
    _put_dummy_output(e2e_env.s3, "ok")
    e2e_env.sqs.send_message(
        QueueUrl=e2e_env.success_url,
        MessageBody=_sns_wrap(_success_body(BATCH_JOB_ID, "ok")),
    )
    e2e_env.sqs.send_message(
        QueueUrl=e2e_env.success_url,
        MessageBody=_sns_wrap(_success_body(other_batch, "other")),
    )

    stubber = e2e_env.stubber
    stubber.add_response(
        "invoke_endpoint_async",
        {"InferenceId": f"{BATCH_JOB_ID}:ok", "OutputLocation": "s3://x/y"},
    )
    stubber.activate()

    log_path = output_dir / "process_log.jsonl"
    result = asyncio.run(
        run_async_batch(
            settings=settings,
            input_dir=input_dir,
            output_dir=output_dir,
            log_path=log_path,
            deadline_seconds=30.0,
        )
    )

    assert result.succeeded_files == ["ok"]
    assert result.failed_files == []
    assert result.in_flight_timeout == []

    # 他バッチのメッセージは visibility=0 で戻っており再受信可能
    leftover = e2e_env.sqs.receive_message(
        QueueUrl=e2e_env.success_url,
        MaxNumberOfMessages=10,
        WaitTimeSeconds=0,
        VisibilityTimeout=0,
    ).get("Messages", [])
    inner = json.loads(json.loads(leftover[0]["Body"])["Message"])
    assert inner["inferenceId"] == f"{other_batch}:other"
    stubber.assert_no_pending_responses()


def test_e2e_deadline_break_records_timeout(e2e_env, tmp_path):
    """deadline 早期切り上げで ``in_flight_timeout`` と timeout ログ行が出る。"""
    settings = _settings()
    settings.success_queue_url = e2e_env.success_url
    settings.failure_queue_url = e2e_env.failure_url

    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    input_dir.mkdir()
    _write_pdf(input_dir, "slow")

    stubber = e2e_env.stubber
    stubber.add_response(
        "invoke_endpoint_async",
        {"InferenceId": f"{BATCH_JOB_ID}:slow", "OutputLocation": "s3://x/y"},
    )
    stubber.activate()

    log_path = output_dir / "process_log.jsonl"
    result = asyncio.run(
        run_async_batch(
            settings=settings,
            input_dir=input_dir,
            output_dir=output_dir,
            log_path=log_path,
            deadline_seconds=0.05,
        )
    )

    assert result.succeeded_files == []
    assert result.failed_files == []
    assert result.in_flight_timeout == ["slow"]

    records = _read_log(log_path)
    assert len(records) == 1
    rec = records[0]
    assert rec["success"] is False
    assert rec["output_path"] is None
    assert "timeout" in rec["error"].lower()
    stubber.assert_no_pending_responses()
