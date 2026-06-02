"""Logging filters — redact secrets from access logs.

The WebSocket endpoint authenticates via a query param (``/ws?token=…``)
because the browser WebSocket API cannot send custom headers. uvicorn's
access logger prints the full request path, so the short-lived access token
ends up in the logs verbatim — which violates the project rule "never log
tokens" (CLAUDE.md). This filter rewrites any ``token=<value>`` occurrence in
a log record (message, args, or websocket "[accepted]" line) to
``token=<redacted>`` before it is emitted.

Install once at app construction via :func:`install_access_log_redaction`.
"""

from __future__ import annotations

import logging
import re

# token=<value> up to the next & or whitespace or quote. Case-insensitive on
# the key so ``Token=``/``TOKEN=`` are caught too.
_TOKEN_RE = re.compile(r"(?i)(token=)[^&\s\"']+")
_REDACTED = r"\1<redacted>"

# Loggers uvicorn routes request/websocket lines through. Filters do NOT
# propagate to child loggers, so each must be patched explicitly; we also
# attach to their handlers to catch records regardless of attachment point.
_TARGET_LOGGERS = ("uvicorn.access", "uvicorn.error", "uvicorn", "websockets")
_INSTALLED_MARKER = "_dcc_token_redaction"


def _redact(value: str) -> str:
    return _TOKEN_RE.sub(_REDACTED, value)


class RedactTokenFilter(logging.Filter):
    """A logging.Filter that scrubs ``token=…`` from the record in place.

    Returns True always (filters here mutate, never drop). Handles both the
    pre-format case (``record.msg`` already contains the token) and the
    deferred-format case (token sits in ``record.args``), covering uvicorn's
    ``'%s - "%s %s HTTP/%s" %s'`` access format and the websocket accept line.
    """

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003
        if isinstance(record.msg, str) and "token=" in record.msg.lower():
            record.msg = _redact(record.msg)
        args = record.args
        if isinstance(args, tuple):
            record.args = tuple(
                _redact(a) if isinstance(a, str) and "token=" in a.lower() else a
                for a in args
            )
        elif isinstance(args, dict):
            record.args = {
                k: (_redact(v) if isinstance(v, str) and "token=" in v.lower() else v)
                for k, v in args.items()
            }
        return True


def install_access_log_redaction() -> None:
    """Attach :class:`RedactTokenFilter` to uvicorn's access/error loggers.

    Idempotent: a marker attribute guards against double-installation across
    repeated ``create_app`` calls (tests, reloads)."""
    flt = RedactTokenFilter()
    for name in _TARGET_LOGGERS:
        logger = logging.getLogger(name)
        if not getattr(logger, _INSTALLED_MARKER, False):
            logger.addFilter(flt)
            setattr(logger, _INSTALLED_MARKER, True)
        for handler in logger.handlers:
            if not getattr(handler, _INSTALLED_MARKER, False):
                handler.addFilter(flt)
                setattr(handler, _INSTALLED_MARKER, True)
