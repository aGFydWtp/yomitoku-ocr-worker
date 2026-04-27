"""Office (PPTX/DOCX/XLSX) → PDF 変換モジュール (Task 3.1).

責務:
    - LibreOffice (`soffice`) subprocess の起動・出力検証・cleanup を 1 モジュールに閉じる
    - 暗号化検知 (msoffcrypto) / silent fail / timeout / 非ゼロ exit / oversize の
      5 失敗カテゴリをそれぞれ専用例外として呼び出し側に通知する
    - 並列変換 (ThreadPoolExecutor) を提供し、成功・失敗いずれの場合も Office 原本を
      ローカル削除する (R7.2 維持: 後段 run_async_batch が SageMaker に Office 形式で
      invoke するのを防ぐ。S3 への delete は呼ばない: 監査要件 R9.2)

外部依存:
    - 標準ライブラリ: subprocess / pathlib / uuid / shutil / signal / os / tempfile /
      concurrent.futures
    - msoffcrypto-tool (>=5,<6): OOXML 暗号化判定
    - soffice バイナリ: Docker image にバンドル (P0)

設計参照: .kiro/specs/office-format-ingestion/design.md > Components and Interfaces >
office_converter.py
"""

from __future__ import annotations

import logging
import os
import shutil
import signal
import subprocess
import tempfile
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import msoffcrypto

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 公開定数 / 例外型
# ---------------------------------------------------------------------------

OFFICE_EXTENSIONS: frozenset[str] = frozenset({".pptx", ".docx", ".xlsx"})


class ConversionError(Exception):
    """Office → PDF 変換失敗を示す共通基底例外。"""


class ConversionEncryptedError(ConversionError):
    """暗号化 / パスワード保護されたファイルで変換不能。"""


class ConversionTimeoutError(ConversionError):
    """soffice subprocess が timeout を超過し強制終了された。"""


class ConversionExitCodeError(ConversionError):
    """soffice subprocess が非ゼロ exit code で終了した。"""


class ConversionSilentFailError(ConversionError):
    """soffice が exit 0 を返したが PDF が生成されない or 0 バイトだった (silent fail)。"""


class ConversionOversizeError(ConversionError):
    """変換後 PDF が許容サイズを超えた。"""


# ---------------------------------------------------------------------------
# 公開 dataclass
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ConvertedFile:
    """変換成功 1 件の結果。"""

    original_path: Path
    pdf_path: Path


@dataclass(frozen=True)
class ConvertFailure:
    """変換失敗 1 件の結果。process_log.jsonl 書き込み素材。"""

    original_path: Path
    reason: str  # "encrypted" | "timeout" | "exit_code" | "silent_fail" | "oversize"
    detail: str


@dataclass(frozen=True)
class ConvertResult:
    """convert_office_files の集約結果。"""

    succeeded: list[ConvertedFile] = field(default_factory=list)
    failed: list[ConvertFailure] = field(default_factory=list)


# ---------------------------------------------------------------------------
# 単機能 public API
# ---------------------------------------------------------------------------


def is_office_format(filename: str) -> bool:
    """ファイル名拡張子が Office 形式 (.pptx/.docx/.xlsx) か判定する。

    比較は case-insensitive。
    """
    return Path(filename).suffix.lower() in OFFICE_EXTENSIONS


def is_password_protected(path: Path) -> bool:
    """ファイルが暗号化 / パスワード保護されているか判定する。

    `msoffcrypto.OfficeFile(...).is_encrypted()` を使用する。
    検知不可エラー (file open 不能 / 非 OOXML フォーマット等) は False を返し、
    後続の実変換段階で別カテゴリの例外として表面化させる。
    """
    try:
        with path.open("rb") as f:
            office_file = msoffcrypto.OfficeFile(f)
            return bool(office_file.is_encrypted())
    except Exception:  # noqa: BLE001 - 検知不可は False (設計仕様)
        logger.debug("password-protection check could not run for %s", path, exc_info=True)
        return False


def validate_converted_size(pdf_path: Path, max_bytes: int) -> None:
    """変換後 PDF の size が max_bytes を超えていれば ConversionOversizeError を raise。

    境界 (size == max_bytes) は許容する。
    """
    actual = pdf_path.stat().st_size
    if actual > max_bytes:
        raise ConversionOversizeError(
            f"converted PDF size {actual} exceeds max_bytes {max_bytes}: {pdf_path}"
        )


def _unlink_converted_pdf(work_dir: Path, stem: str) -> None:
    """Remove a partial / invalid PDF that conversion left behind (best effort).

    Bug 002 fix: when a conversion fails (silent_fail / timeout / exit_code /
    oversize), soffice may have produced a partial or corrupted PDF, or even a
    full-but-oversize PDF, in ``work_dir``. Leaving it behind causes the
    downstream ``run_async_batch`` step to send the bogus PDF to SageMaker
    (R7.2 violation) and creates phantom DDB FILE rows. We remove it here so
    the failure path is consistent with "no PDF produced".

    Errors are intentionally swallowed: ``FileNotFoundError`` is the common
    case (no PDF was created) and other ``OSError`` cases are logged but not
    re-raised, because the caller is already raising a ``Conversion*Error``
    and the cleanup is a defense-in-depth, not a correctness primitive.
    """
    pdf = work_dir / f"{stem}.pdf"
    try:
        pdf.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        logger.warning("failed to remove leftover PDF: %s", pdf, exc_info=True)


def convert_office_to_pdf(input_path: Path, work_dir: Path, timeout_sec: int) -> Path:
    """単一 Office ファイルを PDF に変換し、生成された PDF パスを返す。

    引数:
        input_path: 変換対象の Office ファイル
        work_dir: PDF を出力する作業ディレクトリ (通常は input_path と同階層)
        timeout_sec: subprocess 全体の timeout (秒)

    成功時:
        `work_dir / f"{input_path.stem}.pdf"` を返す。

    失敗時:
        - subprocess.TimeoutExpired → ConversionTimeoutError
        - 非ゼロ exit code → ConversionExitCodeError
        - exit 0 だが PDF が無い / 0 バイト → ConversionSilentFailError

    副作用:
        - `/tmp/lo_profile_{uuid}/` を生成し、try/finally で確実に削除する
        - timeout 時は process group 全体に SIGKILL を送り、zombie soffice を防ぐ
        - Bug 002: 失敗時 (timeout / exit_code / silent_fail) は中間 PDF を
          ``work_dir`` から削除する。後段 ``run_async_batch`` が SageMaker に
          壊れた PDF を送るのを防ぐ (R7.2 維持)。
    """
    profile_dir = Path(tempfile.gettempdir()) / f"lo_profile_{uuid.uuid4().hex}"
    cmd = [
        "soffice",
        "--headless",
        "--invisible",
        "--nodefault",
        "--nofirststartwizard",
        "--norestore",
        "--nolockcheck",
        f"-env:UserInstallation=file://{profile_dir}",
        "--convert-to",
        "pdf",
        "--outdir",
        str(work_dir),
        str(input_path),
    ]
    logger.info("converting office file: %s -> %s", input_path, work_dir)

    try:
        # start_new_session=True により subprocess は独立した process group を持ち、
        # timeout 時に os.killpg で grandchild も含めて確実に kill できる。
        proc = subprocess.Popen(  # noqa: S603 - cmd は固定リスト
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        # Bug 003: ``proc.wait(timeout=...)`` deadlocks when soffice fills the
        # 64 KiB stderr pipe buffer (likely with CJK PPTX font fallback
        # warnings). Result: a 1-3 s job hits the configured 300 s timeout and
        # is mis-classified as ``CONVERSION_FAILED.timeout``. ``communicate()``
        # spawns reader threads that drain stdout/stderr in parallel and
        # therefore does not deadlock. We then reuse the captured stderr in
        # the non-zero-exit branch (no second ``communicate`` call needed).
        try:
            stdout, stderr = proc.communicate(timeout=timeout_sec)
        except subprocess.TimeoutExpired as e:
            # zombie 防止: process group 全体を SIGKILL
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                # 既に終了している or 権限が無いケースは握りつぶす
                logger.warning("failed to killpg pid=%s", proc.pid, exc_info=True)
            # SIGKILL 後の zombie を回収するため pipe を排水する
            try:
                proc.communicate(timeout=5)
            except Exception:  # noqa: BLE001 — best-effort drain after kill
                pass
            # Bug 002: 中間 PDF が残っていれば削除 (R7.2 維持)
            _unlink_converted_pdf(work_dir, input_path.stem)
            raise ConversionTimeoutError(
                f"soffice timeout after {timeout_sec}s: {input_path}"
            ) from e

        if proc.returncode != 0:
            # Bug 002: 中間 PDF が残っていれば削除 (R7.2 維持)
            _unlink_converted_pdf(work_dir, input_path.stem)
            raise ConversionExitCodeError(
                f"soffice exited with code {proc.returncode}: {input_path} "
                f"stderr={stderr.decode('utf-8', errors='replace')[:500]}"
            )

        pdf_path = work_dir / f"{input_path.stem}.pdf"
        if not pdf_path.exists() or pdf_path.stat().st_size == 0:
            # Bug 002: 0 バイト PDF が残っていれば削除 (silent_fail 経路)
            _unlink_converted_pdf(work_dir, input_path.stem)
            raise ConversionSilentFailError(
                f"soffice exited 0 but PDF not generated or empty: {pdf_path}"
            )
        return pdf_path
    finally:
        # profile dir cleanup: 例外時も含めて必ず実行
        shutil.rmtree(profile_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# 高レベル並列 API
# ---------------------------------------------------------------------------


def convert_office_files(
    input_dir: Path,
    *,
    timeout_sec: int,
    max_concurrent: int,
    max_converted_bytes: int,
) -> ConvertResult:
    """input_dir 直下の全 Office ファイルを並列変換する。

    手順 (per-file):
        1. is_office_format で対象判定 (false なら無視 / 削除しない)
        2. is_password_protected で暗号化判定 (true → encrypted failure)
        3. convert_office_to_pdf で変換 (timeout/exit_code/silent_fail を捕捉)
        4. validate_converted_size で size 検証 (oversize failure)
        5. 成功・失敗いずれも Office 原本をローカル削除 (R7.2 維持。S3 は触らない: R9.2)

    並列性:
        ThreadPoolExecutor(max_workers=max_concurrent) で同時最大 max_concurrent。

    引数:
        input_dir: download_inputs の出力ディレクトリ。再帰探索しない (直下のみ)。
        timeout_sec: 1 ファイル変換の上限秒数。
        max_concurrent: 同時実行数。
        max_converted_bytes: 変換後 PDF の許容上限サイズ (bytes)。

    返り値:
        ConvertResult(succeeded=[...], failed=[...]).
        invariant: len(succeeded) + len(failed) == 入力中の Office ファイル数。
    """
    targets = sorted(p for p in input_dir.iterdir() if p.is_file() and is_office_format(p.name))
    if not targets:
        return ConvertResult(succeeded=[], failed=[])

    succeeded: list[ConvertedFile] = []
    failed: list[ConvertFailure] = []

    def _process(p: Path) -> ConvertedFile | ConvertFailure:
        if is_password_protected(p):
            logger.info("skipped (encrypted): %s", p.name)
            return ConvertFailure(
                original_path=p,
                reason="encrypted",
                detail=f"file is password-protected or encrypted: {p.name}",
            )
        try:
            pdf = convert_office_to_pdf(p, work_dir=input_dir, timeout_sec=timeout_sec)
        except ConversionEncryptedError as e:
            logger.info("conversion failed (encrypted): %s: %s", p.name, e)
            return ConvertFailure(original_path=p, reason="encrypted", detail=str(e))
        except ConversionTimeoutError as e:
            logger.info("conversion failed (timeout): %s: %s", p.name, e)
            return ConvertFailure(original_path=p, reason="timeout", detail=str(e))
        except ConversionExitCodeError as e:
            logger.info("conversion failed (exit_code): %s: %s", p.name, e)
            return ConvertFailure(original_path=p, reason="exit_code", detail=str(e))
        except ConversionSilentFailError as e:
            logger.info("conversion failed (silent_fail): %s: %s", p.name, e)
            return ConvertFailure(original_path=p, reason="silent_fail", detail=str(e))
        except ConversionError as e:
            # 想定外の ConversionError サブクラスは exit_code カテゴリとして扱う
            logger.exception("conversion failed (uncategorized): %s", p.name)
            return ConvertFailure(original_path=p, reason="exit_code", detail=str(e))

        try:
            validate_converted_size(pdf, max_bytes=max_converted_bytes)
        except ConversionOversizeError as e:
            logger.info("conversion failed (oversize): %s: %s", p.name, e)
            # Bug 002: oversize 時は変換結果 PDF が残ったままだと後段 run_async_batch
            # が SageMaker に送ってしまう (R7.2 違反 + phantom DDB FILE 行)。
            # 失敗扱いに合わせて中間 PDF をローカル削除する (S3 は触らない: R9.2)。
            _unlink_converted_pdf(input_dir, p.stem)
            return ConvertFailure(original_path=p, reason="oversize", detail=str(e))

        return ConvertedFile(original_path=p, pdf_path=pdf)

    def _unlink_local_original(path: Path, *, context: str) -> None:
        """Office 原本を input_dir からローカル削除する (S3 は不変 / R9.1 維持)。

        成功・失敗いずれの場合も呼び出す: 残置すると後段 run_async_batch が
        SageMaker に Office 形式で invoke してしまい、R7.2 / R2.3
        (application/pdf のみ staging) を破る。
        """
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            logger.warning(
                "failed to delete local original after %s: %s",
                context,
                path,
                exc_info=True,
            )

    workers = max(1, max_concurrent)
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures: list[tuple[Path, Future[ConvertedFile | ConvertFailure]]] = [
            (p, executor.submit(_process, p)) for p in targets
        ]
        for original, fut in futures:
            try:
                outcome = fut.result()
            except Exception as e:  # noqa: BLE001 - 想定外例外は exit_code として扱う
                logger.exception("unexpected error converting %s", original)
                # 想定外失敗でも Office 原本はローカル削除 (R7.2 維持 / S3 不変)
                _unlink_local_original(original, context="unexpected failure")
                failed.append(
                    ConvertFailure(
                        original_path=original,
                        reason="exit_code",
                        detail=f"unexpected error: {e!r}",
                    )
                )
                continue

            if isinstance(outcome, ConvertedFile):
                # 成功: Office 原本をローカル削除 (S3 は触らない)
                _unlink_local_original(outcome.original_path, context="success")
                succeeded.append(outcome)
            else:
                # 失敗: Office 原本もローカル削除 (S3 は触らない / R9.1)
                # 残置すると後段 run_async_batch が SageMaker に Office 形式で
                # invoke してしまい R7.2 / R2.3 (application/pdf のみ staging) を破る。
                _unlink_local_original(outcome.original_path, context="failure")
                failed.append(outcome)

    return ConvertResult(succeeded=succeeded, failed=failed)
