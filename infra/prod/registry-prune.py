#!/usr/bin/env python3
"""Alte Image-Tags samt ihrer Kind-Manifeste aus der Self-Host-Registry raeumen.

**Warum es dieses Skript gibt.** Der GC-Cron darf `--delete-untagged` NICHT
benutzen: bei Multi-Arch-Images haengen die Pro-Architektur-Manifeste nur am
Index und tragen selbst keinen Tag, `registry:2.8.3` haelt sie damit fuer Muell
und loescht sie — am 2026-07-26 hat das alle 91 Tags zerstoert (s. DEPLOY.md).
Ohne den Schalter raeumt die GC aber auch nichts mehr auf, weil jede ueber-
schriebene Revision ihre Blobs weiter festhaelt. Dieses Skript schliesst die
Luecke: es loescht gezielt, was wirklich weg soll, und die GC holt danach die
Blobs.

**Einen Tag zu loeschen genuegt nicht.** Die Revision bleibt sonst liegen und
haelt ihre Blobs; der Platz kommt erst zurueck, wenn Index UND Kinder weg sind.

**Die Schutzliste ist der Kern.** Mehrere Tags koennen auf denselben Index
zeigen (`:edge` und `:stable` tun das regelmaessig), und Kind-Manifeste werden
zwischen Builds geteilt. Deshalb wird ZUERST alles eingesammelt, was ein
behaltener Tag braucht, und nur geloescht, was darin nicht vorkommt. Ohne diesen
Schritt loescht man sich die aktuellen Images weg — derselbe Fehler wie der,
den es zu beheben gilt, nur von Hand.

Laeuft direkt auf dem Speicher, nicht ueber die HTTP-API: die GC stoppt die
Registry ohnehin, und so braucht es keine Token-Berechtigungen.

    # Trockenlauf (aendert nichts):
    docker run --rm -v pulse_pulse_registry:/var/lib/registry \\
      -v ~/pulse/infra/prod/registry-prune.py:/prune.py:ro \\
      python:3-alpine python /prune.py

    # Wirklich loeschen, danach GC:
    …  python /prune.py --apply --behalte-sha 5
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

WURZEL = Path("/var/lib/registry/docker/registry/v2")
IMMER_BEHALTEN = {"edge", "stable"}


def repo_pfad(repo: str) -> Path:
    return WURZEL / "repositories" / repo


def blob_pfad(digest: str) -> Path:
    h = digest.removeprefix("sha256:")
    return WURZEL / "blobs" / "sha256" / h[:2] / h / "data"


def tag_digest(repo: str, tag: str) -> str | None:
    link = repo_pfad(repo) / "_manifests" / "tags" / tag / "current" / "link"
    return link.read_text().strip() if link.exists() else None


def kinder(digest: str) -> list[str]:
    """Kind-Manifeste eines Index; leer, wenn es ein Einzel-Manifest ist."""
    p = blob_pfad(digest)
    if not p.exists():
        return []
    try:
        doc = json.loads(p.read_text())
    except (ValueError, OSError):
        return []
    return [m["digest"] for m in doc.get("manifests", []) if "digest" in m]


def familie(repo: str, tag: str) -> set[str]:
    """Index + Kinder eines Tags."""
    d = tag_digest(repo, tag)
    if not d:
        return set()
    return {d, *kinder(d)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="pulse-allinone")
    ap.add_argument("--behalte-sha", type=int, default=5,
                    help="wie viele der neuesten sha-*-Tags bleiben")
    ap.add_argument("--apply", action="store_true", help="wirklich loeschen")
    args = ap.parse_args()

    tags_dir = repo_pfad(args.repo) / "_manifests" / "tags"
    if not tags_dir.is_dir():
        raise SystemExit(f"kein Repository {args.repo} unter {WURZEL}")

    alle = sorted(p.name for p in tags_dir.iterdir() if p.is_dir())
    sha_tags = [t for t in alle if t.startswith("sha-")]
    # Neueste zuerst — ueber die Aenderungszeit des Tag-Zeigers, nicht ueber den
    # Namen: der Kurz-SHA sagt nichts ueber das Alter.
    sha_tags.sort(key=lambda t: (tags_dir / t / "current" / "link").stat().st_mtime,
                  reverse=True)

    behalten = (IMMER_BEHALTEN & set(alle)) | set(sha_tags[:args.behalte_sha])
    loeschen = [t for t in alle if t not in behalten]

    geschuetzt: set[str] = set()
    for t in behalten:
        geschuetzt |= familie(args.repo, t)

    doomed: set[str] = set()
    for t in loeschen:
        doomed |= familie(args.repo, t) - geschuetzt

    rev = repo_pfad(args.repo) / "_manifests" / "revisions" / "sha256"
    # Zwischen "referenziert" und "liegt wirklich da" unterscheiden: nach dem
    # GC-Unfall vom 2026-07-26 zeigen viele Indexe auf Kinder, die es nicht mehr
    # gibt. Eine Zahl, die beides vermischt, laesst den Aufraeumgewinn groesser
    # aussehen als er ist.
    def da(digests: set[str]) -> int:
        return sum(1 for d in digests if (rev / d.removeprefix("sha256:")).is_dir())

    print(f"Repository {args.repo}: {len(alle)} Tags")
    print(f"  behalten:   {len(behalten)} ({', '.join(sorted(behalten))})")
    print(f"  loeschen:   {len(loeschen)} Tags")
    print(f"  Manifeste:  {da(doomed)} vorhanden von {len(doomed)} referenzierten")
    print(f"  geschuetzt: {da(geschuetzt)} vorhanden von {len(geschuetzt)} referenzierten")
    if not args.apply:
        print("\nTrockenlauf — nichts geaendert. Mit --apply wirklich loeschen.")
        return 0

    for t in loeschen:
        shutil.rmtree(tags_dir / t, ignore_errors=True)
    weg = 0
    for d in doomed:
        p = rev / d.removeprefix("sha256:")
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
            weg += 1
    print(f"\n{len(loeschen)} Tags und {weg} Manifeste entfernt.")
    print("Jetzt `garbage-collect` (OHNE --delete-untagged) laufen lassen, "
          "damit die Blobs freigegeben werden.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
