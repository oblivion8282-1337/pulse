"""End-to-end integration test: HTTP request through a real frp tunnel,
authorised by the relay plugin against a stub auth endpoint.

Four assertions:
  (a) through        — valid tunnel delivers /health → 200
  (b) deny-token     — wrong token → tunnel rejected → no 200
  (c) deny-impersonation — valid user but mismatched subdomain → NewProxy rejected
  (d) reconnect      — kill frpc, restart → /health recovers to 200

Runs only when frps + frpc are on PATH.
"""
from __future__ import annotations

import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

import httpx
import pytest

pytestmark = pytest.mark.skipif(
    not (shutil.which("frps") and shutil.which("frpc")),
    reason="frps/frpc not installed (brew install frpc frps)",
)

# ── Constants ────────────────────────────────────────────────────────────────

RELAY_BASE_DOMAIN = "relay.test"
SUBDOMAIN_SLUG = "brave-otter-4f2a"
FULL_SUBDOMAIN = f"{SUBDOMAIN_SLUG}.{RELAY_BASE_DOMAIN}"
GOOD_TOKEN = "plse_relay_good"
INTERNAL_SECRET = "s3cr3t"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_port(port: int, timeout: float = 10.0) -> bool:
    """Return True once something is listening on 127.0.0.1:port."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def _poll_200(url: str, host_header: str, timeout: float = 15.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            r = httpx.get(url, headers={"Host": host_header}, timeout=2.0)
            if r.status_code == 200:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def _assert_no_200(url: str, host_header: str, duration: float = 5.0) -> None:
    """Assert that polling never returns 200 within *duration* seconds."""
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        try:
            r = httpx.get(url, headers={"Host": host_header}, timeout=2.0)
            assert r.status_code != 200, (
                f"Expected no 200 from {url} Host:{host_header}, got {r.status_code}"
            )
        except httpx.RequestError:
            pass
        time.sleep(0.5)


# ── Target HTTP server ────────────────────────────────────────────────────────

class _HealthHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            body = b"OK"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, fmt, *args):  # silence access log
        pass


def _start_target_server(port: int) -> http.server.HTTPServer:
    srv = http.server.HTTPServer(("127.0.0.1", port), _HealthHandler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv


# ── Stub auth-svc ─────────────────────────────────────────────────────────────

class _AuthHandler(http.server.BaseHTTPRequestHandler):
    """Minimal /selfhost/relay/auth stub: 200 iff secret + {subdomain,token} match."""

    ok_subdomain: str = FULL_SUBDOMAIN
    ok_token: str = GOOD_TOKEN

    def do_POST(self):
        if self.path != "/selfhost/relay/auth":
            self.send_response(404)
            self.end_headers()
            return
        secret = self.headers.get("X-Pulse-Internal-Secret", "")
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        if (
            secret == INTERNAL_SECRET
            and body.get("subdomain") == self.__class__.ok_subdomain
            and body.get("token") == self.__class__.ok_token
        ):
            resp = json.dumps({"instance_id": "1", "subdomain": self.__class__.ok_subdomain}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(resp)))
            self.end_headers()
            self.wfile.write(resp)
        else:
            self.send_response(401)
            self.end_headers()

    def log_message(self, fmt, *args):
        pass


def _start_auth_server(port: int) -> http.server.HTTPServer:
    srv = http.server.HTTPServer(("127.0.0.1", port), _AuthHandler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv


# ── frpc TOML renderer ────────────────────────────────────────────────────────

def _render_frpc_config(
    *,
    frps_port: int,
    target_port: int,
    user: str,
    token: str,
    subdomain_slug: str,
) -> str:
    return (
        'serverAddr = "127.0.0.1"\n'
        f"serverPort = {frps_port}\n"
        f'user = "{user}"\n'
        "\n"
        "[metadatas]\n"
        f'token = "{token}"\n'
        "\n"
        "[[proxies]]\n"
        f'name = "{subdomain_slug}"\n'
        'type = "http"\n'
        f"localPort = {target_port}\n"
        f'subdomain = "{subdomain_slug}"\n'
    )


# ── Main integration test ─────────────────────────────────────────────────────

def test_frp_tunnel_end_to_end(tmp_path):
    target_port = _free_port()
    auth_port = _free_port()
    plugin_port = _free_port()
    frps_port = _free_port()
    vhost_port = _free_port()

    vhost_url = f"http://127.0.0.1:{vhost_port}/health"

    target_srv = _start_target_server(target_port)
    auth_srv = _start_auth_server(auth_port)

    from dcc_relay_frps_plugin.frps_config import render_frps_server_config

    frps_cfg_path = tmp_path / "frps.toml"
    frps_cfg_path.write_text(
        render_frps_server_config(
            bind_port=frps_port,
            vhost_http_port=vhost_port,
            subdomain_host=RELAY_BASE_DOMAIN,
            plugin_addr=f"127.0.0.1:{plugin_port}",
        )
    )

    frpc_good_cfg = tmp_path / "frpc_good.toml"
    frpc_good_cfg.write_text(
        _render_frpc_config(
            frps_port=frps_port,
            target_port=target_port,
            user=FULL_SUBDOMAIN,
            token=GOOD_TOKEN,
            subdomain_slug=SUBDOMAIN_SLUG,
        )
    )

    # Process handles — collected for teardown
    procs: list[subprocess.Popen] = []

    def _kill_all():
        for p in procs:
            try:
                p.terminate()
                p.wait(timeout=5)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass

    try:
        # ── Start plugin ─────────────────────────────────────────────────────
        plugin_env = {
            **os.environ,
            "AUTH_SVC_URL": f"http://127.0.0.1:{auth_port}",
            "INTERNAL_SERVICE_SECRET": INTERNAL_SECRET,
            "RELAY_BASE_DOMAIN": RELAY_BASE_DOMAIN,
        }
        plugin_proc = subprocess.Popen(
            [
                sys.executable, "-m", "uvicorn",
                "dcc_relay_frps_plugin.app:app",
                "--host", "127.0.0.1",
                "--port", str(plugin_port),
                "--log-level", "warning",
            ],
            env=plugin_env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        procs.append(plugin_proc)
        assert _wait_port(plugin_port, 15), "plugin did not start"

        # ── Start frps ───────────────────────────────────────────────────────
        frps_proc = subprocess.Popen(
            ["frps", "-c", str(frps_cfg_path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        procs.append(frps_proc)
        assert _wait_port(frps_port, 10), "frps did not start"
        assert _wait_port(vhost_port, 10), "frps vhost port did not open"

        # ── (a) THROUGH — valid tunnel → 200 ────────────────────────────────
        frpc_good = subprocess.Popen(
            ["frpc", "-c", str(frpc_good_cfg)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        procs.append(frpc_good)

        assert _poll_200(vhost_url, FULL_SUBDOMAIN, timeout=15), (
            "assertion (a) THROUGH: /health did not return 200 through the tunnel"
        )

        # ── (b) DENY-TOKEN — wrong token → tunnel rejected → no 200 ─────────
        frpc_bad_token_cfg = tmp_path / "frpc_bad_token.toml"
        bad_slug = "deny-token-check"
        bad_full = f"{bad_slug}.{RELAY_BASE_DOMAIN}"
        frpc_bad_token_cfg.write_text(
            _render_frpc_config(
                frps_port=frps_port,
                target_port=target_port,
                user=bad_full,
                token="wrong-token",
                subdomain_slug=bad_slug,
            )
        )
        frpc_bad_token = subprocess.Popen(
            ["frpc", "-c", str(frpc_bad_token_cfg)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # (do NOT add to procs yet — we clean it up explicitly below)
        try:
            _assert_no_200(vhost_url, bad_full, duration=5)
        finally:
            try:
                frpc_bad_token.terminate()
                frpc_bad_token.wait(timeout=5)
            except Exception:
                try:
                    frpc_bad_token.kill()
                except Exception:
                    pass

        # ── (c) DENY-IMPERSONATION — authorized user, wrong subdomain ────────
        frpc_impersonate_cfg = tmp_path / "frpc_impersonate.toml"
        victim_slug = "someone-else"
        victim_full = f"{victim_slug}.{RELAY_BASE_DOMAIN}"
        # user = FULL_SUBDOMAIN (authorized), subdomain = "someone-else" (not matching)
        frpc_impersonate_cfg.write_text(
            _render_frpc_config(
                frps_port=frps_port,
                target_port=target_port,
                user=FULL_SUBDOMAIN,
                token=GOOD_TOKEN,
                subdomain_slug=victim_slug,
            )
        )
        frpc_impersonate = subprocess.Popen(
            ["frpc", "-c", str(frpc_impersonate_cfg)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            _assert_no_200(vhost_url, victim_full, duration=5)
        finally:
            try:
                frpc_impersonate.terminate()
                frpc_impersonate.wait(timeout=5)
            except Exception:
                try:
                    frpc_impersonate.kill()
                except Exception:
                    pass

        # ── (d) RECONNECT — kill good frpc, restart → 200 recovers ──────────
        procs.remove(frpc_good)
        try:
            frpc_good.terminate()
            frpc_good.wait(timeout=5)
        except Exception:
            try:
                frpc_good.kill()
            except Exception:
                pass

        frpc_restart = subprocess.Popen(
            ["frpc", "-c", str(frpc_good_cfg)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        procs.append(frpc_restart)

        assert _poll_200(vhost_url, FULL_SUBDOMAIN, timeout=30), (
            "assertion (d) RECONNECT: /health did not recover to 200 after frpc restart"
        )

    finally:
        _kill_all()
        try:
            target_srv.shutdown()
        except Exception:
            pass
        try:
            auth_srv.shutdown()
        except Exception:
            pass
