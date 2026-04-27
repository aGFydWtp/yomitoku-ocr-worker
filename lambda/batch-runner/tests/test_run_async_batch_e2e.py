"""run_async_batch の E2E smoke (Task 5.3) + main.run 経由 PDF + PPTX 混在 (Task 5.10)。

AsyncInvoker / runner を通貫してテストする。moto で S3 / SQS を立ち上げ、
sagemaker-runtime は ``botocore.stub.Stubber`` で ``invoke_endpoint_async``
のシグネチャのみを捕捉する。

検証ポイント (tasks.md Task 5.3):
1. 1 成功 + 1 失敗の混在バッチで ``process_log.jsonl`` が per-file で正しい
2. 別バッチ宛ての SQS メッセージが共通 Queue に混在しても誤消費しない
3. deadline 早期切り上げで ``in_flight_timeout`` と timeout ログ行が出る

検証ポイント (tasks.md Task 5.10):
4. PDF + 変換成功 PPTX + 変換失敗 PPTX (encrypted) を ``main.run`` で 1 周流し、
   office_converter (subprocess.Popen + msoffcrypto) 全て mock した上で
   SageMaker invoke / SQS / S3 / DDB の連動を実 (moto / Stubber) で検証する。
   - SageMaker invoke は変換後 PDF (``.pdf`` / ``application/pdf``) のみ受信する
     (R7.2 / R2.3 確認 = Office 形式 / その MIME は SageMaker に直接届かない)
   - process_log.jsonl は CONVERSION_FAILED 1 + OCR success 2 の 3 行
   - DDB FILE: PDF 原本と CONVERSION_FAILED 元 PPTX の status / errorCategory が
     期待通り。変換成功 PPTX の DDB FILE 更新は filename mismatch のため
     PENDING のまま残る (deferred to result-filename-extension-preservation spec)
"""

from __future__ import annotations

import asyncio
import importlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

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

    # 新仕様: persist パスは原本ファイル名 (`ok.pdf`) + `.json` 終端
    ok_json = output_dir / "ok.pdf.json"
    assert ok_json.exists()
    assert json.loads(ok_json.read_text()) == {"pages": [{"idx": 0}]}

    records = _read_log(log_path)
    by_stem = {Path(r["file_path"]).stem: r for r in records}
    assert by_stem["ok"]["success"] is True
    assert by_stem["ok"]["output_path"].endswith("ok.pdf.json")
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


# ===========================================================================
# Task 5.10: PDF + PPTX 混在バッチを main.run 経由で 1 周流す E2E
# ===========================================================================
#
# 既存テスト群 (5.3) は run_async_batch 単体を直接呼ぶ。本テストは
# main.run() (orchestration) を SNS / SQS / S3 / SageMaker / DDB すべて
# 立てた上で 1 周通し、Office 変換 → SageMaker → DDB FILE 反映までの
# 縦串を実 (moto / Stubber) で検証する (Task 5.10 / R2.1 / R3.1-3 / R7.2 / R9.1)。
#
# Mock 戦略 (task 説明書通り):
#   - subprocess.Popen (= LibreOffice) を mock し変換成功時に空 PDF を吐かせる
#   - msoffcrypto.is_password_protected を mock して encrypted.pptx だけ True
#   - 上記 2 つだけで convert_office_files の実装はそのまま走る
#   - boto3 の S3 / SQS / DynamoDB は moto, sagemaker-runtime は Stubber
#
# 本 e2e は **production の office_converter をラップせず** に直接呼び出す。
# convert_office_files は成功・失敗いずれの場合も Office 原本を input_dir
# からローカル削除する契約 (R7.2 維持) なので、encrypted.pptx を含めても
# 後段 run_async_batch が SageMaker に送るのは application/pdf のみとなる。
# ---------------------------------------------------------------------------

REGION_E2E_MAIN = "us-east-1"
BUCKET_E2E_MAIN = "yomitoku-bucket-e2e-main"
BATCH_JOB_ID_E2E_MAIN = "batch-mixed-main-001"
BATCH_TABLE_E2E_MAIN = "BatchTableE2EMain"


def _make_e2e_main_env(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    """settings.BatchRunnerSettings.from_env が必要とする env を投入する。"""
    env = {
        "BATCH_JOB_ID": BATCH_JOB_ID_E2E_MAIN,
        "BUCKET_NAME": BUCKET_E2E_MAIN,
        "BATCH_TABLE_NAME": BATCH_TABLE_E2E_MAIN,
        "CONTROL_TABLE_NAME": "ControlTableE2E",
        "ENDPOINT_NAME": "yomitoku-async",
        "SUCCESS_QUEUE_URL": "",  # 後で moto SQS URL を上書き
        "FAILURE_QUEUE_URL": "",
        "ASYNC_INPUT_PREFIX": "batches/_async/inputs",
        "ASYNC_OUTPUT_PREFIX": "batches/_async/outputs",
        "ASYNC_ERROR_PREFIX": "batches/_async/errors",
        "AWS_DEFAULT_REGION": REGION_E2E_MAIN,
    }
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("DRY_RUN", raising=False)
    return env


def _create_e2e_main_batch_table():
    """TS BatchTable と同 schema (PK/SK + GSI1) で moto 上に立てる。"""
    res = boto3.resource("dynamodb", region_name=REGION_E2E_MAIN)
    res.create_table(
        TableName=BATCH_TABLE_E2E_MAIN,
        KeySchema=[
            {"AttributeName": "PK", "KeyType": "HASH"},
            {"AttributeName": "SK", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "PK", "AttributeType": "S"},
            {"AttributeName": "SK", "AttributeType": "S"},
            {"AttributeName": "GSI1PK", "AttributeType": "S"},
            {"AttributeName": "GSI1SK", "AttributeType": "S"},
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": "GSI1",
                "KeySchema": [
                    {"AttributeName": "GSI1PK", "KeyType": "HASH"},
                    {"AttributeName": "GSI1SK", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "KEYS_ONLY"},
            },
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    return res.Table(BATCH_TABLE_E2E_MAIN)


def _create_e2e_main_control_table():
    """ControlTable は heartbeat 失敗を非致命にしているため scheme は最小で OK。"""
    res = boto3.resource("dynamodb", region_name=REGION_E2E_MAIN)
    res.create_table(
        TableName="ControlTableE2E",
        KeySchema=[
            {"AttributeName": "PK", "KeyType": "HASH"},
            {"AttributeName": "SK", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "PK", "AttributeType": "S"},
            {"AttributeName": "SK", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    return res.Table("ControlTableE2E")


def _seed_e2e_main_batch(table, filenames: list[str]) -> None:
    """META (PROCESSING) と FILE (PENDING) を投入する。"""
    table.put_item(Item={
        "PK": f"BATCH#{BATCH_JOB_ID_E2E_MAIN}",
        "SK": "META",
        "entityType": "BATCH",
        "batchJobId": BATCH_JOB_ID_E2E_MAIN,
        "status": "PROCESSING",
        "batchLabel": "mixed-e2e-main",
        "totals": {
            "total": len(filenames), "succeeded": 0, "failed": 0,
            "inProgress": len(filenames),
        },
        "createdAt": "2026-04-22T09:00:00.000Z",
        "updatedAt": "2026-04-22T09:00:00.000Z",
        "startedAt": "2026-04-22T09:05:00.000Z",
        "parentBatchJobId": None,
        "GSI1PK": "STATUS#PROCESSING#202604",
        "GSI1SK": "2026-04-22T09:00:00.000Z",
    })
    for fname in filenames:
        fk = f"batches/{BATCH_JOB_ID_E2E_MAIN}/input/{fname}"
        table.put_item(Item={
            "PK": f"BATCH#{BATCH_JOB_ID_E2E_MAIN}",
            "SK": f"FILE#{fk}",
            "entityType": "FILE",
            "batchJobId": BATCH_JOB_ID_E2E_MAIN,
            "fileKey": fk,
            "filename": fname,
            "status": "PENDING",
            "updatedAt": "2026-04-22T09:00:00.000Z",
        })


def _put_input_object(s3: Any, filename: str, body: bytes) -> None:
    s3.put_object(
        Bucket=BUCKET_E2E_MAIN,
        Key=f"batches/{BATCH_JOB_ID_E2E_MAIN}/input/{filename}",
        Body=body,
    )


def _fake_soffice_popen(cmd, *args, **kwargs):
    """soffice subprocess.Popen を mock し、変換成功時のみ ``<stem>.pdf`` を生成する。

    convert_office_to_pdf は ``--outdir`` に PDF が出来ているかを検査するため、
    mock 側で実体を 1 byte 以上で書き出す必要がある。
    """
    # cmd: ['soffice', ..., '--outdir', <work_dir>, <input_pptx>]
    outdir_idx = cmd.index("--outdir") + 1
    outdir = Path(cmd[outdir_idx])
    input_path = Path(cmd[-1])
    pdf_out = outdir / f"{input_path.stem}.pdf"
    outdir.mkdir(parents=True, exist_ok=True)
    pdf_out.write_bytes(b"%PDF-1.4\n%fake-converted\n")
    proc = MagicMock()
    proc.returncode = 0
    proc.pid = 12345
    proc.wait.return_value = 0
    proc.communicate.return_value = (b"", b"")
    return proc


def _sm_invoke_response(batch_job_id: str, stem: str) -> dict[str, Any]:
    """Stubber 用 invoke_endpoint_async の正常応答。"""
    return {
        "InferenceId": f"{batch_job_id}:{stem}",
        "OutputLocation": f"s3://{BUCKET_E2E_MAIN}/batches/_async/outputs/{stem}.out",
    }


def _sm_invoke_expected_params(batch_job_id: str, stem: str) -> dict[str, Any]:
    """SageMaker invoke が PDF として呼ばれることを Stubber で expect する。

    R7.2: SageMaker への入力契約 = PDF / payload ≤ 1 GB。stem で identify、
    InputLocation は ``.pdf`` 拡張子、ContentType は ``application/pdf``。
    """
    return {
        "EndpointName": "yomitoku-async",
        "InputLocation": (
            f"s3://{BUCKET_E2E_MAIN}/batches/_async/inputs/"
            f"{batch_job_id}/{stem}.pdf"
        ),
        "InferenceId": f"{batch_job_id}:{stem}",
        "ContentType": "application/pdf",
    }


def test_e2e_mixed_pdf_and_pptx_via_main_run(
    monkeypatch: pytest.MonkeyPatch,
):
    """PDF + PPTX 混在バッチを main.run() で 1 周流し全ての契約を縦串で検証する。

    入力 3 件:
        - report.pdf      : 既存 PDF (変換不要)
        - deck.pptx       : 変換成功 → deck.pdf を生成 → OCR success
        - encrypted.pptx  : 変換失敗 (encrypted) → CONVERSION_FAILED

    検証:
        1. SageMaker invoke は変換後 PDF (報告 + deck) **2 件のみ**、
           それぞれ ``ContentType=application/pdf`` / ``InputLocation=...{stem}.pdf``
           を受信する (R7.2 / R2.3)
        2. process_log.jsonl は 3 行 (CONVERSION_FAILED 1 + OCR success 2)、
           各行の error_category / success が期待通り
        3. DDB FILE:
           - report.pdf       : status=COMPLETED, errorCategory なし
           - encrypted.pptx   : status=FAILED, errorCategory=CONVERSION_FAILED
           - deck.pptx        : status=PENDING のまま (filename mismatch 既知制約 /
             別 spec `result-filename-extension-preservation` で解消予定)
        4. S3 input prefix の original .pptx は **削除されていない** (R9.1)
        5. main.run() の exit code は 0、META.status は PARTIAL に遷移 (R3.3 / R4.8)
    """
    with mock_aws():
        # --- 1. moto 上の AWS service 群を準備 ---
        s3 = boto3.client("s3", region_name=REGION_E2E_MAIN)
        s3.create_bucket(Bucket=BUCKET_E2E_MAIN)  # us-east-1 は LocationConstraint 不要
        sqs = boto3.client("sqs", region_name=REGION_E2E_MAIN)
        success_url = sqs.create_queue(QueueName="async-success-mixed")["QueueUrl"]
        failure_url = sqs.create_queue(QueueName="async-failure-mixed")["QueueUrl"]
        sagemaker = boto3.client("sagemaker-runtime", region_name=REGION_E2E_MAIN)
        stubber = Stubber(sagemaker)

        # --- 2. DDB BatchTable / ControlTable を seed ---
        batch_table = _create_e2e_main_batch_table()
        _create_e2e_main_control_table()
        _seed_e2e_main_batch(
            batch_table,
            ["report.pdf", "deck.pptx", "encrypted.pptx"],
        )

        # --- 3. S3 input prefix に原本 3 件を put (download_inputs が拾う) ---
        _put_input_object(s3, "report.pdf", b"%PDF-1.4\n%native-pdf\n")
        _put_input_object(s3, "deck.pptx", b"PK\x03\x04fake-pptx-bytes")
        _put_input_object(
            s3, "encrypted.pptx", b"PK\x03\x04fake-encrypted-pptx-bytes",
        )

        # --- 4. SageMaker async OutputLocation を 2 件 (PDF only) put ---
        for stem in ("deck", "report"):
            s3.put_object(
                Bucket=BUCKET_E2E_MAIN,
                Key=f"batches/_async/outputs/{stem}.out",
                Body=json.dumps({"pages": [{"idx": 0, "stem": stem}]}).encode("utf-8"),
                ContentType="application/json",
            )

        # --- 5. SQS success notification を 2 件 (PDF only) 投入 ---
        for stem in ("deck", "report"):
            sqs.send_message(
                QueueUrl=success_url,
                MessageBody=_sns_wrap({
                    "awsRegion": REGION_E2E_MAIN,
                    "invocationStatus": "Completed",
                    "requestParameters": {
                        "endpointName": "yomitoku-async",
                        "inputLocation": (
                            f"s3://{BUCKET_E2E_MAIN}/batches/_async/inputs/"
                            f"{BATCH_JOB_ID_E2E_MAIN}/{stem}.pdf"
                        ),
                    },
                    "responseParameters": {
                        "contentType": "application/json",
                        "outputLocation": (
                            f"s3://{BUCKET_E2E_MAIN}/batches/_async/outputs/{stem}.out"
                        ),
                    },
                    "inferenceId": f"{BATCH_JOB_ID_E2E_MAIN}:{stem}",
                }),
            )

        # --- 6. Stubber に 2 件分の invoke_endpoint_async expectation を登録 ---
        # run_async_batch は input_dir.iterdir() を sorted() で回す。input_dir には
        # 変換後 deck.pdf + report.pdf の 2 件しか残らない想定 (encrypted.pptx は
        # convert_office_files の失敗時クリーンアップ (R7.2) でローカル削除されるため)。
        # sorted: deck.pdf < report.pdf なので deck → report の順で expect する。
        for stem in ("deck", "report"):
            stubber.add_response(
                "invoke_endpoint_async",
                _sm_invoke_response(BATCH_JOB_ID_E2E_MAIN, stem),
                expected_params=_sm_invoke_expected_params(
                    BATCH_JOB_ID_E2E_MAIN, stem
                ),
            )
        stubber.activate()

        # --- 7. env を投入し main を再ロードして moto/Stubber と束ねる ---
        env = _make_e2e_main_env(monkeypatch)
        env["SUCCESS_QUEUE_URL"] = success_url
        env["FAILURE_QUEUE_URL"] = failure_url
        monkeypatch.setenv("SUCCESS_QUEUE_URL", success_url)
        monkeypatch.setenv("FAILURE_QUEUE_URL", failure_url)

        for mod in ("main", "settings"):
            sys.modules.pop(mod, None)
        import main as main_module  # noqa: WPS433 — 再ロード不可避
        importlib.reload(main_module)

        # --- 8. boto3 client/resource を moto 由来 / Stubber 済 sagemaker に束ねる ---
        real_resource = boto3.resource

        def _resource_via_moto(name: str, *args: Any, **kwargs: Any):
            kwargs.setdefault("region_name", REGION_E2E_MAIN)
            return real_resource(name, *args, **kwargs)

        def _client_via_moto(name: str, *args: Any, **kwargs: Any):
            # main.run は s3 のみ自前で生成する (DDB は resource 経由)
            if name == "s3":
                return s3
            kwargs.setdefault("region_name", REGION_E2E_MAIN)
            return boto3.client(name, *args, **kwargs)

        monkeypatch.setattr(main_module.boto3, "resource", _resource_via_moto)
        monkeypatch.setattr(main_module.boto3, "client", _client_via_moto)

        # --- 9. AsyncInvoker の sqs/s3/sagemaker client を moto/Stubber に差し替え ---
        original_invoker_init = AsyncInvoker.__init__

        def _patched_invoker_init(self: AsyncInvoker, **kwargs: Any) -> None:
            kwargs.setdefault("sagemaker_client", sagemaker)
            kwargs.setdefault("sqs_client", sqs)
            kwargs.setdefault("s3_client", s3)
            kwargs.setdefault("poll_wait_seconds", 0)
            original_invoker_init(self, **kwargs)

        monkeypatch.setattr(AsyncInvoker, "__init__", _patched_invoker_init)

        # --- 10. office_converter の subprocess.Popen と is_password_protected を mock ---
        # subprocess.Popen は cmd の --outdir を覗いて変換 PDF を実体化する。
        monkeypatch.setattr(
            "office_converter.subprocess.Popen", _fake_soffice_popen
        )

        def _is_pw_protected(path: Path) -> bool:
            return path.name == "encrypted.pptx"

        monkeypatch.setattr(
            "office_converter.is_password_protected", _is_pw_protected
        )

        # --- 11. yomitoku の visualization 依存を no-op 化 (cv2/yomitoku_client 不要) ---
        monkeypatch.setattr(
            main_module, "generate_all_visualizations", lambda **kw: {}
        )

        # --- 12. 実行 ---
        exit_code = main_module.run(main_module.BatchRunnerSettings.from_env())
        assert exit_code == 0, f"main.run returned non-zero exit: {exit_code}"

        # --- 検証 1: Stubber が 2 invoke (PDF only) のみ受信 → R7.2 ---
        stubber.assert_no_pending_responses()

        # --- 検証 2: process_log.jsonl の 3 行 (CONV_FAILED 1 + OCR success 2) ---
        # main.run は work_root/output/process_log.jsonl に書く。tempfile 経由なので
        # S3 upload された logs/ プレフィックスから読み戻して確認する。
        log_objs = s3.list_objects_v2(
            Bucket=BUCKET_E2E_MAIN,
            Prefix=f"batches/{BATCH_JOB_ID_E2E_MAIN}/logs/",
        )
        log_keys = [o["Key"] for o in log_objs.get("Contents", [])]
        assert any(k.endswith("process_log.jsonl") for k in log_keys), (
            f"process_log.jsonl が S3 にアップロードされていない: {log_keys}"
        )
        log_key = next(k for k in log_keys if k.endswith("process_log.jsonl"))
        log_body = s3.get_object(Bucket=BUCKET_E2E_MAIN, Key=log_key)[
            "Body"
        ].read().decode("utf-8")
        log_records = [
            json.loads(line) for line in log_body.splitlines() if line
        ]
        assert len(log_records) == 3, (
            f"process_log.jsonl: 想定 3 行, 実 {len(log_records)} 行: {log_records}"
        )

        # CONVERSION_FAILED 行 (encrypted.pptx, 1 行)
        conv_failed = [
            r for r in log_records if r.get("error_category") == "CONVERSION_FAILED"
        ]
        assert len(conv_failed) == 1
        assert conv_failed[0]["filename"] == "encrypted.pptx"
        assert conv_failed[0]["success"] is False
        assert "encrypted" in conv_failed[0]["error"].lower()

        # OCR success 行 (deck + report, 2 行)
        ocr_success = [r for r in log_records if r.get("success") is True]
        assert len(ocr_success) == 2
        success_filenames = {Path(r["file_path"]).name for r in ocr_success}
        assert success_filenames == {"deck.pdf", "report.pdf"}, (
            f"OCR 成功 file_path は変換後 PDF 名であるはず: {success_filenames}"
        )
        for r in ocr_success:
            # yomitoku-client は error_category を書かない (OCR_FAILED は Py 側で正規化)
            assert r.get("error_category") is None

        # --- 検証 3: DDB FILE の状態 ---
        # 3a: report.pdf (PDF success) → COMPLETED
        report_item = batch_table.get_item(Key={
            "PK": f"BATCH#{BATCH_JOB_ID_E2E_MAIN}",
            "SK": (
                f"FILE#batches/{BATCH_JOB_ID_E2E_MAIN}/input/report.pdf"
            ),
        })["Item"]
        assert report_item["status"] == "COMPLETED"
        assert "errorCategory" not in report_item
        assert "errorMessage" not in report_item

        # 3b: encrypted.pptx (CONVERSION_FAILED) → FAILED + errorCategory
        enc_item = batch_table.get_item(Key={
            "PK": f"BATCH#{BATCH_JOB_ID_E2E_MAIN}",
            "SK": (
                f"FILE#batches/{BATCH_JOB_ID_E2E_MAIN}/input/encrypted.pptx"
            ),
        })["Item"]
        assert enc_item["status"] == "FAILED"
        assert enc_item["errorCategory"] == "CONVERSION_FAILED"
        assert "encrypted" in enc_item["errorMessage"].lower()

        # 3c: deck.pptx (変換成功 → OCR success) → COMPLETED (Bug 001 fix)
        # apply_process_log が converted_filename_map で deck.pdf → deck.pptx に
        # 書き戻して **原本 deck.pptx 行** を更新するため、PENDING のまま残らない。
        deck_pptx_item = batch_table.get_item(Key={
            "PK": f"BATCH#{BATCH_JOB_ID_E2E_MAIN}",
            "SK": (
                f"FILE#batches/{BATCH_JOB_ID_E2E_MAIN}/input/deck.pptx"
            ),
        })["Item"]
        assert deck_pptx_item["status"] == "COMPLETED", (
            "Bug 001: 変換成功 PPTX は converted_filename_map により "
            "原本 deck.pptx 行が COMPLETED 化されるはず "
            f"(実 {deck_pptx_item['status']})"
        )
        assert "errorCategory" not in deck_pptx_item
        # 新仕様 (R1.2): resultKey は原本 Office 名 (`deck.pptx.json`) を指す。
        # 変換後 PDF basename (`deck.pdf`) ではなく、API レイヤでサニタイズ済の
        # 原本ファイル名 + `.json` 終端で書き込まれる。
        assert deck_pptx_item.get("resultKey", "").endswith("/deck.pptx.json"), (
            f"resultKey は deck.pptx.json を指すはず: {deck_pptx_item.get('resultKey')}"
        )

        # 3d (Bug 001 fix): 変換後 deck.pdf 名で phantom FILE item が
        # 作られていないこと。converted_filename_map で原本名に書き戻されるため。
        deck_pdf_resp = batch_table.get_item(Key={
            "PK": f"BATCH#{BATCH_JOB_ID_E2E_MAIN}",
            "SK": (
                f"FILE#batches/{BATCH_JOB_ID_E2E_MAIN}/input/deck.pdf"
            ),
        })
        assert "Item" not in deck_pdf_resp, (
            "Bug 001: deck.pdf 名で phantom FILE 行が作成されている "
            "(converted_filename_map で原本 deck.pptx 名に書き戻すべき)"
        )

        # --- 検証 4: S3 input prefix の original PPTX は削除されていない (R9.1) ---
        s3_inputs = s3.list_objects_v2(
            Bucket=BUCKET_E2E_MAIN,
            Prefix=f"batches/{BATCH_JOB_ID_E2E_MAIN}/input/",
        )
        s3_input_keys = {o["Key"] for o in s3_inputs.get("Contents", [])}
        assert (
            f"batches/{BATCH_JOB_ID_E2E_MAIN}/input/deck.pptx"
            in s3_input_keys
        ), "変換成功 PPTX の S3 原本が削除されている (R9.1 違反)"
        assert (
            f"batches/{BATCH_JOB_ID_E2E_MAIN}/input/encrypted.pptx"
            in s3_input_keys
        ), "変換失敗 PPTX の S3 原本が削除されている (R9.1 違反)"
        assert (
            f"batches/{BATCH_JOB_ID_E2E_MAIN}/input/report.pdf"
            in s3_input_keys
        ), "PDF 原本が削除されている (R9.1 違反)"

        # --- 検証 5: META.status = PARTIAL (succeeded=2 / failed=1 / total=3) ---
        # apply_process_log の totals は filename ベースなので:
        #   - succeeded: report.pdf + deck.pdf (新規 upsert) = 2
        #   - failed: encrypted.pptx = 1
        # finalize_batch_status は succeeded + failed < total ではなく
        # succeeded > 0 && failed > 0 で PARTIAL 判定 (batch_store 実装)。
        meta = batch_table.get_item(Key={
            "PK": f"BATCH#{BATCH_JOB_ID_E2E_MAIN}", "SK": "META",
        })["Item"]
        assert meta["status"] == "PARTIAL", (
            f"META.status は PARTIAL のはず (succeeded > 0 && failed > 0), "
            f"実 {meta['status']}"
        )
        assert meta["GSI1PK"].startswith("STATUS#PARTIAL#")
