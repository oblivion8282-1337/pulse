#!/usr/bin/env python3
"""Haelt den Sidecar am stdin-Pipe fest offen (EOF wuerde sofort stoppen)
und schickt einen HDR-start-Request. Laeuft bis es getoetet wird -- dabei
schliesst sich die Pipe von selbst, der Sidecar faengt das als EOF ab und
stoppt den Stream sauber (main.rs-Kommentar: "EOF on stdin -> Stream ZUERST
stoppen")."""
import json
import subprocess
import sys
import time

SIDECAR = sys.argv[1]
PUSH_URL = sys.argv[2]
LOGFILE = sys.argv[3]

p = subprocess.Popen(
    [SIDECAR], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT, text=True, bufsize=1,
)

req = {
    "op": "start",
    "id": 2,
    "channel": {"push_url": PUSH_URL},
    "overrides": {"hdr": True, "hdr_ausgang": "DP-2", "codec": "av1"},
    "show_cursor": True,
    "audio": {"mode": "Aus"},
}

with open(LOGFILE, "a", buffering=1) as log:
    log.write(f"--- driver pid={__import__('os').getpid()} sidecar pid={p.pid} ---\n")
    p.stdin.write(json.dumps(req) + "\n")
    p.stdin.flush()
    log.write(f">>> {json.dumps(req)}\n")
    while True:
        line = p.stdout.readline()
        if not line:
            log.write("--- sidecar stdout EOF, driver beendet ---\n")
            break
        log.write(line if line.endswith("\n") else line + "\n")
