"""Tests for the access-log token redaction filter."""

from __future__ import annotations

import logging

from dcc_chat_gateway.log_filters import (
    RedactTokenFilter,
    install_access_log_redaction,
)


def _record(msg, args):
    return logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=msg,
        args=args,
        exc_info=None,
    )


def test_redacts_token_in_deferred_args():
    """uvicorn access format: token sits in record.args (path component)."""
    flt = RedactTokenFilter()
    rec = _record(
        '%s - "%s %s HTTP/%s" %s',
        ("1.2.3.4", "GET", "/ws?token=eyJabc.def.ghi", "1.1", 101),
    )
    assert flt.filter(rec) is True
    assert rec.args[2] == "/ws?token=<redacted>"
    assert "eyJabc" not in (rec.getMessage())


def test_redacts_token_in_preformatted_msg():
    """The websocket accept line arrives pre-formatted in record.msg."""
    flt = RedactTokenFilter()
    rec = _record('1.2.3.4 - "WebSocket /ws?token=SECRETVALUE" [accepted]', None)
    assert flt.filter(rec) is True
    assert "SECRETVALUE" not in rec.getMessage()
    assert "token=<redacted>" in rec.getMessage()


def test_preserves_other_query_params():
    flt = RedactTokenFilter()
    rec = _record("%s", ("/ws?foo=1&token=abc123&bar=2",))
    flt.filter(rec)
    assert rec.args[0] == "/ws?foo=1&token=<redacted>&bar=2"


def test_noop_when_no_token():
    flt = RedactTokenFilter()
    rec = _record('%s - "%s %s HTTP/%s" %s', ("1.2.3.4", "GET", "/health", "1.1", 200))
    flt.filter(rec)
    assert rec.args[2] == "/health"


def test_install_is_idempotent():
    """Repeated installs must not stack duplicate filters on the logger."""
    install_access_log_redaction()
    install_access_log_redaction()
    logger = logging.getLogger("uvicorn.access")
    redactors = [f for f in logger.filters if isinstance(f, RedactTokenFilter)]
    assert len(redactors) == 1
