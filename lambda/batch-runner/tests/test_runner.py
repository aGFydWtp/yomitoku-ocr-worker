"""Tests for runner.py: run_async_batch と可視化生成 (Task 5.1)。

AsyncInvoker は monkeypatch で fake に差し替え、Task 5.1 では runner 層の
組み立て責務 (input/output 準備 + AsyncInvoker 呼び出しへの引数写像) を検証する。
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def settings_stub():
    """BatchRunnerSettings 相当のスタブ (Async フィールド込み)。"""
    from types import SimpleNamespace

    return SimpleNamespace(
        batch_job_id="batch-test-001",
        bucket_name="test-bucket",
        batch_table_name="BatchTable",
        control_table_name="ControlTable",
        endpoint_name="yomitoku-async",
        success_queue_url="https://sqs.invalid/success",
        failure_queue_url="https://sqs.invalid/failure",
        async_input_prefix="batches/_async/inputs",
        async_output_prefix="batches/_async/outputs",
        async_error_prefix="batches/_async/errors",
        async_max_concurrent=4,
        max_file_concurrency=3,
        max_page_concurrency=4,
        max_retries=5,
        read_timeout=120.0,
        circuit_threshold=7,
        circuit_cooldown=45.0,
        batch_max_duration_sec=3600,
        extra_formats=["markdown", "csv"],
    )


@pytest.fixture
def reload_runner():
    def _reload():
        import importlib
        sys.modules.pop("runner", None)
        import runner
        importlib.reload(runner)
        return runner

    return _reload


# ---------------------------------------------------------------------------
# run_async_batch
# ---------------------------------------------------------------------------


class _FakeBatchResult:
    def __init__(self):
        self.succeeded_files = ["a"]
        self.failed_files = [("b", "ModelError: test")]
        self.in_flight_timeout: list[str] = []


class _FakeAsyncInvoker:
    """AsyncInvoker のテスト置換。__init__ と run_batch の引数を記録する。"""

    last_init: dict | None = None
    last_run: dict | None = None

    def __init__(self, **kwargs):
        _FakeAsyncInvoker.last_init = kwargs

    async def run_batch(self, **kwargs):
        _FakeAsyncInvoker.last_run = kwargs
        return _FakeBatchResult()


class TestRunAsyncBatch:
    def setup_method(self, _method):
        _FakeAsyncInvoker.last_init = None
        _FakeAsyncInvoker.last_run = None

    def test_constructs_async_invoker_from_settings(
        self, settings_stub, reload_runner, monkeypatch, tmp_path
    ):
        runner = reload_runner()
        monkeypatch.setattr(runner, "AsyncInvoker", _FakeAsyncInvoker)

        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir()
        output_dir.mkdir()
        (input_dir / "a.pdf").write_bytes(b"%PDF-")
        (input_dir / "b.pdf").write_bytes(b"%PDF-")

        result = asyncio.run(
            runner.run_async_batch(
                settings=settings_stub,
                input_dir=str(input_dir),
                output_dir=str(output_dir),
                log_path=str(output_dir / "process_log.jsonl"),
            )
        )

        init_kwargs = _FakeAsyncInvoker.last_init
        assert init_kwargs is not None
        assert init_kwargs["endpoint_name"] == "yomitoku-async"
        assert init_kwargs["input_bucket"] == "test-bucket"
        assert init_kwargs["output_bucket"] == "test-bucket"
        # input_prefix は settings.async_input_prefix + batch_job_id + "/" で組み立てる
        assert (
            init_kwargs["input_prefix"]
            == "batches/_async/inputs/batch-test-001/"
        )
        assert init_kwargs["success_queue_url"] == "https://sqs.invalid/success"
        assert init_kwargs["failure_queue_url"] == "https://sqs.invalid/failure"
        assert init_kwargs["max_concurrent"] == 4

        # run_batch へ input_files / output_dir / log_path / deadline を転送する
        run_kwargs = _FakeAsyncInvoker.last_run
        assert run_kwargs is not None
        assert run_kwargs["batch_job_id"] == "batch-test-001"
        input_files = sorted(p.name for p in run_kwargs["input_files"])
        assert input_files == ["a.pdf", "b.pdf"]
        assert Path(run_kwargs["output_dir"]) == output_dir
        assert Path(run_kwargs["log_path"]) == output_dir / "process_log.jsonl"
        # deadline は settings.batch_max_duration_sec を使う
        assert run_kwargs["deadline_seconds"] == 3600.0

        # BatchResult をそのまま返す
        assert result.succeeded_files == ["a"]
        assert result.failed_files == [("b", "ModelError: test")]

    def test_deadline_override_is_respected(
        self, settings_stub, reload_runner, monkeypatch, tmp_path
    ):
        runner = reload_runner()
        monkeypatch.setattr(runner, "AsyncInvoker", _FakeAsyncInvoker)

        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir()
        output_dir.mkdir()

        asyncio.run(
            runner.run_async_batch(
                settings=settings_stub,
                input_dir=str(input_dir),
                output_dir=str(output_dir),
                log_path=str(output_dir / "log.jsonl"),
                deadline_seconds=60.0,
            )
        )

        run_kwargs = _FakeAsyncInvoker.last_run
        assert run_kwargs is not None
        assert run_kwargs["deadline_seconds"] == 60.0

    def test_realtime_symbols_are_removed(self, reload_runner):
        """旧 Realtime 経路 (create_client / run_analyze_batch) は撤去済。"""
        runner = reload_runner()
        assert not hasattr(runner, "create_client"), (
            "create_client は Task 5.1 で撤去されているはず"
        )
        assert not hasattr(runner, "run_analyze_batch"), (
            "run_analyze_batch は Task 5.1 で撤去されているはず"
        )


# ---------------------------------------------------------------------------
# generate_visualizations (Task 3.3 から継続)
# ---------------------------------------------------------------------------


class TestGenerateVisualizations:
    def _install_fakes(self, runner, monkeypatch, *, pages: int = 2):
        """parse_pydantic_model / load_pdf / correct_rotation_image / cv2 を偽装する。"""
        import numpy as np

        fake_img = np.zeros((10, 10, 3), dtype=np.uint8)

        class FakePageResult:
            def __init__(self, idx):
                self.idx = idx
                self.preprocess = {"angle": 0}

            def visualize(self, img, mode):
                return fake_img

        class FakeParsed:
            def __init__(self, pages: int):
                self.pages = [FakePageResult(i) for i in range(pages)]

        def fake_parse(data):
            return FakeParsed(pages)

        def fake_load_pdf(path, dpi):
            return [fake_img for _ in range(pages)]

        def fake_correct(img, angle):
            return img

        monkeypatch.setattr(runner, "parse_pydantic_model", fake_parse)
        monkeypatch.setattr(runner, "load_pdf", fake_load_pdf)
        monkeypatch.setattr(runner, "correct_rotation_image", fake_correct)

        written: list[str] = []

        def fake_imwrite(path, img):
            Path(path).write_bytes(b"\xff\xd8fake-jpeg")
            written.append(path)
            return True

        monkeypatch.setattr(runner.cv2, "imwrite", fake_imwrite)
        return written

    def test_generates_layout_and_ocr_per_page(
        self, reload_runner, monkeypatch, tmp_path
    ):
        runner = reload_runner()
        self._install_fakes(runner, monkeypatch, pages=2)

        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir()
        output_dir.mkdir()

        (input_dir / "sample.pdf").write_bytes(b"%PDF-")
        (output_dir / "sample.json").write_text(json.dumps({"pages": []}))

        errors = runner.generate_all_visualizations(
            input_dir=str(input_dir), output_dir=str(output_dir)
        )

        assert errors == {}
        generated = sorted(p.name for p in output_dir.glob("*.jpg"))
        assert generated == [
            "sample_layout_page_0.jpg",
            "sample_layout_page_1.jpg",
            "sample_ocr_page_0.jpg",
            "sample_ocr_page_1.jpg",
        ]

    def test_skips_json_without_matching_pdf(
        self, reload_runner, monkeypatch, tmp_path
    ):
        runner = reload_runner()
        self._install_fakes(runner, monkeypatch)

        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir()
        output_dir.mkdir()

        (output_dir / "missing.json").write_text("{}")

        errors = runner.generate_all_visualizations(
            input_dir=str(input_dir), output_dir=str(output_dir)
        )
        assert "missing" in errors
        assert not list(output_dir.glob("*.jpg"))

    def test_collects_per_page_errors_without_aborting(
        self, reload_runner, monkeypatch, tmp_path
    ):
        runner = reload_runner()
        self._install_fakes(runner, monkeypatch, pages=2)

        original_parse = runner.parse_pydantic_model

        def broken_parse(data):
            parsed = original_parse(data)

            def boom(img, mode):
                raise RuntimeError("layout fail")

            parsed.pages[0].visualize = boom
            return parsed

        monkeypatch.setattr(runner, "parse_pydantic_model", broken_parse)

        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir()
        output_dir.mkdir()
        (input_dir / "a.pdf").write_bytes(b"%PDF-")
        (output_dir / "a.json").write_text("{}")

        errors = runner.generate_all_visualizations(
            input_dir=str(input_dir), output_dir=str(output_dir)
        )

        assert "a" in errors
        assert any("page 0" in e for e in errors["a"])
        generated = sorted(p.name for p in output_dir.glob("*.jpg"))
        assert generated == [
            "a_layout_page_1.jpg",
            "a_ocr_page_1.jpg",
        ]

    def test_visualizes_converted_pdf_after_office_original_removed(
        self, reload_runner, monkeypatch, tmp_path
    ):
        """R8.1-8.3 非退行: Office 原本が削除済 + 変換後 PDF のみ存在する状態でも、
        runner.py の ``in_path / f"{basename}.pdf"`` 解決で可視化が生成される。

        office_converter.convert_office_files() は変換後に原本 (.pptx/.docx/.xlsx)
        を削除し ``{stem}.pdf`` のみを並置するため、本テストでは事後状態
        (input_dir に .pdf のみが存在し、原本拡張子のファイルは存在しない) を
        再現する。
        """
        runner = reload_runner()
        self._install_fakes(runner, monkeypatch, pages=2)

        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir()
        output_dir.mkdir()

        # Office 変換後の状態: 原本 (.pptx 等) は既に削除済。
        # input_dir には変換後 PDF のみ残っている。
        (input_dir / "deck.pdf").write_bytes(b"%PDF-")
        (output_dir / "deck.json").write_text(json.dumps({"pages": []}))

        # Office 原本拡張子のファイルは置かない (削除済を表現)。
        assert not list(input_dir.glob("*.pptx"))
        assert not list(input_dir.glob("*.docx"))
        assert not list(input_dir.glob("*.xlsx"))

        errors = runner.generate_all_visualizations(
            input_dir=str(input_dir), output_dir=str(output_dir)
        )

        # PDF 可視化パイプラインがそのまま再利用され、命名規則も維持されること
        # (R8.1 / R8.2 / R8.3)。
        assert errors == {}
        generated = sorted(p.name for p in output_dir.glob("*.jpg"))
        assert generated == [
            "deck_layout_page_0.jpg",
            "deck_layout_page_1.jpg",
            "deck_ocr_page_0.jpg",
            "deck_ocr_page_1.jpg",
        ]

    def test_visualizes_pdf_and_converted_pdf_are_indistinguishable(
        self, reload_runner, monkeypatch, tmp_path
    ):
        """R8.3 非退行: 既存 PDF 入力と Office 由来の変換後 PDF が input_dir に
        混在しても、両方とも同一の可視化命名規則で処理される。

        runner.py からは両者の出自を区別できず ``.pdf`` として一括処理される
        ことを検証する。
        """
        runner = reload_runner()
        self._install_fakes(runner, monkeypatch, pages=1)

        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir()
        output_dir.mkdir()

        # 既存 PDF と、Office 変換後 PDF を並置 (原本拡張子は無し)。
        (input_dir / "native.pdf").write_bytes(b"%PDF-")
        (input_dir / "converted.pdf").write_bytes(b"%PDF-")
        (output_dir / "native.json").write_text(json.dumps({"pages": []}))
        (output_dir / "converted.json").write_text(json.dumps({"pages": []}))

        errors = runner.generate_all_visualizations(
            input_dir=str(input_dir), output_dir=str(output_dir)
        )

        # 両者とも同じパイプラインで処理され、エラーゼロかつ同形式の JPEG が出る。
        assert errors == {}
        generated = sorted(p.name for p in output_dir.glob("*.jpg"))
        assert generated == [
            "converted_layout_page_0.jpg",
            "converted_ocr_page_0.jpg",
            "native_layout_page_0.jpg",
            "native_ocr_page_0.jpg",
        ]
