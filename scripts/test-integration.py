#!/usr/bin/env python3
"""6.2 処理ワーカー Lambda の結合テストスクリプト.

使い方:
  # 6.2.1-6.2.4 正常系テスト（PDF アップロード → OCR → 結果確認）
  python scripts/test-integration.py upload path/to/test.pdf

  # 6.2.5 異常系テスト（不正ファイルで FAILED → DLQ 確認）
  python scripts/test-integration.py upload-invalid

  # ステータス確認
  python scripts/test-integration.py status <file_key>

  # 全レコード確認
  python scripts/test-integration.py list

  # リソース情報表示
  python scripts/test-integration.py info

前提:
  - ProcessingStack が us-east-1 にデプロイ済み
  - SageMaker エンドポイントが InService 状態（正常系テスト時）
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

cf = boto3.client("cloudformation", region_name=REGION)


def get_stack_outputs() -> dict[str, str]:
    """ProcessingStack の Outputs を取得する。"""
    try:
        resp = cf.describe_stacks(StackName=STACK_NAME)
        outputs = resp["Stacks"][0].get("Outputs", [])
        return {o["OutputKey"]: o["OutputValue"] for o in outputs}
    except ClientError as e:
        print(f"スタック '{STACK_NAME}' の取得に失敗: {e}")
        sys.exit(1)


def show_info() -> None:
    """リソース情報を表示する。"""
    outputs = get_stack_outputs()
    print("--- ProcessingStack リソース ---")
    for k, v in sorted(outputs.items()):
        print(f"  {k}: {v}")


def upload_pdf(pdf_path: str) -> None:
    """6.2.1-6.2.4: PDF を S3 にアップロードし処理結果を確認する。"""
    import os

    outputs = get_stack_outputs()
    bucket = outputs["BucketName"]
    table_name = outputs["StatusTableName"]

    s3 = boto3.client("s3", region_name=REGION)
    dynamodb = boto3.resource("dynamodb", region_name=REGION)
    table = dynamodb.Table(table_name)

    # ファイル名から S3 キーを生成
    filename = os.path.basename(pdf_path)
    file_key = f"input/{filename}"

    # DynamoDB に PENDING レコードを作成
    now = datetime.now(timezone.utc).isoformat()
    table.put_item(
        Item={
            "file_key": file_key,
            "status": "PENDING",
            "created_at": now,
            "updated_at": now,
        }
    )
    print(f"DynamoDB に PENDING レコード作成: {file_key}")

    # S3 にアップロード（→ SQS → Lambda が自動起動）
    print(f"S3 にアップロード中: s3://{bucket}/{file_key}")
    s3.upload_file(pdf_path, bucket, file_key)
    print("アップロード完了。Lambda の処理を待機中...")

    # ステータスをポーリング（最大 5 分）
    for i in range(30):
        time.sleep(10)
        resp = table.get_item(Key={"file_key": file_key})
        item = resp.get("Item", {})
        status = item.get("status", "UNKNOWN")
        elapsed = (i + 1) * 10
        print(f"  [{elapsed}s] ステータス: {status}")

        if status == "COMPLETED":
            print("\n--- 処理完了 ---")
            print(f"  output_key: {item.get('output_key', 'N/A')}")
            print(f"  processing_time_ms: {item.get('processing_time_ms', 'N/A')}")

            # S3 output/ の JSON を確認
            output_key = item.get("output_key")
            if output_key:
                try:
                    obj = s3.get_object(Bucket=bucket, Key=output_key)
                    result = json.loads(obj["Body"].read())
                    result_str = json.dumps(result, ensure_ascii=False)
                    print(f"  結果サイズ: {len(result_str)} 文字")
                    print(f"  先頭 300 文字: {result_str[:300]}...")
                except Exception as e:
                    print(f"  output 読み取りエラー: {e}")
            return

        if status == "FAILED":
            print("\n--- 処理失敗 ---")
            print(f"  error_message: {item.get('error_message', 'N/A')}")
            return

    print("タイムアウト: 5 分以内に処理が完了しませんでした。")


def upload_invalid() -> None:
    """6.2.5: 不正ファイルをアップロードし FAILED → DLQ 移動を確認する。"""
    outputs = get_stack_outputs()
    bucket = outputs["BucketName"]
    table_name = outputs["StatusTableName"]
    dlq_arn = outputs["DeadLetterQueueArn"]

    s3 = boto3.client("s3", region_name=REGION)
    sqs = boto3.client("sqs", region_name=REGION)
    dynamodb = boto3.resource("dynamodb", region_name=REGION)
    table = dynamodb.Table(table_name)

    file_key = "input/invalid-test.pdf"
    now = datetime.now(timezone.utc).isoformat()

    # DynamoDB に PENDING レコード作成
    table.put_item(
        Item={
            "file_key": file_key,
            "status": "PENDING",
            "created_at": now,
            "updated_at": now,
        }
    )
    print(f"DynamoDB に PENDING レコード作成: {file_key}")

    # 不正な内容のファイルをアップロード
    print(f"不正ファイルをアップロード中: s3://{bucket}/{file_key}")
    s3.put_object(Bucket=bucket, Key=file_key, Body=b"this is not a pdf")
    print("アップロード完了。Lambda の処理（と失敗）を待機中...")

    # ステータスをポーリング
    for i in range(30):
        time.sleep(10)
        resp = table.get_item(Key={"file_key": file_key})
        item = resp.get("Item", {})
        status = item.get("status", "UNKNOWN")
        elapsed = (i + 1) * 10
        print(f"  [{elapsed}s] ステータス: {status}")

        if status == "FAILED":
            print("\n--- 期待通り FAILED ---")
            print(f"  error_message: {item.get('error_message', 'N/A')}")

            # DLQ のメッセージ数を確認
            # DLQ URL を ARN から取得
            dlq_name = dlq_arn.split(":")[-1]
            try:
                dlq_url_resp = sqs.get_queue_url(QueueName=dlq_name)
                dlq_url = dlq_url_resp["QueueUrl"]
                attrs = sqs.get_queue_attributes(
                    QueueUrl=dlq_url,
                    AttributeNames=["ApproximateNumberOfMessages"],
                )
                dlq_count = attrs["Attributes"]["ApproximateNumberOfMessages"]
                print(f"  DLQ メッセージ数: {dlq_count}")
            except Exception as e:
                print(f"  DLQ 確認エラー: {e}")
            return

    print("タイムアウト: FAILED にならなかった。Lambda ログを確認してください。")


def check_status(file_key: str) -> None:
    """指定ファイルのステータスを確認する。"""
    outputs = get_stack_outputs()
    table_name = outputs["StatusTableName"]
    dynamodb = boto3.resource("dynamodb", region_name=REGION)
    table = dynamodb.Table(table_name)

    resp = table.get_item(Key={"file_key": file_key})
    item = resp.get("Item")
    if item:
        print(json.dumps(item, ensure_ascii=False, indent=2, default=str))
    else:
        print(f"レコードが見つかりません: {file_key}")


def list_records() -> None:
    """全レコードを一覧表示する。"""
    outputs = get_stack_outputs()
    table_name = outputs["StatusTableName"]
    dynamodb = boto3.resource("dynamodb", region_name=REGION)
    table = dynamodb.Table(table_name)

    resp = table.scan(Limit=50)
    items = resp.get("Items", [])
    if not items:
        print("レコードなし")
        return

    print(f"--- {len(items)} 件 ---")
    for item in items:
        print(
            f"  {item['file_key']}  status={item.get('status')}  "
            f"updated={item.get('updated_at', 'N/A')}"
        )


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    command = sys.argv[1]

    if command == "upload":
        if len(sys.argv) < 3:
            print("使い方: python scripts/test-integration.py upload <PDF パス>")
            sys.exit(1)
        upload_pdf(sys.argv[2])
    elif command == "upload-invalid":
        upload_invalid()
    elif command == "status":
        if len(sys.argv) < 3:
            print("使い方: python scripts/test-integration.py status <file_key>")
            sys.exit(1)
        check_status(sys.argv[2])
    elif command == "list":
        list_records()
    elif command == "info":
        show_info()
    else:
        print(f"不明なコマンド: {command}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
