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
            "SUCCESS_QUEUE_URL": "https://sqs.ap-northeast-1.amazonaws.com/0/success",
            "FAILURE_QUEUE_URL": "https://sqs.ap-northeast-1.amazonaws.com/0/failure",
            "ASYNC_INPUT_PREFIX": "batches/_async/inputs",
            "ASYNC_OUTPUT_PREFIX": "batches/_async/outputs",
            "ASYNC_ERROR_PREFIX": "batches/_async/errors",
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
            "SUCCESS_QUEUE_URL",
            "FAILURE_QUEUE_URL",
            "ASYNC_INPUT_PREFIX",
            "ASYNC_OUTPUT_PREFIX",
            "ASYNC_ERROR_PREFIX",
            "ASYNC_MAX_CONCURRENT",
            "MAX_FILE_CONCURRENCY",
            "MAX_PAGE_CONCURRENCY",
            "MAX_RETRIES",
            "READ_TIMEOUT",
            "CIRCUIT_THRESHOLD",
            "CIRCUIT_COOLDOWN",
            "BATCH_MAX_DURATION_SEC",
            "EXTRA_FORMATS",
            "OFFICE_CONVERT_TIMEOUT_SEC",
            "OFFICE_CONVERT_MAX_CONCURRENT",
            "MAX_CONVERTED_FILE_BYTES",
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

    def test_invalid_int_raises_descriptive_value_error(self):
        """無効な整数環境変数が識別可能な ValueError を送出する。"""
        os.environ["MAX_FILE_CONCURRENCY"] = "abc"
        import sys
        sys.path.insert(0, str(pytest.importorskip("pathlib").Path(__file__).parent.parent))
        import importlib
        sys.modules.pop("settings", None)
        import settings
        importlib.reload(settings)

        with pytest.raises(ValueError, match="MAX_FILE_CONCURRENCY"):
            settings.BatchRunnerSettings.from_env()

    def test_invalid_float_raises_descriptive_value_error(self):
        """無効な浮動小数環境変数が識別可能な ValueError を送出する。"""
        os.environ["READ_TIMEOUT"] = "not-a-number"
        import sys
        sys.path.insert(0, str(pytest.importorskip("pathlib").Path(__file__).parent.parent))
        import importlib
        sys.modules.pop("settings", None)
        import settings
        importlib.reload(settings)

        with pytest.raises(ValueError, match="READ_TIMEOUT"):
            settings.BatchRunnerSettings.from_env()

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
            "success_queue_url", "failure_queue_url",
            "async_input_prefix", "async_output_prefix", "async_error_prefix",
            "async_max_concurrent",
            "max_file_concurrency", "max_page_concurrency",
            "max_retries", "read_timeout",
            "circuit_threshold", "circuit_cooldown",
            "batch_max_duration_sec", "extra_formats",
            "office_convert_timeout_sec", "office_convert_max_concurrent",
            "max_converted_file_bytes",
        }
        assert expected == field_names

    def test_async_fields_loaded(self):
        """Async 用の必須フィールドが環境変数から読み込まれる。"""
        import sys
        sys.path.insert(0, str(pytest.importorskip("pathlib").Path(__file__).parent.parent))
        import importlib
        sys.modules.pop("settings", None)
        import settings
        importlib.reload(settings)

        s = settings.BatchRunnerSettings.from_env()
        assert s.success_queue_url.endswith("/success")
        assert s.failure_queue_url.endswith("/failure")
        assert s.async_input_prefix == "batches/_async/inputs"
        assert s.async_output_prefix == "batches/_async/outputs"
        assert s.async_error_prefix == "batches/_async/errors"

    def test_async_max_concurrent_default(self):
        """ASYNC_MAX_CONCURRENT 未設定時のデフォルトは 4 (BatchExecutionStack と揃える)。"""
        os.environ.pop("ASYNC_MAX_CONCURRENT", None)
        import sys
        sys.path.insert(0, str(pytest.importorskip("pathlib").Path(__file__).parent.parent))
        import importlib
        sys.modules.pop("settings", None)
        import settings
        importlib.reload(settings)

        s = settings.BatchRunnerSettings.from_env()
        assert s.async_max_concurrent == 4

    def test_async_max_concurrent_override(self):
        """ASYNC_MAX_CONCURRENT が整数オーバーライドされる。"""
        os.environ["ASYNC_MAX_CONCURRENT"] = "8"
        import sys
        sys.path.insert(0, str(pytest.importorskip("pathlib").Path(__file__).parent.parent))
        import importlib
        sys.modules.pop("settings", None)
        import settings
        importlib.reload(settings)

        s = settings.BatchRunnerSettings.from_env()
        assert s.async_max_concurrent == 8

    @pytest.mark.parametrize(
        "missing_key",
        [
            "SUCCESS_QUEUE_URL",
            "FAILURE_QUEUE_URL",
            "ASYNC_INPUT_PREFIX",
            "ASYNC_OUTPUT_PREFIX",
            "ASYNC_ERROR_PREFIX",
        ],
    )
    def test_missing_async_required_raises_value_error(self, missing_key: str):
        """Async 必須環境変数が欠けると fail-fast する。"""
        os.environ.pop(missing_key)
        import sys
        sys.path.insert(0, str(pytest.importorskip("pathlib").Path(__file__).parent.parent))
        import importlib
        sys.modules.pop("settings", None)
        import settings
        importlib.reload(settings)

        with pytest.raises(ValueError, match=missing_key):
            settings.BatchRunnerSettings.from_env()

    def test_invalid_async_max_concurrent_raises_value_error(self):
        """ASYNC_MAX_CONCURRENT が数値にパースできないと fail-fast する。"""
        os.environ["ASYNC_MAX_CONCURRENT"] = "not-an-int"
        import sys
        sys.path.insert(0, str(pytest.importorskip("pathlib").Path(__file__).parent.parent))
        import importlib
        sys.modules.pop("settings", None)
        import settings
        importlib.reload(settings)

        with pytest.raises(ValueError, match="ASYNC_MAX_CONCURRENT"):
            settings.BatchRunnerSettings.from_env()

    # ------------------------------------------------------------------
    # Office 変換用 env (R2.4 / R4.6 / R5.2) — task 1.3
    # ------------------------------------------------------------------
    def test_office_convert_fields_have_defaults_when_unset(self):
        """OFFICE_CONVERT_* / MAX_CONVERTED_FILE_BYTES 未設定時は default を使う (raise しない)。"""
        for key in (
            "OFFICE_CONVERT_TIMEOUT_SEC",
            "OFFICE_CONVERT_MAX_CONCURRENT",
            "MAX_CONVERTED_FILE_BYTES",
        ):
            os.environ.pop(key, None)
        import sys
        sys.path.insert(0, str(pytest.importorskip("pathlib").Path(__file__).parent.parent))
        import importlib
        sys.modules.pop("settings", None)
        import settings
        importlib.reload(settings)

        s = settings.BatchRunnerSettings.from_env()
        # R4.6: 既定 300 秒/ファイル
        assert s.office_convert_timeout_sec == 300
        # R2.4: Fargate 4 vCPU と揃える
        assert s.office_convert_max_concurrent == 4
        # R5.2: 1 GiB = SageMaker Async payload 上限
        assert s.max_converted_file_bytes == 1073741824

    def test_office_convert_fields_overridden_from_env(self):
        """env 経由で 3 つの新フィールドがオーバーライドされる。"""
        os.environ["OFFICE_CONVERT_TIMEOUT_SEC"] = "600"
        os.environ["OFFICE_CONVERT_MAX_CONCURRENT"] = "8"
        os.environ["MAX_CONVERTED_FILE_BYTES"] = "536870912"  # 512 MiB
        import sys
        sys.path.insert(0, str(pytest.importorskip("pathlib").Path(__file__).parent.parent))
        import importlib
        sys.modules.pop("settings", None)
        import settings
        importlib.reload(settings)

        s = settings.BatchRunnerSettings.from_env()
        assert s.office_convert_timeout_sec == 600
        assert s.office_convert_max_concurrent == 8
        assert s.max_converted_file_bytes == 536870912

    def test_office_convert_fields_missing_does_not_raise(self):
        """既存必須 env と異なり、Office env 欠落で ValueError を送出しない (運用切替リスク低減)。"""
        for key in (
            "OFFICE_CONVERT_TIMEOUT_SEC",
            "OFFICE_CONVERT_MAX_CONCURRENT",
            "MAX_CONVERTED_FILE_BYTES",
        ):
            os.environ.pop(key, None)
        import sys
        sys.path.insert(0, str(pytest.importorskip("pathlib").Path(__file__).parent.parent))
        import importlib
        sys.modules.pop("settings", None)
        import settings
        importlib.reload(settings)

        # raise しないこと自体が assertion (ValueError が出れば失敗)
        s = settings.BatchRunnerSettings.from_env()
        assert s is not None

    @pytest.mark.parametrize(
        "key",
        [
            "OFFICE_CONVERT_TIMEOUT_SEC",
            "OFFICE_CONVERT_MAX_CONCURRENT",
            "MAX_CONVERTED_FILE_BYTES",
        ],
    )
    def test_office_convert_invalid_int_raises_descriptive_value_error(self, key: str):
        """値が指定されているが int に parse できない場合は既存 _int helper と同様に descriptive ValueError を送出する。"""
        os.environ[key] = "not-an-int"
        import sys
        sys.path.insert(0, str(pytest.importorskip("pathlib").Path(__file__).parent.parent))
        import importlib
        sys.modules.pop("settings", None)
        import settings
        importlib.reload(settings)

        with pytest.raises(ValueError, match=key):
            settings.BatchRunnerSettings.from_env()


class TestMainDryRun:
    """main.py のドライラン（設定ロード成功）テスト。"""

    def setup_method(self):
        os.environ["BATCH_JOB_ID"] = "dry-run-batch-001"
        os.environ["BUCKET_NAME"] = "test-bucket"
        os.environ["BATCH_TABLE_NAME"] = "BatchTable"
        os.environ["CONTROL_TABLE_NAME"] = "ControlTable"
        os.environ["ENDPOINT_NAME"] = "test-endpoint"
        os.environ["SUCCESS_QUEUE_URL"] = (
            "https://sqs.ap-northeast-1.amazonaws.com/0/success"
        )
        os.environ["FAILURE_QUEUE_URL"] = (
            "https://sqs.ap-northeast-1.amazonaws.com/0/failure"
        )
        os.environ["ASYNC_INPUT_PREFIX"] = "batches/_async/inputs"
        os.environ["ASYNC_OUTPUT_PREFIX"] = "batches/_async/outputs"
        os.environ["ASYNC_ERROR_PREFIX"] = "batches/_async/errors"
        os.environ["DRY_RUN"] = "true"

    def teardown_method(self):
        for key in [
            "BATCH_JOB_ID", "BUCKET_NAME", "BATCH_TABLE_NAME",
            "CONTROL_TABLE_NAME", "ENDPOINT_NAME",
            "SUCCESS_QUEUE_URL", "FAILURE_QUEUE_URL",
            "ASYNC_INPUT_PREFIX", "ASYNC_OUTPUT_PREFIX", "ASYNC_ERROR_PREFIX",
            "ASYNC_MAX_CONCURRENT",
            "DRY_RUN",
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
