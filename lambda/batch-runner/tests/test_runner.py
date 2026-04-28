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
    """AsyncInvoker のテスト置換。__init__ と run_batch の引数を記録する。

    Task 4.1 で ``runner.run_async_batch`` が ``InflightPublisher`` の
    ``provider`` として ``invoker.inflight_count`` を直接参照するように
    なったため、このフェイクにも同名メソッドを生やしている (戻り値 0 固定で
    十分。本フェイクを使うテストは publisher の振る舞いを検証しない)。
    """

    last_init: dict | None = None
    last_run: dict | None = None
    events: list[str] = []

    def __init__(self, **kwargs):
        _FakeAsyncInvoker.last_init = kwargs
        _FakeAsyncInvoker.events.append("invoker_init")

    async def run_batch(self, **kwargs):
        _FakeAsyncInvoker.last_run = kwargs
        _FakeAsyncInvoker.events.append("run_batch")
        return _FakeBatchResult()

    def inflight_count(self) -> int:  # noqa: D401 — fake getter
        return 0


class TestRunAsyncBatch:
    def setup_method(self, _method):
        _FakeAsyncInvoker.last_init = None
        _FakeAsyncInvoker.last_run = None
        _FakeAsyncInvoker.events = []

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
# InflightPublisher 統合 (Task 5.3, R2.2 / R2.3 / R2.7 / R3.6)
# ---------------------------------------------------------------------------


class _SpyInflightPublisher:
    """``runner.InflightPublisher`` のテスト置換 spy。

    ``__init__`` / ``start`` / ``stop`` の呼び出しを ``calls`` リストに
    記録し、`runner.run_async_batch` 内のライフサイクル順序検証に使う。
    """

    instances: list["_SpyInflightPublisher"] = []
    start_should_raise: bool = False

    def __init__(self, *, endpoint_name: str, provider, **_kwargs) -> None:
        self.endpoint_name = endpoint_name
        self.provider = provider
        self.calls: list[str] = []
        _FakeAsyncInvoker.events.append("publisher_init")
        _SpyInflightPublisher.instances.append(self)

    def start(self) -> None:
        _FakeAsyncInvoker.events.append("publisher_start")
        self.calls.append("start")
        if _SpyInflightPublisher.start_should_raise:
            raise RuntimeError("publisher start failed")

    def stop(self, *, timeout_sec: float = 5.0) -> None:  # noqa: ARG002
        _FakeAsyncInvoker.events.append("publisher_stop")
        self.calls.append("stop")


class _RaisingFakeAsyncInvoker(_FakeAsyncInvoker):
    """``run_batch`` が例外を投げる版の fake (publisher の finally 動作確認用)。"""

    async def run_batch(self, **kwargs):  # noqa: D401 — fake
        _FakeAsyncInvoker.last_run = kwargs
        _FakeAsyncInvoker.events.append("run_batch")
        raise RuntimeError("run_batch failed for finally test")


class TestRunAsyncBatchPublisherIntegration:
    """``runner.run_async_batch`` の `InflightPublisher` 統合テスト (Task 5.3)。"""

    def setup_method(self, _method):
        _FakeAsyncInvoker.last_init = None
        _FakeAsyncInvoker.last_run = None
        _FakeAsyncInvoker.events = []
        _SpyInflightPublisher.instances = []
        _SpyInflightPublisher.start_should_raise = False

    def _prepare_dirs(self, tmp_path):
        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir(parents=True, exist_ok=True)
        output_dir.mkdir(parents=True, exist_ok=True)
        return input_dir, output_dir

    def test_publisher_started_after_invoker_construction_and_stopped_in_finally(
        self, settings_stub, reload_runner, monkeypatch, tmp_path
    ):
        """R2.2 / R2.3: ``run_async_batch`` 成功時 / 例外時の双方で
        ``__init__`` → ``start`` → ``stop`` の順序が成立し、`stop` は
        ``finally`` 句経由で必ず呼ばれることを assert する。"""
        runner = reload_runner()
        monkeypatch.setattr(runner, "AsyncInvoker", _FakeAsyncInvoker)
        monkeypatch.setattr(runner, "InflightPublisher", _SpyInflightPublisher)

        # --- 成功経路 -----------------------------------------------------
        input_dir, output_dir = self._prepare_dirs(tmp_path / "ok")
        result = asyncio.run(
            runner.run_async_batch(
                settings=settings_stub,
                input_dir=str(input_dir),
                output_dir=str(output_dir),
                log_path=str(output_dir / "process_log.jsonl"),
            )
        )
        assert result.succeeded_files == ["a"]

        assert len(_SpyInflightPublisher.instances) == 1, (
            "publisher は run_async_batch ごとに 1 度だけ構築されるはず"
        )
        spy_ok = _SpyInflightPublisher.instances[0]
        assert spy_ok.endpoint_name == settings_stub.endpoint_name
        assert callable(spy_ok.provider)
        # 構築 → 起動 → 停止 の順で呼ばれていること (= finally で stop が走る)。
        assert spy_ok.calls == ["start", "stop"]
        assert _FakeAsyncInvoker.events == [
            "invoker_init",
            "publisher_init",
            "publisher_start",
            "run_batch",
            "publisher_stop",
        ]

        # --- 例外経路 (run_batch が例外を投げても finally で stop が呼ばれる) --
        _SpyInflightPublisher.instances = []  # リセットして例外経路用に再評価
        _FakeAsyncInvoker.events = []
        monkeypatch.setattr(runner, "AsyncInvoker", _RaisingFakeAsyncInvoker)

        input_dir2, output_dir2 = self._prepare_dirs(tmp_path / "ng")
        with pytest.raises(RuntimeError, match="run_batch failed for finally test"):
            asyncio.run(
                runner.run_async_batch(
                    settings=settings_stub,
                    input_dir=str(input_dir2),
                    output_dir=str(output_dir2),
                    log_path=str(output_dir2 / "process_log.jsonl"),
                )
            )

        assert len(_SpyInflightPublisher.instances) == 1
        spy_ng = _SpyInflightPublisher.instances[0]
        # 例外経路でも start → stop の順序が維持されている (= finally 句経由で
        # stop が必ず呼ばれている)。
        assert spy_ng.calls == ["start", "stop"]
        assert _FakeAsyncInvoker.events == [
            "invoker_init",
            "publisher_init",
            "publisher_start",
            "run_batch",
            "publisher_stop",
        ]

    def test_publisher_provider_is_invoker_inflight_count(
        self, settings_stub, reload_runner, monkeypatch, tmp_path
    ):
        """R3.6: publisher に渡される ``provider`` callable は構築済
        ``invoker.inflight_count`` の bound method そのものであること
        (holder/closure を介さない直接渡し)。"""
        runner = reload_runner()
        monkeypatch.setattr(runner, "AsyncInvoker", _FakeAsyncInvoker)
        monkeypatch.setattr(runner, "InflightPublisher", _SpyInflightPublisher)

        input_dir, output_dir = self._prepare_dirs(tmp_path)
        asyncio.run(
            runner.run_async_batch(
                settings=settings_stub,
                input_dir=str(input_dir),
                output_dir=str(output_dir),
                log_path=str(output_dir / "process_log.jsonl"),
            )
        )

        assert len(_SpyInflightPublisher.instances) == 1
        spy = _SpyInflightPublisher.instances[0]
        provider = spy.provider

        # bound method の identity を厳密に比較する:
        # - ``provider.__self__`` は ``AsyncInvoker`` インスタンス本体
        # - ``provider.__func__`` は class 上の関数オブジェクト
        # この組み合わせで、closure / lambda / partial を介さない直接渡しを
        # 機械的に検証できる (R3.6: 副作用なしの read-only 公開)。
        assert hasattr(provider, "__self__"), (
            "provider は bound method であるべき (closure 経由ではない)"
        )
        assert hasattr(provider, "__func__")
        assert isinstance(provider.__self__, _FakeAsyncInvoker)
        assert provider.__func__ is _FakeAsyncInvoker.inflight_count
        # 呼び出し可能性も確認 (fake は 0 を返す)。
        assert provider() == 0

    def test_publisher_failure_does_not_fail_run_async_batch(
        self, settings_stub, reload_runner, monkeypatch, tmp_path
    ):
        """R2.7: ``InflightPublisher.start`` が ``RuntimeError`` を投げても
        ``run_async_batch`` は ``BatchResult`` を返して正常終了する。
        publisher は observability-only であり、OCR 本体を中断しない。"""
        runner = reload_runner()
        monkeypatch.setattr(runner, "AsyncInvoker", _FakeAsyncInvoker)
        monkeypatch.setattr(runner, "InflightPublisher", _SpyInflightPublisher)
        # spy の start() 内で RuntimeError を投げさせる。
        _SpyInflightPublisher.start_should_raise = True

        input_dir, output_dir = self._prepare_dirs(tmp_path)
        result = asyncio.run(
            runner.run_async_batch(
                settings=settings_stub,
                input_dir=str(input_dir),
                output_dir=str(output_dir),
                log_path=str(output_dir / "process_log.jsonl"),
            )
        )

        # 例外を投げず BatchResult が返る (= publisher 失敗を吸収している)。
        assert result.succeeded_files == ["a"]
        assert result.failed_files == [("b", "ModelError: test")]

        # publisher オブジェクト自体は構築済なので、finally 句で stop() が
        # 呼ばれるはず (start 失敗後でも publisher.stop() を防御的に呼ぶ R2.7 経路)。
        assert len(_SpyInflightPublisher.instances) == 1
        spy = _SpyInflightPublisher.instances[0]
        assert spy.calls == ["start", "stop"], (
            "start が例外を投げても finally で stop が呼ばれることが必要"
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
        """R2.1: PDF native — 新命名規約 ``sample.pdf.json`` から ``sample.pdf`` を解決。"""
        runner = reload_runner()
        self._install_fakes(runner, monkeypatch, pages=2)

        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir()
        output_dir.mkdir()

        (input_dir / "sample.pdf").write_bytes(b"%PDF-")
        (output_dir / "sample.pdf.json").write_text(json.dumps({"pages": []}))

        errors = runner.generate_all_visualizations(
            input_dir=str(input_dir), output_dir=str(output_dir)
        )

        assert errors == {}
        # JPEG basename は pdf_path.stem (= "sample") のまま据え置き (R2.4)。
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
        """lookup miss: 対応 PDF が input_dir に不在 → silent skip + warning ログ。

        ``errors_per_file`` のキーは ``original_input_name``
        (= ``json_file.name[:-len(".json")]``)、エラーメッセージは
        ``"local PDF not found: {local_pdf_basename}"`` (R2.4 関連)。
        """
        runner = reload_runner()
        self._install_fakes(runner, monkeypatch)

        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir()
        output_dir.mkdir()

        (output_dir / "missing.pdf.json").write_text("{}")

        errors = runner.generate_all_visualizations(
            input_dir=str(input_dir), output_dir=str(output_dir)
        )
        assert errors == {"missing.pdf": ["local PDF not found: missing.pdf"]}
        assert not list(output_dir.glob("*.jpg"))

    def test_collects_per_page_errors_without_aborting(
        self, reload_runner, monkeypatch, tmp_path
    ):
        """ページ単位の失敗を収集して継続する非リグレッション (新命名規約)。"""
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
        (output_dir / "a.pdf.json").write_text("{}")

        errors = runner.generate_all_visualizations(
            input_dir=str(input_dir), output_dir=str(output_dir)
        )

        # キーは original_input_name (= "a.pdf")。
        assert "a.pdf" in errors
        assert any("page 0" in e for e in errors["a.pdf"])
        generated = sorted(p.name for p in output_dir.glob("*.jpg"))
        assert generated == [
            "a_layout_page_1.jpg",
            "a_ocr_page_1.jpg",
        ]

    def test_visualizes_converted_pdf_with_office_lookup(
        self, reload_runner, monkeypatch, tmp_path
    ):
        """R2.2 / R2.3: Office case — ``deck.pptx.json`` + ``original_to_local`` 経由で
        変換後 PDF ``deck.pdf`` を逆引き解決する。

        office_converter.convert_office_files() は変換後に原本 (.pptx/.docx/.xlsx)
        を削除し ``{stem}.pdf`` のみを並置する。本テストでは新命名規約
        (``deck.pptx.json``) と双方向 map (``{"deck.pptx": "deck.pdf"}``) を渡し、
        ``input_dir/deck.pdf`` が解決され可視化が生成されることを検証する。
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
        # メイン JSON は新命名規約 (原本ファイル名 + ".json") で保存済。
        (output_dir / "deck.pptx.json").write_text(json.dumps({"pages": []}))

        # Office 原本拡張子のファイルは置かない (削除済を表現)。
        assert not list(input_dir.glob("*.pptx"))
        assert not list(input_dir.glob("*.docx"))
        assert not list(input_dir.glob("*.xlsx"))

        errors = runner.generate_all_visualizations(
            input_dir=str(input_dir),
            output_dir=str(output_dir),
            original_to_local={"deck.pptx": "deck.pdf"},
        )

        # 可視化 JPEG basename は ``pdf_path.stem`` (= "deck") のまま (R2.4 据え置き)。
        assert errors == {}
        generated = sorted(p.name for p in output_dir.glob("*.jpg"))
        assert generated == [
            "deck_layout_page_0.jpg",
            "deck_layout_page_1.jpg",
            "deck_ocr_page_0.jpg",
            "deck_ocr_page_1.jpg",
        ]

    def test_visualizes_pdf_and_converted_pdf_mixed(
        self, reload_runner, monkeypatch, tmp_path
    ):
        """R2.3 非退行: 既存 PDF 入力と Office 由来の変換後 PDF が混在しても、
        新命名規約 + ``original_to_local`` map で正しく逆引き解決される。

        - native PDF は identity (map に entry なし) で ``native.pdf.json``
          → ``native.pdf`` に解決
        - Office case は ``original_to_local`` 経由で ``deck.pptx.json``
          → ``deck.pdf`` に解決
        """
        runner = reload_runner()
        self._install_fakes(runner, monkeypatch, pages=1)

        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir()
        output_dir.mkdir()

        # 既存 PDF と、Office 変換後 PDF を並置 (原本拡張子は無し)。
        (input_dir / "native.pdf").write_bytes(b"%PDF-")
        (input_dir / "deck.pdf").write_bytes(b"%PDF-")
        (output_dir / "native.pdf.json").write_text(json.dumps({"pages": []}))
        (output_dir / "deck.pptx.json").write_text(json.dumps({"pages": []}))

        errors = runner.generate_all_visualizations(
            input_dir=str(input_dir),
            output_dir=str(output_dir),
            original_to_local={"deck.pptx": "deck.pdf"},
        )

        # 両者とも同じパイプラインで処理され、エラーゼロかつ同形式の JPEG が出る。
        assert errors == {}
        generated = sorted(p.name for p in output_dir.glob("*.jpg"))
        assert generated == [
            "deck_layout_page_0.jpg",
            "deck_ocr_page_0.jpg",
            "native_layout_page_0.jpg",
            "native_ocr_page_0.jpg",
        ]

    def test_lookup_miss_for_office_when_map_missing_entry(
        self, reload_runner, monkeypatch, tmp_path
    ):
        """lookup miss (Office): ``original_to_local`` に entry が無く、原本名
        (``deck.pptx``) と一致する PDF も input_dir に無い場合、identity 解決で
        ``deck.pptx`` が試行され、PDF 不在で silent skip される。

        エラーメッセージは ``"local PDF not found: deck.pptx"``、キーは
        ``original_input_name`` (= ``deck.pptx``)。
        """
        runner = reload_runner()
        self._install_fakes(runner, monkeypatch)

        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir()
        output_dir.mkdir()

        # Office JSON のみ存在、対応 PDF は input_dir に無い (map も空)。
        (output_dir / "deck.pptx.json").write_text("{}")

        errors = runner.generate_all_visualizations(
            input_dir=str(input_dir),
            output_dir=str(output_dir),
            original_to_local=None,
        )

        # identity で deck.pptx が試行される → PDF 不在で skip。
        assert errors == {"deck.pptx": ["local PDF not found: deck.pptx"]}
        assert not list(output_dir.glob("*.jpg"))
