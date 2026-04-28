"""inflight_publisher.py のユニットテスト。

Task 5.1: `InflightPublisher` (Task 2.1 で実装済) の挙動を `capsys` ベースで
検証する。実 CloudWatch / boto3 / awslogs ドライバを介さず、stdout に書かれる
EMF (Embedded Metric Format) JSON を直接 parse して assert する。

検証対象:
    - EMF レコード構造 (Namespace / Dimensions / Metrics / EndpointName / 値)
      が design.md "Event Contract (EMF JSON)" と一致すること (R2.2, R2.5)
    - daemon thread が `provider()` を周期的に呼び出して値を publish し、
      同一周期内に 2 datapoint 以上送らないこと (R2.1, R2.6)
    - `stop()` 後に最終 datapoint = 0 で thread が `is_alive() == False` に
      なること (R2.3)
    - `provider()` が `RuntimeError` を投げてもループが落ちず、次周期で
      復旧して publish が継続すること (R2.7, observability-only)

EMF レコード構造 (design.md Event Contract):
    {
      "_aws": {
        "Timestamp": <int ms epoch>,
        "CloudWatchMetrics": [
          {
            "Namespace": "Yomitoku/AsyncEndpoint",
            "Dimensions": [["EndpointName"]],
            "Metrics": [{"Name": "InflightInvocations", "Unit": "Count"}]
          }
        ]
      },
      "EndpointName": "<endpoint>",
      "InflightInvocations": <int>
    }
"""

from __future__ import annotations

import json
import time

import pytest

from inflight_publisher import (
    DIMENSION_NAME,
    METRIC_NAME,
    NAMESPACE,
    InflightPublisher,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_emf_lines(captured_out: str) -> list[dict]:
    """`capsys` で取得した stdout 文字列を JSON Lines として parse する。

    `InflightPublisher` は EMF JSON を 1 行 1 datapoint で書き出すので、
    改行で split → 空行除去 → `json.loads` するだけで datapoint 列が取れる。
    """
    return [json.loads(line) for line in captured_out.strip().split("\n") if line]


# ---------------------------------------------------------------------------
# Case 1: EMF レコード構造 / 値
# ---------------------------------------------------------------------------


class TestEmfRecordStructureAndValues:
    """R2.2 / R2.5: 起動直後に publish される EMF JSON の構造と値を検証する。"""

    def test_emf_record_structure_and_values(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """`publish_zero()` が design.md と一致する EMF レコードを 1 行で書き出す。

        - Namespace == "Yomitoku/AsyncEndpoint"
        - Dimensions == [["EndpointName"]]
        - Metrics == [{"Name": "InflightInvocations", "Unit": "Count"}]
        - EndpointName == 構築時に渡した値
        - InflightInvocations == 0
        - Timestamp は ms epoch の整数 (>= 0)
        - 出力は改行終端の単一 JSON 行
        """
        publisher = InflightPublisher(
            endpoint_name="test-endpoint",
            provider=lambda: 0,
        )

        publisher.publish_zero()

        out = capsys.readouterr().out
        # 1 行の JSON Lines になっていること (改行終端)
        assert out.endswith("\n")
        records = _parse_emf_lines(out)
        assert len(records) == 1, f"expected 1 EMF line, got {len(records)}: {out!r}"

        record = records[0]
        aws = record["_aws"]
        cw_metrics = aws["CloudWatchMetrics"][0]

        # Namespace / Dimensions / Metrics は design.md "Event Contract" と一致
        assert cw_metrics["Namespace"] == NAMESPACE == "Yomitoku/AsyncEndpoint"
        assert cw_metrics["Dimensions"] == [[DIMENSION_NAME]] == [["EndpointName"]]
        assert cw_metrics["Metrics"] == [
            {"Name": METRIC_NAME, "Unit": "Count"}
        ] == [{"Name": "InflightInvocations", "Unit": "Count"}]

        # Dimension 値と Metric 値はトップレベルに直書き
        assert record["EndpointName"] == "test-endpoint"
        assert record["InflightInvocations"] == 0

        # Timestamp は ms epoch の int で、未来でも過去過ぎてもいけない
        timestamp = aws["Timestamp"]
        assert isinstance(timestamp, int)
        assert timestamp >= 0
        # 念のため「現実的な範囲」チェック: 直近 1 分以内に書かれているはず
        now_ms = int(time.time() * 1000)
        assert abs(now_ms - timestamp) < 60_000


# ---------------------------------------------------------------------------
# Case 2: 周期発信 (provider 値の反映)
# ---------------------------------------------------------------------------


class TestPeriodicPublishUsesProvider:
    """R2.1 / R2.6: daemon thread が `provider()` を周期的に呼び出し publish する。"""

    def test_periodic_publish_uses_provider(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """`provider` が `1, 3, 0` を返す状況で 3 周期分の datapoint が publish される。

        実時間で短い `interval_sec` (0.05s) を使い、3 周期分 + α 待機する。
        - startup の publish_zero (= 0)
        - 周期 1: provider -> 1
        - 周期 2: provider -> 3
        - 周期 3: provider -> 0
        - shutdown の publish_zero (= 0)
        という 5 datapoint が観測されることを assert する。
        """
        # provider の呼び出し回数を厳密にカウントし、`stop()` 後に検証する。
        # 値列は `1, 3, 0`。設計上 3 周期分の datapoint を確認したいので、
        # 4 回目以降は `_loop` を「自分自身で stop_event を立てる」形で抜けさせ、
        # タイミング揺れに依存しないテストにする。
        call_count = [0]
        stop_after_three_called = False

        def provider() -> int:
            nonlocal stop_after_three_called
            call_count[0] += 1
            sequence = [1, 3, 0]
            if call_count[0] <= 3:
                value = sequence[call_count[0] - 1]
            else:
                value = 0  # 想定外の追加呼び出し時のフォールバック
            # 3 回目を返した直後に stop_event を立て、4 周期目に進ませない
            # (= R2.6 の周期境界の正確性をタイミングに依存せず検証する)
            if call_count[0] == 3 and not stop_after_three_called:
                stop_after_three_called = True
                publisher._stop_event.set()
            return value

        publisher = InflightPublisher(
            endpoint_name="periodic-endpoint",
            provider=provider,
            interval_sec=0.05,
        )

        publisher.start()
        # 3 周期 (0.15s) + 余裕。`provider` が 3 回呼ばれた時点で
        # `_stop_event` がセットされているため、ループは次の `wait` で即抜ける。
        time.sleep(0.3)
        publisher.stop()

        records = _parse_emf_lines(capsys.readouterr().out)
        values = [r["InflightInvocations"] for r in records]

        # provider は厳密に 3 回呼ばれていること (4 周期目には進まない)
        assert call_count[0] == 3, (
            f"provider should be called exactly 3 times, got {call_count[0]}"
        )

        # 全 datapoint が同一 endpoint 名で発信されていること
        assert all(r["EndpointName"] == "periodic-endpoint" for r in records)

        # startup 0 が先頭、shutdown 0 が末尾
        assert values[0] == 0, f"first datapoint should be startup zero, got {values}"
        assert values[-1] == 0, f"last datapoint should be shutdown zero, got {values}"

        # ループ本体由来の datapoint (startup / shutdown を除く中間) に
        # 1, 3, 0 が順序通り含まれていること (= provider が周期で呼ばれている証拠)
        loop_values = values[1:-1]
        assert loop_values == [1, 3, 0], (
            f"expected loop-publish sequence [1, 3, 0], got {loop_values} "
            f"(full values={values})"
        )

        # R2.6: 同一周期内で 2 datapoint 以上発信していないこと
        # (= startup zero, 1, 3, 0, shutdown zero の 5 件以外があってはならない)
        assert len(records) == 5, (
            f"expected exactly 5 datapoints (startup + 3 periodic + shutdown), "
            f"got {len(records)}: {values}"
        )


# ---------------------------------------------------------------------------
# Case 3: 停止時の zero publish と thread join
# ---------------------------------------------------------------------------


class TestStopPublishesZeroAndJoinsThread:
    """R2.3: `stop()` 後の最終 datapoint は 0 で thread は終了している。"""

    def test_stop_publishes_zero_and_joins_thread(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """`interval_sec` を長めに取りループ発火を抑え、startup/shutdown のみ観測する。

        - `interval_sec=10` でループは実質発火しない (start 直後に stop するため)
        - provider は呼ばれた場合 7 を返すが、ループは到達しないので使われない
        - 出力には startup の 0 と shutdown の 0 の合計 2 datapoint だけ現れる
        - publisher 内部 thread が `is_alive() == False` になる
        """
        provider_calls = []

        def provider() -> int:
            provider_calls.append(1)
            return 7

        publisher = InflightPublisher(
            endpoint_name="stop-endpoint",
            provider=provider,
            interval_sec=10,
        )

        publisher.start()
        publisher.stop()

        # スレッドは join 済みで dead になっていること
        # (`stop` は内部 thread を join するため、戻った時点で is_alive() == False)
        assert publisher._thread is not None
        assert publisher._thread.is_alive() is False

        records = _parse_emf_lines(capsys.readouterr().out)
        values = [r["InflightInvocations"] for r in records]

        # startup の 0 + shutdown の 0 のみ。ループ由来の 7 は出ない
        assert values == [0, 0], (
            f"expected [startup_zero, shutdown_zero] = [0, 0], got {values}"
        )
        # ループに入らなかったことの裏付け: provider が呼ばれていない
        assert provider_calls == [], (
            f"provider should not be called when interval > test duration, "
            f"got {len(provider_calls)} calls"
        )

        # 全レコードが正しい endpoint dimension を持つ
        assert all(r["EndpointName"] == "stop-endpoint" for r in records)


# ---------------------------------------------------------------------------
# Case 4: provider 例外がループを殺さない
# ---------------------------------------------------------------------------


class TestProviderExceptionDoesNotKillLoop:
    """R2.7: `provider()` が例外を投げてもループは継続し、後続周期で publish 復旧する。"""

    def test_provider_exception_does_not_kill_loop(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """provider が「最初の 2 回は RuntimeError、3 回目以降は 42」を返すケース。

        - 1 周期目 / 2 周期目: provider が RuntimeError → publish スキップ
          (= ループは死なない、observability-only)
        - 3 周期目以降: provider が 42 を返し publish 成功
        - startup の 0 / shutdown の 0 datapoint も観測される
        - 例外周期では datapoint が出ない (= 値 42 が現れる前は 0 のみ)
        """
        call_count = [0]

        def flaky_provider() -> int:
            call_count[0] += 1
            if call_count[0] <= 2:
                raise RuntimeError(
                    f"simulated provider failure (call #{call_count[0]})"
                )
            return 42

        publisher = InflightPublisher(
            endpoint_name="flaky-endpoint",
            provider=flaky_provider,
            interval_sec=0.05,
        )

        publisher.start()
        # 5 周期分以上待ち、例外 2 回 + 復旧 publish が確実に観測されるようにする
        time.sleep(0.35)
        publisher.stop()

        records = _parse_emf_lines(capsys.readouterr().out)
        values = [r["InflightInvocations"] for r in records]

        # provider は少なくとも 3 回以上呼ばれている (例外 2 回 + 復旧 1 回以上)
        assert call_count[0] >= 3, (
            f"provider should be called at least 3 times "
            f"(2 failures + 1 recovery), got {call_count[0]}"
        )

        # startup zero が先頭、shutdown zero が末尾
        assert values[0] == 0, f"first datapoint should be startup zero, got {values}"
        assert values[-1] == 0, f"last datapoint should be shutdown zero, got {values}"

        # 復旧後の値 42 が中間 datapoint として少なくとも 1 件現れること
        # (= ループが死なずに次周期で provider を呼べた証拠)
        loop_values = values[1:-1]
        assert 42 in loop_values, (
            f"expected recovered value 42 in loop datapoints after exceptions, "
            f"got {loop_values} (full values={values})"
        )

        # 例外発生時には publish されない (= 中間 datapoint に 0 や None は出ない)
        # provider が値を返せなかった周期では `_publish_value` が呼ばれないため。
        # 中間 datapoint はすべて 42 (復旧後の値) であること。
        assert all(v == 42 for v in loop_values), (
            f"loop datapoints should only contain post-recovery value 42 "
            f"(exception periods skip publish), got {loop_values}"
        )

        # 全レコードが正しい endpoint dimension を持つ
        assert all(r["EndpointName"] == "flaky-endpoint" for r in records)
