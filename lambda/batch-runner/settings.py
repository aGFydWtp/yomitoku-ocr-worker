"""BatchRunner 設定層 — 環境変数を dataclass で型安全に集約する。

ECS Fargate タスクの環境変数をすべてここで読み込み、後続モジュールは
このモジュールから設定値を参照することで直接 os.environ に依存しない。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import ClassVar


@dataclass(frozen=True)
class BatchRunnerSettings:
    """Fargate バッチランナーの全設定を保持する不変 dataclass。"""

    # -----------------------------------------------------------------------
    # 必須フィールド（未設定の場合は ValueError）
    # -----------------------------------------------------------------------
    batch_job_id: str
    """処理対象バッチの ID。"""

    bucket_name: str
    """入出力 S3 バケット名。"""

    batch_table_name: str
    """BatchTable の DynamoDB テーブル名。"""

    control_table_name: str
    """ControlTable（エンドポイント制御ロック）の DynamoDB テーブル名。"""

    endpoint_name: str
    """SageMaker エンドポイント名。"""

    # -----------------------------------------------------------------------
    # 省略可能フィールド（デフォルト値あり）
    # -----------------------------------------------------------------------
    max_file_concurrency: int = 2
    """ファイル並列処理数。yomitoku-client に渡す max_file_concurrency。"""

    max_page_concurrency: int = 2
    """ページ並列処理数。yomitoku-client に渡す max_page_concurrency。"""

    max_retries: int = 3
    """ファイルあたりリトライ回数。yomitoku-client RequestConfig に渡す。"""

    read_timeout: float = 60.0
    """SageMaker 呼び出しリードタイムアウト（秒）。"""

    circuit_threshold: int = 5
    """サーキットブレーカー開放閾値（連続エラー回数）。"""

    circuit_cooldown: float = 30.0
    """サーキットブレーカーのクールダウン時間（秒）。"""

    batch_max_duration_sec: int = 7200
    """バッチ全体の最大実行時間（秒）。Step Functions TimeoutSeconds と一致させる。"""

    extra_formats: list[str] = field(default_factory=list)
    """追加出力フォーマット（例: ["markdown", "csv"]）。空リストで追加なし。"""

    # -----------------------------------------------------------------------
    # クラス定数
    # -----------------------------------------------------------------------
    _REQUIRED: ClassVar[tuple[str, ...]] = (
        "BATCH_JOB_ID",
        "BUCKET_NAME",
        "BATCH_TABLE_NAME",
        "CONTROL_TABLE_NAME",
        "ENDPOINT_NAME",
    )

    # -----------------------------------------------------------------------
    # ファクトリメソッド
    # -----------------------------------------------------------------------
    @classmethod
    def from_env(cls) -> "BatchRunnerSettings":
        """環境変数から設定を読み込んで返す。必須変数が欠けると ValueError を送出。"""
        # 必須フィールドの存在確認
        missing = [k for k in cls._REQUIRED if not os.environ.get(k)]
        if missing:
            raise ValueError(
                f"Required environment variable(s) not set: {', '.join(missing)}"
            )

        def _int(key: str, default: int) -> int:
            val = os.environ.get(key)
            return int(val) if val else default

        def _float(key: str, default: float) -> float:
            val = os.environ.get(key)
            return float(val) if val else default

        def _list(key: str) -> list[str]:
            val = os.environ.get(key, "").strip()
            return [s.strip() for s in val.split(",") if s.strip()] if val else []

        return cls(
            batch_job_id=os.environ["BATCH_JOB_ID"],
            bucket_name=os.environ["BUCKET_NAME"],
            batch_table_name=os.environ["BATCH_TABLE_NAME"],
            control_table_name=os.environ["CONTROL_TABLE_NAME"],
            endpoint_name=os.environ["ENDPOINT_NAME"],
            max_file_concurrency=_int("MAX_FILE_CONCURRENCY", 2),
            max_page_concurrency=_int("MAX_PAGE_CONCURRENCY", 2),
            max_retries=_int("MAX_RETRIES", 3),
            read_timeout=_float("READ_TIMEOUT", 60.0),
            circuit_threshold=_int("CIRCUIT_THRESHOLD", 5),
            circuit_cooldown=_float("CIRCUIT_COOLDOWN", 30.0),
            batch_max_duration_sec=_int("BATCH_MAX_DURATION_SEC", 7200),
            extra_formats=_list("EXTRA_FORMATS"),
        )
