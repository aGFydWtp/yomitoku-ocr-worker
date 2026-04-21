"""analyze_batch_async 実行層 (Task 3.3)。

責務:
1. `create_client(settings)` で `CircuitConfig`/`RequestConfig` 付きの
   `YomitokuClient` を構築する。
2. `run_analyze_batch(client, input_dir, output_dir, settings)` で
   `client.analyze_batch_async` を呼び出す。
3. `generate_all_visualizations(input_dir, output_dir)` で
   `output/*.json` と `input/*.pdf` を対応付け、layout/ocr 双方の
   可視化画像を生成する。ページ単位の失敗はエラーリストに集約し、
   バッチは継続する (要件 6.4)。

すべての外部依存 (yomitoku_client, cv2, numpy) は import 時に解決され、
実行時はテスト側からの monkeypatch が可能な形で公開される。
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

import cv2  # type: ignore[import-not-found]
from yomitoku_client import parse_pydantic_model  # type: ignore[import-not-found]
from yomitoku_client.client import (  # type: ignore[import-not-found]
    CircuitConfig,
    RequestConfig,
    YomitokuClient,
)
from yomitoku_client.models import correct_rotation_image  # type: ignore[import-not-found]
from yomitoku_client.utils import load_pdf  # type: ignore[import-not-found]

logger = logging.getLogger(__name__)


# -----------------------------------------------------------------------------
# クライアント構築
# -----------------------------------------------------------------------------


def create_client(settings: Any) -> Any:
    """`BatchRunnerSettings` から `YomitokuClient` を構築する。

    `read_timeout` / `circuit_cooldown` は float を保持するが、
    yomitoku-client は int を受け取るため int にキャストする。
    """
    request_config = RequestConfig(
        read_timeout=int(settings.read_timeout),
        connect_timeout=10,
        max_retries=settings.max_retries,
    )
    circuit_config = CircuitConfig(
        threshold=settings.circuit_threshold,
        cooldown_time=int(settings.circuit_cooldown),
    )
    return YomitokuClient(
        endpoint=settings.endpoint_name,
        max_workers=settings.max_file_concurrency,
        request_config=request_config,
        circuit_config=circuit_config,
    )


# -----------------------------------------------------------------------------
# analyze_batch_async 実行
# -----------------------------------------------------------------------------


async def run_analyze_batch(
    *,
    client: Any,
    input_dir: str,
    output_dir: str,
    settings: Any,
    log_path: str | None = None,
) -> None:
    """`analyze_batch_async` を実行し、構造化 INFO ログを出力する。

    - 開始ログ: `batch_job_id`, `file_count`
    - 終了ログ: `batch_job_id`, `file_count`, `elapsed_sec`
    """
    input_files = [p for p in Path(input_dir).iterdir() if p.is_file()]
    file_count = len(input_files)

    logger.info(
        "analyze_batch_async start",
        extra={
            "batch_job_id": settings.batch_job_id,
            "file_count": file_count,
        },
    )

    start = time.monotonic()
    await client.analyze_batch_async(
        input_dir=input_dir,
        output_dir=output_dir,
        max_file_concurrency=settings.max_file_concurrency,
        max_page_concurrency=settings.max_page_concurrency,
        extra_formats=settings.extra_formats,
        log_path=log_path,
    )
    elapsed = time.monotonic() - start

    # yomitoku-client のサーキットブレーカー発火回数を記録する
    # (v0.2.0 時点では公開アクセサが無いため private 属性を参照)。
    circuit_break_count = int(getattr(client, "_circuit_failures", 0) or 0)

    logger.info(
        "analyze_batch_async complete",
        extra={
            "batch_job_id": settings.batch_job_id,
            "file_count": file_count,
            "elapsed_sec": round(elapsed, 3),
            "circuit_break_count": circuit_break_count,
        },
    )


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
    *, input_dir: str, output_dir: str
) -> dict[str, list[str]]:
    """`output_dir/*.json` に対して `input_dir/{basename}.pdf` の可視化を生成する。

    Returns:
        `{basename: [error_messages...]}` — エラーがあったファイルのみ記録。
        空 dict なら全件完全成功。
    """
    errors_per_file: dict[str, list[str]] = {}
    out_path = Path(output_dir)
    in_path = Path(input_dir)
    if not out_path.exists():
        return errors_per_file

    for json_file in sorted(out_path.glob("*.json")):
        basename = json_file.stem
        pdf_path = in_path / f"{basename}.pdf"
        if not pdf_path.exists():
            errors_per_file[basename] = [f"input PDF not found: {pdf_path.name}"]
            continue
        errs = _generate_for_single_file(
            json_path=json_file, pdf_path=pdf_path, out_dir=out_path
        )
        if errs:
            errors_per_file[basename] = errs

    if errors_per_file:
        logger.warning(
            "generate_all_visualizations: %d file(s) had errors",
            len(errors_per_file),
            extra={"files_with_errors": sorted(errors_per_file.keys())},
        )
    return errors_per_file
