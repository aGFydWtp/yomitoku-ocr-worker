"""SageMaker Asynchronous Inference 呼び出しクライアント。

Task 3.1 現在の責務:
    - 入力ファイルを ``batches/_async/inputs/{batch_job_id}/{file}`` へ
      S3 ``PutObject`` でステージングする
    - ``InferenceId`` を ``{batch_job_id}:{file_stem}`` 形式で生成する
    - ``sagemaker-runtime.invoke_endpoint_async`` を発行する
    - 4xx (``ValidationException`` 等) の ``ClientError`` を呼び出し元へ
      そのまま伝搬し、AsyncInvoker 内ではリトライしない

後続 (3.2 / 3.3 / 3.4) で SQS long-poll 受信、``InferenceId`` フィルタ、
``max_concurrent`` 背圧、``BatchResult`` 集計、``run_batch`` API を加える。
"""

from __future__ import annotations

import json
import logging
import mimetypes
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import boto3


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

# SQS Receive は 1 回あたり最大 10 件。moto / 本番共通の API 上限。
_RECEIVE_MAX_MESSAGES = 10


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
        """``{batch_job_id}:{file_stem}`` 形式の InferenceId を返す。

        SageMaker API の ``InferenceId`` は 64 文字上限。上限超過時は実行時
        ``ValidationException`` となるため、生成段階で検知して送出する。
        """
        inference_id = f"{batch_job_id}:{file_stem}"
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
        """
        key = f"{self.input_prefix}{file_path.name}"
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
