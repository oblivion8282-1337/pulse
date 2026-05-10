"""Singleton snowflake generator for the auth service."""

from __future__ import annotations

from dcc_auth.config import get_settings
from dcc_shared.snowflake import SnowflakeGenerator

_gen: SnowflakeGenerator | None = None


def get_generator() -> SnowflakeGenerator:
    global _gen
    if _gen is None:
        _gen = SnowflakeGenerator(worker_id=get_settings().snowflake_worker_id_auth)
    return _gen


def next_id() -> int:
    return get_generator().next_id()
