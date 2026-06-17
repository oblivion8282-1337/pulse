"""Renders the frps.toml that registers this plugin as a server-side auth hook.

frps routes ``<slug>.<subdomainHost>`` (vHost HTTP) into the matching frpc
tunnel; Caddy terminates the wildcard TLS in front and reverse-proxies to
``vhostHTTPPort``. The httpPlugins block makes frps consult this service on
Login + NewProxy.
"""
from __future__ import annotations


def render_frps_server_config(
    *, bind_port: int, vhost_http_port: int, subdomain_host: str, plugin_addr: str
) -> str:
    return (
        f"bindPort = {bind_port}\n"
        f"vhostHTTPPort = {vhost_http_port}\n"
        f'subdomainHost = "{subdomain_host}"\n'
        "\n"
        "[[httpPlugins]]\n"
        'name = "pulse-relay-auth"\n'
        f'addr = "{plugin_addr}"\n'
        'path = "/handler"\n'
        'ops = ["Login", "NewProxy"]\n'
    )
