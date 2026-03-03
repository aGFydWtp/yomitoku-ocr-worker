#!/usr/bin/env python3
"""7.4.4 冪等性・排他制御の確認テスト.

使い方:
  # 7.4.4 冪等性テスト
  uv run --with boto3 python scripts/test-idempotency.py idempotency

  # 排他制御テスト
  uv run --with boto3 python scripts/test-idempotency.py mutex
"""

from __future__ import annotations

import json
import sys
import uuid
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

REGION = "us-east-1"
STACK_NAME = "ProcessingStack"
ORCH_STACK_NAME = "OrchestrationStack"

cf = boto3.client("cloudformation", region_name=REGION)
lambda_client = boto3.client("lambda", region_name=REGION)
dynamodb = boto3.resource("dynamodb", region_name=REGION)


def get_outputs(stack_name: str) -> dict[str, str]:
    resp = cf.describe_stacks(StackName=stack_name)
    outputs = resp["Stacks"][0].get("Outputs", [])
    return {o["OutputKey"]: o["OutputValue"] for o in outputs}


def invoke_processor(processor_fn: str, bucket: str, file_key: str) -> dict:
    """Lambda を SQS イベント形式で直接呼び出す."""
    sqs_event = {
        "Records": [
            {
                "messageId": f"test-{uuid.uuid4().hex[:8]}",
                "body": json.dumps(
                    {
                        "Records": [
                            {
                                "s3": {
                                    "bucket": {"name": bucket},
                                    "object": {"key": file_key},
                                }
                            }
                        ]
                    }
                ),
            }
        ]
    }
    print("  Lambda を直接呼び出し中...")
    resp = lambda_client.invoke(
        FunctionName=processor_fn,
        InvocationType="RequestResponse",
        Payload=json.dumps(sqs_event),
    )
    payload = json.loads(resp["Payload"].read())
    print(f"  Lambda レスポンス: {json.dumps(payload)}")
    return payload


def test_idempotency() -> None:
    """7.4.4: 同一ジョブの重複処理が発生しないことを確認."""
    print("=" * 60)
    print("7.4.4 冪等性テスト: 同一ジョブの重複処理防止")
    print("=" * 60)

    outputs = get_outputs(STACK_NAME)
    table = dynamodb.Table(outputs["StatusTableName"])
    processor_fn = outputs["ProcessorFunctionName"]
    bucket = outputs["BucketName"]

    now = datetime.now(timezone.utc).isoformat()

    job_id_a = str(uuid.uuid4())
    job_id_b = str(uuid.uuid4())
    job_id_c = str(uuid.uuid4())

    try:
        # --- テスト A: COMPLETED ジョブの再処理防止 ---
        print("\n[テスト A] COMPLETED ジョブが再処理されないことを確認")

        file_key_a = f"input/{job_id_a}/idempotency-test.pdf"
        table.put_item(
            Item={
                "job_id": job_id_a,
                "file_key": file_key_a,
                "status": "COMPLETED",
                "created_at": now,
                "updated_at": now,
                "output_key": f"output/{job_id_a}/idempotency-test.json",
                "processing_time_ms": 5000,
            }
        )
        print(f"  COMPLETED レコード作成: job_id={job_id_a}")

        payload = invoke_processor(processor_fn, bucket, file_key_a)

        # batchItemFailures が空であることを確認
        failures = payload.get("batchItemFailures", [])
        assert len(failures) == 0, f"予期しない失敗: {failures}"
        print("  batchItemFailures: 空 (OK)")

        # DynamoDB レコードが変化していないことを確認
        item = table.get_item(Key={"job_id": job_id_a})["Item"]
        assert item["status"] == "COMPLETED", f"ステータスが変化: {item['status']}"
        assert item["updated_at"] == now, "updated_at が変化している"
        print("  DynamoDB レコード: 変化なし (OK)")
        print("  -> テスト A: PASS")

        # --- テスト B: PROCESSING ジョブの重複処理防止 ---
        print("\n[テスト B] PROCESSING ジョブが再処理されないことを確認")

        file_key_b = f"input/{job_id_b}/idempotency-test-b.pdf"
        table.put_item(
            Item={
                "job_id": job_id_b,
                "file_key": file_key_b,
                "status": "PROCESSING",
                "created_at": now,
                "updated_at": now,
            }
        )
        print(f"  PROCESSING レコード作成: job_id={job_id_b}")

        payload = invoke_processor(processor_fn, bucket, file_key_b)

        failures = payload.get("batchItemFailures", [])
        assert len(failures) == 0, f"予期しない失敗: {failures}"
        print("  batchItemFailures: 空 (OK)")

        item = table.get_item(Key={"job_id": job_id_b})["Item"]
        assert item["status"] == "PROCESSING", f"ステータスが変化: {item['status']}"
        assert item["updated_at"] == now, "updated_at が変化している"
        print("  DynamoDB レコード: 変化なし (OK)")
        print("  -> テスト B: PASS")

        # --- テスト C: FAILED ジョブの再処理防止 ---
        print("\n[テスト C] FAILED ジョブが再処理されないことを確認")

        file_key_c = f"input/{job_id_c}/idempotency-test-c.pdf"
        table.put_item(
            Item={
                "job_id": job_id_c,
                "file_key": file_key_c,
                "status": "FAILED",
                "created_at": now,
                "updated_at": now,
                "error_message": "Test error",
            }
        )
        print(f"  FAILED レコード作成: job_id={job_id_c}")

        payload = invoke_processor(processor_fn, bucket, file_key_c)

        failures = payload.get("batchItemFailures", [])
        assert len(failures) == 0, f"予期しない失敗: {failures}"
        print("  batchItemFailures: 空 (OK)")

        item = table.get_item(Key={"job_id": job_id_c})["Item"]
        assert item["status"] == "FAILED", f"ステータスが変化: {item['status']}"
        print("  DynamoDB レコード: 変化なし (OK)")
        print("  -> テスト C: PASS")

        print("\n" + "=" * 60)
        print("7.4.4 冪等性テスト: 全 PASS")
        print("=" * 60)

    finally:
        # assert 失敗時もテストレコードを確実に削除
        for job_id in [job_id_a, job_id_b, job_id_c]:
            table.delete_item(Key={"job_id": job_id})
        print("\n  テストレコード削除完了")


def test_mutex() -> None:
    """排他制御テスト: 複数の Step Functions 実行が同時にエンドポイントを操作しないことを確認."""
    print("=" * 60)
    print("排他制御テスト: 同時ロック防止")
    print("=" * 60)

    orch_outputs = get_outputs(ORCH_STACK_NAME)
    proc_outputs = get_outputs(STACK_NAME)
    control_fn = orch_outputs["EndpointControlFunctionName"]
    control_table = dynamodb.Table(proc_outputs["ControlTableName"])

    # --- 準備: control table を IDLE にリセット ---
    now = datetime.now(timezone.utc).isoformat()
    control_table.put_item(
        Item={
            "lock_key": "endpoint_control",
            "endpoint_state": "IDLE",
            "updated_at": now,
        }
    )
    print("\n  control table を IDLE にリセット")

    try:
        # --- テスト A: 1回目のロック取得 ---
        print("\n[テスト A] 1回目の acquire_lock → 成功すること")
        resp = lambda_client.invoke(
            FunctionName=control_fn,
            InvocationType="RequestResponse",
            Payload=json.dumps({
                "action": "acquire_lock",
                "execution_id": "test-execution-1",
            }),
        )
        payload = json.loads(resp["Payload"].read())
        print(f"  レスポンス: {json.dumps(payload)}")
        assert payload["lock_acquired"] is True, f"ロック取得失敗: {payload}"
        print("  -> テスト A: PASS (lock_acquired=true)")

        # --- テスト B: 2回目のロック取得（排他制御） ---
        print("\n[テスト B] 2回目の acquire_lock → 拒否されること")
        resp = lambda_client.invoke(
            FunctionName=control_fn,
            InvocationType="RequestResponse",
            Payload=json.dumps({
                "action": "acquire_lock",
                "execution_id": "test-execution-2",
            }),
        )
        payload = json.loads(resp["Payload"].read())
        print(f"  レスポンス: {json.dumps(payload)}")
        assert payload["lock_acquired"] is False, f"ロックが取得できてしまった: {payload}"
        print("  -> テスト B: PASS (lock_acquired=false)")

        # --- テスト C: ロック中の execution_id が正しいことを確認 ---
        print("\n[テスト C] ロック保持者が正しいことを確認")
        item = control_table.get_item(Key={"lock_key": "endpoint_control"})["Item"]
        assert item["execution_id"] == "test-execution-1", (
            f"execution_id が不正: {item['execution_id']}"
        )
        assert item["endpoint_state"] == "CREATING", (
            f"endpoint_state が不正: {item['endpoint_state']}"
        )
        print(f"  execution_id: {item['execution_id']} (OK)")
        print(f"  endpoint_state: {item['endpoint_state']} (OK)")
        print("  -> テスト C: PASS")

        # --- テスト D: ロック解放後に再取得可能 ---
        print("\n[テスト D] release_lock 後に再度 acquire_lock → 成功すること")
        resp = lambda_client.invoke(
            FunctionName=control_fn,
            InvocationType="RequestResponse",
            Payload=json.dumps({"action": "release_lock"}),
        )
        payload = json.loads(resp["Payload"].read())
        print(f"  release_lock レスポンス: {json.dumps(payload)}")
        assert payload["lock_released"] is True

        resp = lambda_client.invoke(
            FunctionName=control_fn,
            InvocationType="RequestResponse",
            Payload=json.dumps({
                "action": "acquire_lock",
                "execution_id": "test-execution-3",
            }),
        )
        payload = json.loads(resp["Payload"].read())
        print(f"  acquire_lock レスポンス: {json.dumps(payload)}")
        assert payload["lock_acquired"] is True, f"再取得失敗: {payload}"
        print("  -> テスト D: PASS (lock_acquired=true)")

        print("\n" + "=" * 60)
        print("排他制御テスト: 全 PASS")
        print("=" * 60)

    finally:
        # assert 失敗時もロックを確実に解放
        lambda_client.invoke(
            FunctionName=control_fn,
            InvocationType="RequestResponse",
            Payload=json.dumps({"action": "release_lock"}),
        )
        print("\n  ロック解放（クリーンアップ）完了")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    command = sys.argv[1]
    if command == "idempotency":
        test_idempotency()
    elif command == "mutex":
        test_mutex()
    elif command == "all":
        test_idempotency()
        print("\n")
        test_mutex()
    else:
        print(f"不明なコマンド: {command}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
