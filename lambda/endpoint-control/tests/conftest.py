"""Shared fixtures for endpoint-control tests."""

from __future__ import annotations

import os

# Environment variables must be set before importing index
os.environ.setdefault("ENDPOINT_NAME", "test-endpoint")
os.environ.setdefault("ENDPOINT_CONFIG_NAME", "test-config")
os.environ.setdefault("QUEUE_URL", "")  # Set per test with moto
os.environ.setdefault("CONTROL_TABLE_NAME", "test-control-table")
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-1")
