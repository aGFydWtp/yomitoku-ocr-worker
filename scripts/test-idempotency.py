#!/usr/bin/env python3
"""6.4 冪等性・排他制御の確認テスト.

使い方:
  # 6.4.1 冪等性テスト
  uv run --with boto3 python scripts/test-idempotency.py idempotency

  # 6.4.2 排他制御テスト
  uv run --with boto3 python scripts/test-idempotency.py mutex
"""

from __future__ import annotations

import json
import sys
import time
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


def test_idempotency() -> None:
    """6.4.1: 同一ファイルの重複処理が発生しないことを確認."""
    print("=" * 60)
    print("6.4.1 冪等性テスト: 同一ファイルの重複処理防止")
    print("=" * 60)

    outputs = get_outputs(STACK_NAME)
    table = dynamodb.Table(outputs["StatusTableName"])
    processor_fn = outputs["ProcessorFunctionName"]
    bucket = outputs["BucketName"]

    test_file_key = "input/idempotency-test.pdf"
    now = datetime.now(timezone.utc).isoformat()

    # --- テスト A: COMPLETED ファイルの再処理防止 ---
    print("\n[テスト A] COMPLETED ファイルが再処理されないことを確認")

    # COMPLETED レコードを作成
    table.put_item(
        Item={
            "file_key": test_file_key,
            "status": "COMPLETED",
            "created_at": now,
            "updated_at": now,
            "output_key": "output/idempotency-test.json",
            "processing_time_ms": 5000,
        }
    )
    print(f"  COMPLETED レコード作成: {test_file_key}")

    # Lambda を直接呼び出し（SQS イベント形式）
    sqs_event = {
        "Records": [
            {
                "messageId": "test-msg-001",
                "body": json.dumps(
                    {
                        "Records": [
                            {
                                "s3": {
                                    "bucket": {"name": bucket},
                                    "object": {"key": test_file_key},
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

    # batchItemFailures が空であることを確認
    failures = payload.get("batchItemFailures", [])
    assert len(failures) == 0, f"予期しない失敗: {failures}"
    print("  batchItemFailures: 空 (OK)")

    # DynamoDB レコードが変化していないことを確認
    item = table.get_item(Key={"file_key": test_file_key})["Item"]
    assert item["status"] == "COMPLETED", f"ステータスが変化: {item['status']}"
    assert item["updated_at"] == now, "updated_at が変化している"
    print("  DynamoDB レコード: 変化なし (OK)")
    print("  -> テスト A: PASS")

    # --- テスト B: PROCESSING ファイルの重複処理防止 ---
    print("\n[テスト B] PROCESSING ファイルが再処理されないことを確認")

    test_file_key_b = "input/idempotency-test-b.pdf"
    table.put_item(
        Item={
            "file_key": test_file_key_b,
            "status": "PROCESSING",
            "created_at": now,
            "updated_at": now,
        }
    )
    print(f"  PROCESSING レコード作成: {test_file_key_b}")

    sqs_event_b = {
        "Records": [
            {
                "messageId": "test-msg-002",
                "body": json.dumps(
                    {
                        "Records": [
                            {
                                "s3": {
                                    "bucket": {"name": bucket},
                                    "object": {"key": test_file_key_b},
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
        Payload=json.dumps(sqs_event_b),
    )
    payload = json.loads(resp["Payload"].read())
    print(f"  Lambda レスポンス: {json.dumps(payload)}")

    failures = payload.get("batchItemFailures", [])
    assert len(failures) == 0, f"予期しない失敗: {failures}"
    print("  batchItemFailures: 空 (OK)")

    item = table.get_item(Key={"file_key": test_file_key_b})["Item"]
    assert item["status"] == "PROCESSING", f"ステータスが変化: {item['status']}"
    assert item["updated_at"] == now, "updated_at が変化している"
    print("  DynamoDB レコード: 変化なし (OK)")
    print("  -> テスト B: PASS")

    # --- テスト C: FAILED ファイルの再処理防止 ---
    print("\n[テスト C] FAILED ファイルが再処理されないことを確認")

    test_file_key_c = "input/idempotency-test-c.pdf"
    table.put_item(
        Item={
            "file_key": test_file_key_c,
            "status": "FAILED",
            "created_at": now,
            "updated_at": now,
            "error_message": "Test error",
        }
    )
    print(f"  FAILED レコード作成: {test_file_key_c}")

    sqs_event_c = {
        "Records": [
            {
                "messageId": "test-msg-003",
                "body": json.dumps(
                    {
                        "Records": [
                            {
                                "s3": {
                                    "bucket": {"name": bucket},
                                    "object": {"key": test_file_key_c},
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
        Payload=json.dumps(sqs_event_c),
    )
    payload = json.loads(resp["Payload"].read())
    print(f"  Lambda レスポンス: {json.dumps(payload)}")

    failures = payload.get("batchItemFailures", [])
    assert len(failures) == 0, f"予期しない失敗: {failures}"
    print("  batchItemFailures: 空 (OK)")

    item = table.get_item(Key={"file_key": test_file_key_c})["Item"]
    assert item["status"] == "FAILED", f"ステータスが変化: {item['status']}"
    print("  DynamoDB レコード: 変化なし (OK)")
    print("  -> テスト C: PASS")

    # クリーンアップ
    for key in [test_file_key, test_file_key_b, test_file_key_c]:
        table.delete_item(Key={"file_key": key})
    print("\n  テストレコード削除完了")
    print("\n" + "=" * 60)
    print("6.4.1 冪等性テスト: 全 PASS")
    print("=" * 60)


def test_mutex() -> None:
    """6.4.2: 複数の Step Functions 実行が同時にエンドポイントを操作しないことを確認."""
    print("=" * 60)
    print("6.4.2 排他制御テスト: 同時ロック防止")
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

    # --- クリーンアップ ---
    resp = lambda_client.invoke(
        FunctionName=control_fn,
        InvocationType="RequestResponse",
        Payload=json.dumps({"action": "release_lock"}),
    )
    print("\n  ロック解放（クリーンアップ）完了")

    print("\n" + "=" * 60)
    print("6.4.2 排他制御テスト: 全 PASS")
    print("=" * 60)


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
