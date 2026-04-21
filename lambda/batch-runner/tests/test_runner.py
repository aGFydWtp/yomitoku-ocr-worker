"""Tests for runner.py: analyze_batch_async 実行と可視化生成。

YomitokuClient / analyze_batch_async / parse_pydantic_model / DocumentResult.visualize
はすべて monkeypatch で置換し、外部依存なしで動作検証する。
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def settings_stub():
    """BatchRunnerSettings 相当のスタブ。"""
    from types import SimpleNamespace

    return SimpleNamespace(
        batch_job_id="batch-test-001",
        bucket_name="test-bucket",
        batch_table_name="BatchTable",
        control_table_name="ControlTable",
        endpoint_name="yomitoku-endpoint",
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
# create_client
# ---------------------------------------------------------------------------


class TestCreateClient:
    def test_constructs_yomitoku_client_with_configs(
        self, settings_stub, reload_runner, monkeypatch
    ):
        runner = reload_runner()

        captured: dict = {}

        class FakeRequestConfig:
            def __init__(self, **kwargs):
                captured["request_config"] = kwargs

        class FakeCircuitConfig:
            def __init__(self, **kwargs):
                captured["circuit_config"] = kwargs

        class FakeClient:
            def __init__(self, **kwargs):
                captured["client"] = kwargs

        monkeypatch.setattr(runner, "YomitokuClient", FakeClient)
        monkeypatch.setattr(runner, "RequestConfig", FakeRequestConfig)
        monkeypatch.setattr(runner, "CircuitConfig", FakeCircuitConfig)

        runner.create_client(settings_stub)

        assert captured["request_config"] == {
            "read_timeout": 120,
            "connect_timeout": 10,
            "max_retries": 5,
        }
        assert captured["circuit_config"] == {
            "threshold": 7,
            "cooldown_time": 45,
        }
        assert captured["client"]["endpoint"] == "yomitoku-endpoint"
        assert captured["client"]["max_workers"] == 3
        assert isinstance(
            captured["client"]["request_config"], FakeRequestConfig
        )
        assert isinstance(
            captured["client"]["circuit_config"], FakeCircuitConfig
        )


# ---------------------------------------------------------------------------
# run_analyze_batch
# ---------------------------------------------------------------------------


class TestRunAnalyzeBatch:
    def test_calls_analyze_batch_async_with_settings(
        self, settings_stub, reload_runner, tmp_path
    ):
        runner = reload_runner()

        captured: dict = {}

        class FakeClient:
            async def analyze_batch_async(self, **kwargs):
                captured.update(kwargs)
                # process_log.jsonl を模擬作成
                log_path = kwargs.get("log_path")
                if log_path:
                    Path(log_path).write_text(
                        json.dumps(
                            {"file_path": "a.pdf", "success": True}
                        ) + "\n"
                    )

        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir()
        output_dir.mkdir()

        log_path = output_dir / "process_log.jsonl"
        asyncio.run(
            runner.run_analyze_batch(
                client=FakeClient(),
                input_dir=str(input_dir),
                output_dir=str(output_dir),
                settings=settings_stub,
                log_path=str(log_path),
            )
        )

        assert captured["input_dir"] == str(input_dir)
        assert captured["output_dir"] == str(output_dir)
        assert captured["max_file_concurrency"] == 3
        assert captured["max_page_concurrency"] == 4
        assert captured["extra_formats"] == ["markdown", "csv"]
        assert captured["log_path"] == str(log_path)
        assert log_path.exists()

    def test_emits_structured_info_log(
        self, settings_stub, reload_runner, tmp_path, caplog
    ):
        runner = reload_runner()

        class FakeClient:
            async def analyze_batch_async(self, **kwargs):
                return None

        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir()
        output_dir.mkdir()
        (input_dir / "a.pdf").write_bytes(b"%PDF")
        (input_dir / "b.pdf").write_bytes(b"%PDF")

        with caplog.at_level(logging.INFO, logger=runner.logger.name):
            asyncio.run(
                runner.run_analyze_batch(
                    client=FakeClient(),
                    input_dir=str(input_dir),
                    output_dir=str(output_dir),
                    settings=settings_stub,
                )
            )

        # batch_job_id とファイル数を INFO ログで出すこと
        info_records = [r for r in caplog.records if r.levelno == logging.INFO]
        assert any(
            getattr(r, "batch_job_id", None) == "batch-test-001"
            and getattr(r, "file_count", None) == 2
            for r in info_records
        ), f"structured INFO log not found: {[r.__dict__ for r in info_records]}"
        # 経過時間 (elapsed_sec) が記録されること
        assert any(
            getattr(r, "elapsed_sec", None) is not None
            for r in info_records
        )

    def test_complete_log_includes_circuit_break_count(
        self, settings_stub, reload_runner, tmp_path, caplog
    ):
        """complete ログに circuit_break_count (private _circuit_failures) を記録する。"""
        runner = reload_runner()

        class FakeClient:
            def __init__(self):
                # yomitoku-client の private 属性を模擬
                self._circuit_failures = 3

            async def analyze_batch_async(self, **kwargs):
                return None

        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir()
        output_dir.mkdir()

        with caplog.at_level(logging.INFO, logger=runner.logger.name):
            asyncio.run(
                runner.run_analyze_batch(
                    client=FakeClient(),
                    input_dir=str(input_dir),
                    output_dir=str(output_dir),
                    settings=settings_stub,
                )
            )

        complete_records = [
            r for r in caplog.records
            if r.levelno == logging.INFO
            and getattr(r, "circuit_break_count", None) is not None
        ]
        assert complete_records, "complete log with circuit_break_count not found"
        assert complete_records[-1].circuit_break_count == 3

    def test_complete_log_circuit_break_count_defaults_to_zero(
        self, settings_stub, reload_runner, tmp_path, caplog
    ):
        """client に _circuit_failures が無い場合は 0 を記録する。"""
        runner = reload_runner()

        class FakeClient:
            async def analyze_batch_async(self, **kwargs):
                return None

        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir()
        output_dir.mkdir()

        with caplog.at_level(logging.INFO, logger=runner.logger.name):
            asyncio.run(
                runner.run_analyze_batch(
                    client=FakeClient(),
                    input_dir=str(input_dir),
                    output_dir=str(output_dir),
                    settings=settings_stub,
                )
            )

        assert any(
            getattr(r, "circuit_break_count", None) == 0
            for r in caplog.records
        )


# ---------------------------------------------------------------------------
# generate_visualizations
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
                # 戻り値は np.ndarray
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
        # 2 page × 2 mode = 4 jpgs
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

        # PDF が無い (DDB FILE 削除など)
        (output_dir / "missing.json").write_text("{}")

        errors = runner.generate_all_visualizations(
            input_dir=str(input_dir), output_dir=str(output_dir)
        )
        assert "missing" in errors
        assert not list(output_dir.glob("*.jpg"))

    def test_collects_per_page_errors_without_aborting(
        self, reload_runner, monkeypatch, tmp_path
    ):
        """1 ページの可視化失敗でファイル処理を中断せず、残りページを継続する。"""
        runner = reload_runner()
        self._install_fakes(runner, monkeypatch, pages=2)

        # page 0 の visualize だけ常に失敗するように差し替え
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

        # page 0 のエラーが捕捉されている
        assert "a" in errors
        assert any("page 0" in e for e in errors["a"])
        # page 1 の 2 枚は生成成功
        generated = sorted(p.name for p in output_dir.glob("*.jpg"))
        assert generated == [
            "a_layout_page_1.jpg",
            "a_ocr_page_1.jpg",
        ]
