"""Database engine, session and base model."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends
from sqlalchemy import BigInteger, MetaData
from sqlalchemy.ext.asyncio import (
    AsyncAttrs,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, mapped_column
from sqlalchemy.orm import Mapped as Mapped  # re-export for callers

from dcc_auth.config import get_settings

_settings = get_settings()

_db_url = _settings.effective_database_url
_pool_kwargs: dict = (
    {"pool_size": 10, "max_overflow": 20, "pool_pre_ping": True}
    if "asyncpg" in _db_url
    else {}
)
engine = create_async_engine(_db_url, echo=False, **_pool_kwargs)

SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

metadata = MetaData(schema=_settings.database_schema)


class Base(AsyncAttrs, DeclarativeBase):
    metadata = metadata


# Convenience column factory for BIGINT primary keys (snowflakes).
def snowflake_pk():
    return mapped_column(BigInteger, primary_key=True, autoincrement=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session


SessionDep = Annotated[AsyncSession, Depends(get_session)]
