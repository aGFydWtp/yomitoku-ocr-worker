"""Tests for settings.py: BatchRunnerSettings dataclass."""

from __future__ import annotations

import os
from dataclasses import fields

import pytest


class TestBatchRunnerSettings:
    """settings.py の BatchRunnerSettings dataclass のテスト。"""

    def _import_settings(self):
        """遅延インポートにより環境変数の影響を分離する。"""
        import importlib
        import sys

        # キャッシュをクリアして再インポート
        sys.modules.pop("settings", None)
        import settings as m

        importlib.reload(m)
        return m.BatchRunnerSettings

    def setup_method(self):
        """各テスト前に環境変数を初期化する。"""
        self.required_env = {
            "BATCH_JOB_ID": "test-batch-001",
            "BUCKET_NAME": "test-bucket",
            "BATCH_TABLE_NAME": "BatchTable",
            "CONTROL_TABLE_NAME": "ControlTable",
            "ENDPOINT_NAME": "yomitoku-endpoint",
        }
        for key, val in self.required_env.items():
            os.environ[key] = val

    def teardown_method(self):
        """テスト後に環境変数を削除する。"""
        all_keys = [
            "BATCH_JOB_ID",
            "BUCKET_NAME",
            "BATCH_TABLE_NAME",
            "CONTROL_TABLE_NAME",
            "ENDPOINT_NAME",
            "MAX_FILE_CONCURRENCY",
            "MAX_PAGE_CONCURRENCY",
            "MAX_RETRIES",
            "READ_TIMEOUT",
            "CIRCUIT_THRESHOLD",
            "CIRCUIT_COOLDOWN",
            "BATCH_MAX_DURATION_SEC",
            "EXTRA_FORMATS",
        ]
        for key in all_keys:
            os.environ.pop(key, None)

    def test_required_fields_loaded(self):
        """必須環境変数が正しく読み込まれる。"""
        import sys
        sys.path.insert(0, str(pytest.importorskip("pathlib").Path(__file__).parent.parent))
        import importlib
        sys.modules.pop("settings", None)
        import settings
        importlib.reload(settings)

        s = settings.BatchRunnerSettings.from_env()
        assert s.batch_job_id == "test-batch-001"
        assert s.bucket_name == "test-bucket"
        assert s.batch_table_name == "BatchTable"
        assert s.control_table_name == "ControlTable"
        assert s.endpoint_name == "yomitoku-endpoint"

    def test_optional_fields_have_defaults(self):
        """省略可能フィールドはデフォルト値を持つ。"""
        import sys
        sys.path.insert(0, str(pytest.importorskip("pathlib").Path(__file__).parent.parent))
        import importlib
        sys.modules.pop("settings", None)
        import settings
        importlib.reload(settings)

        s = settings.BatchRunnerSettings.from_env()
        assert s.max_file_concurrency >= 1
        assert s.max_page_concurrency >= 1
        assert s.max_retries >= 1
        assert s.read_timeout > 0
        assert s.circuit_threshold >= 1
        assert s.circuit_cooldown > 0
        assert s.batch_max_duration_sec > 0
        assert isinstance(s.extra_formats, list)

    def test_extra_formats_parsed_from_env(self):
        """EXTRA_FORMATS 環境変数がカンマ区切りでパースされる。"""
        os.environ["EXTRA_FORMATS"] = "markdown,csv,html"
        import sys
        sys.path.insert(0, str(pytest.importorskip("pathlib").Path(__file__).parent.parent))
        import importlib
        sys.modules.pop("settings", None)
        import settings
        importlib.reload(settings)

        s = settings.BatchRunnerSettings.from_env()
        assert s.extra_formats == ["markdown", "csv", "html"]

    def test_extra_formats_empty_when_not_set(self):
        """EXTRA_FORMATS 未設定時は空リストになる。"""
        os.environ.pop("EXTRA_FORMATS", None)
        import sys
        sys.path.insert(0, str(pytest.importorskip("pathlib").Path(__file__).parent.parent))
        import importlib
        sys.modules.pop("settings", None)
        import settings
        importlib.reload(settings)

        s = settings.BatchRunnerSettings.from_env()
        assert s.extra_formats == []

    def test_missing_required_raises_value_error(self):
        """必須環境変数が欠けると ValueError を送出する。"""
        os.environ.pop("BATCH_JOB_ID")
        import sys
        sys.path.insert(0, str(pytest.importorskip("pathlib").Path(__file__).parent.parent))
        import importlib
        sys.modules.pop("settings", None)
        import settings
        importlib.reload(settings)

        with pytest.raises(ValueError, match="BATCH_JOB_ID"):
            settings.BatchRunnerSettings.from_env()

    def test_numeric_overrides(self):
        """数値環境変数が正しくオーバーライドされる。"""
        os.environ["MAX_FILE_CONCURRENCY"] = "4"
        os.environ["MAX_RETRIES"] = "5"
        os.environ["BATCH_MAX_DURATION_SEC"] = "3600"
        import sys
        sys.path.insert(0, str(pytest.importorskip("pathlib").Path(__file__).parent.parent))
        import importlib
        sys.modules.pop("settings", None)
        import settings
        importlib.reload(settings)

        s = settings.BatchRunnerSettings.from_env()
        assert s.max_file_concurrency == 4
        assert s.max_retries == 5
        assert s.batch_max_duration_sec == 3600

    def test_is_dataclass(self):
        """BatchRunnerSettings が dataclass である。"""
        import sys
        sys.path.insert(0, str(pytest.importorskip("pathlib").Path(__file__).parent.parent))
        import importlib
        sys.modules.pop("settings", None)
        import settings
        importlib.reload(settings)
        import dataclasses

        assert dataclasses.is_dataclass(settings.BatchRunnerSettings)
        field_names = {f.name for f in fields(settings.BatchRunnerSettings)}
        expected = {
            "batch_job_id", "bucket_name", "batch_table_name",
            "control_table_name", "endpoint_name",
            "max_file_concurrency", "max_page_concurrency",
            "max_retries", "read_timeout",
            "circuit_threshold", "circuit_cooldown",
            "batch_max_duration_sec", "extra_formats",
        }
        assert expected == field_names


class TestMainDryRun:
    """main.py のドライラン（設定ロード成功）テスト。"""

    def setup_method(self):
        os.environ["BATCH_JOB_ID"] = "dry-run-batch-001"
        os.environ["BUCKET_NAME"] = "test-bucket"
        os.environ["BATCH_TABLE_NAME"] = "BatchTable"
        os.environ["CONTROL_TABLE_NAME"] = "ControlTable"
        os.environ["ENDPOINT_NAME"] = "test-endpoint"
        os.environ["DRY_RUN"] = "true"

    def teardown_method(self):
        for key in [
            "BATCH_JOB_ID", "BUCKET_NAME", "BATCH_TABLE_NAME",
            "CONTROL_TABLE_NAME", "ENDPOINT_NAME", "DRY_RUN",
        ]:
            os.environ.pop(key, None)

    def test_main_dry_run_exits_zero(self):
        """DRY_RUN=true の場合、main.py が設定ロード成功後にゼロ終了する。"""
        import sys
        sys.path.insert(0, str(pytest.importorskip("pathlib").Path(__file__).parent.parent))
        import importlib
        sys.modules.pop("main", None)
        sys.modules.pop("settings", None)
        import main
        importlib.reload(main)

        # dry_run() 関数が呼べて例外を投げないことを確認
        main.dry_run()
