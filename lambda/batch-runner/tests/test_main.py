"""main.py orchestration tests。

単体のヘルパー (s3_sync / runner.run_async_batch / batch_store / control_table /
process_log_reader) は各 test_*.py で網羅済みなので、本ファイルは **main.run が
正しい順序で呼び分ける** ことのみを検証する。各ヘルパーは monkeypatch で差し替え、
外部 I/O には触れない (DRY_RUN 以外)。
"""

from __future__ import annotations

import importlib
import json
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


class TestOfficeConversionPhase:
    """convert_office_files フェーズの分岐ロジック (R2.1, R3.1, R7.1, R9.1, R9.2 / task 4.1)。"""

    def test_pdf_only_batch_skips_convert_phase(
        self, monkeypatch: pytest.MonkeyPatch, patched_main
    ):
        """downloaded が PDF のみのとき convert_office_files は一度も呼ばれない (R7.1)。"""
        main_module, rec = patched_main

        def _bomb_convert(*args, **kwargs):
            rec.calls.append(("convert_office_files", {"args": args, "kwargs": kwargs}))
            raise AssertionError("convert_office_files must not be called for PDF-only batch")

        monkeypatch.setattr(main_module, "convert_office_files", _bomb_convert)

        assert main_module.main() == 0
        assert "convert_office_files" not in rec.names
        # 既存 8 ステップが順序通りに走ること
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

    def test_mixed_batch_invokes_convert_and_appends_failures(
        self, monkeypatch: pytest.MonkeyPatch, patched_main, tmp_path: Path
    ):
        """PDF + PPTX 混在で convert_office_files が呼ばれ、失敗が process_log.jsonl に追記される。

        process_log.jsonl への追記行は CONVERSION_FAILED + ConvertFailure.detail を含む。
        書き込み順は convert → run_async_batch (yomitoku-client が後で書く形を想定)。
        """
        main_module, rec = patched_main

        # downloaded を mixed (PDF + PPTX) に差し替え
        monkeypatch.setattr(
            main_module, "download_inputs",
            lambda **kw: (
                rec.record("download_inputs")(**kw),
                ["batches/x/input/a.pdf", "batches/x/input/deck.pptx"],
            )[1],
        )

        # convert_office_files は ConvertResult(succeeded, failed) を返す。
        # 1 件は成功 (= 原本ローカル削除済み想定)、1 件は変換失敗とする。
        captured_log_path: dict[str, Path] = {}
        original_office_path = tmp_path / "input" / "deck.pptx"

        def _fake_convert(input_dir, *, timeout_sec, max_concurrent, max_converted_bytes):
            rec.calls.append((
                "convert_office_files",
                {
                    "input_dir": input_dir,
                    "timeout_sec": timeout_sec,
                    "max_concurrent": max_concurrent,
                    "max_converted_bytes": max_converted_bytes,
                },
            ))
            return SimpleNamespace(
                succeeded=[],
                failed=[
                    SimpleNamespace(
                        original_path=original_office_path,
                        reason="encrypted",
                        detail="file is password-protected or encrypted: deck.pptx",
                    )
                ],
            )

        monkeypatch.setattr(main_module, "convert_office_files", _fake_convert)

        # run_async_batch / read_process_log では実際に書かれた log_path を覗いて検証する
        async def _capture_run_async(**kwargs):
            rec.calls.append(("run_async_batch", kwargs))
            captured_log_path["log_path"] = Path(kwargs["log_path"])
            return SimpleNamespace(
                succeeded_files=["a"], failed_files=[], in_flight_timeout=[]
            )

        monkeypatch.setattr(main_module, "run_async_batch", _capture_run_async)

        assert main_module.main() == 0

        # 順序検証: download → convert → run_async ...
        assert rec.names.index("convert_office_files") > rec.names.index("download_inputs")
        assert rec.names.index("run_async_batch") > rec.names.index("convert_office_files")

        # convert_office_files に env 由来の引数が伝わっていること
        convert_kw = next(c for c in rec.calls if c[0] == "convert_office_files")[1]
        assert convert_kw["timeout_sec"] == 300  # default
        assert convert_kw["max_concurrent"] == 4
        assert convert_kw["max_converted_bytes"] == 1073741824

        # 実 log_path に CONVERSION_FAILED 行が追記されていること
        log_path = captured_log_path["log_path"]
        assert log_path.exists()
        lines = [
            json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines() if line
        ]
        assert len(lines) == 1
        record = lines[0]
        assert record["success"] is False
        assert record["error_category"] == "CONVERSION_FAILED"
        assert record["filename"] == "deck.pptx"
        assert record["file_path"] == str(original_office_path)
        assert "encrypted" in record["error"]
        assert "timestamp" in record

    def test_convert_phase_with_no_failures_does_not_write_log(
        self, monkeypatch: pytest.MonkeyPatch, patched_main, tmp_path: Path
    ):
        """変換成功のみ (failed=[]) の場合 process_log.jsonl への追記は行わない。"""
        main_module, rec = patched_main

        monkeypatch.setattr(
            main_module, "download_inputs",
            lambda **kw: (
                rec.record("download_inputs")(**kw),
                ["batches/x/input/deck.pptx"],
            )[1],
        )

        def _fake_convert(input_dir, **kwargs):
            rec.calls.append(("convert_office_files", {"input_dir": input_dir, **kwargs}))
            return SimpleNamespace(succeeded=[SimpleNamespace()], failed=[])

        monkeypatch.setattr(main_module, "convert_office_files", _fake_convert)

        captured_log_path: dict[str, Path] = {}

        async def _capture_run_async(**kwargs):
            rec.calls.append(("run_async_batch", kwargs))
            captured_log_path["log_path"] = Path(kwargs["log_path"])
            return SimpleNamespace(
                succeeded_files=["deck"], failed_files=[], in_flight_timeout=[]
            )

        monkeypatch.setattr(main_module, "run_async_batch", _capture_run_async)

        assert main_module.main() == 0
        assert "convert_office_files" in rec.names
        # 失敗 0 件なので convert 由来の追記行は無し
        log_path = captured_log_path["log_path"]
        if log_path.exists():
            convert_failed_lines = [
                json.loads(line)
                for line in log_path.read_text(encoding="utf-8").splitlines()
                if line and json.loads(line).get("error_category") == "CONVERSION_FAILED"
            ]
            assert convert_failed_lines == []

    def test_convert_phase_does_not_call_s3_delete(
        self, monkeypatch: pytest.MonkeyPatch, patched_main
    ):
        """変換フェーズは S3 input prefix への delete API を呼ばない (R9.1 維持)。

        s3_client は patched_main 内で SimpleNamespace に差し替え済みだが、
        delete_object / delete_objects 属性が呼ばれた場合に検知できるよう
        attribute 監視を仕掛ける。
        """
        main_module, rec = patched_main

        called: dict[str, int] = {"delete_object": 0, "delete_objects": 0}

        class _GuardedS3:
            def __getattr__(self, name):
                if name in called:
                    called[name] += 1
                    raise AssertionError(
                        f"main.run must not call s3.{name} during convert phase (R9.1)"
                    )
                # download などはダミー callable
                return lambda *args, **kwargs: None

        monkeypatch.setattr(main_module.boto3, "client", lambda *a, **kw: _GuardedS3())

        monkeypatch.setattr(
            main_module, "download_inputs",
            lambda **kw: (
                rec.record("download_inputs")(**kw),
                ["batches/x/input/deck.pptx"],
            )[1],
        )

        monkeypatch.setattr(
            main_module, "convert_office_files",
            lambda input_dir, **kwargs: (
                rec.calls.append(("convert_office_files", kwargs)),
                SimpleNamespace(succeeded=[], failed=[]),
            )[1],
        )

        assert main_module.main() == 0
        assert called["delete_object"] == 0
        assert called["delete_objects"] == 0


class TestAppendConversionFailuresHelper:
    """_append_conversion_failures_to_log の単体検証。"""

    def test_appends_one_line_per_failure(
        self, patched_main, tmp_path: Path
    ):
        main_module, _ = patched_main
        log_path = tmp_path / "out" / "process_log.jsonl"
        failures = [
            SimpleNamespace(
                original_path=Path("/tmp/in/a.pptx"),
                reason="timeout",
                detail="soffice timeout after 300s: /tmp/in/a.pptx",
            ),
            SimpleNamespace(
                original_path=Path("/tmp/in/b.docx"),
                reason="oversize",
                detail="converted PDF size 2147483648 exceeds max_bytes 1073741824",
            ),
        ]
        main_module._append_conversion_failures_to_log(log_path, failures)

        lines = log_path.read_text(encoding="utf-8").splitlines()
        assert len(lines) == 2
        for raw, src in zip(lines, failures):
            obj = json.loads(raw)
            assert obj["success"] is False
            assert obj["error_category"] == "CONVERSION_FAILED"
            assert obj["error"] == src.detail
            assert obj["filename"] == src.original_path.name
            assert obj["file_path"] == str(src.original_path)
            assert "timestamp" in obj

    def test_empty_failures_is_noop_and_does_not_create_file(
        self, patched_main, tmp_path: Path
    ):
        main_module, _ = patched_main
        log_path = tmp_path / "out" / "process_log.jsonl"
        main_module._append_conversion_failures_to_log(log_path, [])
        assert not log_path.exists()


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
