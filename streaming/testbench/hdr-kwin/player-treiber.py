#!/usr/bin/env python3
"""Haelt pulse-player am stdin-Pipe offen und schickt ein 'open' mit der
WHEP-URL. Analoges Muster zum sidecar_driver.py."""
import json
import subprocess
import sys

PLAYER = sys.argv[1]
WHEP_URL = sys.argv[2]
LOGFILE = sys.argv[3]

p = subprocess.Popen(
    [PLAYER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT, text=True, bufsize=1,
)

req = {"op": "open", "id": 1, "url": WHEP_URL, "title": "HDR-Nachweis DP-2"}

with open(LOGFILE, "a", buffering=1) as log:
    log.write(f"--- driver pid={__import__('os').getpid()} player pid={p.pid} ---\n")
    p.stdin.write(json.dumps(req) + "\n")
    p.stdin.flush()
    log.write(f">>> {json.dumps(req)}\n")
    while True:
        line = p.stdout.readline()
        if not line:
            log.write("--- player stdout EOF, driver beendet ---\n")
            break
        log.write(line if line.endswith("\n") else line + "\n")
