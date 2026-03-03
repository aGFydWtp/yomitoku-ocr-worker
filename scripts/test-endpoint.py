#!/usr/bin/env python3
"""6.1 エンドポイント単体の動作確認スクリプト.

使い方:
  # 6.1.1 エンドポイント作成 → InService 待機
  python scripts/test-endpoint.py create

  # 6.1.2 OCR テスト（PDF ファイルを指定）
  python scripts/test-endpoint.py invoke path/to/test.pdf

  # 6.1.3 エンドポイント削除
  python scripts/test-endpoint.py delete

  # ステータス確認のみ
  python scripts/test-endpoint.py status
"""

from __future__ import annotations

import json
import sys
import time

import boto3
from botocore.exceptions import ClientError

REGION = "us-east-1"
ENDPOINT_NAME = "yomitoku-pro-endpoint"
ENDPOINT_CONFIG_NAME = "yomitoku-pro-config"

sagemaker = boto3.client("sagemaker", region_name=REGION)
runtime = boto3.client("sagemaker-runtime", region_name=REGION)


def get_status() -> str | None:
    """エンドポイントのステータスを取得する。"""
    try:
        resp = sagemaker.describe_endpoint(EndpointName=ENDPOINT_NAME)
        return resp["EndpointStatus"]
    except ClientError as e:
        if "Could not find" in str(e):
            return None
        raise


def create_endpoint() -> None:
    """6.1.1: エンドポイントを作成し InService になるまで待機する。"""
    status = get_status()
    if status is not None:
        print(f"エンドポイントは既に存在します（ステータス: {status}）")
        if status == "InService":
            return
        if status == "Creating":
            print("作成中です。待機します...")
        else:
            print(f"予期しないステータス: {status}")
            return
    else:
        print(f"エンドポイント '{ENDPOINT_NAME}' を作成します...")
        sagemaker.create_endpoint(
            EndpointName=ENDPOINT_NAME,
            EndpointConfigName=ENDPOINT_CONFIG_NAME,
        )
        print("作成リクエストを送信しました。")

    # InService になるまでポーリング（最大 30 分）
    print("InService になるまで待機中（ml.g5.xlarge は約 5-10 分かかります）...")
    for i in range(60):
        time.sleep(30)
        status = get_status()
        elapsed = (i + 1) * 30
        print(f"  [{elapsed}s] ステータス: {status}")
        if status == "InService":
            print("エンドポイントが InService になりました。")
            return
        if status == "Failed":
            print("エンドポイントの作成に失敗しました。")
            resp = sagemaker.describe_endpoint(EndpointName=ENDPOINT_NAME)
            print(f"  失敗理由: {resp.get('FailureReason', '不明')}")
            return

    print("タイムアウト: 30 分以内に InService になりませんでした。")


def invoke_endpoint(pdf_path: str) -> None:
    """6.1.2: エンドポイントに PDF を送信し OCR 結果を確認する。"""
    status = get_status()
    if status != "InService":
        print(f"エンドポイントが InService ではありません（ステータス: {status}）")
        return

    print(f"PDF を読み込み中: {pdf_path}")
    with open(pdf_path, "rb") as f:
        payload = f.read()

    print(f"エンドポイント '{ENDPOINT_NAME}' を呼び出し中...")
    start = time.time()

    response = runtime.invoke_endpoint(
        EndpointName=ENDPOINT_NAME,
        ContentType="application/pdf",
        Body=payload,
    )

    elapsed = time.time() - start
    print(f"応答時間: {elapsed:.2f} 秒")

    result_bytes = response["Body"].read()
    result = json.loads(result_bytes)

    # 結果の概要を表示
    print("\n--- OCR 結果概要 ---")
    if isinstance(result, dict):
        print(f"キー: {list(result.keys())}")
        # ページ数があれば表示
        if "pages" in result:
            print(f"ページ数: {len(result['pages'])}")
        # テキストの一部を表示
        result_str = json.dumps(result, ensure_ascii=False)
        if len(result_str) > 500:
            print(f"結果サイズ: {len(result_str)} 文字")
            print(f"先頭 500 文字:\n{result_str[:500]}...")
        else:
            print(f"結果:\n{result_str}")
    else:
        print(f"結果型: {type(result)}")
        print(f"結果: {str(result)[:500]}")

    # JSON ファイルに保存
    output_path = pdf_path.replace(".pdf", "_result.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"\n結果を保存しました: {output_path}")


def delete_endpoint() -> None:
    """6.1.3: エンドポイントを削除する。"""
    status = get_status()
    if status is None:
        print("エンドポイントは存在しません。")
        return

    print(f"エンドポイント '{ENDPOINT_NAME}' を削除します（ステータス: {status}）...")
    sagemaker.delete_endpoint(EndpointName=ENDPOINT_NAME)
    print("削除リクエストを送信しました。")

    # 削除完了を確認
    for i in range(20):
        time.sleep(10)
        s = get_status()
        if s is None:
            print("エンドポイントが削除されました。")
            return
        print(f"  [{(i + 1) * 10}s] ステータス: {s}")

    print("削除の完了を確認できませんでした。AWS コンソールで確認してください。")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    command = sys.argv[1]

    if command == "create":
        create_endpoint()
    elif command == "invoke":
        if len(sys.argv) < 3:
            print("使い方: python scripts/test-endpoint.py invoke <PDF ファイルパス>")
            sys.exit(1)
        invoke_endpoint(sys.argv[2])
    elif command == "delete":
        delete_endpoint()
    elif command == "status":
        status = get_status()
        print(f"ステータス: {status or 'NOT_FOUND'}")
    else:
        print(f"不明なコマンド: {command}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
