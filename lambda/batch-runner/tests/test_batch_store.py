"""Tests for batch_store.py: DDB BatchTable 更新ヘルパー。

moto で DynamoDB テーブルを立ち上げ、`lambda/api/lib/batch-store.ts` と
同じスキーマで FILE/META アイテムを操作できることを検証する。
"""

from __future__ import annotations

import sys
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).parent.parent))


BATCH_TABLE = "TestBatchTable"
BATCH_ID = "batch-xyz-001"


def _create_batch_table():
    """TypeScript 側 `lib/processing-stack.ts` の BatchTable 相当を作成する。"""
    client = boto3.resource("dynamodb", region_name="us-east-1")
    client.create_table(
        TableName=BATCH_TABLE,
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
    return client.Table(BATCH_TABLE)


def _seed_batch(table, batch_id: str, files: list[str], status: str = "PROCESSING"):
    """META + FILE アイテムを PROCESSING 状態で投入する。"""
    table.put_item(Item={
        "PK": f"BATCH#{batch_id}",
        "SK": "META",
        "entityType": "BATCH",
        "batchJobId": batch_id,
        "status": status,
        "batchLabel": "samples",
        "totals": {"total": len(files), "succeeded": 0, "failed": 0, "inProgress": len(files)},
        "createdAt": "2026-04-22T09:00:00.000Z",
        "updatedAt": "2026-04-22T09:00:00.000Z",
        "startedAt": "2026-04-22T09:05:00.000Z",
        "parentBatchJobId": None,
        "GSI1PK": f"STATUS#{status}#202604",
        "GSI1SK": "2026-04-22T09:00:00.000Z",
    })
    for fname in files:
        fk = f"batches/{batch_id}/input/{fname}"
        table.put_item(Item={
            "PK": f"BATCH#{batch_id}",
            "SK": f"FILE#{fk}",
            "entityType": "FILE",
            "batchJobId": batch_id,
            "fileKey": fk,
            "filename": fname,
            "status": "PENDING",
            "updatedAt": "2026-04-22T09:00:00.000Z",
        })


# ---------------------------------------------------------------------------
# update_file_result
# ---------------------------------------------------------------------------


class TestUpdateFileResult:
    def test_marks_file_completed_with_attributes(self):
        with mock_aws():
            table = _create_batch_table()
            _seed_batch(table, BATCH_ID, ["a.pdf"])

            import batch_store

            updated = batch_store.update_file_result(
                table=table,
                batch_job_id=BATCH_ID,
                file_key=f"batches/{BATCH_ID}/input/a.pdf",
                status="COMPLETED",
                dpi=200,
                processing_time_ms=5432,
                result_key=f"batches/{BATCH_ID}/output/a.json",
            )
            assert updated is True

            resp = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/a.pdf",
            })
            item = resp["Item"]
            assert item["status"] == "COMPLETED"
            assert int(item["dpi"]) == 200
            assert int(item["processingTimeMs"]) == 5432
            assert item["resultKey"] == f"batches/{BATCH_ID}/output/a.json"

    def test_marks_file_failed_with_error_message(self):
        with mock_aws():
            table = _create_batch_table()
            _seed_batch(table, BATCH_ID, ["b.pdf"])

            import batch_store

            updated = batch_store.update_file_result(
                table=table,
                batch_job_id=BATCH_ID,
                file_key=f"batches/{BATCH_ID}/input/b.pdf",
                status="FAILED",
                error_message="SageMaker timeout",
            )
            assert updated is True

            item = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/b.pdf",
            })["Item"]
            assert item["status"] == "FAILED"
            assert item["errorMessage"] == "SageMaker timeout"

    def test_skips_update_when_already_completed(self):
        with mock_aws():
            table = _create_batch_table()
            _seed_batch(table, BATCH_ID, ["c.pdf"])
            import batch_store

            # 先に COMPLETED にする
            batch_store.update_file_result(
                table=table, batch_job_id=BATCH_ID,
                file_key=f"batches/{BATCH_ID}/input/c.pdf",
                status="COMPLETED",
            )
            # 2 回目 (FAILED で上書き試行) はスキップされる
            updated = batch_store.update_file_result(
                table=table, batch_job_id=BATCH_ID,
                file_key=f"batches/{BATCH_ID}/input/c.pdf",
                status="FAILED",
                error_message="should not overwrite",
            )
            assert updated is False
            item = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/c.pdf",
            })["Item"]
            assert item["status"] == "COMPLETED"
            assert "errorMessage" not in item

    def test_writes_error_category_when_provided(self):
        """error_category 引数が渡されたら DDB の errorCategory 属性に書く (R4.2)。"""
        with mock_aws():
            table = _create_batch_table()
            _seed_batch(table, BATCH_ID, ["d.pdf"])
            import batch_store

            updated = batch_store.update_file_result(
                table=table,
                batch_job_id=BATCH_ID,
                file_key=f"batches/{BATCH_ID}/input/d.pdf",
                status="FAILED",
                error_message="encrypted PDF",
                error_category="CONVERSION_FAILED",
            )
            assert updated is True

            item = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/d.pdf",
            })["Item"]
            assert item["status"] == "FAILED"
            assert item["errorCategory"] == "CONVERSION_FAILED"

    def test_omits_error_category_when_none(self):
        """error_category=None (デフォルト) の場合は errorCategory 属性を書かない (R4.2)。"""
        with mock_aws():
            table = _create_batch_table()
            _seed_batch(table, BATCH_ID, ["e.pdf"])
            import batch_store

            updated = batch_store.update_file_result(
                table=table,
                batch_job_id=BATCH_ID,
                file_key=f"batches/{BATCH_ID}/input/e.pdf",
                status="COMPLETED",
                dpi=200,
            )
            assert updated is True

            item = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/e.pdf",
            })["Item"]
            assert item["status"] == "COMPLETED"
            # 明示しない限り errorCategory 属性は書かれない (TS 側 batch-store.ts と同じ契約)
            assert "errorCategory" not in item


# ---------------------------------------------------------------------------
# transition_batch_status
# ---------------------------------------------------------------------------


class TestTransitionBatchStatus:
    def test_updates_meta_status_and_gsi1pk(self):
        with mock_aws():
            table = _create_batch_table()
            _seed_batch(table, BATCH_ID, ["a.pdf"], status="PROCESSING")
            import batch_store

            batch_store.transition_batch_status(
                table=table,
                batch_job_id=BATCH_ID,
                new_status="COMPLETED",
                expected_current="PROCESSING",
                totals={"total": 1, "succeeded": 1, "failed": 0, "inProgress": 0},
            )
            item = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}", "SK": "META"
            })["Item"]
            assert item["status"] == "COMPLETED"
            assert item["GSI1PK"].startswith("STATUS#COMPLETED#")
            assert int(item["totals"]["succeeded"]) == 1
            # PENDING 以外への遷移で ttl は残っていてはいけない (元々なかった場合は無視)

    def test_conflict_when_expected_current_mismatch(self):
        with mock_aws():
            table = _create_batch_table()
            _seed_batch(table, BATCH_ID, ["a.pdf"], status="COMPLETED")
            import batch_store

            with pytest.raises(batch_store.ConflictError):
                batch_store.transition_batch_status(
                    table=table,
                    batch_job_id=BATCH_ID,
                    new_status="PARTIAL",
                    expected_current="PROCESSING",
                )


# ---------------------------------------------------------------------------
# apply_process_log + finalize_batch_status
# ---------------------------------------------------------------------------


class TestApplyProcessLog:
    def test_applies_all_entries_and_returns_totals(self):
        from process_log_reader import ProcessLogEntry
        with mock_aws():
            table = _create_batch_table()
            _seed_batch(table, BATCH_ID, ["a.pdf", "b.pdf", "c.pdf"])
            import batch_store

            entries = [
                ProcessLogEntry(
                    file_path="/tmp/input/a.pdf", filename="a.pdf",
                    success=True, dpi=200,
                    output_path="/tmp/output/a.json",
                ),
                ProcessLogEntry(
                    file_path="/tmp/input/b.pdf", filename="b.pdf",
                    success=False, error="boom",
                ),
                ProcessLogEntry(
                    file_path="/tmp/input/c.pdf", filename="c.pdf",
                    success=True, dpi=200,
                    output_path="/tmp/output/c.json",
                ),
            ]
            totals = batch_store.apply_process_log(
                table=table, batch_job_id=BATCH_ID, entries=entries,
            )
            assert totals == {"succeeded": 2, "failed": 1, "skipped": 0}

            a_item = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/a.pdf",
            })["Item"]
            assert a_item["status"] == "COMPLETED"
            assert a_item["resultKey"] == f"batches/{BATCH_ID}/output/a.json"
            b_item = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/b.pdf",
            })["Item"]
            assert b_item["status"] == "FAILED"
            assert b_item["errorMessage"] == "boom"

    def test_preserves_explicit_conversion_failed_and_derives_ocr_failed(self):
        """error_category 派生規則 (R4.2 / R4.3):

        - success=False かつ error_category="CONVERSION_FAILED" → そのまま CONVERSION_FAILED
        - success=False かつ error_category=None → "OCR_FAILED" に正規化
        - success=True → errorCategory 属性は書かない (overwrite しない)
        """
        from process_log_reader import ProcessLogEntry
        with mock_aws():
            table = _create_batch_table()
            _seed_batch(table, BATCH_ID, ["conv.pdf", "ocr.pdf", "ok.pdf"])
            import batch_store

            entries = [
                # 1. 変換失敗: error_category=CONVERSION_FAILED → そのまま採用
                ProcessLogEntry(
                    file_path="/tmp/input/conv.pdf", filename="conv.pdf",
                    success=False, error="encrypted",
                    error_category="CONVERSION_FAILED",
                ),
                # 2. OCR 失敗: error_category=None → OCR_FAILED に正規化
                ProcessLogEntry(
                    file_path="/tmp/input/ocr.pdf", filename="ocr.pdf",
                    success=False, error="SageMaker timeout",
                    error_category=None,
                ),
                # 3. 成功: errorCategory 属性は書かれない
                ProcessLogEntry(
                    file_path="/tmp/input/ok.pdf", filename="ok.pdf",
                    success=True, dpi=200,
                    output_path="/tmp/output/ok.json",
                ),
            ]
            totals = batch_store.apply_process_log(
                table=table, batch_job_id=BATCH_ID, entries=entries,
            )
            assert totals == {"succeeded": 1, "failed": 2, "skipped": 0}

            conv_item = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/conv.pdf",
            })["Item"]
            assert conv_item["status"] == "FAILED"
            assert conv_item["errorCategory"] == "CONVERSION_FAILED"
            assert conv_item["errorMessage"] == "encrypted"

            ocr_item = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/ocr.pdf",
            })["Item"]
            assert ocr_item["status"] == "FAILED"
            assert ocr_item["errorCategory"] == "OCR_FAILED"
            assert ocr_item["errorMessage"] == "SageMaker timeout"

            ok_item = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/ok.pdf",
            })["Item"]
            assert ok_item["status"] == "COMPLETED"
            assert "errorCategory" not in ok_item


class TestFinalizeBatchStatus:
    def test_all_success_transitions_to_completed(self):
        with mock_aws():
            table = _create_batch_table()
            _seed_batch(table, BATCH_ID, ["a.pdf", "b.pdf"])
            import batch_store

            status = batch_store.finalize_batch_status(
                table=table, batch_job_id=BATCH_ID,
                total_files=2, succeeded=2, failed=0,
            )
            assert status == "COMPLETED"
            meta = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}", "SK": "META"
            })["Item"]
            assert meta["status"] == "COMPLETED"

    def test_mixed_transitions_to_partial(self):
        with mock_aws():
            table = _create_batch_table()
            _seed_batch(table, BATCH_ID, ["a.pdf", "b.pdf"])
            import batch_store

            status = batch_store.finalize_batch_status(
                table=table, batch_job_id=BATCH_ID,
                total_files=2, succeeded=1, failed=1,
            )
            assert status == "PARTIAL"
            meta = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}", "SK": "META"
            })["Item"]
            assert meta["status"] == "PARTIAL"
            assert int(meta["totals"]["succeeded"]) == 1
            assert int(meta["totals"]["failed"]) == 1

    def test_all_failed_transitions_to_failed(self):
        with mock_aws():
            table = _create_batch_table()
            _seed_batch(table, BATCH_ID, ["a.pdf"])
            import batch_store

            status = batch_store.finalize_batch_status(
                table=table, batch_job_id=BATCH_ID,
                total_files=1, succeeded=0, failed=1,
            )
            assert status == "FAILED"

    def test_infra_interruption_all_zero_transitions_to_failed(self):
        """インフラ中断で process_log が空 = succeeded=0, failed=0 も FAILED 扱い。"""
        with mock_aws():
            table = _create_batch_table()
            _seed_batch(table, BATCH_ID, ["a.pdf", "b.pdf"])
            import batch_store

            status = batch_store.finalize_batch_status(
                table=table, batch_job_id=BATCH_ID,
                total_files=2, succeeded=0, failed=0,
            )
            assert status == "FAILED"
