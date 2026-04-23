"""AsyncInvoker (Task 3.x) のユニットテスト。

Task 3.1 (本ファイル初版):
    - S3 入力ステージング (`batches/_async/inputs/{batch_job_id}/{file}`)
    - `invoke_endpoint_async` 発行と `InferenceId` 生成 (`{batch_job_id}:{file_stem}`)
    - 4xx (ValidationException) の即時失敗・リトライなしパス

Task 3.2 追補:
    - SNS ラップ / Raw の両形式に対応した通知メッセージのアンラップ
    - `InferenceId` による in-flight セットへのフィルタ
    - 自バッチ宛ては DeleteMessage、他バッチ宛ては ChangeMessageVisibility=0

Task 3.3 追補:
    - `max_concurrent` 背圧 (`_poll_queue` に渡る in-flight 集合が上限を超えない)
    - `BatchResult` (succeeded / failed / in_flight_timeout) の集計
    - deadline 超過で未完了 InferenceId が `in_flight_timeout` に落ちる
    - 同期 4xx ClientError を即時 `failed_files` へ積む

Task 3.4 追補 (``run_batch`` 統合シナリオ):
    - Async Endpoint 側タイムアウト (ErrorTopic 経由) の ``failureReason``
      記録パス
    - SQS at-least-once 重複配信 (同一 `InferenceId` が 2 度届く) の
      idempotent 処理
    - 2 バッチ分のメッセージが共通 SuccessQueue に混在した場合の
      自バッチ限定処理 (他バッチは ``ChangeMessageVisibility=0`` で返却)

テスト用依存:
    - moto[s3,sqs] で S3 / SQS をモック
    - sagemaker-runtime は moto が未対応のため ``botocore.stub.Stubber`` で
      ``invoke_endpoint_async`` のレスポンスを捕捉する
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.stub import Stubber
from moto import mock_aws

from async_invoker import AsyncInvoker, BatchResult, PolledNotification


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
def sqs_env():
    """SuccessQueue / FailureQueue を moto 上に用意し、AsyncInvoker と SQS クライアントを返す。"""
    with mock_aws():
        sqs = boto3.client("sqs", region_name=REGION)
        success_url = sqs.create_queue(QueueName="async-success")["QueueUrl"]
        failure_url = sqs.create_queue(QueueName="async-failure")["QueueUrl"]
        invoker = AsyncInvoker(
            endpoint_name="yomitoku-async",
            input_bucket=BUCKET,
            input_prefix=INPUT_PREFIX,
            output_bucket=BUCKET,
            success_queue_url=success_url,
            failure_queue_url=failure_url,
            max_concurrent=2,
            poll_wait_seconds=0,  # moto では long-poll を短縮
            sqs_client=sqs,
        )
        yield invoker, sqs, success_url, failure_url


def _sns_wrap(inner: dict) -> str:
    """SNS → SQS (Raw Message Delivery OFF) で配送されるメッセージ形式。"""
    return json.dumps(
        {
            "Type": "Notification",
            "MessageId": "00000000-0000-0000-0000-000000000000",
            "TopicArn": "arn:aws:sns:ap-northeast-1:123456789012:AsyncSuccess",
            "Message": json.dumps(inner),
            "Timestamp": "2026-04-23T00:00:00.000Z",
        }
    )


def _success_body(inference_id: str) -> dict:
    # outputLocation は stem 単位で別 URI にして、テストでダミー JSON を
    # 事前配置した S3 オブジェクトを指せるようにする。
    stem = inference_id.split(":")[-1]
    return {
        "awsRegion": REGION,
        "invocationStatus": "Completed",
        "requestParameters": {
            "endpointName": "yomitoku-async",
            "inputLocation": (
                f"s3://{BUCKET}/batches/_async/inputs/{BATCH_JOB_ID}/{stem}.pdf"
            ),
        },
        "responseParameters": {
            "contentType": "application/json",
            "outputLocation": f"s3://{BUCKET}/batches/_async/outputs/{stem}.out",
        },
        "inferenceId": inference_id,
    }


def _put_dummy_output(s3: Any, stem: str, payload: dict | None = None) -> None:
    """Async 成功時の OutputLocation に相当するダミー JSON を S3 に配置する。"""
    body = json.dumps(payload or {"pages": [], "stem": stem}).encode("utf-8")
    s3.put_object(
        Bucket=BUCKET,
        Key=f"batches/_async/outputs/{stem}.out",
        Body=body,
        ContentType="application/json",
    )


def _failure_body(inference_id: str) -> dict:
    return {
        "awsRegion": REGION,
        "invocationStatus": "Failed",
        "requestParameters": {
            "endpointName": "yomitoku-async",
            "inputLocation": (
                f"s3://{BUCKET}/batches/_async/inputs/{BATCH_JOB_ID}/{inference_id.split(':')[-1]}.pdf"
            ),
        },
        "failureLocation": f"s3://{BUCKET}/batches/_async/errors/def.out",
        "failureReason": "ModelError: invalid PDF",
        "inferenceId": inference_id,
    }


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


# --------------------------------------------------------------------------
# Task 3.2: SQS long-poll + InferenceId フィルタリング
# --------------------------------------------------------------------------
def test_poll_success_returns_matching_notifications_and_deletes(sqs_env) -> None:
    """自バッチ宛ての Success メッセージはパースして返却し、キューから削除される。"""
    invoker, sqs, success_url, _ = sqs_env

    mine = _success_body(f"{BATCH_JOB_ID}:a")
    other = _success_body("other-batch:z")
    sqs.send_message(QueueUrl=success_url, MessageBody=_sns_wrap(mine))
    sqs.send_message(QueueUrl=success_url, MessageBody=_sns_wrap(other))

    notifications = invoker._poll_queue(
        queue_url=success_url,
        in_flight={f"{BATCH_JOB_ID}:a", f"{BATCH_JOB_ID}:b"},
    )

    assert len(notifications) == 1
    notif = notifications[0]
    assert isinstance(notif, PolledNotification)
    assert notif.inference_id == f"{BATCH_JOB_ID}:a"
    assert notif.body["invocationStatus"] == "Completed"

    # 残っているのは他バッチのみ (ChangeMessageVisibility=0 で即時返却されている)
    remaining = sqs.receive_message(
        QueueUrl=success_url, MaxNumberOfMessages=10, VisibilityTimeout=0
    ).get("Messages", [])
    parsed = [json.loads(json.loads(m["Body"])["Message"]) for m in remaining]
    ids = {m["inferenceId"] for m in parsed}
    assert ids == {"other-batch:z"}


def test_poll_failure_returns_matching_failure(sqs_env) -> None:
    """自バッチ宛ての Failure メッセージは failureReason と failureLocation を保持する。"""
    invoker, sqs, _, failure_url = sqs_env

    mine = _failure_body(f"{BATCH_JOB_ID}:b")
    sqs.send_message(QueueUrl=failure_url, MessageBody=_sns_wrap(mine))

    notifications = invoker._poll_queue(
        queue_url=failure_url,
        in_flight={f"{BATCH_JOB_ID}:b"},
    )

    assert len(notifications) == 1
    notif = notifications[0]
    assert notif.inference_id == f"{BATCH_JOB_ID}:b"
    assert notif.body["invocationStatus"] == "Failed"
    assert notif.body["failureReason"] == "ModelError: invalid PDF"


def test_poll_handles_raw_message_delivery(sqs_env) -> None:
    """Raw Message Delivery が有効化された場合 (Message が裸 JSON) でも動く。"""
    invoker, sqs, success_url, _ = sqs_env

    mine = _success_body(f"{BATCH_JOB_ID}:c")
    sqs.send_message(QueueUrl=success_url, MessageBody=json.dumps(mine))

    notifications = invoker._poll_queue(
        queue_url=success_url,
        in_flight={f"{BATCH_JOB_ID}:c"},
    )

    assert len(notifications) == 1
    assert notifications[0].inference_id == f"{BATCH_JOB_ID}:c"


def test_poll_does_not_consume_other_batch_messages(sqs_env) -> None:
    """他バッチ宛てメッセージは Delete されず、再度 receive 可能な状態で残る。"""
    invoker, sqs, success_url, _ = sqs_env

    other = _success_body("other-batch:x")
    sqs.send_message(QueueUrl=success_url, MessageBody=_sns_wrap(other))

    # 自バッチの in-flight セットに該当しない
    notifications = invoker._poll_queue(
        queue_url=success_url,
        in_flight={f"{BATCH_JOB_ID}:a"},
    )

    assert notifications == []

    # ChangeMessageVisibility=0 により即座に受信可能な状態で残っている
    remaining = sqs.receive_message(
        QueueUrl=success_url, MaxNumberOfMessages=10, VisibilityTimeout=0
    ).get("Messages", [])
    assert len(remaining) == 1
    inner = json.loads(json.loads(remaining[0]["Body"])["Message"])
    assert inner["inferenceId"] == "other-batch:x"


def test_poll_skips_malformed_messages_without_raising(sqs_env) -> None:
    """JSON 破損メッセージは無視して処理を継続する (at-least-once 配送耐性)。"""
    invoker, sqs, success_url, _ = sqs_env

    sqs.send_message(QueueUrl=success_url, MessageBody="not-a-json")
    mine = _success_body(f"{BATCH_JOB_ID}:d")
    sqs.send_message(QueueUrl=success_url, MessageBody=_sns_wrap(mine))

    notifications = invoker._poll_queue(
        queue_url=success_url,
        in_flight={f"{BATCH_JOB_ID}:d"},
    )

    # 正常な方だけ拾える
    ids = {n.inference_id for n in notifications}
    assert ids == {f"{BATCH_JOB_ID}:d"}


# --------------------------------------------------------------------------
# Task 3.3: max_concurrent 背圧 + BatchResult + timeout 集計
# --------------------------------------------------------------------------
@pytest.fixture
def full_aws_env():
    """S3 + SQS を同一 `mock_aws()` 内で立ち上げ、sagemaker-runtime は Stubber 経由。

    `run_batch` は `_stage_input` (S3 PutObject) と `_invoke_async`
    (sagemaker-runtime) と `_poll_queue` (SQS) を束ねるため、1 テスト内で
    3 サービス全てのモックを共有する必要がある。
    """
    with mock_aws():
        s3 = boto3.client("s3", region_name=REGION)
        s3.create_bucket(
            Bucket=BUCKET,
            CreateBucketConfiguration={"LocationConstraint": REGION},
        )
        sqs = boto3.client("sqs", region_name=REGION)
        success_url = sqs.create_queue(QueueName="async-success")["QueueUrl"]
        failure_url = sqs.create_queue(QueueName="async-failure")["QueueUrl"]
        sagemaker = boto3.client("sagemaker-runtime", region_name=REGION)
        stubber = Stubber(sagemaker)
        try:
            yield {
                "s3": s3,
                "sqs": sqs,
                "sagemaker": sagemaker,
                "stubber": stubber,
                "success_url": success_url,
                "failure_url": failure_url,
            }
        finally:
            stubber.deactivate()


def _make_invoker(env: dict[str, Any], *, max_concurrent: int = 2) -> AsyncInvoker:
    """`full_aws_env` から `AsyncInvoker` を構築する小ヘルパ。"""
    return AsyncInvoker(
        endpoint_name="yomitoku-async",
        input_bucket=BUCKET,
        input_prefix=INPUT_PREFIX,
        output_bucket=BUCKET,
        success_queue_url=env["success_url"],
        failure_queue_url=env["failure_url"],
        max_concurrent=max_concurrent,
        poll_wait_seconds=0,
        sagemaker_client=env["sagemaker"],
        sqs_client=env["sqs"],
        s3_client=env["s3"],
    )


def test_run_batch_respects_max_concurrent_semaphore(full_aws_env, tmp_path: Path) -> None:
    """`max_concurrent=2` で 3 ファイルを投げても、同時 in-flight が 2 を超えない。

    観測方法: `_poll_queue` が呼ばれた際の `in_flight` セットサイズを記録し、
    最大値を assert する。poll が走る時点の in_flight = 同時並行数 - 完了数。
    pending=a,b,c を max_concurrent=2 で流した場合、`a,b` 投入 → poll → `c` 投入
    の順となり、poll 時点で観測される in_flight の最大は 2 に収まるはず。
    """
    env = full_aws_env
    invoker = _make_invoker(env, max_concurrent=2)

    files = [_write_input(tmp_path, f"{stem}.pdf") for stem in ("a", "b", "c")]

    # 3 ファイル分の Success メッセージを事前投入しておく (poll でまとめて回収)
    # OutputLocation ダウンロードが発生するので S3 にもダミーを配置する。
    for stem in ("a", "b", "c"):
        _put_dummy_output(env["s3"], stem)
        env["sqs"].send_message(
            QueueUrl=env["success_url"],
            MessageBody=_sns_wrap(_success_body(f"{BATCH_JOB_ID}:{stem}")),
        )

    stubber = env["stubber"]
    for stem in ("a", "b", "c"):
        stubber.add_response(
            "invoke_endpoint_async",
            {"InferenceId": f"{BATCH_JOB_ID}:{stem}", "OutputLocation": "s3://x/y"},
        )
    stubber.activate()

    observed_max = [0]
    original_poll = invoker._poll_queue

    def spy_poll(*, queue_url: str, in_flight: set[str]):
        observed_max[0] = max(observed_max[0], len(in_flight))
        return original_poll(queue_url=queue_url, in_flight=in_flight)

    invoker._poll_queue = spy_poll  # type: ignore[method-assign]

    result = asyncio.run(
        invoker.run_batch(
            batch_job_id=BATCH_JOB_ID,
            input_files=files,
            output_dir=tmp_path / "out",
            log_path=tmp_path / "log.jsonl",
            deadline_seconds=30.0,
        )
    )

    assert observed_max[0] <= 2, (
        f"max in-flight exceeded max_concurrent=2: observed={observed_max[0]}"
    )
    assert isinstance(result, BatchResult)
    assert sorted(result.succeeded_files) == ["a", "b", "c"]
    assert result.failed_files == []
    assert result.in_flight_timeout == []
    stubber.assert_no_pending_responses()


def test_run_batch_aggregates_success_and_failure(full_aws_env, tmp_path: Path) -> None:
    """1 成功 + 1 失敗 の混在バッチで BatchResult が両方を正しく集計する。"""
    env = full_aws_env
    invoker = _make_invoker(env, max_concurrent=4)

    file_ok = _write_input(tmp_path, "ok.pdf")
    file_bad = _write_input(tmp_path, "bad.pdf")

    _put_dummy_output(env["s3"], "ok")
    env["sqs"].send_message(
        QueueUrl=env["success_url"],
        MessageBody=_sns_wrap(_success_body(f"{BATCH_JOB_ID}:ok")),
    )
    env["sqs"].send_message(
        QueueUrl=env["failure_url"],
        MessageBody=_sns_wrap(_failure_body(f"{BATCH_JOB_ID}:bad")),
    )

    stubber = env["stubber"]
    for stem in ("ok", "bad"):
        stubber.add_response(
            "invoke_endpoint_async",
            {"InferenceId": f"{BATCH_JOB_ID}:{stem}", "OutputLocation": "s3://x/y"},
        )
    stubber.activate()

    result = asyncio.run(
        invoker.run_batch(
            batch_job_id=BATCH_JOB_ID,
            input_files=[file_ok, file_bad],
            output_dir=tmp_path / "out",
            log_path=tmp_path / "log.jsonl",
            deadline_seconds=30.0,
        )
    )

    assert result.succeeded_files == ["ok"]
    assert len(result.failed_files) == 1
    stem, reason = result.failed_files[0]
    assert stem == "bad"
    assert "ModelError" in reason  # _failure_body() の failureReason が記録される
    assert result.in_flight_timeout == []
    stubber.assert_no_pending_responses()


def test_run_batch_collects_in_flight_timeout(full_aws_env, tmp_path: Path) -> None:
    """deadline 内に通知が来なかった InferenceId は `in_flight_timeout` に落ちる。

    SuccessQueue / FailureQueue のどちらにも何も投入せず、`deadline_seconds` を
    極小 (100ms) に設定することで、invoke 後の polling がすぐに時間切れする。
    """
    env = full_aws_env
    invoker = _make_invoker(env, max_concurrent=2)

    file_a = _write_input(tmp_path, "a.pdf")
    file_b = _write_input(tmp_path, "b.pdf")

    stubber = env["stubber"]
    for stem in ("a", "b"):
        stubber.add_response(
            "invoke_endpoint_async",
            {"InferenceId": f"{BATCH_JOB_ID}:{stem}", "OutputLocation": "s3://x/y"},
        )
    stubber.activate()

    result = asyncio.run(
        invoker.run_batch(
            batch_job_id=BATCH_JOB_ID,
            input_files=[file_a, file_b],
            output_dir=tmp_path / "out",
            log_path=tmp_path / "log.jsonl",
            deadline_seconds=0.1,
        )
    )

    assert result.succeeded_files == []
    assert result.failed_files == []
    assert sorted(result.in_flight_timeout) == ["a", "b"]
    stubber.assert_no_pending_responses()


def test_run_batch_records_4xx_as_immediate_failure(full_aws_env, tmp_path: Path) -> None:
    """同期 4xx ValidationException は `failed_files` に即積まれる (リトライなし)。

    残り 1 ファイルは通常の Async 経路で成功し、BatchResult に両方が反映される。
    """
    env = full_aws_env
    invoker = _make_invoker(env, max_concurrent=4)

    file_ok = _write_input(tmp_path, "ok.pdf")
    file_bad = _write_input(tmp_path, "bad.pdf")

    _put_dummy_output(env["s3"], "ok")
    env["sqs"].send_message(
        QueueUrl=env["success_url"],
        MessageBody=_sns_wrap(_success_body(f"{BATCH_JOB_ID}:ok")),
    )

    stubber = env["stubber"]
    stubber.add_response(
        "invoke_endpoint_async",
        {"InferenceId": f"{BATCH_JOB_ID}:ok", "OutputLocation": "s3://x/y"},
    )
    stubber.add_client_error(
        "invoke_endpoint_async",
        service_error_code="ValidationException",
        service_message="Invalid content type",
        http_status_code=400,
    )
    stubber.activate()

    result = asyncio.run(
        invoker.run_batch(
            batch_job_id=BATCH_JOB_ID,
            input_files=[file_ok, file_bad],
            output_dir=tmp_path / "out",
            log_path=tmp_path / "log.jsonl",
            deadline_seconds=30.0,
        )
    )

    assert result.succeeded_files == ["ok"]
    assert len(result.failed_files) == 1
    stem, reason = result.failed_files[0]
    assert stem == "bad"
    assert "ValidationException" in reason
    assert result.in_flight_timeout == []
    stubber.assert_no_pending_responses()


# --------------------------------------------------------------------------
# Task 3.4: run_batch レベルの追加シナリオ (Async timeout / 重複配信 / 混在)
# --------------------------------------------------------------------------
def _failure_body_with_reason(inference_id: str, reason: str) -> dict:
    """任意 `failureReason` で FailureQueue 用 body を作る (Async タイムアウト等)。"""
    body = _failure_body(inference_id)
    body["failureReason"] = reason
    return body


def test_run_batch_records_async_timeout_failure_reason(
    full_aws_env, tmp_path: Path
) -> None:
    """Async Endpoint 側のタイムアウトは FailureQueue 経由で
    `failed_files` に `failureReason` が記録される。

    SageMaker Async Inference は `InvocationTimeoutSeconds` (既定 3600s) を
    超えると ErrorTopic → FailureQueue に `failureReason` 付きで通知する。
    ここではそれと等価なメッセージを直接投入して経路を検証する。
    """
    env = full_aws_env
    invoker = _make_invoker(env, max_concurrent=2)

    file_slow = _write_input(tmp_path, "slow.pdf")

    timeout_reason = (
        "ModelInvocationTimeout: Invocation exceeded InvocationTimeoutSeconds=3600"
    )
    env["sqs"].send_message(
        QueueUrl=env["failure_url"],
        MessageBody=_sns_wrap(
            _failure_body_with_reason(f"{BATCH_JOB_ID}:slow", timeout_reason)
        ),
    )

    stubber = env["stubber"]
    stubber.add_response(
        "invoke_endpoint_async",
        {"InferenceId": f"{BATCH_JOB_ID}:slow", "OutputLocation": "s3://x/y"},
    )
    stubber.activate()

    result = asyncio.run(
        invoker.run_batch(
            batch_job_id=BATCH_JOB_ID,
            input_files=[file_slow],
            output_dir=tmp_path / "out",
            log_path=tmp_path / "log.jsonl",
            deadline_seconds=30.0,
        )
    )

    assert result.succeeded_files == []
    assert len(result.failed_files) == 1
    stem, reason = result.failed_files[0]
    assert stem == "slow"
    assert "InvocationTimeoutSeconds" in reason
    assert result.in_flight_timeout == []
    stubber.assert_no_pending_responses()


def test_run_batch_idempotent_on_sqs_duplicate_delivery(
    full_aws_env, tmp_path: Path
) -> None:
    """SQS at-least-once により同一 InferenceId が 2 度届いても、
    succeeded_files への重複加算 / 例外は発生しない。

    SuccessQueue に 2 通同じ成功通知を投入し、2 回目は
    ``in_flight.pop()`` が ``None`` を返す分岐で握りつぶされることを確認する。
    """
    env = full_aws_env
    invoker = _make_invoker(env, max_concurrent=2)

    file_ok = _write_input(tmp_path, "ok.pdf")

    _put_dummy_output(env["s3"], "ok")
    body = _sns_wrap(_success_body(f"{BATCH_JOB_ID}:ok"))
    # 同一メッセージを 2 通送信 (重複配信をシミュレート)
    env["sqs"].send_message(QueueUrl=env["success_url"], MessageBody=body)
    env["sqs"].send_message(QueueUrl=env["success_url"], MessageBody=body)

    stubber = env["stubber"]
    stubber.add_response(
        "invoke_endpoint_async",
        {"InferenceId": f"{BATCH_JOB_ID}:ok", "OutputLocation": "s3://x/y"},
    )
    stubber.activate()

    result = asyncio.run(
        invoker.run_batch(
            batch_job_id=BATCH_JOB_ID,
            input_files=[file_ok],
            output_dir=tmp_path / "out",
            log_path=tmp_path / "log.jsonl",
            deadline_seconds=30.0,
        )
    )

    # 1 件のみ集計され、失敗もタイムアウトも無い
    assert result.succeeded_files == ["ok"]
    assert result.failed_files == []
    assert result.in_flight_timeout == []
    stubber.assert_no_pending_responses()


def test_run_batch_ignores_other_batch_messages_in_shared_queue(
    full_aws_env, tmp_path: Path
) -> None:
    """共通 SuccessQueue に 2 バッチ分の成功通知が混在する場合、
    ``run_batch`` は自バッチ分だけを消費し、他バッチ分は Visibility=0 で
    即時返却する (他ランナーが拾える状態を維持)。
    """
    env = full_aws_env
    invoker = _make_invoker(env, max_concurrent=2)

    file_ok = _write_input(tmp_path, "ok.pdf")

    other_batch = "batch-async-999"
    _put_dummy_output(env["s3"], "ok")
    # 自バッチの成功通知 + 他バッチの成功通知を同一 SuccessQueue に投入
    env["sqs"].send_message(
        QueueUrl=env["success_url"],
        MessageBody=_sns_wrap(_success_body(f"{BATCH_JOB_ID}:ok")),
    )
    env["sqs"].send_message(
        QueueUrl=env["success_url"],
        MessageBody=_sns_wrap(_success_body(f"{other_batch}:other")),
    )

    stubber = env["stubber"]
    stubber.add_response(
        "invoke_endpoint_async",
        {"InferenceId": f"{BATCH_JOB_ID}:ok", "OutputLocation": "s3://x/y"},
    )
    stubber.activate()

    result = asyncio.run(
        invoker.run_batch(
            batch_job_id=BATCH_JOB_ID,
            input_files=[file_ok],
            output_dir=tmp_path / "out",
            log_path=tmp_path / "log.jsonl",
            deadline_seconds=30.0,
        )
    )

    # 自バッチだけ成功集計
    assert result.succeeded_files == ["ok"]
    assert result.failed_files == []
    assert result.in_flight_timeout == []
    stubber.assert_no_pending_responses()

    # 他バッチのメッセージは ChangeMessageVisibility=0 で即座に
    # 再受信可能な状態で Queue に残っている
    leftover = env["sqs"].receive_message(
        QueueUrl=env["success_url"],
        MaxNumberOfMessages=10,
        WaitTimeSeconds=0,
        VisibilityTimeout=0,
    )
    messages = leftover.get("Messages", [])
    assert len(messages) == 1
    leftover_inner = json.loads(messages[0]["Body"])
    inner = json.loads(leftover_inner["Message"])
    assert inner["inferenceId"] == f"{other_batch}:other"


# --------------------------------------------------------------------------
# Task 5.1: OutputLocation ダウンロード + process_log.jsonl 永続化
# --------------------------------------------------------------------------
def _read_process_log(log_path: Path) -> list[dict]:
    """process_log.jsonl を読み込んで dict のリストに変換する。"""
    if not log_path.exists():
        return []
    return [
        json.loads(line)
        for line in log_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def test_run_batch_persists_output_json_from_output_location(
    full_aws_env, tmp_path: Path
) -> None:
    """成功通知を受けたら OutputLocation から JSON をダウンロードし
    `output_dir/{stem}.json` に保存する。"""
    env = full_aws_env
    invoker = _make_invoker(env, max_concurrent=2)

    file_ok = _write_input(tmp_path, "ok.pdf")
    _put_dummy_output(env["s3"], "ok", payload={"pages": [{"idx": 0}], "stem": "ok"})
    env["sqs"].send_message(
        QueueUrl=env["success_url"],
        MessageBody=_sns_wrap(_success_body(f"{BATCH_JOB_ID}:ok")),
    )

    stubber = env["stubber"]
    stubber.add_response(
        "invoke_endpoint_async",
        {"InferenceId": f"{BATCH_JOB_ID}:ok", "OutputLocation": "s3://x/y"},
    )
    stubber.activate()

    output_dir = tmp_path / "out"
    log_path = tmp_path / "out" / "process_log.jsonl"
    result = asyncio.run(
        invoker.run_batch(
            batch_job_id=BATCH_JOB_ID,
            input_files=[file_ok],
            output_dir=output_dir,
            log_path=log_path,
            deadline_seconds=30.0,
        )
    )

    assert result.succeeded_files == ["ok"]
    # output JSON がローカルに書き出される
    persisted = output_dir / "ok.json"
    assert persisted.exists(), f"output JSON not persisted: {persisted}"
    body = json.loads(persisted.read_text(encoding="utf-8"))
    assert body == {"pages": [{"idx": 0}], "stem": "ok"}


def test_run_batch_appends_process_log_for_success_and_failure(
    full_aws_env, tmp_path: Path
) -> None:
    """process_log.jsonl には成功・失敗の両方が 1 行 1 レコードで追記される。"""
    env = full_aws_env
    invoker = _make_invoker(env, max_concurrent=4)

    file_ok = _write_input(tmp_path, "ok.pdf")
    file_bad = _write_input(tmp_path, "bad.pdf")

    _put_dummy_output(env["s3"], "ok")
    env["sqs"].send_message(
        QueueUrl=env["success_url"],
        MessageBody=_sns_wrap(_success_body(f"{BATCH_JOB_ID}:ok")),
    )
    env["sqs"].send_message(
        QueueUrl=env["failure_url"],
        MessageBody=_sns_wrap(_failure_body(f"{BATCH_JOB_ID}:bad")),
    )

    stubber = env["stubber"]
    for stem in ("ok", "bad"):
        stubber.add_response(
            "invoke_endpoint_async",
            {"InferenceId": f"{BATCH_JOB_ID}:{stem}", "OutputLocation": "s3://x/y"},
        )
    stubber.activate()

    output_dir = tmp_path / "out"
    log_path = output_dir / "process_log.jsonl"
    asyncio.run(
        invoker.run_batch(
            batch_job_id=BATCH_JOB_ID,
            input_files=[file_ok, file_bad],
            output_dir=output_dir,
            log_path=log_path,
            deadline_seconds=30.0,
        )
    )

    records = _read_process_log(log_path)
    by_success: dict[bool, list[dict]] = {True: [], False: []}
    for r in records:
        by_success[bool(r.get("success"))].append(r)

    assert len(by_success[True]) == 1
    assert len(by_success[False]) == 1
    success_row = by_success[True][0]
    assert Path(success_row["file_path"]).name == "ok.pdf"
    assert success_row["output_path"].endswith("ok.json")
    assert success_row.get("error") in (None, "")
    failure_row = by_success[False][0]
    assert Path(failure_row["file_path"]).name == "bad.pdf"
    assert "ModelError" in (failure_row.get("error") or "")


def test_run_batch_records_output_download_failure(
    full_aws_env, tmp_path: Path
) -> None:
    """OutputLocation ダウンロードに失敗したら failed_files に積み、
    process_log.jsonl にもエラーとして記録する。"""
    env = full_aws_env
    invoker = _make_invoker(env, max_concurrent=2)

    file_ok = _write_input(tmp_path, "ghost.pdf")
    # あえて _put_dummy_output を呼ばない → S3 に該当オブジェクトが存在しない
    env["sqs"].send_message(
        QueueUrl=env["success_url"],
        MessageBody=_sns_wrap(_success_body(f"{BATCH_JOB_ID}:ghost")),
    )

    stubber = env["stubber"]
    stubber.add_response(
        "invoke_endpoint_async",
        {"InferenceId": f"{BATCH_JOB_ID}:ghost", "OutputLocation": "s3://x/y"},
    )
    stubber.activate()

    output_dir = tmp_path / "out"
    log_path = output_dir / "process_log.jsonl"
    result = asyncio.run(
        invoker.run_batch(
            batch_job_id=BATCH_JOB_ID,
            input_files=[file_ok],
            output_dir=output_dir,
            log_path=log_path,
            deadline_seconds=30.0,
        )
    )

    assert result.succeeded_files == []
    assert len(result.failed_files) == 1
    stem, reason = result.failed_files[0]
    assert stem == "ghost"
    assert "output" in reason.lower() or "NoSuchKey" in reason
    records = _read_process_log(log_path)
    assert any(
        r.get("success") is False and Path(r["file_path"]).name == "ghost.pdf"
        for r in records
    )


def test_parse_s3_uri_rejects_traversal_and_foreign_bucket(
    s3_bucket: str,
) -> None:
    """``_parse_s3_uri`` は ``..`` / 未知 bucket を汚染 URI として拒否する。"""
    invoker = AsyncInvoker(
        endpoint_name="yomitoku-async",
        input_bucket=BUCKET,
        input_prefix=INPUT_PREFIX,
        output_bucket=BUCKET,
        success_queue_url="https://sqs.invalid/success",
        failure_queue_url="https://sqs.invalid/failure",
        max_concurrent=2,
    )

    with pytest.raises(ValueError, match="not normalized"):
        invoker._parse_s3_uri(f"s3://{BUCKET}/batches/../etc/passwd")

    with pytest.raises(ValueError, match="does not match"):
        invoker._parse_s3_uri("s3://foreign-bucket/batches/_async/outputs/x.out")

    with pytest.raises(ValueError, match="missing key"):
        invoker._parse_s3_uri(f"s3://{BUCKET}/")

    with pytest.raises(ValueError, match="invalid S3 URI"):
        invoker._parse_s3_uri("https://example.com/bucket/key")


def test_run_batch_rejects_oversized_output(full_aws_env, tmp_path: Path) -> None:
    """ContentLength が上限を超える場合は ``failed_files`` に積む。"""
    env = full_aws_env
    invoker = _make_invoker(env, max_concurrent=2)

    file_ok = _write_input(tmp_path, "big.pdf")
    # 実際には 130 MiB 書き込まないが、moto の head が ContentLength を
    # 返すように実体を置いた上で、上限を絞って閾値超過を発火する。
    big_body = b"0" * 1024
    env["s3"].put_object(
        Bucket=BUCKET,
        Key="batches/_async/outputs/big.out",
        Body=big_body,
        ContentType="application/json",
    )
    env["sqs"].send_message(
        QueueUrl=env["success_url"],
        MessageBody=_sns_wrap(_success_body(f"{BATCH_JOB_ID}:big")),
    )

    # 上限を実 body より小さくして閾値違反を発生させる
    invoker._MAX_OUTPUT_BYTES = 512  # type: ignore[attr-defined]

    stubber = env["stubber"]
    stubber.add_response(
        "invoke_endpoint_async",
        {"InferenceId": f"{BATCH_JOB_ID}:big", "OutputLocation": "s3://x/y"},
    )
    stubber.activate()

    result = asyncio.run(
        invoker.run_batch(
            batch_job_id=BATCH_JOB_ID,
            input_files=[file_ok],
            output_dir=tmp_path / "out",
            log_path=tmp_path / "out" / "process_log.jsonl",
            deadline_seconds=30.0,
        )
    )

    assert result.succeeded_files == []
    assert len(result.failed_files) == 1
    stem, reason = result.failed_files[0]
    assert stem == "big"
    assert "output too large" in reason
    stubber.assert_no_pending_responses()


def test_run_batch_records_in_flight_timeout_to_process_log(
    full_aws_env, tmp_path: Path
) -> None:
    """deadline 超過で未完了のファイルは process_log.jsonl に failure 行として記録される。"""
    env = full_aws_env
    invoker = _make_invoker(env, max_concurrent=2)

    file_a = _write_input(tmp_path, "a.pdf")

    stubber = env["stubber"]
    stubber.add_response(
        "invoke_endpoint_async",
        {"InferenceId": f"{BATCH_JOB_ID}:a", "OutputLocation": "s3://x/y"},
    )
    stubber.activate()

    output_dir = tmp_path / "out"
    log_path = output_dir / "process_log.jsonl"
    result = asyncio.run(
        invoker.run_batch(
            batch_job_id=BATCH_JOB_ID,
            input_files=[file_a],
            output_dir=output_dir,
            log_path=log_path,
            deadline_seconds=0.1,
        )
    )

    assert result.in_flight_timeout == ["a"]
    records = _read_process_log(log_path)
    assert any(
        r.get("success") is False
        and Path(r["file_path"]).name == "a.pdf"
        and "timeout" in (r.get("error") or "").lower()
        for r in records
    )
