#!/usr/bin/env python3
"""フェーズ 10: API 結合テストスクリプト.

使い方:
  # 全テスト実行（E2E フロー以外）
  python scripts/test-api.py

  # E2E フローテスト（SageMaker エンドポイント起動済み前提）
  python scripts/test-api.py --e2e

  # 個別テスト実行
  python scripts/test-api.py --test A    # POST /jobs
  python scripts/test-api.py --test B    # GET /jobs/:jobId
  python scripts/test-api.py --test C    # GET /jobs 一覧
  python scripts/test-api.py --test D    # DELETE /jobs/:jobId
  python scripts/test-api.py --test E    # バリデーション
  python scripts/test-api.py --test F    # API Key なし 403
  python scripts/test-api.py --test G    # E2E OCR フロー
  python scripts/test-api.py --test H    # 直接アクセス拒否

前提:
  - ApiStack が us-east-1 にデプロイ済み
  - pip install requests (or urllib3)
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import uuid
from urllib.request import Request, urlopen
from urllib.error import HTTPError


REGION = "us-east-1"
STACK_NAME = "ApiStack"

# --- Helpers ---


def get_stack_outputs() -> dict[str, str]:
    """CloudFormation Output から URL / API Key 情報を取得."""
    result = subprocess.run(
        [
            "aws", "cloudformation", "describe-stacks",
            "--stack-name", STACK_NAME,
            "--region", REGION,
            "--query", "Stacks[0].Outputs",
            "--output", "json",
        ],
        capture_output=True, text=True, check=True,
    )
    outputs = json.loads(result.stdout)
    return {o["OutputKey"]: o["OutputValue"] for o in outputs}


def get_api_key_value(api_key_id: str) -> str:
    """API Key ID から実際の値を取得."""
    result = subprocess.run(
        [
            "aws", "apigateway", "get-api-key",
            "--api-key", api_key_id,
            "--include-value",
            "--query", "value",
            "--output", "text",
            "--region", REGION,
        ],
        capture_output=True, text=True, check=True,
    )
    return result.stdout.strip()


def api_request(
    method: str,
    url: str,
    *,
    api_key: str | None = None,
    body: dict | None = None,
    expect_status: int | None = None,
) -> tuple[int, dict | str]:
    """HTTP リクエストを送信し (status, body) を返す."""
    data = json.dumps(body).encode() if body else None
    req = Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if api_key:
        req.add_header("x-api-key", api_key)

    try:
        with urlopen(req) as resp:
            status = resp.status
            raw = resp.read().decode()
    except HTTPError as e:
        status = e.code
        raw = e.read().decode()

    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        parsed = raw

    if expect_status and status != expect_status:
        print(f"  FAIL: expected {expect_status}, got {status}")
        print(f"  Response: {parsed}")
        return status, parsed

    return status, parsed


def assert_eq(label: str, actual, expected):
    if actual == expected:
        print(f"  PASS: {label} == {expected}")
    else:
        print(f"  FAIL: {label}: expected {expected}, got {actual}")


def assert_in(label: str, key: str, data: dict):
    if key in data:
        print(f"  PASS: {label} - '{key}' present")
    else:
        print(f"  FAIL: {label} - '{key}' missing from {list(data.keys())}")


# --- Tests ---


def test_a_post_jobs(base_url: str, api_key: str) -> str | None:
    """テスト A: POST /jobs でジョブを作成."""
    print("\n=== Test A: POST /jobs ===")

    status, body = api_request(
        "POST", f"{base_url}jobs",
        api_key=api_key,
        body={"filename": "test.pdf"},
    )
    assert_eq("status", status, 201)
    if status != 201:
        return None

    assert_in("body", "jobId", body)
    assert_in("body", "uploadUrl", body)

    job_id = body.get("jobId")
    upload_url = body.get("uploadUrl")
    print(f"  jobId: {job_id}")

    # uploadUrl に PDF を PUT アップロード
    if upload_url:
        print("  Uploading dummy PDF to presigned URL...")
        dummy_pdf = b"%PDF-1.4 dummy content for testing"
        put_req = Request(upload_url, data=dummy_pdf, method="PUT")
        put_req.add_header("Content-Type", "application/pdf")
        try:
            with urlopen(put_req) as resp:
                assert_eq("upload status", resp.status, 200)
        except HTTPError as e:
            print(f"  FAIL: upload failed with {e.code}")

    return job_id


def test_b_get_job(base_url: str, api_key: str, job_id: str):
    """テスト B: GET /jobs/:jobId でステータス確認."""
    print("\n=== Test B: GET /jobs/:jobId ===")

    status, body = api_request(
        "GET", f"{base_url}jobs/{job_id}",
        api_key=api_key,
    )
    assert_eq("status", status, 200)
    if status != 200:
        return

    assert_in("body", "jobId", body)
    assert_in("body", "status", body)
    assert_eq("jobId", body.get("jobId"), job_id)
    print(f"  status: {body.get('status')}")


def test_c_get_jobs(base_url: str, api_key: str):
    """テスト C: GET /jobs 一覧取得."""
    print("\n=== Test C: GET /jobs ===")

    # ステータスフィルタ
    status, body = api_request(
        "GET", f"{base_url}jobs?status=PENDING",
        api_key=api_key,
    )
    assert_eq("status", status, 200)
    if status == 200:
        assert_in("body", "items", body)
        print(f"  items count: {len(body.get('items', []))}")

    # ページネーション (status は必須)
    status, body = api_request(
        "GET", f"{base_url}jobs?status=PENDING&limit=1",
        api_key=api_key,
    )
    assert_eq("status (limit=1)", status, 200)
    if status == 200 and len(body.get("items", [])) > 0:
        if body.get("cursor"):
            print(f"  PASS: cursor present: {body['cursor'][:20]}...")
            # 次ページ取得
            status2, body2 = api_request(
                "GET", f"{base_url}jobs?status=PENDING&limit=1&cursor={body['cursor']}",
                api_key=api_key,
            )
            assert_eq("next page status", status2, 200)
        else:
            print("  INFO: no cursor (possibly only 1 item)")


def test_d_delete_job(base_url: str, api_key: str):
    """テスト D: DELETE /jobs/:jobId キャンセル."""
    print("\n=== Test D: DELETE /jobs/:jobId ===")

    # 新規ジョブ作成（アップロードしない）
    status, body = api_request(
        "POST", f"{base_url}jobs",
        api_key=api_key,
        body={"filename": "cancel-test.pdf"},
    )
    if status != 201:
        print(f"  FAIL: could not create job (status={status})")
        return

    job_id = body["jobId"]
    print(f"  Created job: {job_id}")

    # DELETE
    status, body = api_request(
        "DELETE", f"{base_url}jobs/{job_id}",
        api_key=api_key,
    )
    assert_eq("delete status", status, 200)
    if status == 200:
        assert_eq("body.status", body.get("status"), "CANCELLED")

    # GET で CANCELLED 確認
    status, body = api_request(
        "GET", f"{base_url}jobs/{job_id}",
        api_key=api_key,
    )
    assert_eq("get status after cancel", status, 200)
    if status == 200:
        assert_eq("status", body.get("status"), "CANCELLED")

    # 再度 DELETE → 409
    status, _body = api_request(
        "DELETE", f"{base_url}jobs/{job_id}",
        api_key=api_key,
    )
    assert_eq("re-delete status", status, 409)


def test_e_validation(base_url: str, api_key: str):
    """テスト E: バリデーション."""
    print("\n=== Test E: Validation ===")

    # filename なし → 400
    status, _ = api_request(
        "POST", f"{base_url}jobs",
        api_key=api_key,
        body={},
    )
    assert_eq("no filename", status, 400)

    # .txt ファイル → 400
    status, _ = api_request(
        "POST", f"{base_url}jobs",
        api_key=api_key,
        body={"filename": "test.txt"},
    )
    assert_eq(".txt filename", status, 400)

    # 存在しない jobId → 404
    fake_id = str(uuid.uuid4())
    status, _ = api_request(
        "GET", f"{base_url}jobs/{fake_id}",
        api_key=api_key,
    )
    assert_eq("non-existent jobId", status, 404)


def test_f_no_api_key(base_url: str):
    """テスト F: API Key なしでアクセス → 403."""
    print("\n=== Test F: No API Key → 403 ===")

    status, _ = api_request(
        "GET", f"{base_url}jobs",
    )
    assert_eq("no api key", status, 403)


def test_g_e2e_flow(base_url: str, api_key: str):
    """テスト G: E2E OCR フロー（エンドポイント起動済み前提）."""
    print("\n=== Test G: E2E OCR Flow ===")
    print("  NOTE: Requires SageMaker endpoint to be InService")

    # POST /jobs
    status, body = api_request(
        "POST", f"{base_url}jobs",
        api_key=api_key,
        body={"filename": "e2e-test.pdf"},
    )
    if status != 201:
        print(f"  FAIL: could not create job (status={status})")
        return

    job_id = body["jobId"]
    upload_url = body["uploadUrl"]
    print(f"  jobId: {job_id}")

    # Upload a minimal PDF
    dummy_pdf = b"%PDF-1.4 dummy content for e2e testing"
    put_req = Request(upload_url, data=dummy_pdf, method="PUT")
    put_req.add_header("Content-Type", "application/pdf")
    try:
        with urlopen(put_req) as resp:
            assert_eq("upload status", resp.status, 200)
    except HTTPError as e:
        print(f"  FAIL: upload failed with {e.code}")
        return

    # Poll for COMPLETED (max 5 min)
    print("  Polling for completion...")
    max_wait = 300
    interval = 10
    elapsed = 0
    final_status = None
    result_url = None

    while elapsed < max_wait:
        time.sleep(interval)
        elapsed += interval
        status, body = api_request(
            "GET", f"{base_url}jobs/{job_id}",
            api_key=api_key,
        )
        if status != 200:
            print(f"  WARN: GET returned {status}")
            continue

        final_status = body.get("status")
        print(f"  [{elapsed}s] status: {final_status}")

        if final_status == "COMPLETED":
            result_url = body.get("resultUrl")
            break
        if final_status == "FAILED":
            print(f"  FAIL: job failed - {body.get('error', 'unknown')}")
            return

    if final_status != "COMPLETED":
        print(f"  FAIL: timed out after {max_wait}s (last status: {final_status})")
        return

    # Fetch result
    if result_url:
        print(f"  Fetching result from {result_url[:50]}...")
        try:
            with urlopen(Request(result_url)) as resp:
                result_data = json.loads(resp.read().decode())
                print(f"  PASS: result JSON received, keys: {list(result_data.keys())}")
        except Exception as e:
            print(f"  FAIL: could not fetch result: {e}")
    else:
        print("  FAIL: no resultUrl in response")


def test_h_direct_access(api_gateway_url: str, api_key: str):
    """テスト H: API Gateway 直接アクセスの拒否確認."""
    print("\n=== Test H: Direct API Gateway Access → 403 ===")

    status, _ = api_request(
        "GET", f"{api_gateway_url}jobs",
        api_key=api_key,
    )
    assert_eq("direct access blocked", status, 403)


# --- Main ---


def main():
    parser = argparse.ArgumentParser(description="API Integration Tests")
    parser.add_argument("--test", help="Run specific test (A-H)")
    parser.add_argument("--e2e", action="store_true", help="Include E2E flow test (G)")
    args = parser.parse_args()

    print("Loading stack outputs...")
    outputs = get_stack_outputs()
    cf_domain = outputs.get("DistributionDomainName", "")
    api_key_id = outputs.get("ApiKeyId", "")
    api_gw_url = outputs.get("ApiUrl", "")

    base_url = f"https://{cf_domain}/"
    api_key = get_api_key_value(api_key_id)

    print(f"  CloudFront: {base_url}")
    print(f"  API Gateway: {api_gw_url}")
    print(f"  API Key: {api_key[:8]}...")

    tests_to_run = set()
    if args.test:
        tests_to_run.add(args.test.upper())
    elif args.e2e:
        tests_to_run = {"A", "B", "C", "D", "E", "F", "G", "H"}
    else:
        tests_to_run = {"A", "B", "C", "D", "E", "F", "H"}

    job_id = None

    if "A" in tests_to_run:
        job_id = test_a_post_jobs(base_url, api_key)

    if "B" in tests_to_run and job_id:
        test_b_get_job(base_url, api_key, job_id)

    if "C" in tests_to_run:
        test_c_get_jobs(base_url, api_key)

    if "D" in tests_to_run:
        test_d_delete_job(base_url, api_key)

    if "E" in tests_to_run:
        test_e_validation(base_url, api_key)

    if "F" in tests_to_run:
        test_f_no_api_key(base_url)

    if "G" in tests_to_run:
        test_g_e2e_flow(base_url, api_key)

    if "H" in tests_to_run:
        test_h_direct_access(api_gw_url, api_key)

    print("\n=== Done ===")


if __name__ == "__main__":
    main()
