"""AsyncInvoker (Task 3.x) のユニットテスト。

Task 3.1 (本ファイル初版):
    - S3 入力ステージング (`batches/_async/inputs/{batch_job_id}/{file}`)
    - `invoke_endpoint_async` 発行と `InferenceId` 生成 (`{batch_job_id}:{file_stem}`)
    - 4xx (ValidationException) の即時失敗・リトライなしパス

実メッセージ受信 (SQS long-poll / InferenceId filter / max_concurrent) や
BatchResult 集計は後続サブタスク (3.2 / 3.3 / 3.4) で追加する。

テスト用依存:
    - moto[s3] で S3 をモック
    - sagemaker-runtime は moto が未対応のため ``botocore.stub.Stubber`` で
      ``invoke_endpoint_async`` のレスポンスを捕捉する
"""

from __future__ import annotations

from pathlib import Path

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.stub import Stubber
from moto import mock_aws

from async_invoker import AsyncInvoker


REGION = "ap-northeast-1"
BUCKET = "yomitoku-bucket-test"
BATCH_JOB_ID = "batch-async-001"
INPUT_PREFIX = f"batches/_async/inputs/{BATCH_JOB_ID}/"


@pytest.fixture
def s3_bucket() -> str:
    """moto S3 バケットを立ち上げて返す。"""
    with mock_aws():
        s3 = boto3.client("s3", region_name=REGION)
        s3.create_bucket(
            Bucket=BUCKET,
            CreateBucketConfiguration={"LocationConstraint": REGION},
        )
        yield BUCKET


@pytest.fixture
def sagemaker_runtime_stub():
    """sagemaker-runtime クライアントと ``Stubber`` を提供する。

    moto は ``invoke_endpoint_async`` を十分サポートしないため、呼び出し単位の
    入出力検証は ``botocore.stub.Stubber`` で固定する。
    """
    client = boto3.client("sagemaker-runtime", region_name=REGION)
    stubber = Stubber(client)
    try:
        yield client, stubber
    finally:
        stubber.deactivate()


@pytest.fixture
def sqs_clients():
    """SuccessQueue / FailureQueue を moto 上に用意して URL を返す。"""
    with mock_aws():
        sqs = boto3.client("sqs", region_name=REGION)
        success_url = sqs.create_queue(QueueName="async-success")["QueueUrl"]
        failure_url = sqs.create_queue(QueueName="async-failure")["QueueUrl"]
        yield sqs, success_url, failure_url


def _write_input(tmp_path: Path, name: str) -> Path:
    p = tmp_path / name
    p.write_bytes(b"%PDF-1.4\n%stub\n")
    return p


def test_stage_input_puts_to_async_inputs_prefix(
    s3_bucket: str, tmp_path: Path
) -> None:
    """入力ファイルが ``batches/_async/inputs/{batch_job_id}/{file}`` に PUT される。"""
    src = _write_input(tmp_path, "sample.pdf")

    s3 = boto3.client("s3", region_name=REGION)
    invoker = AsyncInvoker(
        endpoint_name="yomitoku-async",
        input_bucket=BUCKET,
        input_prefix=INPUT_PREFIX,
        output_bucket=BUCKET,
        success_queue_url="https://sqs.invalid/success",
        failure_queue_url="https://sqs.invalid/failure",
        max_concurrent=2,
        s3_client=s3,
    )

    uri = invoker._stage_input(src)

    assert uri == f"s3://{BUCKET}/batches/_async/inputs/{BATCH_JOB_ID}/sample.pdf"
    head = s3.head_object(
        Bucket=BUCKET,
        Key=f"batches/_async/inputs/{BATCH_JOB_ID}/sample.pdf",
    )
    assert head["ContentLength"] == len(src.read_bytes())


def test_build_inference_id_uses_batch_job_id_and_file_stem() -> None:
    """InferenceId は ``{batch_job_id}:{file_stem}`` 形式で生成される。"""
    assert (
        AsyncInvoker._build_inference_id(BATCH_JOB_ID, "sample")
        == f"{BATCH_JOB_ID}:sample"
    )


def test_build_inference_id_rejects_over_64_chars() -> None:
    """SageMaker API の 64 文字上限を超える場合は ValueError を送出する。"""
    long_stem = "s" * 64
    with pytest.raises(ValueError, match="exceeds SageMaker max length"):
        AsyncInvoker._build_inference_id(BATCH_JOB_ID, long_stem)


def test_stage_input_rejects_name_with_slash(s3_bucket: str, tmp_path: Path) -> None:
    """``file_path.name`` に ``/`` を含む入力は prefix 逸脱として拒否する。"""
    # Path.name は通常 '/' を取り除くが、防御的検査を通すため直接構築する。
    s3 = boto3.client("s3", region_name=REGION)
    invoker = AsyncInvoker(
        endpoint_name="yomitoku-async",
        input_bucket=BUCKET,
        input_prefix=INPUT_PREFIX,
        output_bucket=BUCKET,
        success_queue_url="https://sqs.invalid/success",
        failure_queue_url="https://sqs.invalid/failure",
        max_concurrent=2,
        s3_client=s3,
    )

    class _FakePath:
        name = "../secret.pdf"

        def read_bytes(self) -> bytes:  # pragma: no cover - called only on success path
            return b""

    # '/' を含む name を `_stage_input` が拒否することを確認。
    # Path('../secret.pdf').name は 'secret.pdf' になるため、
    # 本ガードの狙いはその後段 (未知の name 操作) で '/' が混入したケース。
    bad = _FakePath()
    bad.name = "other-job/payload.pdf"
    with pytest.raises(ValueError, match="escapes input_prefix"):
        invoker._stage_input(bad)  # type: ignore[arg-type]


def test_invoke_async_issues_sagemaker_call_with_inference_id(
    sagemaker_runtime_stub, tmp_path: Path
) -> None:
    """``invoke_endpoint_async`` に InputLocation と InferenceId が正しく渡る。"""
    client, stubber = sagemaker_runtime_stub

    input_location = (
        f"s3://{BUCKET}/batches/_async/inputs/{BATCH_JOB_ID}/sample.pdf"
    )
    expected_request = {
        "EndpointName": "yomitoku-async",
        "InputLocation": input_location,
        "InferenceId": f"{BATCH_JOB_ID}:sample",
        "ContentType": "application/pdf",
    }
    stubber.add_response(
        "invoke_endpoint_async",
        {"InferenceId": f"{BATCH_JOB_ID}:sample", "OutputLocation": "s3://.../.out"},
        expected_request,
    )
    stubber.activate()

    invoker = AsyncInvoker(
        endpoint_name="yomitoku-async",
        input_bucket=BUCKET,
        input_prefix=INPUT_PREFIX,
        output_bucket=BUCKET,
        success_queue_url="https://sqs.invalid/success",
        failure_queue_url="https://sqs.invalid/failure",
        max_concurrent=2,
        sagemaker_client=client,
    )

    invoker._invoke_async(
        inference_id=f"{BATCH_JOB_ID}:sample",
        input_location=input_location,
        content_type="application/pdf",
    )

    stubber.assert_no_pending_responses()


def test_invoke_async_4xx_validation_exception_is_immediate_failure(
    sagemaker_runtime_stub,
) -> None:
    """``ValidationException`` は即時失敗として ClientError を再送出し、リトライしない。"""
    client, stubber = sagemaker_runtime_stub

    stubber.add_client_error(
        "invoke_endpoint_async",
        service_error_code="ValidationException",
        service_message="Model not found",
        http_status_code=400,
        expected_params={
            "EndpointName": "yomitoku-async",
            "InputLocation": (
                f"s3://{BUCKET}/batches/_async/inputs/{BATCH_JOB_ID}/bad.pdf"
            ),
            "InferenceId": f"{BATCH_JOB_ID}:bad",
            "ContentType": "application/pdf",
        },
    )
    stubber.activate()

    invoker = AsyncInvoker(
        endpoint_name="yomitoku-async",
        input_bucket=BUCKET,
        input_prefix=INPUT_PREFIX,
        output_bucket=BUCKET,
        success_queue_url="https://sqs.invalid/success",
        failure_queue_url="https://sqs.invalid/failure",
        max_concurrent=2,
        sagemaker_client=client,
    )

    with pytest.raises(ClientError) as exc_info:
        invoker._invoke_async(
            inference_id=f"{BATCH_JOB_ID}:bad",
            input_location=(
                f"s3://{BUCKET}/batches/_async/inputs/{BATCH_JOB_ID}/bad.pdf"
            ),
            content_type="application/pdf",
        )

    assert exc_info.value.response["Error"]["Code"] == "ValidationException"
    # スタブに次のレスポンスを登録していないので、リトライが起きた場合は
    # StubResponseError が送出される。ここを通過できれば再試行なしを担保する。
    stubber.assert_no_pending_responses()
