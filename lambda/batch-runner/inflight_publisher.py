"""InflightPublisher (Task 2.1)。

batch-runner が抱える in-flight 数 (=`AsyncInvoker` が `invoke_endpoint_async`
発行後 / 終端通知前で保持している InferenceId 件数) を CloudWatch カスタム
メトリクスとして publish するための observability-only モジュール。

仕様要点:

- CloudWatch Embedded Metric Format (EMF) の JSON を 1 行 stdout に書き出すだけで、
  awslogs ドライバ → CloudWatch Logs → EMF パーサ → カスタムメトリクス
  経路で取り込まれる (`boto3` も `aws_embedded_metrics` も使わない)。
- `Yomitoku/AsyncEndpoint::InflightInvocations` を `EndpointName` dimension
  のみで publish する (タスク識別 dimension は付けない、Sum 集約前提)。
- 起動時 / 60 秒周期 / 停止時にそれぞれ 1 datapoint ずつ publish する。
  `CloudWatch period (60 秒) 内に同一プロセスから 2 回以上発信しない` という
  不変条件はループ周期で担保する。
- publish 失敗 (stdout 書き込み例外) と provider 例外はすべて try/except で
  吸収し `logger.exception` でログのみ残す。OCR バッチ本体は中断しない
  (R2.7 observability-only)。
- 周期スレッドは `threading.Thread(daemon=True)` で生成し、メインプロセス
  終了で道連れに止まる。停止は `threading.Event.set()` でループから抜ける。

このモジュールは PUBLISH_INTERVAL_SEC / NAMESPACE / METRIC_NAME / DIMENSION_NAME
を module-level 定数として固定する (= configurable にしない)。値を変更する
場合は CDK 側 (`lib/sagemaker-stack.ts` の `AsyncBacklogScalingPolicy` metric
math) と完全一致させる必要があるため、設計上意図的に 2 箇所同時更新を強制する。
"""

from __future__ import annotations

import json
import logging
import sys
import threading
import time
from collections.abc import Callable

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

# CloudWatch period (60 秒) と完全一致させる必要がある (R2.6)。
# 引き上げる場合は ScalingPolicy 側 metric stat の period も同時に変更すること。
PUBLISH_INTERVAL_SEC: int = 60

# CDK 側 metric math `m2.metricStat.metric.namespace` と完全一致させる
# 必要がある (Revalidation Trigger)。
NAMESPACE: str = "Yomitoku/AsyncEndpoint"
METRIC_NAME: str = "InflightInvocations"
DIMENSION_NAME: str = "EndpointName"


# --------------------------------------------------------------------------- #
# InflightPublisher
# --------------------------------------------------------------------------- #


class InflightPublisher:
    """in-flight 数を CloudWatch EMF 経由で publish する daemon publisher.

    起動 / 周期 / 停止のいずれの publish 失敗も OCR バッチ本体を中断しない。
    """

    def __init__(
        self,
        *,
        endpoint_name: str,
        provider: Callable[[], int],
        interval_sec: int = PUBLISH_INTERVAL_SEC,
    ) -> None:
        """publisher を構築する。

        Args:
            endpoint_name: EMF dimension `EndpointName` に埋め込むエンドポイント名。
                空文字を渡すとカスタムメトリクスが対象 endpoint を識別不能になるため
                呼び出し側で必ず非空文字を保証すること (R2.5)。
            provider: in-flight 件数を返す callable。`AsyncInvoker.inflight_count`
                を渡す前提。例外を投げた場合は publisher 側で吸収する (R2.7)。
            interval_sec: publish 周期 (秒)。デフォルトは CloudWatch period と
                一致する 60 秒。テスト用に短縮するためだけに引数化している
                (本番経路では既定値を使うこと、R2.6)。
        """
        self._endpoint_name = endpoint_name
        self._provider = provider
        self._interval_sec = interval_sec
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------------ #
    # lifecycle
    # ------------------------------------------------------------------ #

    def start(self) -> None:
        """publish_zero を 1 回呼び、daemon thread を起動する。

        冪等ではない (1 度だけ呼ぶ前提)。`runner.run_async_batch` が
        `AsyncInvoker` 構築直後に 1 回だけ呼ぶ。
        """
        # R2.2: 起動直後 (= まだ invoke_endpoint_async を 1 件も発行していない)
        # 段階で in-flight=0 を 1 datapoint publish する。
        self.publish_zero()

        thread = threading.Thread(
            target=self._loop,
            name="InflightPublisher",
            daemon=True,
        )
        self._thread = thread
        thread.start()

    def stop(self, *, timeout_sec: float = 5.0) -> None:
        """daemon thread を止め、publish_zero を 1 回呼んで終了する。

        `runner.run_async_batch` の `try/finally` の `finally` 句から
        呼ばれる。スレッドが既に死んでいる / 起動されていない場合でも
        例外を投げない (observability-only)。
        """
        self._stop_event.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=timeout_sec)

        # R2.3: 終了時に in-flight=0 を 1 datapoint publish する。
        # スレッドが最後に publish した値が period を超えて固着しないよう、
        # 最後に必ず 0 を上書きする (R1.3 とも連動)。
        self.publish_zero()

    # ------------------------------------------------------------------ #
    # publish
    # ------------------------------------------------------------------ #

    def publish_zero(self) -> None:
        """値 0 を 1 datapoint publish する。起動時 / 停止時に呼ぶ。"""
        self._publish_value(0)

    def _publish_value(self, value: int) -> None:
        """EMF JSON を 1 行 stdout に書き出す。失敗してもログのみで吸収。"""
        record = self._build_emf_record(value)
        try:
            line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
            sys.stdout.write(line + "\n")
            sys.stdout.flush()
        except (OSError, ValueError):  # noqa: BLE001 — ObservabilityOnly
            # FD 枯渇 / encoding 異常等。OCR 本体には伝搬させない (R2.7)。
            logger.exception(
                "InflightPublisher: failed to publish EMF record (non-fatal)"
            )

    def _build_emf_record(self, value: int) -> dict[str, object]:
        """EMF 形式の dict を構築する。

        EMF 仕様: Timestamp はミリ秒単位の Unix epoch、Dimensions は
        ネストされた配列 (各内側配列は 1 つの dimension set を表す)。
        本 publisher は dimension set を `EndpointName` のみ 1 種類しか
        使わないので `[["EndpointName"]]` を渡す (R2.5)。
        """
        return {
            "_aws": {
                "Timestamp": int(time.time() * 1000),
                "CloudWatchMetrics": [
                    {
                        "Namespace": NAMESPACE,
                        "Dimensions": [[DIMENSION_NAME]],
                        "Metrics": [{"Name": METRIC_NAME, "Unit": "Count"}],
                    }
                ],
            },
            DIMENSION_NAME: self._endpoint_name,
            METRIC_NAME: int(value),
        }

    # ------------------------------------------------------------------ #
    # daemon thread loop
    # ------------------------------------------------------------------ #

    def _loop(self) -> None:
        """周期スレッド本体。`_stop_event` がセットされるまで publish を続ける。

        ループ構造:
            1. `Event.wait(interval_sec)` で次のティックを待つ。stop されると
               即座に True が返るのでループを抜ける。
            2. `provider()` を呼んで in-flight 数を取得 (例外は吸収して skip)。
            3. publish (例外は吸収)。
            4. ループ先頭へ。

        待機を先頭に置くことで「`start()` 内の起動時 publish_zero」と
        「ループ初回 publish」が同一 period 内に二重で走るのを防ぐ (R2.6)。
        """
        while True:
            # 先に待つ → stop されていれば即座に抜ける。
            stopped = self._stop_event.wait(timeout=self._interval_sec)
            if stopped:
                return

            try:
                value = self._provider()
            except Exception:  # noqa: BLE001 — ObservabilityOnly
                # provider (= AsyncInvoker.inflight_count) が壊れていても
                # publisher スレッドは死なせず、次のティックで再試行する。
                logger.exception(
                    "InflightPublisher: provider() raised (skipping this tick)"
                )
                continue

            self._publish_value(value)
