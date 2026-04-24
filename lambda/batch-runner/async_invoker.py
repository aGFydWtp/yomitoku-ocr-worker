"""SageMaker Asynchronous Inference 呼び出しクライアント。

Task 3.1 〜 3.3 / 5.1 を通じて以下を担う:
    - 入力ファイルを ``batches/_async/inputs/{batch_job_id}/{file}`` へ
      S3 ``PutObject`` でステージングする
    - ``InferenceId`` を ``{batch_job_id}:{file_stem}`` 形式で生成する
    - ``sagemaker-runtime.invoke_endpoint_async`` を発行する
    - 4xx (``ValidationException`` 等) の ``ClientError`` は即時失敗として
      ``BatchResult.failed_files`` に積み、リトライしない
    - ``AsyncCompletionQueue`` / ``AsyncFailureQueue`` を 20 秒 long-poll で
      交互受信し、自バッチ宛ては ``DeleteMessage``、他バッチ宛ては
      ``ChangeMessageVisibility=0`` で他ランナーに返却する
    - in-flight `InferenceId` 集合を ``max_concurrent`` 上限で維持し、上限到達
      時は新規 invoke を停止して SQS pull に専念する (背圧制御)
    - ``BATCH_TASK_TIMEOUT_SECONDS=7200`` (既定、引数で上書き可) の deadline
      まで待機し、未完了 InferenceId は ``BatchResult.in_flight_timeout`` に
      集計する
    - 成功時は ``OutputLocation`` から JSON を取得して
      ``output_dir/{stem}.json`` に保存し、全結果 (成功/失敗/タイムアウト) を
      ``process_log.jsonl`` に 1 行 1 レコードで追記する
"""

from __future__ import annotations

import hashlib
import json
import logging
import mimetypes
import posixpath
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import boto3
from botocore.exceptions import ClientError


logger = logging.getLogger(__name__)


_DEFAULT_CONTENT_TYPE = "application/octet-stream"
_CONTENT_TYPE_OVERRIDES: dict[str, str] = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
}

# SageMaker InvokeEndpointAsync API は InferenceId を 64 文字までに制限する
# (docs: pattern ``\A\S[\p{Print}]*\z`` / maxLength 64)。
# 制約超過時は実行時 ValidationException となるため、呼び出し前に検知する。
_INFERENCE_ID_MAX_LENGTH = 64


# SageMaker ``invoke_endpoint_async`` は ``InferenceId`` と ``InputLocation`` を
# HTTP ヘッダ (``x-amzn-sagemaker-inference-id`` / ``x-amzn-sagemaker-inputlocation``)
# に載せて送出する。非 ASCII バイトが混ざると:
#   1. SigV4 canonical string が client/server で乖離 → InvalidSignatureException
#   2. 仮に signing を擦り抜けても ``InferenceId`` の 64 文字上限を UTF-8 → percent-encode
#      で容易に超過する (日本語 1 文字 = 9 ASCII 文字)
# そのため ASCII でない場合は SHA-1 先頭 16 文字の安定ハッシュで置き換える。
# ASCII の場合は元の文字列をそのまま使うことで、既存テスト / 運用上の可読性を維持する。
_SAFE_IDENT_HASH_LENGTH = 16


def _safe_ident(value: str) -> str:
    """ASCII のみの場合はそのまま、非 ASCII を含む場合は SHA-1 先頭 16 文字を返す。"""
    if value.isascii():
        return value
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:_SAFE_IDENT_HASH_LENGTH]

# SQS Receive は 1 回あたり最大 10 件。moto / 本番共通の API 上限。
_RECEIVE_MAX_MESSAGES = 10

# Fargate タスク全体のウォッチドッグ。design.md の設定と一致させる
# (個別推論の ``InvocationTimeoutSeconds`` は別管理で 3600 秒)。
_DEFAULT_DEADLINE_SECONDS = 7200.0


@dataclass(frozen=True)
class BatchResult:
    """`run_batch` の戻り値。

    - ``succeeded_files``: 成功確定したファイル stem (``InferenceId`` の ``:`` 以降)
    - ``failed_files``: ``(file_stem, error_message)`` のリスト。同期 4xx と
      Async FailureQueue 経由の双方が混在する
    - ``in_flight_timeout``: deadline までに通知が来なかったファイル stem。
      Fargate タスクはこれらを `FAILED` として扱い、SFN 側で `MarkFailedForced`
      に分岐する (design.md Req 3.3)
    """

    succeeded_files: list[str] = field(default_factory=list)
    failed_files: list[tuple[str, str]] = field(default_factory=list)
    in_flight_timeout: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class PolledNotification:
    """SQS から受信した SageMaker Async 通知の正規化表現。

    ``body`` は SNS エンベロープを剥がした後の SageMaker 通知本体を
    JSON デコード済みの dict で保持する。呼び出し側は
    ``body["invocationStatus"]`` / ``responseParameters.outputLocation`` /
    ``failureReason`` 等を直接参照する。
    """

    inference_id: str
    body: dict[str, Any]


def _guess_content_type(file_path: Path) -> str:
    """拡張子から ContentType を推定する。

    ``mimetypes`` の結果を優先するが、PDF / TIFF は環境差を避けるため
    明示マッピングで上書きする。未知拡張子は ``application/octet-stream``。
    """
    override = _CONTENT_TYPE_OVERRIDES.get(file_path.suffix.lower())
    if override:
        return override
    mime, _ = mimetypes.guess_type(file_path.name)
    return mime or _DEFAULT_CONTENT_TYPE


class AsyncInvoker:
    """SageMaker Async Endpoint の呼び出しをカプセル化する。

    Task 3.1 では同期的な `_stage_input` / `_build_inference_id` /
    `_invoke_async` のみ実装し、`run_batch` (async) は後続で追加する。
    """

    def __init__(
        self,
        *,
        endpoint_name: str,
        input_bucket: str,
        input_prefix: str,
        output_bucket: str,
        success_queue_url: str,
        failure_queue_url: str,
        max_concurrent: int,
        poll_wait_seconds: int = 20,
        sagemaker_client: Any | None = None,
        sqs_client: Any | None = None,
        s3_client: Any | None = None,
    ) -> None:
        if not input_prefix.endswith("/"):
            raise ValueError(
                f"input_prefix must end with '/': {input_prefix!r}"
            )
        if max_concurrent < 1:
            raise ValueError(
                f"max_concurrent must be >= 1: got {max_concurrent}"
            )
        self.endpoint_name = endpoint_name
        self.input_bucket = input_bucket
        self.input_prefix = input_prefix
        self.output_bucket = output_bucket
        self.success_queue_url = success_queue_url
        self.failure_queue_url = failure_queue_url
        self.max_concurrent = max_concurrent
        self.poll_wait_seconds = poll_wait_seconds
        self._sagemaker = sagemaker_client or boto3.client("sagemaker-runtime")
        self._sqs = sqs_client or boto3.client("sqs")
        self._s3 = s3_client or boto3.client("s3")

    # ------------------------------------------------------------------
    # Task 3.1: S3 ステージング + invoke_endpoint_async
    # ------------------------------------------------------------------
    @staticmethod
    def _build_inference_id(batch_job_id: str, file_stem: str) -> str:
        """``{batch_job_id}:{safe_stem}`` 形式の InferenceId を返す。

        SageMaker API の ``InferenceId`` は 64 文字上限。上限超過時は実行時
        ``ValidationException`` となるため、生成段階で検知して送出する。

        ``file_stem`` が非 ASCII を含む場合はそのままでは HTTP ヘッダ送信
        (SigV4 canonical string の解釈乖離) で失敗する。かつ UTF-8 を
        percent-encode しても 64 文字上限を超過しやすい。``_safe_ident`` で
        ASCII のみの場合は無変換、非 ASCII を含む場合は SHA-1 16 文字に
        畳み込む。
        """
        safe_stem = _safe_ident(file_stem)
        inference_id = f"{batch_job_id}:{safe_stem}"
        if len(inference_id) > _INFERENCE_ID_MAX_LENGTH:
            raise ValueError(
                "InferenceId exceeds SageMaker max length "
                f"({_INFERENCE_ID_MAX_LENGTH}): {inference_id!r} "
                f"(len={len(inference_id)})"
            )
        return inference_id

    def _stage_input(self, file_path: Path) -> str:
        """入力ファイルを ``input_prefix`` 配下へ PUT し、``s3://`` URI を返す。

        ``file_path.name`` 由来の S3 key が ``input_prefix`` 配下に収まることを
        呼び出し前に検証し、他バッチ prefix への書き込み事故を防ぐ。

        staging key のファイル名部分は ``_safe_ident`` で ASCII 化する
        (ASCII ならそのまま、非 ASCII なら SHA-1 ハッシュに置換)。
        ``InputLocation`` は後段 ``invoke_endpoint_async`` で HTTP ヘッダに
        乗るため、非 ASCII バイトが混ざると SigV4 ``InvalidSignatureException``
        を引き起こす。拡張子は ``file_path.suffix`` を保持して Content-Type
        推定や model container 側のディスパッチに使わせる。
        """
        # ``file_path`` は本番では ``pathlib.Path`` だがテストの ``_FakePath``
        # 等も受け入れるため、``stem`` / ``suffix`` は ``name`` から計算する。
        name_view = Path(file_path.name)
        safe_stem = _safe_ident(name_view.stem)
        safe_name = f"{safe_stem}{name_view.suffix}"
        key = f"{self.input_prefix}{safe_name}"
        if not key.startswith(self.input_prefix) or "/" in file_path.name:
            # Path.name はディレクトリ区切りを取り除くが、空文字や
            # Windows 由来の妙な文字列が混じると prefix を逸脱し得るため、
            # 念のため防御的に検証する。
            raise ValueError(
                f"Staged key escapes input_prefix: key={key!r}, "
                f"prefix={self.input_prefix!r}"
            )
        self._s3.put_object(
            Bucket=self.input_bucket,
            Key=key,
            Body=file_path.read_bytes(),
            ContentType=_guess_content_type(file_path),
        )
        return f"s3://{self.input_bucket}/{key}"

    def _invoke_async(
        self,
        *,
        inference_id: str,
        input_location: str,
        content_type: str,
    ) -> dict[str, Any]:
        """``invoke_endpoint_async`` を 1 回だけ発行する。

        4xx (``ValidationException`` 等) の ``ClientError`` はそのまま伝搬し、
        呼び出し元 (将来的には ``run_batch``) が ``process_log`` の ``error``
        に記録した上で当該ファイルを failed として確定させる想定。
        """
        return self._sagemaker.invoke_endpoint_async(
            EndpointName=self.endpoint_name,
            InputLocation=input_location,
            InferenceId=inference_id,
            ContentType=content_type,
        )

    # ------------------------------------------------------------------
    # Task 3.2: SQS long-poll + InferenceId フィルタ
    # ------------------------------------------------------------------
    def _poll_queue(
        self,
        *,
        queue_url: str,
        in_flight: set[str],
    ) -> list[PolledNotification]:
        """``queue_url`` から最大 10 件 receive し、in-flight と照合して返す。

        - 自バッチ宛て (inference_id ∈ in_flight): 正規化して返し、SQS から削除
        - 他バッチ宛て: ``ChangeMessageVisibility=0`` で即時返却し他ランナーに渡す
        - JSON 破損 / ``inferenceId`` 欠落: 無視 (ログのみ)。at-least-once 配送
          耐性を確保するため本 receive では削除せず、SQS の redrive 設定に委ねる
        """
        response = self._sqs.receive_message(
            QueueUrl=queue_url,
            MaxNumberOfMessages=_RECEIVE_MAX_MESSAGES,
            WaitTimeSeconds=self.poll_wait_seconds,
        )
        messages = response.get("Messages", [])
        results: list[PolledNotification] = []
        for msg in messages:
            receipt = msg["ReceiptHandle"]
            notification = self._unwrap_notification(msg.get("Body", ""))
            if notification is None:
                logger.warning(
                    "async_invoker: dropping unparseable SQS message", extra={
                        "queue_url": queue_url,
                        "message_id": msg.get("MessageId"),
                    }
                )
                continue
            inference_id = notification.get("inferenceId")
            if not isinstance(inference_id, str):
                logger.warning(
                    "async_invoker: SQS message missing inferenceId",
                    extra={"message_id": msg.get("MessageId")},
                )
                continue
            if inference_id in in_flight:
                results.append(
                    PolledNotification(inference_id=inference_id, body=notification)
                )
                self._sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=receipt)
            else:
                # 他バッチ宛て: 即時返却して別ランナーが受信できるようにする
                self._sqs.change_message_visibility(
                    QueueUrl=queue_url,
                    ReceiptHandle=receipt,
                    VisibilityTimeout=0,
                )
        return results

    # ------------------------------------------------------------------
    # Task 3.3 / 5.1: max_concurrent 背圧 + BatchResult + deadline 監視
    #                 + OutputLocation ダウンロード + process_log.jsonl 永続化
    # ------------------------------------------------------------------
    async def run_batch(
        self,
        *,
        batch_job_id: str,
        input_files: list[Path],
        output_dir: Path,
        log_path: Path,
        deadline_seconds: float = _DEFAULT_DEADLINE_SECONDS,
    ) -> BatchResult:
        """入力ファイルを Async Endpoint で処理し、BatchResult を返す。

        制御フロー (pseudo):

        1. deadline を ``time.monotonic() + deadline_seconds`` で固定
        2. ``pending`` と ``in_flight`` の両方が空になるまでループ:
           a. 空きがあれば ``max_concurrent`` 上限まで ``_stage_input`` →
              ``_invoke_async`` を同期発行する。4xx の ``ClientError`` は
              ``failed_files`` に積んで継続
           b. ``_poll_queue(success)`` と ``_poll_queue(failure)`` を順に呼び、
              自バッチ宛てを ``succeeded_files`` / ``failed_files`` に集計し、
              成功時は OutputLocation から ``output_dir/{stem}.json`` を保存
              する。同時に ``process_log.jsonl`` に 1 行 1 レコードで追記する
        3. deadline 超過で抜けた場合、残 in-flight を ``in_flight_timeout`` へ
           移送し、各ファイルに timeout レコードを追記する

        ``boto3`` は同期 API なので ``async def`` の内部では ``await`` を
        使わない。呼び出し側は ``asyncio.run(invoker.run_batch(...))`` で起動
        する想定。``async`` シグネチャは ``design.md`` の契約に揃えるため維持。
        """
        output_dir = Path(output_dir)
        log_path = Path(log_path)
        output_dir.mkdir(parents=True, exist_ok=True)
        log_path.parent.mkdir(parents=True, exist_ok=True)

        deadline = time.monotonic() + deadline_seconds
        result = BatchResult()

        # in_flight: InferenceId → file_stem
        in_flight: dict[str, str] = {}
        # stem → 元の入力 Path。process_log の file_path 欄と
        # 成功時の output パス生成で使う。
        stem_to_input: dict[str, Path] = {}
        pending: list[Path] = list(input_files)

        while pending or in_flight:
            if time.monotonic() >= deadline:
                break

            # Phase A: in-flight 上限まで invoke を発行
            while pending and len(in_flight) < self.max_concurrent:
                file_path = pending.pop(0)
                file_stem = file_path.stem
                stem_to_input[file_stem] = file_path
                try:
                    inference_id = self._build_inference_id(batch_job_id, file_stem)
                    input_location = self._stage_input(file_path)
                    self._invoke_async(
                        inference_id=inference_id,
                        input_location=input_location,
                        content_type=_guess_content_type(file_path),
                    )
                except ClientError as exc:
                    # 4xx は即時失敗確定 (リトライなし)。エラーコード + message を残す
                    code = exc.response.get("Error", {}).get("Code", "ClientError")
                    message = exc.response.get("Error", {}).get("Message", str(exc))
                    reason = f"{code}: {message}"
                    result.failed_files.append((file_stem, reason))
                    self._append_log_entry(
                        log_path=log_path,
                        file_path=file_path,
                        output_path=None,
                        success=False,
                        error=reason,
                    )
                    continue
                except (OSError, ValueError) as exc:
                    # 入力 read 失敗 / InferenceId 長さ超過 / prefix 逸脱等
                    reason = str(exc)
                    result.failed_files.append((file_stem, reason))
                    self._append_log_entry(
                        log_path=log_path,
                        file_path=file_path,
                        output_path=None,
                        success=False,
                        error=reason,
                    )
                    continue
                in_flight[inference_id] = file_stem

            if not in_flight:
                # 全件 invoke 前エラー or 全件完了
                break

            # Phase B: SQS を交互に polling して完了通知を回収
            self._drain_queue(
                queue_url=self.success_queue_url,
                in_flight=in_flight,
                stem_to_input=stem_to_input,
                result=result,
                output_dir=output_dir,
                log_path=log_path,
                is_failure=False,
            )
            self._drain_queue(
                queue_url=self.failure_queue_url,
                in_flight=in_flight,
                stem_to_input=stem_to_input,
                result=result,
                output_dir=output_dir,
                log_path=log_path,
                is_failure=True,
            )

        # deadline 超過で抜けた場合、残 in-flight をタイムアウト扱い
        for file_stem in sorted(in_flight.values()):
            result.in_flight_timeout.append(file_stem)
            file_path = stem_to_input.pop(file_stem, None)
            if file_path is not None:
                self._append_log_entry(
                    log_path=log_path,
                    file_path=file_path,
                    output_path=None,
                    success=False,
                    error="timeout: deadline exceeded before Async notification",
                )
        return result

    def _drain_queue(
        self,
        *,
        queue_url: str,
        in_flight: dict[str, str],
        stem_to_input: dict[str, Path],
        result: BatchResult,
        output_dir: Path,
        log_path: Path,
        is_failure: bool,
    ) -> None:
        """1 回 ``_poll_queue`` を実行し、結果を result / in_flight に反映する。

        成功通知を受けた場合は ``responseParameters.outputLocation`` から
        JSON を S3 経由でダウンロードし、``output_dir/{stem}.json`` に保存する。
        ダウンロード失敗は失敗扱いとして ``failed_files`` に積む。

        失敗通知を受けた場合は ``failureReason`` を ``failed_files`` と
        ``process_log.jsonl`` に記録する。

        自バッチ宛てメッセージは ``_poll_queue`` 内で ``DeleteMessage`` 済。
        """
        notifications = self._poll_queue(
            queue_url=queue_url,
            in_flight=set(in_flight.keys()),
        )
        for notif in notifications:
            file_stem = in_flight.pop(notif.inference_id, None)
            if file_stem is None:
                # 別 iteration で既に取り込み済 (重複配信)。at-least-once 耐性。
                continue
            file_path = stem_to_input.pop(file_stem, None)

            def _record_failure(reason: str) -> None:
                """失敗を result と process_log に 1 箇所で記録する。"""
                result.failed_files.append((file_stem, reason))
                if file_path is not None:
                    self._append_log_entry(
                        log_path=log_path,
                        file_path=file_path,
                        output_path=None,
                        success=False,
                        error=reason,
                    )

            if is_failure:
                reason = notif.body.get("failureReason") or "unknown"
                _record_failure(str(reason))
                continue

            # 成功: OutputLocation から JSON をダウンロードして保存
            output_location = (
                notif.body.get("responseParameters", {}).get("outputLocation")
            )
            persisted_path = output_dir / f"{file_stem}.json"
            try:
                if not isinstance(output_location, str) or not output_location:
                    raise ValueError(
                        "responseParameters.outputLocation missing in success notification"
                    )
                self._download_output(
                    s3_uri=output_location, destination=persisted_path
                )
            except ClientError as exc:
                code = exc.response.get("Error", {}).get("Code", "ClientError")
                message = exc.response.get("Error", {}).get("Message", str(exc))
                _record_failure(f"output download failed ({code}): {message}")
                continue
            except (OSError, ValueError) as exc:
                _record_failure(f"output download failed: {exc}")
                continue

            result.succeeded_files.append(file_stem)
            if file_path is not None:
                self._append_log_entry(
                    log_path=log_path,
                    file_path=file_path,
                    output_path=persisted_path,
                    success=True,
                    error=None,
                )

    # ------------------------------------------------------------------
    # Task 5.1: S3 OutputLocation ダウンロード + process_log.jsonl 追記
    # ------------------------------------------------------------------
    def _parse_s3_uri(self, uri: str) -> tuple[str, str]:
        """``s3://bucket/key`` を ``(bucket, key)`` に分解する。

        スキームが ``s3`` 以外、または bucket / key が空なら ``ValueError``。
        ``..`` を含むなど正規化後に変わるキーも不正 URI として拒否する
        (SageMaker からの notification が汚染された場合の横取り防止)。
        ``bucket`` は ``self.output_bucket`` と一致するもののみ許可する。
        """
        parsed = urlparse(uri)
        if parsed.scheme != "s3" or not parsed.netloc:
            raise ValueError(f"invalid S3 URI: {uri!r}")
        key = parsed.path.lstrip("/")
        if not key:
            raise ValueError(f"S3 URI missing key: {uri!r}")
        if key != posixpath.normpath(key) or ".." in key.split("/"):
            raise ValueError(f"S3 URI key is not normalized: {uri!r}")
        if parsed.netloc != self.output_bucket:
            raise ValueError(
                f"S3 URI bucket {parsed.netloc!r} does not match "
                f"output_bucket {self.output_bucket!r}"
            )
        return parsed.netloc, key

    # SageMaker Async の出力サイズ上限は 1GB。yomitoku の応答は数 MB 程度に
    # 収まる想定だが、誤設定で巨大レスポンスが返された場合にメモリを食い
    # 潰さないよう、ストリーム書き込み + ContentLength 上限で防御する。
    _MAX_OUTPUT_BYTES = 128 * 1024 * 1024  # 128 MiB

    def _download_output(self, *, s3_uri: str, destination: Path) -> None:
        """``s3_uri`` を ``destination`` にストリーム保存する。

        ContentLength が ``_MAX_OUTPUT_BYTES`` を超えるレスポンスは即時拒否し、
        本体 read 前に ``ValueError`` を送出する。
        """
        bucket, key = self._parse_s3_uri(s3_uri)
        response = self._s3.get_object(Bucket=bucket, Key=key)
        content_length = response.get("ContentLength")
        if (
            isinstance(content_length, int)
            and content_length > self._MAX_OUTPUT_BYTES
        ):
            raise ValueError(
                f"output too large: {content_length} bytes "
                f"(max={self._MAX_OUTPUT_BYTES})"
            )
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("wb") as f:
            shutil.copyfileobj(response["Body"], f)

    @staticmethod
    def _append_log_entry(
        *,
        log_path: Path,
        file_path: Path,
        output_path: Path | None,
        success: bool,
        error: str | None,
    ) -> None:
        """``process_log.jsonl`` に 1 行 1 レコードで追記する。

        DDB 反映 (Task 3.4 の ``update_batch_items_from_log``) で
        ``file_path`` → ``BatchTable`` PK を特定し、
        ``output_path`` / ``success`` / ``error`` を状態遷移に用いる。
        """
        log_path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "file_path": str(file_path),
            "output_path": str(output_path) if output_path is not None else None,
            "success": success,
            "error": error,
        }
        with log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False))
            f.write("\n")

    @staticmethod
    def _unwrap_notification(body_text: str) -> dict[str, Any] | None:
        """SNS エンベロープ / Raw Message Delivery の双方に対応して本体を返す。

        - SNS エンベロープ (``Type == "Notification"``): ``Message`` 文字列を
          再度 JSON パースして返す
        - Raw Message Delivery: body そのものが SageMaker 通知 JSON
        - JSON として解釈できない場合は ``None`` を返す
        """
        try:
            outer = json.loads(body_text)
        except json.JSONDecodeError:
            return None

        if isinstance(outer, dict) and outer.get("Type") == "Notification":
            inner_text = outer.get("Message")
            if not isinstance(inner_text, str):
                return None
            try:
                inner = json.loads(inner_text)
            except json.JSONDecodeError:
                return None
            return inner if isinstance(inner, dict) else None

        return outer if isinstance(outer, dict) else None
