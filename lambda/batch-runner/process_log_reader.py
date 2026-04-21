"""process_log.jsonl 読み込み (Task 3.4)。

`yomitoku-client` が `output_dir/process_log.jsonl` に 1 行 1 レコードで
出力する JSON Lines を安全に読み込み `ProcessLogEntry` に写像する。

想定スキーマ (ライブラリ仕様):
    {
      "timestamp":   ISO8601 文字列,
      "file_path":   入力 PDF のローカルパス (/tmp/input/foo.pdf),
      "output_path": 出力 JSON のローカルパス (成功時のみ),
      "dpi":         int,
      "executed":    bool,
      "success":     bool,
      "error":       str | null
    }

破損行は best-effort でスキップしバッチ全体を止めない。
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

logger = logging.getLogger(__name__)


@dataclass
class ProcessLogEntry:
    """process_log.jsonl 1 行分のエントリ (Python dataclass)。"""

    file_path: str
    filename: str
    success: bool
    executed: bool | None = None
    dpi: int | None = None
    output_path: str | None = None
    error: str | None = None
    processing_time_ms: int | None = None
    timestamp: str | None = None


def read_process_log(log_path: str) -> Iterator[ProcessLogEntry]:
    """`process_log.jsonl` を 1 行ずつ読み込み `ProcessLogEntry` を yield する。

    - ファイルが存在しない場合は空シーケンスを返す (正常系: ログ未生成)。
    - 空行や JSON パース失敗行はスキップし、WARNING を残す。
    """
    path = Path(log_path)
    if not path.exists():
        logger.info("process_log.jsonl not found: %s", path)
        return

    with path.open("r", encoding="utf-8") as fp:
        for lineno, raw in enumerate(fp, start=1):
            line = raw.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError as exc:
                logger.warning(
                    "process_log.jsonl line %d skipped (invalid json): %s",
                    lineno, exc,
                )
                continue

            file_path = data.get("file_path") or ""
            yield ProcessLogEntry(
                file_path=file_path,
                filename=Path(file_path).name if file_path else "",
                success=bool(data.get("success", False)),
                executed=data.get("executed"),
                dpi=data.get("dpi"),
                output_path=data.get("output_path"),
                error=data.get("error"),
                processing_time_ms=data.get("processing_time_ms"),
                timestamp=data.get("timestamp"),
            )
