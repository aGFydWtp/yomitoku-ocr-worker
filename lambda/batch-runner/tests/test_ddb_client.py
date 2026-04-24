"""Tests for ddb_client.py: boto3 resource の遅延生成。"""

from __future__ import annotations

import sys
from pathlib import Path


class TestDdbClient:
    """ddb_client.py の遅延初期化テスト。"""

    def _reload(self):
        sys.path.insert(0, str(Path(__file__).parent.parent))
        import importlib

        sys.modules.pop("ddb_client", None)
        import ddb_client

        importlib.reload(ddb_client)
        return ddb_client

    def test_import_has_no_side_effect(self):
        """import 時に boto3.resource() を呼ばない（モジュール属性として存在しない）。"""
        mod = self._reload()
        # モジュール直下に `dynamodb` 変数（副作用）が存在しないこと
        assert not hasattr(mod, "dynamodb"), (
            "ddb_client must not invoke boto3.resource() at import time"
        )

    def test_factory_returns_resource(self, monkeypatch):
        """get_dynamodb_resource() が boto3.resource('dynamodb') を呼ぶ。"""
        mod = self._reload()

        calls: list[str] = []

        def fake_resource(name: str):
            calls.append(name)
            return {"fake": True, "name": name}

        monkeypatch.setattr(mod.boto3, "resource", fake_resource)
        result = mod.get_dynamodb_resource()
        assert calls == ["dynamodb"]
        assert result == {"fake": True, "name": "dynamodb"}
