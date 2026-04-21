"""Tests for control_table.py: heartbeat と ACTIVE#COUNT 管理 (Task 3.5)。"""

from __future__ import annotations

import sys
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).parent.parent))


CONTROL_TABLE = "TestControlTable"
BATCH_ID = "batch-xyz-001"


def _create_control_table():
    """`lib/processing-stack.ts` の ControlTable 相当 (PK=lock_key) を作成する。"""
    client = boto3.resource("dynamodb", region_name="us-east-1")
    client.create_table(
        TableName=CONTROL_TABLE,
        KeySchema=[{"AttributeName": "lock_key", "KeyType": "HASH"}],
        AttributeDefinitions=[
            {"AttributeName": "lock_key", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    return client.Table(CONTROL_TABLE)


# ---------------------------------------------------------------------------
# register_heartbeat
# ---------------------------------------------------------------------------


class TestRegisterHeartbeat:
    def test_writes_heartbeat_with_expires_at(self):
        with mock_aws():
            table = _create_control_table()
            import control_table

            control_table.register_heartbeat(
                table=table,
                batch_job_id=BATCH_ID,
                duration_sec=7200,
                now_epoch=1_700_000_000,
            )
            item = table.get_item(Key={
                "lock_key": f"BATCH_IN_FLIGHT#{BATCH_ID}"
            })["Item"]
            assert item["batchJobId"] == BATCH_ID
            assert int(item["expiresAt"]) == 1_700_000_000 + 7200
            assert int(item["createdAt"]) == 1_700_000_000

    def test_increments_active_count(self):
        with mock_aws():
            table = _create_control_table()
            import control_table

            control_table.register_heartbeat(
                table=table, batch_job_id="b1",
                duration_sec=60, now_epoch=1_700_000_000,
            )
            control_table.register_heartbeat(
                table=table, batch_job_id="b2",
                duration_sec=60, now_epoch=1_700_000_100,
            )
            counter = table.get_item(Key={"lock_key": "ACTIVE#COUNT"})["Item"]
            assert int(counter["count"]) == 2


# ---------------------------------------------------------------------------
# update_heartbeat
# ---------------------------------------------------------------------------


class TestUpdateHeartbeat:
    def test_extends_expires_at(self):
        with mock_aws():
            table = _create_control_table()
            import control_table

            control_table.register_heartbeat(
                table=table, batch_job_id=BATCH_ID,
                duration_sec=60, now_epoch=1_700_000_000,
            )
            control_table.update_heartbeat(
                table=table, batch_job_id=BATCH_ID,
                duration_sec=120, now_epoch=1_700_000_030,
            )
            item = table.get_item(Key={
                "lock_key": f"BATCH_IN_FLIGHT#{BATCH_ID}"
            })["Item"]
            assert int(item["expiresAt"]) == 1_700_000_030 + 120
            assert int(item["updatedAt"]) == 1_700_000_030


# ---------------------------------------------------------------------------
# delete_heartbeat
# ---------------------------------------------------------------------------


class TestDeleteHeartbeat:
    def test_removes_heartbeat_item(self):
        with mock_aws():
            table = _create_control_table()
            import control_table

            control_table.register_heartbeat(
                table=table, batch_job_id=BATCH_ID,
                duration_sec=60, now_epoch=1_700_000_000,
            )
            control_table.delete_heartbeat(table=table, batch_job_id=BATCH_ID)

            resp = table.get_item(Key={
                "lock_key": f"BATCH_IN_FLIGHT#{BATCH_ID}"
            })
            assert "Item" not in resp

    def test_decrements_active_count(self):
        with mock_aws():
            table = _create_control_table()
            import control_table

            control_table.register_heartbeat(
                table=table, batch_job_id="b1",
                duration_sec=60, now_epoch=1_700_000_000,
            )
            control_table.register_heartbeat(
                table=table, batch_job_id="b2",
                duration_sec=60, now_epoch=1_700_000_100,
            )
            control_table.delete_heartbeat(table=table, batch_job_id="b1")

            counter = table.get_item(Key={"lock_key": "ACTIVE#COUNT"})["Item"]
            assert int(counter["count"]) == 1

    def test_decrement_does_not_go_below_zero(self):
        with mock_aws():
            table = _create_control_table()
            import control_table

            # 未登録バッチの delete は例外を発生させない
            control_table.delete_heartbeat(table=table, batch_job_id="ghost")
            # カウンタも負にならない (item 自体が存在しない)
            resp = table.get_item(Key={"lock_key": "ACTIVE#COUNT"})
            assert "Item" not in resp or int(resp["Item"]["count"]) >= 0
