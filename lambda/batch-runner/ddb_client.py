"""DynamoDB クライアント — Task 3.4/3.5 で実装予定のスタブ。"""

from __future__ import annotations

import boto3


def get_dynamodb_resource():
    """boto3 DynamoDB resource を遅延生成して返す。

    モジュール import 時には AWS 認証情報や endpoint 解決を行わないため、
    テスト環境や DRY_RUN 実行でも副作用なしで import できる。
    """
    return boto3.resource("dynamodb")


# TODO(task 3.4): BatchTable META/FILE アイテム更新ヘルパー
# TODO(task 3.5): ControlTable heartbeat 登録・更新・削除
