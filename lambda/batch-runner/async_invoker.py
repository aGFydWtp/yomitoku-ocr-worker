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

import mimetypes
from pathlib import Path
from typing import Any

import boto3


_DEFAULT_CONTENT_TYPE = "application/octet-stream"
_CONTENT_TYPE_OVERRIDES: dict[str, str] = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
}


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
        """``{batch_job_id}:{file_stem}`` 形式の InferenceId を返す。"""
        return f"{batch_job_id}:{file_stem}"

    def _stage_input(self, file_path: Path) -> str:
        """入力ファイルを ``input_prefix`` 配下へ PUT し、``s3://`` URI を返す。"""
        key = f"{self.input_prefix}{file_path.name}"
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
