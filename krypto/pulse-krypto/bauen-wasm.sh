#!/usr/bin/env bash
# Baut die WASM-Ausgabe fuer den Web-Klienten.
# wasm-pack liegt unter ~/.cargo/bin, das nicht in jedem PATH steht.
set -euo pipefail
cd "$(dirname "$0")"
PATH="$HOME/.cargo/bin:$PATH"
wasm-pack build --target web --out-dir pkg
