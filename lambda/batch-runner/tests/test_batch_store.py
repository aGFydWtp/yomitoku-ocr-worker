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
                result_key=f"batches/{BATCH_ID}/output/a.pdf.json",
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
            assert item["resultKey"] == f"batches/{BATCH_ID}/output/a.pdf.json"

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

    def test_does_not_create_orphan_file_when_pk_missing(self):
        """attribute_exists(PK) 条件: 未seed の FILE PK に対する update は False
        を返してスキップし、orphan FILE 行を作らない (Codex defense-in-depth)。

        本来の bug は ``apply_process_log`` の filename mismatch (.pptx → .pdf)
        だが、本テストは下流ガードとして ``update_file_result`` 単体が orphan
        upsert を起こさないことを保証する。これにより将来 mapping 漏れが起き
        ても silent な orphan 行ではなく、テスト / ログで早期に検知できる。
        """
        with mock_aws():
            table = _create_batch_table()
            _seed_batch(table, BATCH_ID, ["seeded.pdf"])
            import batch_store

            # seeded.pdf は table に存在するが、ghost.pdf は存在しない
            updated = batch_store.update_file_result(
                table=table, batch_job_id=BATCH_ID,
                file_key=f"batches/{BATCH_ID}/input/ghost.pdf",
                status="COMPLETED",
                result_key=f"batches/{BATCH_ID}/output/ghost.pdf.json",
            )
            # 既存行が無いため ConditionalCheckFailedException → False
            assert updated is False
            # orphan 行が作られていないことを確認 (= GetItem で見つからない)
            response = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/ghost.pdf",
            })
            assert "Item" not in response

            # 既存の seeded.pdf には影響なし (PENDING のまま)
            seeded = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/seeded.pdf",
            })["Item"]
            assert seeded["status"] == "PENDING"

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
                    output_path="/tmp/output/a.pdf.json",
                ),
                ProcessLogEntry(
                    file_path="/tmp/input/b.pdf", filename="b.pdf",
                    success=False, error="boom",
                ),
                ProcessLogEntry(
                    file_path="/tmp/input/c.pdf", filename="c.pdf",
                    success=True, dpi=200,
                    output_path="/tmp/output/c.pdf.json",
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
            assert a_item["resultKey"] == f"batches/{BATCH_ID}/output/a.pdf.json"
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
                    output_path="/tmp/output/ok.pdf.json",
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


class TestApplyProcessLogConvertedFilenameMap:
    """Bug 001: filename mismatch fix.

    When ``convert_office_files`` succeeds, ``yomitoku-client`` writes the
    converted PDF basename (e.g. ``deck.pdf``) to ``process_log.jsonl``. The
    seeded DDB FILE row, however, lives under the **original** filename
    (e.g. ``deck.pptx``). Without the rewrite, ``apply_process_log`` upserts a
    new ``deck.pdf`` row and leaves the original ``deck.pptx`` row PENDING
    forever (= phantom FILE row, R3.3 totals violation).

    These tests assert the rewrite happens via the new
    ``converted_filename_map`` parameter.
    """

    def test_rewrites_converted_pdf_back_to_original_office_filename(self):
        from process_log_reader import ProcessLogEntry

        with mock_aws():
            table = _create_batch_table()
            # Seed deck.pptx (the original) — NOT deck.pdf
            _seed_batch(table, BATCH_ID, ["deck.pptx"])
            import batch_store

            entries = [
                # process_log says deck.pdf (= post-conversion local file) but
                # async_invoker は local_to_original 経由で原本 deck.pptx 名で
                # JSON を書く。よって output_path は deck.pptx.json (新仕様 R1.2)
                ProcessLogEntry(
                    file_path="/tmp/input/deck.pdf",
                    filename="deck.pdf",
                    success=True,
                    dpi=200,
                    output_path="/tmp/output/deck.pptx.json",
                ),
            ]
            totals = batch_store.apply_process_log(
                table=table,
                batch_job_id=BATCH_ID,
                entries=entries,
                converted_filename_map={"deck.pdf": "deck.pptx"},
            )
            assert totals == {"succeeded": 1, "failed": 0, "skipped": 0}

            # Original deck.pptx row is now COMPLETED
            deck_pptx = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/deck.pptx",
            })["Item"]
            assert deck_pptx["status"] == "COMPLETED"
            # 新仕様 (R1.2): resultKey は原本 Office 名 (`deck.pptx.json`) を指す。
            # 変換後 PDF basename ではなく、async_invoker で原本ファイル名を
            # local_to_original 経由で書き戻した結果。
            assert deck_pptx["resultKey"] == (
                f"batches/{BATCH_ID}/output/deck.pptx.json"
            )

            # No phantom deck.pdf row
            deck_pdf_resp = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/deck.pdf",
            })
            assert "Item" not in deck_pdf_resp, (
                "phantom deck.pdf row created — converted_filename_map "
                "should have rewritten the PK back to deck.pptx"
            )

    def test_unmapped_filename_falls_through_unchanged(self):
        """Pure PDF entries (not in the map) must not be rewritten."""
        from process_log_reader import ProcessLogEntry

        with mock_aws():
            table = _create_batch_table()
            _seed_batch(table, BATCH_ID, ["report.pdf"])
            import batch_store

            entries = [
                ProcessLogEntry(
                    file_path="/tmp/input/report.pdf",
                    filename="report.pdf",
                    success=True,
                    dpi=200,
                    output_path="/tmp/output/report.pdf.json",
                ),
            ]
            totals = batch_store.apply_process_log(
                table=table,
                batch_job_id=BATCH_ID,
                entries=entries,
                converted_filename_map={"deck.pdf": "deck.pptx"},
            )
            assert totals == {"succeeded": 1, "failed": 0, "skipped": 0}

            report_item = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/report.pdf",
            })["Item"]
            assert report_item["status"] == "COMPLETED"

    def test_omitted_map_preserves_legacy_behavior(self):
        """Backward compat: no map (or None) leaves filename untouched."""
        from process_log_reader import ProcessLogEntry

        with mock_aws():
            table = _create_batch_table()
            _seed_batch(table, BATCH_ID, ["a.pdf"])
            import batch_store

            entries = [
                ProcessLogEntry(
                    file_path="/tmp/input/a.pdf",
                    filename="a.pdf",
                    success=True,
                    dpi=200,
                    output_path="/tmp/output/a.pdf.json",
                ),
            ]
            # No converted_filename_map argument
            totals = batch_store.apply_process_log(
                table=table, batch_job_id=BATCH_ID, entries=entries,
            )
            assert totals == {"succeeded": 1, "failed": 0, "skipped": 0}
            a = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/a.pdf",
            })["Item"]
            assert a["status"] == "COMPLETED"

    def test_mixed_batch_with_pdf_and_converted_pptx(self):
        """report.pdf (no rewrite) + deck.pptx (rewrite from deck.pdf) +
        broken.pptx (CONVERSION_FAILED, original name kept)."""
        from process_log_reader import ProcessLogEntry

        with mock_aws():
            table = _create_batch_table()
            _seed_batch(table, BATCH_ID, [
                "report.pdf", "deck.pptx", "broken.pptx",
            ])
            import batch_store

            entries = [
                # CONVERSION_FAILED row (written by main._append_conversion_failures_to_log)
                # — keeps the original .pptx name
                ProcessLogEntry(
                    file_path="/tmp/input/broken.pptx",
                    filename="broken.pptx",
                    success=False,
                    error="encrypted",
                    error_category="CONVERSION_FAILED",
                ),
                # OCR success rows from async_invoker (新仕様 {原本名}.json):
                # report.pdf は native PDF → report.pdf.json
                # deck.pdf は変換後 → 原本 deck.pptx 名で deck.pptx.json
                ProcessLogEntry(
                    file_path="/tmp/input/report.pdf",
                    filename="report.pdf",
                    success=True,
                    dpi=200,
                    output_path="/tmp/output/report.pdf.json",
                ),
                ProcessLogEntry(
                    file_path="/tmp/input/deck.pdf",  # post-conversion local file
                    filename="deck.pdf",
                    success=True,
                    dpi=200,
                    output_path="/tmp/output/deck.pptx.json",
                ),
            ]
            totals = batch_store.apply_process_log(
                table=table,
                batch_job_id=BATCH_ID,
                entries=entries,
                converted_filename_map={"deck.pdf": "deck.pptx"},
            )
            assert totals == {"succeeded": 2, "failed": 1, "skipped": 0}

            # All 3 original rows are touched (no phantom rows)
            report_item = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/report.pdf",
            })["Item"]
            assert report_item["status"] == "COMPLETED"

            deck_pptx_item = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/deck.pptx",
            })["Item"]
            assert deck_pptx_item["status"] == "COMPLETED"
            assert deck_pptx_item["resultKey"] == (
                f"batches/{BATCH_ID}/output/deck.pptx.json"
            )

            broken_item = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/broken.pptx",
            })["Item"]
            assert broken_item["status"] == "FAILED"
            assert broken_item["errorCategory"] == "CONVERSION_FAILED"

            # No phantom deck.pdf
            phantom = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/deck.pdf",
            })
            assert "Item" not in phantom


class TestResultKeyExtensionPreservation:
    """Task 4.1 (a): result-filename-extension-preservation の resultKey 全形式検証。

    PDF / PPTX / DOCX / XLSX + 変換失敗 PPTX が混在するバッチで、各 FILE の
    resultKey が新仕様 ``{原本ファイル名}.json`` で書き込まれることを assert。
    変換失敗ファイルは resultKey 未設定 + errorCategory=CONVERSION_FAILED を確認
    (R1.1, R1.2, R1.3, R1.5, R3.1)。
    """

    def test_all_office_formats_get_extension_preserved_result_key(self):
        from process_log_reader import ProcessLogEntry

        with mock_aws():
            table = _create_batch_table()
            _seed_batch(table, BATCH_ID, [
                "report.pdf",   # native PDF
                "deck.pptx",    # PPTX → 変換成功
                "memo.docx",    # DOCX → 変換成功
                "sheet.xlsx",   # XLSX → 変換成功
                "broken.pptx",  # PPTX → 変換失敗
            ])
            import batch_store

            entries = [
                ProcessLogEntry(
                    file_path="/tmp/input/broken.pptx",
                    filename="broken.pptx",
                    success=False,
                    error="encrypted PPTX",
                    error_category="CONVERSION_FAILED",
                ),
                ProcessLogEntry(
                    file_path="/tmp/input/report.pdf",
                    filename="report.pdf",
                    success=True, dpi=200,
                    output_path="/tmp/output/report.pdf.json",
                ),
                ProcessLogEntry(
                    file_path="/tmp/input/deck.pdf",
                    filename="deck.pdf",
                    success=True, dpi=200,
                    output_path="/tmp/output/deck.pptx.json",
                ),
                ProcessLogEntry(
                    file_path="/tmp/input/memo.pdf",
                    filename="memo.pdf",
                    success=True, dpi=200,
                    output_path="/tmp/output/memo.docx.json",
                ),
                ProcessLogEntry(
                    file_path="/tmp/input/sheet.pdf",
                    filename="sheet.pdf",
                    success=True, dpi=200,
                    output_path="/tmp/output/sheet.xlsx.json",
                ),
            ]
            totals = batch_store.apply_process_log(
                table=table, batch_job_id=BATCH_ID, entries=entries,
                converted_filename_map={
                    "deck.pdf": "deck.pptx",
                    "memo.pdf": "memo.docx",
                    "sheet.pdf": "sheet.xlsx",
                },
            )
            assert totals == {"succeeded": 4, "failed": 1, "skipped": 0}

            # 各原本ファイル行で resultKey 値が新仕様であることを assert
            expected = {
                "report.pdf": "report.pdf.json",
                "deck.pptx": "deck.pptx.json",
                "memo.docx": "memo.docx.json",
                "sheet.xlsx": "sheet.xlsx.json",
            }
            for orig_filename, expected_basename in expected.items():
                item = table.get_item(Key={
                    "PK": f"BATCH#{BATCH_ID}",
                    "SK": f"FILE#batches/{BATCH_ID}/input/{orig_filename}",
                })["Item"]
                assert item["status"] == "COMPLETED"
                assert item["resultKey"] == (
                    f"batches/{BATCH_ID}/output/{expected_basename}"
                )

            # 変換失敗 PPTX は resultKey 未設定 + errorCategory=CONVERSION_FAILED
            broken = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/broken.pptx",
            })["Item"]
            assert broken["status"] == "FAILED"
            assert broken["errorCategory"] == "CONVERSION_FAILED"
            assert "resultKey" not in broken


class TestPreExistingResultKeyImmutability:
    """Task 4.1 (c): R5.1 / R5.2 ガード — 既存バッチ非影響の検証。

    旧フォーマット ``{stem}.json`` の resultKey を持つ既存 FILE 行が、
    別バッチで新仕様の ``apply_process_log`` を実行したときに、
    遡及的に書き換えられないことを assert (R5.1: S3 オブジェクト遡及リネーム
    なし / R5.2: DDB resultKey 値遡及更新なし)。
    """

    def test_existing_batch_legacy_result_key_unchanged_after_new_batch(self):
        from process_log_reader import ProcessLogEntry

        legacy_batch_id = "old-batch-001"
        new_batch_id = "new-batch-002"

        with mock_aws():
            table = _create_batch_table()
            # 1. 既存 (旧仕様デプロイ前) のバッチを seed: report.pdf に
            #    旧フォーマット resultKey が既に書かれている
            _seed_batch(table, legacy_batch_id, ["report.pdf"])
            import batch_store
            batch_store.update_file_result(
                table=table, batch_job_id=legacy_batch_id,
                file_key=f"batches/{legacy_batch_id}/input/report.pdf",
                status="COMPLETED",
                dpi=200,
                processing_time_ms=1000,
                # legacy-on-purpose: R5.1/R5.2 検証用の旧フォーマット (stem ベース)
                # 値を意図的に DDB に書き込み、新仕様 deploy 後の遡及更新が
                # 起きないことを確認する。本リテラルは契約ガードの除外対象。
                result_key=f"batches/{legacy_batch_id}/output/report.json",  # legacy-on-purpose
            )

            # 2. 別の新規バッチを seed して新仕様で apply_process_log を実行
            _seed_batch(table, new_batch_id, ["report.pdf"])
            entries = [
                ProcessLogEntry(
                    file_path="/tmp/input/report.pdf",
                    filename="report.pdf",
                    success=True, dpi=200,
                    output_path="/tmp/output/report.pdf.json",
                ),
            ]
            totals = batch_store.apply_process_log(
                table=table, batch_job_id=new_batch_id, entries=entries,
            )
            assert totals == {"succeeded": 1, "failed": 0, "skipped": 0}

            # 3. 既存バッチの resultKey 値が unchanged (= 旧フォーマットのまま) を assert
            legacy = table.get_item(Key={
                "PK": f"BATCH#{legacy_batch_id}",
                "SK": f"FILE#batches/{legacy_batch_id}/input/report.pdf",
            })["Item"]
            assert legacy["resultKey"] == (
                f"batches/{legacy_batch_id}/output/report.json"  # legacy-on-purpose
            ), (
                "R5.2 違反: 既存バッチの resultKey が遡及更新された "
                f"(現値: {legacy.get('resultKey')})"
            )

            # 4. 新規バッチは新仕様で書かれている
            new = table.get_item(Key={
                "PK": f"BATCH#{new_batch_id}",
                "SK": f"FILE#batches/{new_batch_id}/input/report.pdf",
            })["Item"]
            assert new["resultKey"] == (
                f"batches/{new_batch_id}/output/report.pdf.json"
            )


class TestPendingProcessingFilesHaveNoResultKey:
    """Task 4.1 / R3.3: PENDING / PROCESSING 状態の FILE で resultKey 属性が
    存在しないことを assert。``_seed_batch`` 直後の PENDING 行は resultKey が
    未設定 (optional default 動作) であることを契約としてテストする。
    """

    def test_pending_file_has_no_result_key_attribute(self):
        with mock_aws():
            table = _create_batch_table()
            _seed_batch(table, BATCH_ID, ["pending.pdf"])

            item = table.get_item(Key={
                "PK": f"BATCH#{BATCH_ID}",
                "SK": f"FILE#batches/{BATCH_ID}/input/pending.pdf",
            })["Item"]
            assert item["status"] == "PENDING"
            assert "resultKey" not in item


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
