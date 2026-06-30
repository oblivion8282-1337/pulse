# Dropbox / Ablage – Handover

Stand: 2026-06-30, zwischen zwei Rechner-Wechseln.

## Was steht live auf netcup

- **Branch:** `main`, sauber, kein offenes WIP.
- **Commits (chronologisch):**
  1. `feat(dropbox): per-guild file storage channel` (`92ac09d3`) — Backend (Models, Routes, WS-Events), Frontend (DropboxView, ChannelList-Section, CreateChannelDialog 3. Option), Settings-Editor, i18n, Changelog-Eintrag.
  2. `test(dropbox): e2e skeleton` (`7ea0e900`) — Playwright-Smoke-Skelett (`web/tests/e2e/dropbox.spec.ts`).
  3. `debug(chat-gateway): log offending body on RequestValidationError` (PR #101) — globaler 422-Handler, loggt `errors=[]` + `raw_body=…` ins container-log, **bleibt drin**.
  4. `fix(dropbox): don't double-stringify request body` (PR #102) — `web/src/lib/api/dropbox.ts`. `request()` macht selber `JSON.stringify`, deshalb war `body: JSON.stringify(payload)` doppelt und FastAPI sah ein top-level-string statt dict. Konvention aus `chat.ts` (Objekt direkt durchreichen) übernommen.
- **Cloud-Bilder:** `ghcr.io/oblivion8282-1337/pulse-*` alle auf `latest`, letzte Rebuilds 12:01–14:01 UTC (`pulse-web` 14:01 UTC = enthält den Fix).
- **Cron-deploy auf netcup:** `infra/prod/pulse-update.sh`, alle 2 min. Letztes erfolgreiches Deploy 12:02:23 UTC (pull + recreate). Digest-Gate wirkt (kein unnötiger Recreate).

## Was der User auf netcup testete (vor dem Rechner-Wechsel)

- Ablage-Kanal anlegen: ✓ (3. Option „Ablage" im Create-Dialog, eigene Sektion zwischen Text/Sprache)
- Quota-Editor: ✓ (Server-Settings → Tab „Ablage")
- **Upload: 422-Fehler**, gefixt, **Browser-Cache muss noch hart neu geladen werden** (Strg+Shift+R), sonst sieht der User denselben 422 wie vor dem Fix.

## Was im Code noch offen / bewusst nicht drin

- **Window-level drag-and-drop** – nur Klick-Button-Upload. `webkitGetAsEntry()`-Pfad ist im Schema vorgesehen, braucht ~150 Z. Upload-Queue mit Pause/Cancel.
- **Inline-Preview** – Karten zeigen nur MIME-Type-Icon.
- **Bulk-Select** mit Multi-Aktionen (Delete/Download ZIP).
- **Public-Share-Link** mit zeitlicher Begrenzung – Cert-Modell-Datenschutz-Konflikt, für Phase 4-6 vorgemerkt.
- **Self-Host-deploytest** wurde übersprungen, weil lokales Docker am CachyOS-Kernel nicht startet (`bridge`-Modul + `overlay`-Support fehlen auf btrfs).

## Wie der neue Rechner die Arbeit aufnimmt

```bash
cd ~/Dokumente/pulse    # oder wo auch immer das Repo liegt
git checkout main
git pull --ff-only
# Branch-Info, falls noch lokal weitergewerkelt wurde:
git fetch origin
# Logs der letzten Commits:
git log --oneline -8
```

Dropbox-Tab sollte nach Hot-Reload des Browsers (Cmd+Shift+R / Strg+Shift+R) verfügbar sein — eine alte Service-Worker- oder Bundle-Cache-Schicht muss zerschlagen werden.

## Wo Bugs in Zukunft sichtbar werden

Wenn ein 422 auftritt: `ssh michael@159.195.150.54 "docker logs --since 5m pulse_chat_gateway | grep request_validation_error"` — gibt `errors=` (Pydantic-Detail) + `raw_body=` (das, was der Client tatsächlich geschickt hat) auf eine Zeile. Bleibt auf prod, hilft auch über dieses Feature hinaus.

## Memory-Hinweise (für `~/.claude/projects/.../memory/` auf dem nächsten Rechner)

Da Memory **per Maschine** ist, lebt das hier nur als Dokument und der Anwender (auf dem neuen Rechner) kann daraus seine eigene Memory ableiten. Substanzielle neue Erkenntnisse (die nicht schon im Code stehen) gab es in dieser Session bewusst wenige – die ganze Dropbox-Arbeit war „Code-Commit + Tests", keine neuen langlebigen Tatsachen.
