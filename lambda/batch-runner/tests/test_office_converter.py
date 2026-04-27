"""office_converter.py のユニットテスト。

Task 3.1: Office (PPTX/DOCX/XLSX) → PDF 変換モジュールの全 public API をカバーする。

テスト対象 public API:
    - is_office_format(filename) -> bool
    - is_password_protected(path) -> bool
    - convert_office_to_pdf(input_path, work_dir, timeout_sec) -> Path
    - validate_converted_size(pdf_path, max_bytes) -> None
    - convert_office_files(input_dir, *, timeout_sec, max_concurrent, max_converted_bytes) -> ConvertResult

例外型:
    - ConversionEncryptedError / ConversionTimeoutError / ConversionExitCodeError
    - ConversionSilentFailError / ConversionOversizeError
    - 共通基底: ConversionError

主に subprocess.Popen / msoffcrypto を mock してオフラインで決定論的に検証する。
LibreOffice / soffice バイナリは実行しない。
"""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from dataclasses import FrozenInstanceError
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from office_converter import (
    OFFICE_EXTENSIONS,
    ConversionEncryptedError,
    ConversionError,
    ConversionExitCodeError,
    ConversionOversizeError,
    ConversionSilentFailError,
    ConversionTimeoutError,
    ConvertedFile,
    ConvertFailure,
    ConvertResult,
    convert_office_files,
    convert_office_to_pdf,
    is_office_format,
    is_password_protected,
    validate_converted_size,
)


# ---------------------------------------------------------------------------
# is_office_format
# ---------------------------------------------------------------------------


class TestIsOfficeFormat:
    @pytest.mark.parametrize("name", ["a.pptx", "doc.docx", "sheet.xlsx", "MIXED.PPTX", "Foo.Docx"])
    def test_returns_true_for_office_extensions_case_insensitive(self, name: str) -> None:
        assert is_office_format(name) is True

    @pytest.mark.parametrize("name", ["a.pdf", "image.png", "noext", "archive.zip", ".pptx.bak"])
    def test_returns_false_for_non_office_extensions(self, name: str) -> None:
        assert is_office_format(name) is False

    def test_office_extensions_constant_is_frozenset(self) -> None:
        assert isinstance(OFFICE_EXTENSIONS, frozenset)
        assert OFFICE_EXTENSIONS == frozenset({".pptx", ".docx", ".xlsx"})


# ---------------------------------------------------------------------------
# is_password_protected
# ---------------------------------------------------------------------------


class TestIsPasswordProtected:
    def test_returns_true_when_msoffcrypto_reports_encrypted(self, tmp_path: Path) -> None:
        f = tmp_path / "x.pptx"
        f.write_bytes(b"dummy")
        with patch("office_converter.msoffcrypto") as m:
            m.OfficeFile.return_value.is_encrypted.return_value = True
            assert is_password_protected(f) is True

    def test_returns_false_when_msoffcrypto_reports_clear(self, tmp_path: Path) -> None:
        f = tmp_path / "x.pptx"
        f.write_bytes(b"dummy")
        with patch("office_converter.msoffcrypto") as m:
            m.OfficeFile.return_value.is_encrypted.return_value = False
            assert is_password_protected(f) is False

    def test_returns_false_when_msoffcrypto_raises(self, tmp_path: Path) -> None:
        """検知不可な corrupted ファイル等は False を返し、後段の変換段階で別途エラーになる。"""
        f = tmp_path / "x.pptx"
        f.write_bytes(b"junk")
        with patch("office_converter.msoffcrypto") as m:
            m.OfficeFile.side_effect = RuntimeError("not OOXML")
            assert is_password_protected(f) is False

    def test_returns_false_when_open_raises(self, tmp_path: Path) -> None:
        # 存在しないファイルでも例外を握りつぶし False を返す
        missing = tmp_path / "missing.pptx"
        with patch("office_converter.msoffcrypto"):
            assert is_password_protected(missing) is False


# ---------------------------------------------------------------------------
# validate_converted_size
# ---------------------------------------------------------------------------


class TestValidateConvertedSize:
    def test_passes_for_size_within_limit(self, tmp_path: Path) -> None:
        f = tmp_path / "out.pdf"
        f.write_bytes(b"x" * 100)
        validate_converted_size(f, max_bytes=200)  # no raise

    def test_passes_at_boundary(self, tmp_path: Path) -> None:
        f = tmp_path / "out.pdf"
        f.write_bytes(b"x" * 100)
        validate_converted_size(f, max_bytes=100)  # equal is OK

    def test_raises_when_over_limit(self, tmp_path: Path) -> None:
        f = tmp_path / "out.pdf"
        f.write_bytes(b"x" * 101)
        with pytest.raises(ConversionOversizeError) as ei:
            validate_converted_size(f, max_bytes=100)
        msg = str(ei.value)
        assert "101" in msg
        assert "100" in msg


# ---------------------------------------------------------------------------
# convert_office_to_pdf
# ---------------------------------------------------------------------------


def _fake_popen_success(work_dir: Path, stem: str, *, exit_code: int = 0, write_pdf: bool = True, pdf_size: int = 1024, stderr: bytes = b""):
    """soffice subprocess.Popen を成功 (or 任意の exit_code/書き出し有無) でモックする factory。

    Bug 003 (deadlock fix): production code now calls ``proc.communicate(timeout=...)``
    instead of ``proc.wait(timeout=...)``. The mock therefore performs the
    PDF-write side effect inside ``communicate`` so the contract still matches
    the real soffice flow. ``wait`` is also wired up for parity with any older
    callers / tests, but the production path no longer triggers it.
    """
    pdf = work_dir / f"{stem}.pdf"

    proc = MagicMock()
    proc.pid = 12345

    def _produce(timeout=None):  # noqa: ARG001
        if write_pdf:
            pdf.write_bytes(b"%PDF-fake\n" + b"x" * (pdf_size - 10 if pdf_size > 10 else 0))
        proc.returncode = exit_code
        return exit_code

    def _communicate(input=None, timeout=None):  # noqa: A002, ARG001
        _produce()
        return (b"", stderr)

    proc.wait.side_effect = _produce
    proc.communicate.side_effect = _communicate
    proc.returncode = exit_code  # 初期値は communicate 後に上書き
    return proc


class TestConvertOfficeToPdf:
    def test_success_returns_pdf_path(self, tmp_path: Path) -> None:
        input_path = tmp_path / "deck.pptx"
        input_path.write_bytes(b"dummy")
        proc = _fake_popen_success(tmp_path, "deck")
        with patch("office_converter.subprocess.Popen", return_value=proc) as popen, \
             patch("office_converter.os.killpg"):
            out = convert_office_to_pdf(input_path, work_dir=tmp_path, timeout_sec=60)
        assert out == tmp_path / "deck.pdf"
        assert out.exists()
        # CLI flags assertion
        cmd = popen.call_args[0][0]
        assert cmd[0] == "soffice"
        for flag in [
            "--headless",
            "--invisible",
            "--nodefault",
            "--nofirststartwizard",
            "--norestore",
            "--nolockcheck",
            "--convert-to",
            "pdf",
            "--outdir",
        ]:
            assert flag in cmd, f"missing flag {flag}"
        # UserInstallation プロファイル分離
        env_arg = next(c for c in cmd if c.startswith("-env:UserInstallation="))
        assert "lo_profile_" in env_arg
        # start_new_session=True (zombie 対策)
        assert popen.call_args.kwargs.get("start_new_session") is True

    def test_uses_unique_profile_dir_each_call(self, tmp_path: Path) -> None:
        """2 回呼び出すと UserInstallation のプロファイル dir が別 UUID になる。"""
        input_path = tmp_path / "deck.pptx"
        input_path.write_bytes(b"dummy")
        seen: list[str] = []

        def _popen(cmd, **_kwargs):
            env_arg = next(c for c in cmd if c.startswith("-env:UserInstallation="))
            seen.append(env_arg)
            # 各呼び出しで PDF を生成
            return _fake_popen_success(tmp_path, "deck")

        with patch("office_converter.subprocess.Popen", side_effect=_popen), \
             patch("office_converter.os.killpg"):
            convert_office_to_pdf(input_path, work_dir=tmp_path, timeout_sec=60)
            (tmp_path / "deck.pdf").unlink()
            convert_office_to_pdf(input_path, work_dir=tmp_path, timeout_sec=60)

        assert len(seen) == 2
        assert seen[0] != seen[1]

    def test_cleans_up_profile_dir_on_success(self, tmp_path: Path) -> None:
        input_path = tmp_path / "deck.pptx"
        input_path.write_bytes(b"dummy")
        captured: list[Path] = []

        def _popen(cmd, **_kwargs):
            env_arg = next(c for c in cmd if c.startswith("-env:UserInstallation="))
            # parse path
            prefix = "-env:UserInstallation=file://"
            captured.append(Path(env_arg[len(prefix):]))
            return _fake_popen_success(tmp_path, "deck")

        with patch("office_converter.subprocess.Popen", side_effect=_popen), \
             patch("office_converter.os.killpg"):
            convert_office_to_pdf(input_path, work_dir=tmp_path, timeout_sec=60)

        # cleanup: profile dir は削除されている (作成済みであっても消える)
        assert captured, "profile dir not captured"
        assert not captured[0].exists()

    def test_cleans_up_profile_dir_on_exception(self, tmp_path: Path) -> None:
        input_path = tmp_path / "deck.pptx"
        input_path.write_bytes(b"dummy")
        captured: list[Path] = []

        def _popen(cmd, **_kwargs):
            env_arg = next(c for c in cmd if c.startswith("-env:UserInstallation="))
            prefix = "-env:UserInstallation=file://"
            captured.append(Path(env_arg[len(prefix):]))
            return _fake_popen_success(tmp_path, "deck", exit_code=77, write_pdf=False)

        with patch("office_converter.subprocess.Popen", side_effect=_popen), \
             patch("office_converter.os.killpg"):
            with pytest.raises(ConversionExitCodeError):
                convert_office_to_pdf(input_path, work_dir=tmp_path, timeout_sec=60)
        assert not captured[0].exists()

    def test_timeout_raises_conversion_timeout_error_and_kills_process_group(self, tmp_path: Path) -> None:
        input_path = tmp_path / "slow.pptx"
        input_path.write_bytes(b"dummy")

        proc = MagicMock()
        proc.pid = 99999
        # Bug 003 fix: production calls ``communicate(timeout=...)`` instead of
        # ``wait(timeout=...)`` to avoid stderr-pipe deadlock. The first call
        # raises TimeoutExpired; the post-kill drain call returns normally.
        proc.communicate.side_effect = [
            subprocess.TimeoutExpired(cmd="soffice", timeout=1),
            (b"", b""),
        ]
        proc.returncode = -9

        with patch("office_converter.subprocess.Popen", return_value=proc), \
             patch("office_converter.os.killpg") as killpg, \
             patch("office_converter.os.getpgid", return_value=99999):
            with pytest.raises(ConversionTimeoutError):
                convert_office_to_pdf(input_path, work_dir=tmp_path, timeout_sec=1)

        killpg.assert_called_once()
        args = killpg.call_args[0]
        assert args[0] == 99999
        assert args[1] == signal.SIGKILL

    def test_uses_communicate_not_wait_to_avoid_pipe_deadlock(self, tmp_path: Path) -> None:
        """Bug 003 regression: production must use ``communicate(timeout=...)``.

        Calling ``proc.wait(timeout=...)`` while ``Popen(stdout=PIPE, stderr=PIPE)``
        is set deadlocks when soffice fills the 64 KiB stderr buffer with CJK
        font fallback warnings. ``communicate`` spawns reader threads and is
        the safe primitive. This test asserts (a) ``communicate`` is invoked
        with the configured timeout, and (b) ``wait`` is NOT invoked with a
        timeout (defense-in-depth: the deadlock-prone primitive must not be
        called).
        """
        input_path = tmp_path / "deck.pptx"
        input_path.write_bytes(b"dummy")
        proc = _fake_popen_success(tmp_path, "deck")
        with patch("office_converter.subprocess.Popen", return_value=proc), \
             patch("office_converter.os.killpg"):
            convert_office_to_pdf(input_path, work_dir=tmp_path, timeout_sec=42)

        # communicate was called with the configured timeout
        assert proc.communicate.called, "production must use proc.communicate"
        first_call = proc.communicate.call_args_list[0]
        assert first_call.kwargs.get("timeout") == 42 or (
            first_call.args and first_call.args[-1] == 42
        ), (
            "communicate must be called with the timeout from convert_office_to_pdf, "
            f"got call args: {first_call}"
        )
        # wait should NOT be called with a timeout (deadlock primitive)
        for call in proc.wait.call_args_list:
            assert "timeout" not in call.kwargs, (
                "proc.wait(timeout=...) must not be used (Bug 003 deadlock)"
            )

    def test_non_zero_exit_raises_conversion_exit_code_error(self, tmp_path: Path) -> None:
        input_path = tmp_path / "bad.pptx"
        input_path.write_bytes(b"dummy")
        proc = _fake_popen_success(tmp_path, "bad", exit_code=1, write_pdf=False)
        with patch("office_converter.subprocess.Popen", return_value=proc), \
             patch("office_converter.os.killpg"):
            with pytest.raises(ConversionExitCodeError) as ei:
                convert_office_to_pdf(input_path, work_dir=tmp_path, timeout_sec=60)
        assert "1" in str(ei.value)

    def test_silent_fail_when_pdf_missing(self, tmp_path: Path) -> None:
        input_path = tmp_path / "ghost.pptx"
        input_path.write_bytes(b"dummy")
        # exit 0 だが PDF を書かない
        proc = _fake_popen_success(tmp_path, "ghost", exit_code=0, write_pdf=False)
        with patch("office_converter.subprocess.Popen", return_value=proc), \
             patch("office_converter.os.killpg"):
            with pytest.raises(ConversionSilentFailError):
                convert_office_to_pdf(input_path, work_dir=tmp_path, timeout_sec=60)

    def test_silent_fail_when_pdf_zero_bytes(self, tmp_path: Path) -> None:
        input_path = tmp_path / "empty.pptx"
        input_path.write_bytes(b"dummy")

        def _communicate(input=None, timeout=None):  # noqa: A002, ARG001
            (tmp_path / "empty.pdf").write_bytes(b"")
            return (b"", b"")

        proc = MagicMock()
        proc.pid = 1
        proc.communicate.side_effect = _communicate
        proc.returncode = 0
        with patch("office_converter.subprocess.Popen", return_value=proc), \
             patch("office_converter.os.killpg"):
            with pytest.raises(ConversionSilentFailError):
                convert_office_to_pdf(input_path, work_dir=tmp_path, timeout_sec=60)


# ---------------------------------------------------------------------------
# Bug 002: leftover PDF cleanup on failure paths
# ---------------------------------------------------------------------------


class TestConvertOfficeToPdfCleansLeftoverOnFailure:
    """Bug 002: failed convert_office_to_pdf must not leave a partial / invalid
    PDF in ``work_dir``. The 3 failure types raised by ``convert_office_to_pdf``
    (timeout / exit_code / silent_fail) are covered here. The 4th category
    (oversize) is enforced one level up in ``_process`` and is asserted by
    ``TestConvertOfficeFiles.test_oversize_failure_*``.
    """

    def test_timeout_unlinks_leftover_partial_pdf(self, tmp_path: Path) -> None:
        """Timeout: kill before completion may leave a half-written PDF.

        We simulate a partial PDF on disk before the timeout fires; after
        the exception is raised, that file must be gone.
        """
        input_path = tmp_path / "slow.pptx"
        input_path.write_bytes(b"dummy")
        # Pre-seed a "partial PDF" that the killed soffice would have left:
        partial_pdf = tmp_path / "slow.pdf"
        partial_pdf.write_bytes(b"%PDF-partial\n")

        proc = MagicMock()
        proc.pid = 4242
        proc.communicate.side_effect = [
            subprocess.TimeoutExpired(cmd="soffice", timeout=1),
            (b"", b""),
        ]
        proc.returncode = -9
        with patch("office_converter.subprocess.Popen", return_value=proc), \
             patch("office_converter.os.killpg"), \
             patch("office_converter.os.getpgid", return_value=4242):
            with pytest.raises(ConversionTimeoutError):
                convert_office_to_pdf(input_path, work_dir=tmp_path, timeout_sec=1)

        assert not partial_pdf.exists(), (
            "Bug 002: timeout path must unlink the leftover partial PDF "
            f"({partial_pdf} still exists)"
        )

    def test_exit_code_unlinks_leftover_partial_pdf(self, tmp_path: Path) -> None:
        """Non-zero exit: soffice may have written a corrupt PDF before failing."""
        input_path = tmp_path / "bad.pptx"
        input_path.write_bytes(b"dummy")
        # write_pdf=True so a "corrupt PDF" is on disk when exit_code != 0
        proc = _fake_popen_success(tmp_path, "bad", exit_code=1, write_pdf=True)
        with patch("office_converter.subprocess.Popen", return_value=proc), \
             patch("office_converter.os.killpg"):
            with pytest.raises(ConversionExitCodeError):
                convert_office_to_pdf(input_path, work_dir=tmp_path, timeout_sec=60)

        assert not (tmp_path / "bad.pdf").exists(), (
            "Bug 002: exit_code path must unlink the leftover (possibly corrupt) PDF"
        )

    def test_silent_fail_unlinks_zero_byte_pdf(self, tmp_path: Path) -> None:
        """Silent fail (zero-byte PDF): exit 0 but PDF is empty → must unlink."""
        input_path = tmp_path / "empty.pptx"
        input_path.write_bytes(b"dummy")

        def _communicate(input=None, timeout=None):  # noqa: A002, ARG001
            # exit 0 but produces a 0-byte PDF
            (tmp_path / "empty.pdf").write_bytes(b"")
            return (b"", b"")

        proc = MagicMock()
        proc.pid = 1
        proc.communicate.side_effect = _communicate
        proc.returncode = 0
        with patch("office_converter.subprocess.Popen", return_value=proc), \
             patch("office_converter.os.killpg"):
            with pytest.raises(ConversionSilentFailError):
                convert_office_to_pdf(input_path, work_dir=tmp_path, timeout_sec=60)

        assert not (tmp_path / "empty.pdf").exists(), (
            "Bug 002: silent_fail path must unlink the zero-byte PDF"
        )

    def test_silent_fail_with_no_pdf_does_not_raise_during_cleanup(
        self, tmp_path: Path
    ) -> None:
        """Silent fail (PDF missing): unlink helper must swallow FileNotFoundError."""
        input_path = tmp_path / "ghost.pptx"
        input_path.write_bytes(b"dummy")
        # exit 0 だが PDF を書かない
        proc = _fake_popen_success(tmp_path, "ghost", exit_code=0, write_pdf=False)
        with patch("office_converter.subprocess.Popen", return_value=proc), \
             patch("office_converter.os.killpg"):
            with pytest.raises(ConversionSilentFailError):
                convert_office_to_pdf(input_path, work_dir=tmp_path, timeout_sec=60)
        # No PDF was ever there; cleanup must not have raised.


# ---------------------------------------------------------------------------
# Exception hierarchy
# ---------------------------------------------------------------------------


class TestExceptionHierarchy:
    @pytest.mark.parametrize(
        "exc_cls",
        [
            ConversionEncryptedError,
            ConversionTimeoutError,
            ConversionExitCodeError,
            ConversionSilentFailError,
            ConversionOversizeError,
        ],
    )
    def test_all_extend_conversion_error(self, exc_cls: type[Exception]) -> None:
        assert issubclass(exc_cls, ConversionError)

    def test_conversion_error_extends_exception(self) -> None:
        assert issubclass(ConversionError, Exception)


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


class TestDataclasses:
    def test_converted_file_is_frozen(self, tmp_path: Path) -> None:
        cf = ConvertedFile(original_path=tmp_path / "a.pptx", pdf_path=tmp_path / "a.pdf")
        with pytest.raises(FrozenInstanceError):
            cf.original_path = tmp_path / "x"  # type: ignore[misc]

    def test_convert_failure_is_frozen(self, tmp_path: Path) -> None:
        cf = ConvertFailure(original_path=tmp_path / "a.pptx", reason="encrypted", detail="…")
        with pytest.raises(FrozenInstanceError):
            cf.reason = "timeout"  # type: ignore[misc]

    def test_convert_result_is_frozen(self) -> None:
        cr = ConvertResult(succeeded=[], failed=[])
        with pytest.raises(FrozenInstanceError):
            cr.succeeded = []  # type: ignore[misc]


# ---------------------------------------------------------------------------
# convert_office_files (integration of above)
# ---------------------------------------------------------------------------


class _Recorder:
    """convert_office_to_pdf を mock するための呼び出し記録機。

    実 PDF を生成し、parallel 実行検証用に開始/終了タイムスタンプを記録する。
    delay_sec を入れることで「同時に走った」ことの検証ができる。
    """

    def __init__(self, *, delay_sec: float = 0.05, fail_for: dict[str, Exception] | None = None) -> None:
        self.delay = delay_sec
        self.fail_for = fail_for or {}
        self.intervals: list[tuple[str, float, float]] = []  # (stem, start, end)
        self._lock = threading.Lock()

    def __call__(self, input_path: Path, *, work_dir: Path, timeout_sec: int) -> Path:  # noqa: ARG002
        stem = input_path.stem
        start = time.monotonic()
        time.sleep(self.delay)
        end = time.monotonic()
        with self._lock:
            self.intervals.append((stem, start, end))
        if stem in self.fail_for:
            raise self.fail_for[stem]
        pdf = work_dir / f"{stem}.pdf"
        pdf.write_bytes(b"%PDF-mock\n" + b"x" * 200)
        return pdf

    def max_overlap(self) -> int:
        events: list[tuple[float, int]] = []
        for _, s, e in self.intervals:
            events.append((s, +1))
            events.append((e, -1))
        events.sort(key=lambda x: (x[0], -x[1]))
        cur = peak = 0
        for _, delta in events:
            cur += delta
            peak = max(peak, cur)
        return peak


class TestConvertOfficeFiles:
    def _make_files(self, dir_: Path, names: list[str]) -> list[Path]:
        out = []
        for n in names:
            p = dir_ / n
            p.write_bytes(b"dummy")
            out.append(p)
        return out

    def test_returns_empty_result_for_empty_dir(self, tmp_path: Path) -> None:
        result = convert_office_files(
            tmp_path, timeout_sec=30, max_concurrent=2, max_converted_bytes=10**9
        )
        assert result.succeeded == []
        assert result.failed == []

    def test_skips_non_office_files(self, tmp_path: Path) -> None:
        self._make_files(tmp_path, ["report.pdf", "image.png", "data.csv"])
        with patch("office_converter.convert_office_to_pdf") as conv:
            result = convert_office_files(
                tmp_path, timeout_sec=30, max_concurrent=2, max_converted_bytes=10**9
            )
        conv.assert_not_called()
        assert result.succeeded == []
        assert result.failed == []
        # 元 PDF は削除しない
        assert (tmp_path / "report.pdf").exists()

    def test_success_path_deletes_original_office_file(self, tmp_path: Path) -> None:
        self._make_files(tmp_path, ["deck.pptx"])
        recorder = _Recorder(delay_sec=0.0)
        with patch("office_converter.convert_office_to_pdf", side_effect=recorder), \
             patch("office_converter.is_password_protected", return_value=False):
            result = convert_office_files(
                tmp_path, timeout_sec=30, max_concurrent=2, max_converted_bytes=10**9
            )
        assert len(result.succeeded) == 1
        sf = result.succeeded[0]
        assert sf.original_path == tmp_path / "deck.pptx"
        assert sf.pdf_path == tmp_path / "deck.pdf"
        # 原本ローカル削除 (R9.2 系: ローカルだけ、S3 は不変)
        assert not (tmp_path / "deck.pptx").exists()
        assert (tmp_path / "deck.pdf").exists()

    def test_encrypted_file_recorded_as_failure_without_calling_converter(self, tmp_path: Path) -> None:
        self._make_files(tmp_path, ["secret.docx"])
        with patch("office_converter.convert_office_to_pdf") as conv, \
             patch("office_converter.is_password_protected", return_value=True):
            result = convert_office_files(
                tmp_path, timeout_sec=30, max_concurrent=1, max_converted_bytes=10**9
            )
        conv.assert_not_called()
        assert len(result.failed) == 1
        f = result.failed[0]
        assert f.reason == "encrypted"
        assert f.original_path == tmp_path / "secret.docx"
        # 失敗時も R7.2 維持のため原本は削除する (S3 は不変 / R9.1)
        assert not (tmp_path / "secret.docx").exists()

    @pytest.mark.parametrize(
        "exc, expected_reason",
        [
            (ConversionTimeoutError("boom"), "timeout"),
            (ConversionExitCodeError("boom"), "exit_code"),
            (ConversionSilentFailError("boom"), "silent_fail"),
        ],
    )
    def test_each_failure_type_recorded_with_correct_reason(
        self, tmp_path: Path, exc: Exception, expected_reason: str
    ) -> None:
        self._make_files(tmp_path, ["broken.pptx"])
        recorder = _Recorder(delay_sec=0.0, fail_for={"broken": exc})
        with patch("office_converter.convert_office_to_pdf", side_effect=recorder), \
             patch("office_converter.is_password_protected", return_value=False):
            result = convert_office_files(
                tmp_path, timeout_sec=30, max_concurrent=1, max_converted_bytes=10**9
            )
        assert result.succeeded == []
        assert len(result.failed) == 1
        assert result.failed[0].reason == expected_reason
        # 失敗時も R7.2 維持のため原本は削除する (S3 は不変 / R9.1)
        assert not (tmp_path / "broken.pptx").exists()
        # Bug 002: convert_office_to_pdf 内部で leftover PDF を unlink する責務がある。
        # _Recorder は PDF を生成しない (raise する) ので、実際には何も残っていない
        # ことを確認することで、convert_office_files レイヤが追加の PDF を残さない
        # ことの回帰検知になる。
        assert not (tmp_path / "broken.pdf").exists(), (
            "Bug 002: convert_office_files の失敗経路で PDF が残置されている"
        )

    def test_oversize_failure_recorded_and_original_deleted(self, tmp_path: Path) -> None:
        """変換は成功するが size 超過で失敗扱い。失敗時も R7.2 維持のため原本は削除。

        Bug 002: oversize 経路でも変換後 PDF (= big.pdf) を削除しないと、後段
        ``run_async_batch`` が SageMaker に巨大 PDF を送りつけてしまい
        ``CONVERSION_FAILED.oversize`` の意味が破綻する (phantom DDB FILE 行も発生)。
        """
        self._make_files(tmp_path, ["big.xlsx"])

        def _conv(input_path, *, work_dir, timeout_sec):  # noqa: ARG001
            pdf = work_dir / f"{input_path.stem}.pdf"
            pdf.write_bytes(b"x" * 5000)
            return pdf

        with patch("office_converter.convert_office_to_pdf", side_effect=_conv), \
             patch("office_converter.is_password_protected", return_value=False):
            result = convert_office_files(
                tmp_path, timeout_sec=30, max_concurrent=1, max_converted_bytes=1000
            )
        assert result.succeeded == []
        assert len(result.failed) == 1
        assert result.failed[0].reason == "oversize"
        # 失敗時も R7.2 維持のため原本は削除する (S3 は不変 / R9.1)
        assert not (tmp_path / "big.xlsx").exists()
        # Bug 002: oversize PDF も削除されていること (R7.2 維持)
        assert not (tmp_path / "big.pdf").exists(), (
            "Bug 002: oversize 経路で変換後 PDF が input_dir に残っている → "
            "run_async_batch が SageMaker に送ってしまう (R7.2 違反)"
        )

    def test_mixed_batch_partial_success(self, tmp_path: Path) -> None:
        self._make_files(tmp_path, ["ok.pptx", "fail.pptx", "report.pdf"])
        recorder = _Recorder(
            delay_sec=0.0,
            fail_for={"fail": ConversionTimeoutError("nope")},
        )
        with patch("office_converter.convert_office_to_pdf", side_effect=recorder), \
             patch("office_converter.is_password_protected", return_value=False):
            result = convert_office_files(
                tmp_path, timeout_sec=30, max_concurrent=2, max_converted_bytes=10**9
            )
        assert {s.original_path.name for s in result.succeeded} == {"ok.pptx"}
        assert {f.original_path.name for f in result.failed} == {"fail.pptx"}
        # PDF 原本は無関係
        assert (tmp_path / "report.pdf").exists()
        # 成功した office 原本は消えている
        assert not (tmp_path / "ok.pptx").exists()
        # 失敗側も R7.2 維持のため原本は削除する (S3 は不変 / R9.1)
        assert not (tmp_path / "fail.pptx").exists()

    def test_parallel_execution_respects_max_concurrent(self, tmp_path: Path) -> None:
        """3 ファイル / max_concurrent=2 で同時実行は最大 2 (3 ではない) を満たす。"""
        self._make_files(tmp_path, ["a.pptx", "b.pptx", "c.pptx"])
        recorder = _Recorder(delay_sec=0.15)
        with patch("office_converter.convert_office_to_pdf", side_effect=recorder), \
             patch("office_converter.is_password_protected", return_value=False):
            result = convert_office_files(
                tmp_path, timeout_sec=30, max_concurrent=2, max_converted_bytes=10**9
            )
        assert len(result.succeeded) == 3
        peak = recorder.max_overlap()
        assert peak <= 2, f"max simultaneous = {peak} (expected <= 2)"
        assert peak >= 2, f"max simultaneous = {peak} (expected >= 2 to prove parallel)"

    def test_invariant_succeeded_plus_failed_equals_office_count(self, tmp_path: Path) -> None:
        self._make_files(
            tmp_path,
            ["ok1.pptx", "ok2.docx", "enc.xlsx", "tout.pptx", "report.pdf", "img.png"],
        )
        recorder = _Recorder(
            delay_sec=0.0,
            fail_for={"tout": ConversionTimeoutError("…")},
        )

        def _is_enc(p: Path) -> bool:
            return p.stem == "enc"

        with patch("office_converter.convert_office_to_pdf", side_effect=recorder), \
             patch("office_converter.is_password_protected", side_effect=_is_enc):
            result = convert_office_files(
                tmp_path, timeout_sec=30, max_concurrent=3, max_converted_bytes=10**9
            )
        # office files = 4
        assert len(result.succeeded) + len(result.failed) == 4
