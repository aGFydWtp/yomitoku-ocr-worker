"""Tests for s3_sync.py: S3 入出力同期層。

対象:
- download_inputs: s3://bucket/batches/{id}/input/* → local input_dir
- verify_input_parity: HeadObject で DDB 期待集合と S3 実在集合を照合
- upload_outputs: local output_dir → batches/{id}/{output,results,visualizations,logs}/
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

# テスト対象モジュールへのパス
sys.path.insert(0, str(Path(__file__).parent.parent))


BUCKET = "test-yomitoku-bucket"
BATCH_ID = "batch-xyz-001"


@pytest.fixture
def s3_bucket():
    """moto で S3 バケットを立ち上げる。"""
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket=BUCKET)
        yield client


@pytest.fixture
def tmp_dirs(tmp_path):
    """ローカル入出力ディレクトリを用意する。"""
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    input_dir.mkdir()
    output_dir.mkdir()
    return input_dir, output_dir


# ---------------------------------------------------------------------------
# download_inputs
# ---------------------------------------------------------------------------


class TestDownloadInputs:
    def test_downloads_all_objects_under_input_prefix(self, s3_bucket, tmp_dirs):
        input_dir, _ = tmp_dirs
        # S3 にサンプル PDF を 3 つ配置
        for i in range(3):
            s3_bucket.put_object(
                Bucket=BUCKET,
                Key=f"batches/{BATCH_ID}/input/sample_{i}.pdf",
                Body=f"pdf-content-{i}".encode(),
            )

        import s3_sync

        keys = s3_sync.download_inputs(
            bucket=BUCKET, batch_job_id=BATCH_ID, input_dir=str(input_dir),
            s3_client=s3_bucket,
        )
        assert sorted(keys) == [
            f"batches/{BATCH_ID}/input/sample_0.pdf",
            f"batches/{BATCH_ID}/input/sample_1.pdf",
            f"batches/{BATCH_ID}/input/sample_2.pdf",
        ]
        # ローカルにファイルが展開されていること
        for i in range(3):
            local = input_dir / f"sample_{i}.pdf"
            assert local.exists()
            assert local.read_bytes() == f"pdf-content-{i}".encode()

    def test_returns_empty_when_no_objects(self, s3_bucket, tmp_dirs):
        input_dir, _ = tmp_dirs
        import s3_sync

        keys = s3_sync.download_inputs(
            bucket=BUCKET, batch_job_id=BATCH_ID, input_dir=str(input_dir),
            s3_client=s3_bucket,
        )
        assert keys == []

    def test_skips_path_traversal_keys(self, s3_bucket, tmp_dirs):
        """S3 キーに `../` が含まれる場合は input_dir 外に出るため無視する。"""
        input_dir, _ = tmp_dirs
        # 正常ファイル 1 件
        s3_bucket.put_object(
            Bucket=BUCKET,
            Key=f"batches/{BATCH_ID}/input/ok.pdf",
            Body=b"ok",
        )
        # 悪意ある ../escape.pdf を直接 put (S3 は任意のキーを許容)
        s3_bucket.put_object(
            Bucket=BUCKET,
            Key=f"batches/{BATCH_ID}/input/../escape.pdf",
            Body=b"evil",
        )

        import s3_sync

        keys = s3_sync.download_inputs(
            bucket=BUCKET, batch_job_id=BATCH_ID, input_dir=str(input_dir),
            s3_client=s3_bucket,
        )
        # 正常ファイルのみが処理され、input_dir 外にはファイルが作成されない
        assert f"batches/{BATCH_ID}/input/ok.pdf" in keys
        assert (input_dir / "ok.pdf").exists()
        assert not (input_dir.parent / "escape.pdf").exists()

    def test_skips_subdirectory_prefixes(self, s3_bucket, tmp_dirs):
        """input/ 直下のファイルのみを対象とし、サブディレクトリは無視する。"""
        input_dir, _ = tmp_dirs
        s3_bucket.put_object(
            Bucket=BUCKET,
            Key=f"batches/{BATCH_ID}/input/a.pdf",
            Body=b"a",
        )
        # サブディレクトリ下の物は無視（階層は設計上存在しないが防御）
        s3_bucket.put_object(
            Bucket=BUCKET,
            Key=f"batches/{BATCH_ID}/input/sub/b.pdf",
            Body=b"b",
        )

        import s3_sync

        keys = s3_sync.download_inputs(
            bucket=BUCKET, batch_job_id=BATCH_ID, input_dir=str(input_dir),
            s3_client=s3_bucket,
        )
        assert keys == [f"batches/{BATCH_ID}/input/a.pdf"]
        assert (input_dir / "a.pdf").exists()
        assert not (input_dir / "sub").exists()


# ---------------------------------------------------------------------------
# verify_input_parity
# ---------------------------------------------------------------------------


class TestVerifyInputParity:
    def test_returns_empty_when_all_expected_keys_exist(self, s3_bucket):
        for key in [
            f"batches/{BATCH_ID}/input/a.pdf",
            f"batches/{BATCH_ID}/input/b.pdf",
        ]:
            s3_bucket.put_object(Bucket=BUCKET, Key=key, Body=b"x")

        import s3_sync

        missing = s3_sync.verify_input_parity(
            bucket=BUCKET,
            expected_keys=[
                f"batches/{BATCH_ID}/input/a.pdf",
                f"batches/{BATCH_ID}/input/b.pdf",
            ],
            s3_client=s3_bucket,
        )
        assert missing == []

    def test_returns_missing_keys(self, s3_bucket):
        s3_bucket.put_object(
            Bucket=BUCKET, Key=f"batches/{BATCH_ID}/input/a.pdf", Body=b"x"
        )

        import s3_sync

        missing = s3_sync.verify_input_parity(
            bucket=BUCKET,
            expected_keys=[
                f"batches/{BATCH_ID}/input/a.pdf",
                f"batches/{BATCH_ID}/input/missing.pdf",
            ],
            s3_client=s3_bucket,
        )
        assert missing == [f"batches/{BATCH_ID}/input/missing.pdf"]

    def test_empty_expected_keys_returns_empty(self, s3_bucket):
        import s3_sync

        missing = s3_sync.verify_input_parity(
            bucket=BUCKET, expected_keys=[], s3_client=s3_bucket,
        )
        assert missing == []


# ---------------------------------------------------------------------------
# upload_outputs
# ---------------------------------------------------------------------------


class TestUploadOutputs:
    def _make_output_tree(self, output_dir: Path) -> None:
        """yomitoku-client が生成するような出力ツリーを作成する。"""
        # 結果 JSON
        (output_dir / "sample_0.json").write_text(json.dumps({"pages": []}))
        (output_dir / "sample_1.json").write_text(json.dumps({"pages": []}))
        # 追加フォーマット
        (output_dir / "sample_0.md").write_text("# title")
        (output_dir / "sample_0.csv").write_text("a,b,c")
        (output_dir / "sample_0.html").write_text("<p>x</p>")
        (output_dir / "sample_0.pdf").write_bytes(b"%PDF")
        # 可視化画像
        (output_dir / "sample_0_layout_page_0.jpg").write_bytes(b"\xff\xd8img")
        (output_dir / "sample_0_ocr_page_0.jpg").write_bytes(b"\xff\xd8img")
        # process_log.jsonl
        (output_dir / "process_log.jsonl").write_text(
            json.dumps({"file_path": "sample_0.pdf", "success": True}) + "\n"
        )

    def test_uploads_files_into_categorized_prefixes(self, s3_bucket, tmp_dirs):
        _, output_dir = tmp_dirs
        self._make_output_tree(output_dir)

        import s3_sync

        result = s3_sync.upload_outputs(
            bucket=BUCKET,
            batch_job_id=BATCH_ID,
            output_dir=str(output_dir),
            s3_client=s3_bucket,
        )

        # カテゴリ別件数
        assert result["output"] == 2  # sample_0.json, sample_1.json
        assert result["results"] == 4  # md, csv, html, pdf
        assert result["visualizations"] == 2  # 2 jpgs
        assert result["logs"] == 1  # process_log.jsonl

        # 実際のキーが正しく配置されていること
        listed = s3_bucket.list_objects_v2(
            Bucket=BUCKET, Prefix=f"batches/{BATCH_ID}/"
        )
        keys = sorted(obj["Key"] for obj in listed.get("Contents", []))
        assert f"batches/{BATCH_ID}/output/sample_0.json" in keys
        assert f"batches/{BATCH_ID}/output/sample_1.json" in keys
        assert f"batches/{BATCH_ID}/results/sample_0.md" in keys
        assert f"batches/{BATCH_ID}/results/sample_0.csv" in keys
        assert f"batches/{BATCH_ID}/results/sample_0.html" in keys
        assert f"batches/{BATCH_ID}/results/sample_0.pdf" in keys
        assert (
            f"batches/{BATCH_ID}/visualizations/sample_0_layout_page_0.jpg" in keys
        )
        assert f"batches/{BATCH_ID}/visualizations/sample_0_ocr_page_0.jpg" in keys
        assert f"batches/{BATCH_ID}/logs/process_log.jsonl" in keys

    def test_empty_output_dir_uploads_nothing(self, s3_bucket, tmp_dirs):
        _, output_dir = tmp_dirs
        import s3_sync

        result = s3_sync.upload_outputs(
            bucket=BUCKET,
            batch_job_id=BATCH_ID,
            output_dir=str(output_dir),
            s3_client=s3_bucket,
        )
        assert result == {"output": 0, "results": 0, "visualizations": 0, "logs": 0}

    def test_tags_match_lifecycle_filters(self, s3_bucket, tmp_dirs):
        """各カテゴリは ProcessingStack の lifecycle tagFilter と整合するタグを付与する。

        ProcessingStack の `batch-content-type` タグ値:
          - logs/* → "log"
          - visualizations/* → "visualization"
          - results/* → "result"
          - output/* → タグなし (ライフサイクル対象外で常時保持)
        """
        _, output_dir = tmp_dirs
        (output_dir / "process_log.jsonl").write_text("{}\n")
        (output_dir / "sample.jpg").write_bytes(b"\xff\xd8")
        (output_dir / "sample.md").write_text("# x")
        (output_dir / "sample.json").write_text("{}")

        import s3_sync

        s3_sync.upload_outputs(
            bucket=BUCKET,
            batch_job_id=BATCH_ID,
            output_dir=str(output_dir),
            s3_client=s3_bucket,
        )

        def _tags(key: str) -> dict[str, str]:
            response = s3_bucket.get_object_tagging(Bucket=BUCKET, Key=key)
            return {t["Key"]: t["Value"] for t in response["TagSet"]}

        assert _tags(f"batches/{BATCH_ID}/logs/process_log.jsonl") == {
            "batch-content-type": "log"
        }
        assert _tags(f"batches/{BATCH_ID}/visualizations/sample.jpg") == {
            "batch-content-type": "visualization"
        }
        assert _tags(f"batches/{BATCH_ID}/results/sample.md") == {
            "batch-content-type": "result"
        }
        # output/*.json はタグなし (長期保持)
        assert _tags(f"batches/{BATCH_ID}/output/sample.json") == {}
