"""ControlTable heartbeat 管理 (Task 3.5)。

`lib/processing-stack.ts` の ControlTable (PK=`lock_key`) に以下 2 種類の
アイテムを書き込む:

1. `BATCH_IN_FLIGHT#{batchJobId}` — バッチ実行中フラグ + TTL (expiresAt)
2. `ACTIVE#COUNT` — 並行バッチ数のカウンタ (ADD による原子更新)

Scan / GSI を使わずに同時実行数を管理するために ACTIVE#COUNT を採用する。

**アトミシティ**: heartbeat アイテムと ACTIVE#COUNT の整合性を保つため、
register / delete は `TransactWriteItems` で同時に書き込む。タスクが
Put と Update の間でクラッシュした場合でも、両方成功か両方失敗のどちらかに
収束し、カウンタのゴーストドリフトを防ぐ。
"""

from __future__ import annotations

import logging
import time

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)


BATCH_IN_FLIGHT_PREFIX = "BATCH_IN_FLIGHT#"
ACTIVE_COUNT_KEY = "ACTIVE#COUNT"


def _batch_key(batch_job_id: str) -> str:
    return f"{BATCH_IN_FLIGHT_PREFIX}{batch_job_id}"


def _client_and_name(table):
    """boto3 Table resource から low-level client と table name を取り出す。

    ``table.meta.client`` を直接使うと moto のテストハーネスで
    ``TransactWriteItems`` 呼び出し時に ``unhashable type: dict`` で落ちるため、
    同じ region を引き継いだ別クライアントを生成する。本番 (実 DDB) では
    ``boto3.client('dynamodb')`` は同一エンドポイントを解決するため動作差異はない。
    """
    region = table.meta.client.meta.region_name
    endpoint_url = table.meta.client.meta.endpoint_url
    return (
        boto3.client("dynamodb", region_name=region, endpoint_url=endpoint_url),
        table.name,
    )


# ---------------------------------------------------------------------------
# register_heartbeat
# ---------------------------------------------------------------------------


def register_heartbeat(
    *,
    table,
    batch_job_id: str,
    duration_sec: int,
    now_epoch: int | None = None,
) -> None:
    """バッチ開始時に heartbeat と ACTIVE#COUNT を登録する。

    `TransactWriteItems` で以下を 1 トランザクションにまとめる:
        - `BATCH_IN_FLIGHT#{id}` の Put (expiresAt/createdAt 付与)
        - `ACTIVE#COUNT` の ADD 1 (Update)
    """
    now = now_epoch if now_epoch is not None else int(time.time())
    expires_at = now + duration_sec

    client, table_name = _client_and_name(table)
    client.transact_write_items(TransactItems=[
        {
            "Put": {
                "TableName": table_name,
                "Item": {
                    "lock_key": {"S": _batch_key(batch_job_id)},
                    "batchJobId": {"S": batch_job_id},
                    "expiresAt": {"N": str(expires_at)},
                    "createdAt": {"N": str(now)},
                },
            },
        },
        {
            "Update": {
                "TableName": table_name,
                "Key": {"lock_key": {"S": ACTIVE_COUNT_KEY}},
                "UpdateExpression": "ADD #c :one",
                "ExpressionAttributeNames": {"#c": "count"},
                "ExpressionAttributeValues": {":one": {"N": "1"}},
            },
        },
    ])


# ---------------------------------------------------------------------------
# update_heartbeat
# ---------------------------------------------------------------------------


def update_heartbeat(
    *,
    table,
    batch_job_id: str,
    duration_sec: int,
    now_epoch: int | None = None,
) -> None:
    """heartbeat の expiresAt/updatedAt を延長する (counter は触らない)。"""
    now = now_epoch if now_epoch is not None else int(time.time())
    expires_at = now + duration_sec

    table.update_item(
        Key={"lock_key": _batch_key(batch_job_id)},
        UpdateExpression="SET #exp = :exp, #upd = :upd",
        ExpressionAttributeNames={
            "#exp": "expiresAt",
            "#upd": "updatedAt",
        },
        ExpressionAttributeValues={
            ":exp": expires_at,
            ":upd": now,
        },
    )


# ---------------------------------------------------------------------------
# delete_heartbeat
# ---------------------------------------------------------------------------


def delete_heartbeat(*, table, batch_job_id: str) -> None:
    """バッチ終了時に heartbeat を削除し ACTIVE#COUNT を -1 する。

    `TransactWriteItems` で以下を 1 トランザクションにまとめる:
        - `BATCH_IN_FLIGHT#{id}` の Delete
        - `ACTIVE#COUNT` の ADD -1 (`count > 0` 条件付き)

    ゴースト削除 (register されていない batch) でも ACTIVE#COUNT が負に
    ならないよう、条件失敗時はトランザクション全体が無操作で終了する。
    """
    client, table_name = _client_and_name(table)
    try:
        client.transact_write_items(TransactItems=[
            {
                "Delete": {
                    "TableName": table_name,
                    "Key": {"lock_key": {"S": _batch_key(batch_job_id)}},
                },
            },
            {
                "Update": {
                    "TableName": table_name,
                    "Key": {"lock_key": {"S": ACTIVE_COUNT_KEY}},
                    "UpdateExpression": "ADD #c :minus_one",
                    "ConditionExpression": "attribute_exists(#c) AND #c > :zero",
                    "ExpressionAttributeNames": {"#c": "count"},
                    "ExpressionAttributeValues": {
                        ":minus_one": {"N": "-1"},
                        ":zero": {"N": "0"},
                    },
                },
            },
        ])
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")
        # TransactionCanceledException: ConditionCheck 失敗を含むトランザクション失敗
        if code in ("TransactionCanceledException", "ConditionalCheckFailedException"):
            logger.info(
                "delete_heartbeat: ACTIVE#COUNT not decremented (already 0 or missing): %s",
                batch_job_id,
            )
            # ゴースト削除ケース: heartbeat アイテム単体の削除はベストエフォートで実行
            try:
                table.delete_item(Key={"lock_key": _batch_key(batch_job_id)})
            except ClientError:
                logger.warning(
                    "delete_heartbeat: fallback delete_item failed for %s", batch_job_id
                )
            return
        raise
