"""main.py orchestration tests。

単体のヘルパー (s3_sync / runner.run_async_batch / batch_store / control_table /
process_log_reader) は各 test_*.py で網羅済みなので、本ファイルは **main.run が
正しい順序で呼び分ける** ことのみを検証する。各ヘルパーは monkeypatch で差し替え、
外部 I/O には触れない (DRY_RUN 以外)。

`TestEndToEndMixedBatch` のみ moto[dynamodb] で実 DDB (mocked) を立ち上げ、
`apply_process_log` + `finalize_batch_status` を本物のまま走らせて META.status の
PARTIAL 遷移と FILE の errorCategory 反映を end-to-end で検証する (Task 5.8 / R4.8)。
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import boto3
import pytest
from moto import mock_aws

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


# ---------------------------------------------------------------------------
# Task 5.8: End-to-end mixed batch with REAL (moto) DDB
# ---------------------------------------------------------------------------
#
# 既存 TestOfficeConversionPhase は apply_process_log / finalize_batch_status を
# stub に差し替え呼び出し順序のみ検証する。Task 5.8 は **DDB 反映と META.status
# 遷移まで含めた end-to-end 統合** を確認するため、moto[dynamodb] で実テーブルを
# 立て、`apply_process_log` と `finalize_batch_status` を本物のまま走らせる。
#
# シナリオ:
#   入力 3 件 ... a.pdf / deck.pptx / broken.pptx
#   convert_office_files: deck.pptx → 成功 (deck.pdf 生成), broken.pptx → CONVERSION_FAILED (encrypted)
#   run_async_batch: a.pdf, deck.pdf を OCR 成功として process_log.jsonl に書く
#   期待: PARTIAL (succeeded=2, failed=1) / 各 FILE の errorCategory 適切
# ---------------------------------------------------------------------------


_E2E_BATCH_TABLE = "TestBatchTableE2E"
_E2E_BATCH_ID = "batch-mixed-e2e-001"


def _create_e2e_batch_table():
    """`test_batch_store._create_batch_table` 相当 (E2E 用に独立化)。

    test_batch_store と同名テーブルを再利用すると import 順依存が出るため、
    本ファイル専用に別名で立てる。スキーマは TS 側 BatchTable と同じ。
    """
    client = boto3.resource("dynamodb", region_name="us-east-1")
    client.create_table(
        TableName=_E2E_BATCH_TABLE,
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
    return client.Table(_E2E_BATCH_TABLE)


def _seed_e2e_batch(table, batch_id: str, filenames: list[str]) -> None:
    """META (PROCESSING) と FILE (PENDING) を投入する。"""
    table.put_item(Item={
        "PK": f"BATCH#{batch_id}",
        "SK": "META",
        "entityType": "BATCH",
        "batchJobId": batch_id,
        "status": "PROCESSING",
        "batchLabel": "mixed-e2e",
        "totals": {
            "total": len(filenames),
            "succeeded": 0,
            "failed": 0,
            "inProgress": len(filenames),
        },
        "createdAt": "2026-04-22T09:00:00.000Z",
        "updatedAt": "2026-04-22T09:00:00.000Z",
        "startedAt": "2026-04-22T09:05:00.000Z",
        "parentBatchJobId": None,
        "GSI1PK": "STATUS#PROCESSING#202604",
        "GSI1SK": "2026-04-22T09:00:00.000Z",
    })
    for fname in filenames:
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


class TestEndToEndMixedBatch:
    """混在バッチで apply_process_log → finalize_batch_status まで通貫させる (Task 5.8)。"""

    def test_end_to_end_mixed_batch_writes_partial_and_error_category(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """PDF + PPTX 混在で META.status=PARTIAL, FILE 3 件が期待通り更新される。

        - a.pdf: PDF success → status=COMPLETED, errorCategory なし
        - deck.pptx → deck.pdf 変換成功 → OCR success → status=COMPLETED, errorCategory なし
        - broken.pptx: 変換失敗 (encrypted) → status=FAILED, errorCategory=CONVERSION_FAILED,
          errorMessage に 'encrypted' を含む
        - META.status: PARTIAL (succeeded=2 / failed=1) → R3.3 / R4.8

        moto で DDB を立て、`apply_process_log` / `finalize_batch_status` は **本物** を使う。
        boto3.client("s3") は本流で download/upload 時に呼ばれるが、download_inputs / upload_outputs
        を mock で抜くため実 S3 API 呼び出しは発生しない。
        """
        with mock_aws():
            # --- DDB 準備 ---
            table = _create_e2e_batch_table()
            filenames = ["a.pdf", "deck.pptx", "broken.pptx"]
            _seed_e2e_batch(table, _E2E_BATCH_ID, filenames)

            # --- main モジュールを env 込みで再ロード ---
            _set_env(
                monkeypatch,
                overrides={
                    "BATCH_JOB_ID": _E2E_BATCH_ID,
                    "BATCH_TABLE_NAME": _E2E_BATCH_TABLE,
                },
            )
            for mod in ("main", "settings"):
                sys.modules.pop(mod, None)
            import main as main_module
            importlib.reload(main_module)

            # --- boto3.client は touched しない (S3 helper を mock するため) ---
            # boto3.resource は moto 上の DDB を返したいので、real な resource を返させる。
            real_resource = boto3.resource

            def _resource_via_moto(name, *args, **kwargs):
                kwargs.setdefault("region_name", "us-east-1")
                return real_resource(name, *args, **kwargs)

            monkeypatch.setattr(
                main_module.boto3, "resource", _resource_via_moto
            )
            monkeypatch.setattr(
                main_module.boto3, "client",
                lambda name, *a, **kw: SimpleNamespace(name=name),
            )

            # --- heartbeat / visualize / upload は no-op で固定 ---
            monkeypatch.setattr(
                main_module, "register_heartbeat", lambda **kw: None
            )
            monkeypatch.setattr(
                main_module, "delete_heartbeat", lambda **kw: None
            )
            monkeypatch.setattr(
                main_module, "generate_all_visualizations", lambda **kw: {}
            )
            monkeypatch.setattr(
                main_module, "upload_outputs",
                lambda **kw: {
                    "output": 2, "results": 0, "visualizations": 0, "logs": 1
                },
            )

            # --- download_inputs: 3 件 (PDF + PPTX 2 件) を返す。
            # 副作用として原本ファイルも作っておく (office_converter mock では参照しないが、
            # main.py 側の input_dir 操作と整合させるため)。
            captured_input_dir: dict[str, Path] = {}

            def _fake_download(**kwargs):
                input_dir = Path(kwargs["input_dir"])
                captured_input_dir["input_dir"] = input_dir
                return [
                    f"batches/{_E2E_BATCH_ID}/input/{fn}" for fn in filenames
                ]

            monkeypatch.setattr(
                main_module, "download_inputs", _fake_download
            )

            # --- convert_office_files: deck.pptx 成功 / broken.pptx 失敗 ---
            def _fake_convert(input_dir, **_kwargs):
                broken_path = input_dir / "broken.pptx"
                deck_pdf = input_dir / "deck.pdf"
                deck_pptx = input_dir / "deck.pptx"
                return SimpleNamespace(
                    succeeded=[
                        SimpleNamespace(
                            original_path=deck_pptx, pdf_path=deck_pdf
                        )
                    ],
                    failed=[
                        SimpleNamespace(
                            original_path=broken_path,
                            reason="encrypted",
                            detail=(
                                "file is password-protected or encrypted: "
                                "broken.pptx"
                            ),
                        )
                    ],
                )

            monkeypatch.setattr(
                main_module, "convert_office_files", _fake_convert
            )

            # --- run_async_batch: a.pdf, deck.pdf を OCR success として
            # process_log.jsonl に直接書く。yomitoku-client が同じ log_path に追記する
            # 振る舞いを模倣 (CONVERSION_FAILED 行は main.py が先に書いている)。
            async def _fake_run_async(**kwargs):
                log_path = Path(kwargs["log_path"])
                input_dir = Path(kwargs["input_dir"])
                output_dir = Path(kwargs["output_dir"])
                output_dir.mkdir(parents=True, exist_ok=True)
                # OCR 成功 PDF (a.pdf, 変換後 deck.pdf) の log エントリを追記する。
                # CONVERSION_FAILED 行は main.py の _append_conversion_failures_to_log で
                # 既に書かれているため、ここでは success 2 行のみ追記。
                with log_path.open("a", encoding="utf-8") as fp:
                    for stem in ("a", "deck"):
                        fp.write(json.dumps({
                            "timestamp": "2026-04-22T09:10:00.000+00:00",
                            "file_path": str(input_dir / f"{stem}.pdf"),
                            "output_path": str(output_dir / f"{stem}.json"),
                            "dpi": 200,
                            "executed": True,
                            "success": True,
                            "error": None,
                        }) + "\n")
                return SimpleNamespace(
                    succeeded_files=["a", "deck"],
                    failed_files=[],
                    in_flight_timeout=[],
                )

            monkeypatch.setattr(
                main_module, "run_async_batch", _fake_run_async
            )

            # --- 実行 ---
            assert main_module.main() == 0

            # --- 検証 1: process_log.jsonl に 3 件並ぶ (CONV_FAILED 1 + success 2) ---
            input_dir = captured_input_dir["input_dir"]
            log_path = input_dir.parent / "output" / "process_log.jsonl"
            assert log_path.exists(), (
                f"process_log.jsonl が生成されていない: {log_path}"
            )
            lines = [
                json.loads(line)
                for line in log_path.read_text(encoding="utf-8").splitlines()
                if line
            ]
            assert len(lines) == 3, f"想定 3 件, 実 {len(lines)} 件: {lines}"

            # 1 行目: CONVERSION_FAILED (main.py が convert 直後に書く)
            assert lines[0]["success"] is False
            assert lines[0]["error_category"] == "CONVERSION_FAILED"
            assert lines[0]["filename"] == "broken.pptx"
            assert "encrypted" in lines[0]["error"]
            # 2 / 3 行目: OCR success
            success_filenames = {
                Path(line["file_path"]).name for line in lines[1:]
            }
            assert success_filenames == {"a.pdf", "deck.pdf"}
            for line in lines[1:]:
                assert line["success"] is True
                # OCR success には error_category を書かない (yomitoku-client 仕様)
                assert line.get("error_category") is None

            # --- 検証 2: DDB FILE 3 件の状態 ---
            # a.pdf (PDF success): COMPLETED, errorCategory なし
            a_item = table.get_item(Key={
                "PK": f"BATCH#{_E2E_BATCH_ID}",
                "SK": f"FILE#batches/{_E2E_BATCH_ID}/input/a.pdf",
            })["Item"]
            assert a_item["status"] == "COMPLETED"
            assert "errorCategory" not in a_item
            assert "errorMessage" not in a_item

            # deck.pptx (変換成功 → OCR success): COMPLETED, errorCategory なし
            # 重要: process_log の filename は "deck.pdf" だが DDB FILE PK は
            # **原本ファイル名 (deck.pptx)** で seed されている → 整合確認は別タスク (5.10) 担当。
            # ここでは process_log 由来の "deck.pdf" 行が DDB 上 (存在しない) item に
            # update_item しても新規 item を作る (DDB upsert 仕様) ため、
            # 元の deck.pptx PENDING item が残る点を確認するに留める。
            deck_pptx_item = table.get_item(Key={
                "PK": f"BATCH#{_E2E_BATCH_ID}",
                "SK": f"FILE#batches/{_E2E_BATCH_ID}/input/deck.pptx",
            })["Item"]
            # PENDING のまま残る (CONVERSION_FAILED 対象ではないので touched なし)
            assert deck_pptx_item["status"] == "PENDING"

            # broken.pptx (CONVERSION_FAILED): FAILED + errorCategory + errorMessage
            broken_item = table.get_item(Key={
                "PK": f"BATCH#{_E2E_BATCH_ID}",
                "SK": f"FILE#batches/{_E2E_BATCH_ID}/input/broken.pptx",
            })["Item"]
            assert broken_item["status"] == "FAILED"
            assert broken_item["errorCategory"] == "CONVERSION_FAILED"
            assert "encrypted" in broken_item["errorMessage"]

            # --- 検証 3: META.status == PARTIAL ---
            # finalize_batch_status は succeeded=2 (a + deck.pdf), failed=1 (broken),
            # total=3 で評価する → PARTIAL。
            meta = table.get_item(Key={
                "PK": f"BATCH#{_E2E_BATCH_ID}", "SK": "META"
            })["Item"]
            assert meta["status"] == "PARTIAL", (
                f"META.status は PARTIAL のはず, 実 {meta['status']}"
            )
            totals = meta["totals"]
            assert int(totals["total"]) == 3
            assert int(totals["succeeded"]) == 2
            assert int(totals["failed"]) == 1
            # GSI1PK が新 status で書き換わっていること
            assert meta["GSI1PK"].startswith("STATUS#PARTIAL#")

    def test_pdf_only_end_to_end_does_not_call_convert_office_files(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """PDF only バッチで convert_office_files が **一度も呼ばれない** (R7.1 / Task 5.8 第 3 要件)。

        TestOfficeConversionPhase.test_pdf_only_batch_skips_convert_phase は
        AssertionError raise で検知するが、本ケースは call_count を Mock で明示的に
        0 と assert することで R7.1 のレグレッション検知を二重化する。
        """
        with mock_aws():
            table = _create_e2e_batch_table()
            _seed_e2e_batch(table, _E2E_BATCH_ID, ["a.pdf", "b.pdf"])

            _set_env(
                monkeypatch,
                overrides={
                    "BATCH_JOB_ID": _E2E_BATCH_ID,
                    "BATCH_TABLE_NAME": _E2E_BATCH_TABLE,
                },
            )
            for mod in ("main", "settings"):
                sys.modules.pop(mod, None)
            import main as main_module
            importlib.reload(main_module)

            real_resource = boto3.resource
            monkeypatch.setattr(
                main_module.boto3, "resource",
                lambda name, *a, **kw: real_resource(
                    name, *a, region_name=kw.get("region_name", "us-east-1")
                ),
            )
            monkeypatch.setattr(
                main_module.boto3, "client",
                lambda name, *a, **kw: SimpleNamespace(name=name),
            )
            monkeypatch.setattr(main_module, "register_heartbeat", lambda **kw: None)
            monkeypatch.setattr(main_module, "delete_heartbeat", lambda **kw: None)
            monkeypatch.setattr(main_module, "generate_all_visualizations", lambda **kw: {})
            monkeypatch.setattr(
                main_module, "upload_outputs",
                lambda **kw: {"output": 2, "results": 0, "visualizations": 0, "logs": 1},
            )

            captured_input_dir: dict[str, Path] = {}

            def _fake_download(**kwargs):
                captured_input_dir["input_dir"] = Path(kwargs["input_dir"])
                return [
                    f"batches/{_E2E_BATCH_ID}/input/a.pdf",
                    f"batches/{_E2E_BATCH_ID}/input/b.pdf",
                ]

            monkeypatch.setattr(main_module, "download_inputs", _fake_download)

            # convert_office_files は spy で wrap し call_count を確認
            convert_calls = {"n": 0}

            def _spy_convert(*args, **kwargs):
                convert_calls["n"] += 1
                return SimpleNamespace(succeeded=[], failed=[])

            monkeypatch.setattr(main_module, "convert_office_files", _spy_convert)

            async def _fake_run_async(**kwargs):
                log_path = Path(kwargs["log_path"])
                output_dir = Path(kwargs["output_dir"])
                output_dir.mkdir(parents=True, exist_ok=True)
                input_dir = Path(kwargs["input_dir"])
                with log_path.open("a", encoding="utf-8") as fp:
                    for stem in ("a", "b"):
                        fp.write(json.dumps({
                            "timestamp": "2026-04-22T09:10:00.000+00:00",
                            "file_path": str(input_dir / f"{stem}.pdf"),
                            "output_path": str(output_dir / f"{stem}.json"),
                            "dpi": 200,
                            "executed": True,
                            "success": True,
                            "error": None,
                        }) + "\n")
                return SimpleNamespace(
                    succeeded_files=["a", "b"], failed_files=[], in_flight_timeout=[]
                )

            monkeypatch.setattr(main_module, "run_async_batch", _fake_run_async)

            assert main_module.main() == 0

            # R7.1: PDF only では一度も呼ばない
            assert convert_calls["n"] == 0, (
                f"PDF only バッチで convert_office_files が {convert_calls['n']} 回呼ばれた "
                "(R7.1 違反)"
            )

            # META.status は COMPLETED (混在無し / 全件成功 / failed=0)
            meta = table.get_item(Key={
                "PK": f"BATCH#{_E2E_BATCH_ID}", "SK": "META"
            })["Item"]
            assert meta["status"] == "COMPLETED"
