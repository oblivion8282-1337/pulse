# relay-frps-plugin

HTTP auth-hook plugin for [frp](https://github.com/fatedier/frp) (`frps`) that
gates tunnel access for the Pulse self-host relay service.

## Purpose

frps calls this service on every `Login` and `NewProxy` event. The plugin
validates the shared token, checks that the requested subdomain matches the
tenant's allocated slug, and returns allow or deny. It is **fail-closed**: any
error (network, bad token, unknown slug) results in a denial.

**The token is never logged** — neither in request traces nor in error output.

## Local prerequisites

```bash
brew install frpc frps   # macOS
```

On Linux install the frp release binary from
<https://github.com/fatedier/frp/releases>.

## Configuration

`render_frps_server_config()` in `frps_config.py` generates the `frps.toml`
that wires frps to this plugin:

```toml
bindPort = 7000
vhostHTTPPort = 8080
subdomainHost = "relay.example.com"

[[httpPlugins]]
name = "pulse-relay-auth"
addr = "127.0.0.1:9100"
path = "/handler"
ops = ["Login", "NewProxy"]
```

## Integration test (Task 5)

The integration test in `tests/test_integration.py` starts a real `frps`
process using the rendered config, spawns an `frpc` tunnel client, and asserts
that only correctly-credentialed connections are forwarded. Run it with:

```bash
uv run pytest tests/test_integration.py -v
```

`frps` and `frpc` must be on `PATH` for the test to run.
