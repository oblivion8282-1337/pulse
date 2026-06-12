#!/usr/bin/env python3
"""Scan all first-party source files and report the ones over the size cap.

Implements the CLAUDE.md / PLAN.md §12.1 size policy:
  - Python / TypeScript source: soft cap 350 lines
  - Svelte components:          soft cap 250 lines
  - Exempt: tests, Alembic migrations, conftest, the shadcn `ui/` vendor dir,
    and the generated paraglide output.

Writes two JSON files under `.cache/` (git-ignored):
  - source-inventory.json : every scanned file, largest first
  - over-cap.json         : only the files exceeding their cap (the input the
                            `simplify-scan` workflow consumes as `args`)

Usage:
    python3 scripts/source-size-scan.py            # write + print summary
    python3 scripts/source-size-scan.py --print    # also dump the over-cap list
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

PY_CAP = 350
TS_CAP = 350
SVELTE_CAP = 250


def _find(args: list[str]) -> list[str]:
    return subprocess.run(["find", *args], capture_output=True, text=True).stdout.split()


def collect() -> list[dict]:
    paths: list[tuple[str, str, int]] = []
    for p in _find(
        ["services", "shared", "-name", "*.py",
         "-not", "-path", "*/tests/*",
         "-not", "-path", "*/alembic/*",
         "-not", "-name", "conftest.py"]
    ):
        paths.append((p, "py", PY_CAP))
    for p in _find(["web/src", "-type", "f", "-name", "*.ts"]):
        if "/lib/components/ui/" in p or "/paraglide/" in p:
            continue
        paths.append((p, "ts", TS_CAP))
    for p in _find(["web/src", "-type", "f", "-name", "*.svelte"]):
        if "/lib/components/ui/" in p:
            continue
        paths.append((p, "svelte", SVELTE_CAP))

    inv: list[dict] = []
    for path, kind, cap in paths:
        try:
            with open(path, encoding="utf-8", errors="ignore") as fh:
                n = sum(1 for _ in fh)
        except OSError:
            continue
        inv.append({"path": path, "lines": n, "kind": kind, "cap": cap, "over": n > cap})
    inv.sort(key=lambda x: -x["lines"])
    return inv


def main() -> None:
    inv = collect()
    over = [
        {"path": x["path"], "lines": x["lines"], "kind": x["kind"], "cap": x["cap"]}
        for x in inv
        if x["over"]
    ]
    os.makedirs(".cache", exist_ok=True)
    with open(".cache/source-inventory.json", "w") as fh:
        json.dump(inv, fh, indent=0)
    with open(".cache/over-cap.json", "w") as fh:
        json.dump(over, fh, indent=0)

    print(f"total source files: {len(inv)}")
    print(f"over cap:           {len(over)}  (py>{PY_CAP}, ts>{TS_CAP}, svelte>{SVELTE_CAP})")
    print("wrote .cache/source-inventory.json + .cache/over-cap.json")
    if "--print" in sys.argv:
        print("\n--- over-cap, largest first ---")
        for x in over:
            print(f'{x["lines"]:>5}  {x["kind"]:<7} {x["path"]}')


if __name__ == "__main__":
    main()
