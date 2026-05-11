"""Database engine + session for the chat-gateway."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends
from sqlalchemy import BigInteger, MetaData
from sqlalchemy.ext.asyncio import AsyncAttrs, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from dcc_chat_gateway.config import get_settings

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


def snowflake_pk():
    return mapped_column(BigInteger, primary_key=True, autoincrement=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session


SessionDep = Annotated[AsyncSession, Depends(get_session)]


__all__ = ["Base", "Mapped", "SessionDep", "get_session", "snowflake_pk", "engine"]
