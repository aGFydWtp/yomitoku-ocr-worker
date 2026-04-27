"""Tests for process_log_reader.py: process_log.jsonl 読み込み。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))


class TestReadProcessLog:
    def test_parses_each_jsonl_line_into_entry(self, tmp_path):
        from process_log_reader import read_process_log

        log = tmp_path / "process_log.jsonl"
        log.write_text(
            json.dumps({
                "timestamp": "2026-04-22T10:00:00Z",
                "file_path": "/tmp/input/a.pdf",
                "output_path": "/tmp/output/a.json",
                "dpi": 200,
                "executed": True,
                "success": True,
            }) + "\n"
            + json.dumps({
                "timestamp": "2026-04-22T10:01:00Z",
                "file_path": "/tmp/input/b.pdf",
                "output_path": None,
                "dpi": 200,
                "executed": True,
                "success": False,
                "error": "SageMaker timeout",
            }) + "\n"
        )

        entries = list(read_process_log(str(log)))
        assert len(entries) == 2
        assert entries[0].filename == "a.pdf"
        assert entries[0].success is True
        assert entries[0].dpi == 200
        assert entries[0].output_path == "/tmp/output/a.json"
        assert entries[1].filename == "b.pdf"
        assert entries[1].success is False
        assert entries[1].error == "SageMaker timeout"

    def test_returns_empty_when_log_missing(self, tmp_path):
        from process_log_reader import read_process_log

        entries = list(read_process_log(str(tmp_path / "nonexistent.jsonl")))
        assert entries == []

    def test_skips_blank_lines_and_malformed_json(self, tmp_path):
        from process_log_reader import read_process_log

        log = tmp_path / "process_log.jsonl"
        log.write_text(
            "\n"
            + json.dumps({"file_path": "a.pdf", "success": True}) + "\n"
            + "not-json-at-all\n"
            + json.dumps({"file_path": "b.pdf", "success": False}) + "\n"
        )
        entries = list(read_process_log(str(log)))
        assert [e.filename for e in entries] == ["a.pdf", "b.pdf"]

    def test_reads_error_category_when_present(self, tmp_path):
        from process_log_reader import read_process_log

        log = tmp_path / "process_log.jsonl"
        log.write_text(
            json.dumps({
                "timestamp": "2026-04-22T10:00:00Z",
                "file_path": "/tmp/input/broken.pdf",
                "output_path": None,
                "dpi": 200,
                "executed": True,
                "success": False,
                "error": "PDF parser raised",
                "error_category": "pdf_parse_error",
            }) + "\n"
        )

        entries = list(read_process_log(str(log)))
        assert len(entries) == 1
        assert entries[0].success is False
        assert entries[0].error_category == "pdf_parse_error"

    def test_legacy_log_without_error_category_yields_none(self, tmp_path):
        """旧形式 (error_category フィールド無し) の jsonl 行も例外を出さず読める。"""
        from process_log_reader import ProcessLogEntry, read_process_log

        log = tmp_path / "process_log.jsonl"
        log.write_text(
            json.dumps({
                "timestamp": "2026-04-22T10:00:00Z",
                "file_path": "/tmp/input/old.pdf",
                "output_path": "/tmp/output/old.json",
                "dpi": 200,
                "executed": True,
                "success": True,
            }) + "\n"
        )

        entries = list(read_process_log(str(log)))
        assert len(entries) == 1
        assert isinstance(entries[0], ProcessLogEntry)
        assert entries[0].error_category is None
