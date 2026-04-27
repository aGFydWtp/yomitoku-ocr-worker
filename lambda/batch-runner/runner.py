"""BatchRunner 実行層 (Task 5.1)。

責務:
1. ``run_async_batch(settings, input_dir, output_dir, log_path, deadline_seconds)``
   で ``AsyncInvoker`` を ``BatchRunnerSettings`` から組み立て、
   ``invoker.run_batch`` を呼び出して ``BatchResult`` を返す。
2. ``generate_all_visualizations(input_dir, output_dir)`` で
   ``output/*.json`` と ``input/*.pdf`` を対応付け、layout/ocr 双方の
   可視化画像を生成する。ページ単位の失敗はエラーリストに集約し、
   バッチは継続する (要件 6.4)。

Realtime (``yomitoku_client.analyze_batch_async``) 経由の実装は
Task 5.1 で Async Inference に置き換えたため撤去済。
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path

import cv2  # type: ignore[import-not-found]
from yomitoku_client import parse_pydantic_model  # type: ignore[import-not-found]
from yomitoku_client.models import correct_rotation_image  # type: ignore[import-not-found]
from yomitoku_client.utils import load_pdf  # type: ignore[import-not-found]

from async_invoker import AsyncInvoker, BatchResult
from settings import BatchRunnerSettings

logger = logging.getLogger(__name__)


# -----------------------------------------------------------------------------
# Async 経路バッチ実行
# -----------------------------------------------------------------------------


async def run_async_batch(
    *,
    settings: BatchRunnerSettings,
    input_dir: str | Path,
    output_dir: str | Path,
    log_path: str | Path,
    deadline_seconds: float | None = None,
) -> BatchResult:
    """Async Inference 経路でバッチを実行し、``BatchResult`` を返す。

    - 入力 prefix は ``{settings.async_input_prefix}/{batch_job_id}/`` で固定
      (末尾スラッシュ必須: ``AsyncInvoker.__init__`` が検証)
    - ``deadline_seconds`` を省略した場合は
      ``settings.batch_max_duration_sec`` を採用する
    - 呼び出し側 (Fargate main) は ``BatchResult.succeeded_files`` /
      ``failed_files`` / ``in_flight_timeout`` を DDB 反映に利用する
    """
    input_path = Path(input_dir)
    input_files = [p for p in sorted(input_path.iterdir()) if p.is_file()]
    file_count = len(input_files)

    logger.info(
        "run_async_batch start",
        extra={
            "batch_job_id": settings.batch_job_id,
            "file_count": file_count,
        },
    )

    invoker = AsyncInvoker(
        endpoint_name=settings.endpoint_name,
        input_bucket=settings.bucket_name,
        input_prefix=f"{settings.async_input_prefix}/{settings.batch_job_id}/",
        output_bucket=settings.bucket_name,
        success_queue_url=settings.success_queue_url,
        failure_queue_url=settings.failure_queue_url,
        max_concurrent=settings.async_max_concurrent,
    )

    deadline = float(
        deadline_seconds
        if deadline_seconds is not None
        else settings.batch_max_duration_sec
    )

    start = time.monotonic()
    result = await invoker.run_batch(
        batch_job_id=settings.batch_job_id,
        input_files=input_files,
        output_dir=Path(output_dir),
        log_path=Path(log_path),
        deadline_seconds=deadline,
    )
    elapsed = time.monotonic() - start

    logger.info(
        "run_async_batch complete",
        extra={
            "batch_job_id": settings.batch_job_id,
            "file_count": file_count,
            "succeeded": len(result.succeeded_files),
            "failed": len(result.failed_files),
            "timeout": len(result.in_flight_timeout),
            "elapsed_sec": round(elapsed, 3),
        },
    )
    return result


# -----------------------------------------------------------------------------
# 可視化生成
# -----------------------------------------------------------------------------

_VISUALIZE_MODES: tuple[str, ...] = ("layout", "ocr")
_DEFAULT_DPI = 200


def _generate_for_single_file(
    *, json_path: Path, pdf_path: Path, out_dir: Path
) -> list[str]:
    """1 ファイルの可視化を生成する。ページ単位で失敗を収集。

    Returns:
        エラーメッセージのリスト (空なら全ページ成功)。
    """
    errors: list[str] = []
    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
        parsed = parse_pydantic_model(data)
    except Exception as exc:  # noqa: BLE001 — ファイル全体のパース失敗
        return [f"parse failed: {exc}"]

    try:
        images = load_pdf(str(pdf_path), dpi=_DEFAULT_DPI)
    except Exception as exc:  # noqa: BLE001
        return [f"load_pdf failed: {exc}"]

    basename = pdf_path.stem
    for idx, img in enumerate(images):
        try:
            page_result = parsed.pages[idx]
            angle = page_result.preprocess.get("angle", 0) if hasattr(
                page_result, "preprocess"
            ) else 0
            corrected = correct_rotation_image(img, angle=angle)
            for mode in _VISUALIZE_MODES:
                vis_img = page_result.visualize(corrected, mode=mode)
                target = out_dir / f"{basename}_{mode}_page_{idx}.jpg"
                if not cv2.imwrite(str(target), vis_img):
                    raise RuntimeError(f"cv2.imwrite failed for {target}")
        except Exception as exc:  # noqa: BLE001 — ページ単位は致命ではない
            errors.append(f"page {idx}: {exc}")
    return errors


def generate_all_visualizations(
    *,
    input_dir: str,
    output_dir: str,
    original_to_local: dict[str, str] | None = None,
) -> dict[str, list[str]]:
    """``output_dir/*.json`` に対して ``input_dir/{local_pdf_basename}.pdf`` の可視化を生成する。

    新命名規約 (``{原本ファイル名}.json``) に対応するため、JSON ファイル名から
    ``.json`` を 1 段だけ剥がして ``original_input_name`` を得る。Office 形式の
    場合、``original_to_local`` map (例: ``{"deck.pptx": "deck.pdf"}``) で
    ローカル PDF basename に逆引き解決する。ネイティブ PDF は identity 解決
    (``report.pdf.json`` → ``report.pdf``)。

    Args:
        input_dir: ローカル PDF が並置されているディレクトリ。
        output_dir: メイン JSON および可視化 JPEG を出力するディレクトリ。
        original_to_local: Office 形式の ``{原本ファイル名: ローカル PDF basename}``
            マッピング。``None`` または空 dict は identity 解決と等価
            (ネイティブ PDF のみのバッチで使用)。

    Returns:
        ``{original_input_name: [error_messages...]}`` — エラーがあったファイル
        のみ記録。空 dict なら全件完全成功。lookup 失敗は致命ではなく silent
        skip + warning ログとして扱う。
    """
    errors_per_file: dict[str, list[str]] = {}
    out_path = Path(output_dir)
    in_path = Path(input_dir)
    if not out_path.exists():
        return errors_per_file

    lookup = original_to_local or {}
    for json_file in sorted(out_path.glob("*.json")):
        # ``.json`` を 1 段だけ剥がす (新命名規約: ``{原本ファイル名}.json``)。
        original_input_name = json_file.name[: -len(".json")]
        local_pdf_basename = lookup.get(original_input_name, original_input_name)
        pdf_path = in_path / local_pdf_basename
        if not pdf_path.exists():
            errors_per_file[original_input_name] = [
                f"local PDF not found: {local_pdf_basename}"
            ]
            continue
        errs = _generate_for_single_file(
            json_path=json_file, pdf_path=pdf_path, out_dir=out_path
        )
        if errs:
            errors_per_file[original_input_name] = errs

    if errors_per_file:
        logger.warning(
            "generate_all_visualizations: %d file(s) had errors",
            len(errors_per_file),
            extra={"files_with_errors": sorted(errors_per_file.keys())},
        )
    return errors_per_file


__all__ = [
    "AsyncInvoker",
    "BatchResult",
    "generate_all_visualizations",
    "run_async_batch",
]
