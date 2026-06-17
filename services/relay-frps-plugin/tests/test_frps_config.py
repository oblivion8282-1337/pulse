from __future__ import annotations
from dcc_relay_frps_plugin.frps_config import render_frps_server_config


def test_render_frps_server_config():
    toml = render_frps_server_config(
        bind_port=7000, vhost_http_port=8080,
        subdomain_host="relay.test", plugin_addr="127.0.0.1:9100",
    )
    assert 'bindPort = 7000' in toml
    assert 'vhostHTTPPort = 8080' in toml
    assert 'subdomainHost = "relay.test"' in toml
    assert '[[httpPlugins]]' in toml
    assert 'addr = "127.0.0.1:9100"' in toml
    assert 'path = "/handler"' in toml
    assert 'ops = ["Login", "NewProxy"]' in toml
