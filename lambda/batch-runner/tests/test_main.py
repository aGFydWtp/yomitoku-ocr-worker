"""main.py orchestration tests。

単体のヘルパー (s3_sync / runner.run_async_batch / batch_store / control_table /
process_log_reader) は各 test_*.py で網羅済みなので、本ファイルは **main.run が
正しい順序で呼び分ける** ことのみを検証する。各ヘルパーは monkeypatch で差し替え、
外部 I/O には触れない (DRY_RUN 以外)。
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

REQUIRED_ENV = {
    "BATCH_JOB_ID": "batch-main-test",
    "BUCKET_NAME": "bucket-main-test",
    "BATCH_TABLE_NAME": "BatchTable",
    "CONTROL_TABLE_NAME": "ControlTable",
    "ENDPOINT_NAME": "yomitoku-async",
    "SUCCESS_QUEUE_URL": "https://sqs.example.com/success",
    "FAILURE_QUEUE_URL": "https://sqs.example.com/failure",
    "ASYNC_INPUT_PREFIX": "batches/_async/inputs",
    "ASYNC_OUTPUT_PREFIX": "batches/_async/outputs",
    "ASYNC_ERROR_PREFIX": "batches/_async/errors",
}


def _set_env(monkeypatch: pytest.MonkeyPatch, overrides: dict[str, str] | None = None) -> None:
    for k, v in REQUIRED_ENV.items():
        monkeypatch.setenv(k, v)
    for k, v in (overrides or {}).items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("DRY_RUN", raising=False)


class _Recorder:
    """呼び出し順序と引数を記録する単純な recorder。"""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def record(self, name: str):
        def _inner(**kwargs):
            self.calls.append((name, kwargs))

        return _inner

    @property
    def names(self) -> list[str]:
        return [c[0] for c in self.calls]


@pytest.fixture
def patched_main(monkeypatch: pytest.MonkeyPatch):
    """main モジュールをフレッシュロードし、外部ヘルパーを差し替える。"""
    _set_env(monkeypatch)
    # 既ロード済だと settings が古い環境で保持されるので確実に再ロード
    for mod in ("main", "settings"):
        sys.modules.pop(mod, None)
    import main as main_module
    importlib.reload(main_module)

    rec = _Recorder()

    # boto3 client/resource は呼ばれても実 AWS に触れないようダミー化
    def _fake_boto3_client(name, *args, **kwargs):
        return SimpleNamespace(name=name)

    def _fake_boto3_resource(name, *args, **kwargs):
        return SimpleNamespace(
            Table=lambda tbl: SimpleNamespace(table_name=tbl),
        )

    monkeypatch.setattr(main_module.boto3, "client", _fake_boto3_client)
    monkeypatch.setattr(main_module.boto3, "resource", _fake_boto3_resource)

    # 既定では成功パスを返すスタブ
    monkeypatch.setattr(main_module, "register_heartbeat", rec.record("register_heartbeat"))
    monkeypatch.setattr(main_module, "delete_heartbeat", rec.record("delete_heartbeat"))
    monkeypatch.setattr(
        main_module, "download_inputs",
        lambda **kw: (rec.record("download_inputs")(**kw),
                      ["batches/x/input/a.pdf", "batches/x/input/b.pdf"])[1],
    )

    async def _fake_run_async(**kwargs):
        rec.calls.append(("run_async_batch", kwargs))
        return SimpleNamespace(
            succeeded_files=["a", "b"], failed_files=[], in_flight_timeout=[]
        )

    monkeypatch.setattr(main_module, "run_async_batch", _fake_run_async)
    monkeypatch.setattr(
        main_module, "generate_all_visualizations",
        lambda **kw: (rec.record("generate_all_visualizations")(**kw), {})[1],
    )
    monkeypatch.setattr(
        main_module, "upload_outputs",
        lambda **kw: (rec.record("upload_outputs")(**kw),
                      {"output": 2, "results": 0, "visualizations": 0, "logs": 1})[1],
    )
    monkeypatch.setattr(
        main_module, "read_process_log",
        lambda p: (rec.record("read_process_log")(log_path=p), iter([]))[1],
    )
    monkeypatch.setattr(
        main_module, "apply_process_log",
        lambda **kw: (rec.record("apply_process_log")(**kw),
                      {"succeeded": 2, "failed": 0, "skipped": 0})[1],
    )
    monkeypatch.setattr(
        main_module, "finalize_batch_status",
        lambda **kw: (rec.record("finalize_batch_status")(**kw), "COMPLETED")[1],
    )

    return main_module, rec


# ---------------------------------------------------------------------------
# main() entry
# ---------------------------------------------------------------------------


class TestDryRun:
    def test_dry_run_true_returns_0_without_touching_helpers(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        _set_env(monkeypatch)
        monkeypatch.setenv("DRY_RUN", "true")
        for mod in ("main", "settings"):
            sys.modules.pop(mod, None)
        import main as main_module
        importlib.reload(main_module)

        # run() が呼ばれたら FAIL させるスタブ
        called = {"n": 0}

        def _bomb(_settings):
            called["n"] += 1

        monkeypatch.setattr(main_module, "run", _bomb)
        assert main_module.main() == 0
        assert called["n"] == 0


class TestHappyPath:
    def test_happy_path_returns_0_and_calls_helpers_in_order(self, patched_main):
        main_module, rec = patched_main
        assert main_module.main() == 0
        # 順序と個数を確認
        assert rec.names == [
            "register_heartbeat",
            "download_inputs",
            "run_async_batch",
            "generate_all_visualizations",
            "upload_outputs",
            "read_process_log",
            "apply_process_log",
            "finalize_batch_status",
            "delete_heartbeat",
        ]

    def test_finalize_receives_totals_from_apply_process_log(self, patched_main):
        main_module, rec = patched_main
        main_module.main()
        finalize_kw = dict(rec.calls)["finalize_batch_status"]
        assert finalize_kw["total_files"] == 2
        assert finalize_kw["succeeded"] == 2
        assert finalize_kw["failed"] == 0
        assert finalize_kw["expected_current"] == "PROCESSING"


class TestEmptyInput:
    def test_no_input_files_still_finalizes_and_returns_0(
        self, monkeypatch: pytest.MonkeyPatch, patched_main
    ):
        main_module, rec = patched_main
        # download_inputs を空リストに差し替え
        monkeypatch.setattr(
            main_module, "download_inputs",
            lambda **kw: (rec.record("download_inputs")(**kw), [])[1],
        )
        assert main_module.main() == 0
        # run_async_batch はスキップされ、finalize は total_files=0 で呼ばれる
        assert "run_async_batch" not in rec.names
        finalize_kw = dict(rec.calls)["finalize_batch_status"]
        assert finalize_kw["total_files"] == 0


class TestFailures:
    def test_settings_load_failure_returns_1(self, monkeypatch: pytest.MonkeyPatch):
        _set_env(monkeypatch)
        monkeypatch.delenv("BATCH_JOB_ID")  # 必須欠落
        for mod in ("main", "settings"):
            sys.modules.pop(mod, None)
        import main as main_module
        importlib.reload(main_module)
        assert main_module.main() == 1

    def test_run_async_batch_exception_returns_1_but_still_calls_delete_heartbeat(
        self, monkeypatch: pytest.MonkeyPatch, patched_main
    ):
        main_module, rec = patched_main

        async def _boom(**kwargs):
            rec.calls.append(("run_async_batch", kwargs))
            raise RuntimeError("simulated failure")

        monkeypatch.setattr(main_module, "run_async_batch", _boom)

        assert main_module.main() == 1
        # 例外後も heartbeat 削除は試行される (finally)
        assert "delete_heartbeat" in rec.names
        # finalize は呼ばれていない (SFN の MarkFailedForced 経路に委譲)
        assert "finalize_batch_status" not in rec.names

    def test_register_heartbeat_failure_does_not_fail_batch(
        self, monkeypatch: pytest.MonkeyPatch, patched_main
    ):
        main_module, rec = patched_main

        def _raise(**kwargs):
            rec.calls.append(("register_heartbeat", kwargs))
            raise RuntimeError("DDB throttled")

        monkeypatch.setattr(main_module, "register_heartbeat", _raise)

        assert main_module.main() == 0
        # heartbeat 未登録のとき delete_heartbeat は呼ばれない
        assert "delete_heartbeat" not in rec.names
        # ただし本体の finalize は完了している
        assert "finalize_batch_status" in rec.names

    def test_upload_outputs_failure_does_not_skip_finalize(
        self, monkeypatch: pytest.MonkeyPatch, patched_main
    ):
        main_module, rec = patched_main

        def _raise(**kwargs):
            rec.calls.append(("upload_outputs", kwargs))
            raise RuntimeError("S3 500")

        monkeypatch.setattr(main_module, "upload_outputs", _raise)

        assert main_module.main() == 0
        # finalize まで到達していること (成果物未整合でも PROCESSING 放置は避ける)
        assert "finalize_batch_status" in rec.names

    def test_visualize_failure_is_non_fatal(
        self, monkeypatch: pytest.MonkeyPatch, patched_main
    ):
        main_module, rec = patched_main

        def _raise(**kwargs):
            rec.calls.append(("generate_all_visualizations", kwargs))
            raise RuntimeError("cv2 missing")

        monkeypatch.setattr(main_module, "generate_all_visualizations", _raise)

        assert main_module.main() == 0
        # upload / finalize とも呼ばれる
        assert rec.names.index("generate_all_visualizations") < rec.names.index(
            "upload_outputs"
        )
        assert "finalize_batch_status" in rec.names
