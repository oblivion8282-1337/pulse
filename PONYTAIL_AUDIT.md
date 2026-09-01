# Ponytail-Audit-Tracker

> Welche Bereiche von Pulse wurden schon nach den Ponytail-Regeln (siehe `AGENTS.md`)
> durchgesehen, was ist noch offen? Ziel: nichts doppelt auditieren.
> Stand: 2026-09-01.
>
> **Ablauf pro Runde:** Bereich wählen → Audit (Funde mit Pfad:Zeile, Ersparnis,
> Sicherheit) → User wählt Funde → Umsetzung → Simplifier-Pass → Commit → hier abhaken.
> **Nicht doppelt prüfen:** einmal auditierte Dateien nur bei tiefen Eingriffen erneut
> ansehen; Querverweis-Funde (Muster in fremden Ordnern) stehen in der Notiz-Spalte.

## Erledigt

| Bereich | Umfang | Datum | Ergebnis / Notizen |
|---|---|---|---|
| Name-Fallback in Voice/Video-Kacheln (CameraTile, ScreenShareTile, VoiceParticipantTile, SpatialPositioner) | ~500 Zeilen | 2026-09-01 (Runde 1) | 4 Duplikate → `userCache.displayName(id, fallback?)` |
| `errText`-Util projektweit (Schwerpunkt admin/) | 89 Stellen, 53 Dateien | 2026-09-01 (Runde 1) | Inline-Ternaries ersetzt; ~54 abweichende Varianten bewusst liegen gelassen |
| Admin-Komponenten `web/src/lib/components/admin/` | ~5.400 Zeilen | 2026-09-01 (Runde 2) | StreamLimits zusammengezogen, Switch, confirmDialog, ReasonDialog (7×), fmtUser/fmtTime, AdminTabBar, tote errMsg-Wrapper. Querverweis: Reason-Dialog-Muster existiert auch in `settings/` |
| Typing-Indicator (Existenz-Check) | — | 2026-09-01 | Existierte bereits end-to-end — nichts gebaut (Leiter-Sprosse 2) |
| `web/src/lib/components/settings/` | ~10.100 Zeilen | 2026-09-01 (Runde 3) | Erstaunlich diszipliniert: 6 kleine Funde, 5 umgesetzt (formatTimestamp 4×, confirmDialog im RolesEditor, formatBytes, 2× form/Switch), Fund 6 bewusst ausgelassen. Querverweise: ReasonDialog hat HIER keine Verbraucher; RolleDetail-Tab-Leiste einziger Verbraucher, erst bei ui/-Hebung |

## Offen — Frontend

| Bereich | Umfang | Notizen |
|---|---|---|
| `web/src/lib/components/` (Kern: Chat, MessageList, Kanäle, DMs) | ~29.000 Zeilen Rest | Größtes Paket, in Teilpakete teilen (Chat/Messages zuerst — Pin-Code sitzt dort frisch) |
| `web/src/lib/stream/` | ~10.200 Zeilen | HQ-Streaming; viel berechtigte Komplexität (Hardware/Codecs) vermutet |
| `web/src/routes/` | ~6.100 Zeilen | Seiten-Hüllen; eher niedrige Ertragserwartung |
| `web/src/lib/remote/` | ~5.200 Zeilen | Fernsteuerung |
| `web/src/lib/ws/` | ~4.200 Zeilen | Gateway/Handler; Duplicate-Risiko bei den Dispatch-Patterns |
| `web/src/lib/voice/` | ~4.900 Zeilen | LiveKit-Anbindung |
| `web/src/lib/devices/` | ~3.600 Zeilen | Geräte/Sitzungen |
| `web/src/lib/components/dropbox/` + `web/src/lib/dropbox` | ~1.600+ Zeilen | Ablage-UI |
| `web/src/lib/permissions/` | ~1.400 Zeilen | Rechte-UI (frisch gebaut, vermutlich diszipliniert) |
| `web/src/lib/components/mobile/` | ~1.200 Zeilen | Mobil-Layouts |
| Rest (account, friends, channels, feedback, ui, form, …) | ~6.000 Zeilen | ui/ ist die Bibliothek selbst — Audit nur als Verbraucher, nicht die Primitives selbst |

## Offen — Backend / Infra

| Bereich | Umfang | Notizen |
|---|---|---|
| `services/chat-gateway/` routes | ~21.600 Zeilen | In Paketen angehen: `dropbox.py` + `_dropbox_helpers.py` (~1.350) zuerst — Verdacht auf Stdlib-Nachbau; dann `guilds.py` (884, größte Datei); `ws_*`-Paket (~4.500) |
| `services/auth/` | ~15.000 Zeilen | Nach chat-gateway |
| `shared/src/dcc_shared/` | ? | Events/Serialisierung — nach den Service-Audits (Registry-Muster jetzt durch pin_update bekannt) |
| `services/voice-signaling/`, `media-svc/`, `mediamtx-auth-hook/`, `relay-frps-plugin/` | ~4.800 Zeilen zusammen | Klein, am Schluss |
| `desktop/electron/`, `mobile/`, `streaming/` (Rust/Player) | ? | Plattform-Code; Ponytail gilt, aber Audit-Kriterien (native APIs!) etwas anders gewichten |

## Bewusst außen vor / noch nicht erfasst

| Bereich | Notizen |
|---|---|
| `web/tests/` (~5.700) | Tests: Ponytail gilt, aber Deduplizierung hat dort niedrigere Priorität als Klarheit je Testfall |
| `plugins/`, `scripts/`, `infra/`, `packaging/` | Betriebs-/Werkzeugcode, hinten |
| `krypto/` (~1.200) | Unversioniert (nicht im Git) — Klären, ob es ins Repo soll; bis dahin nicht anfassen |
| `streaming/`, `mobile/` exakte Größe | Zeilenzahlen aktuell durch node_modules/Vendor-Code aufgebläht; eigener Code erst bei Bedarf sauber messen |
| `node_modules/`, `build/`, `uploads/`, `secrets/`, `data/`, `dump.rdb` | Abhängigkeiten/Laufzeitdaten — niemals Audit-Gegenstand |

## Vorschlag nächste Runde

1. **`dropbox.py` + `_dropbox_helpers.py`** (Backend, ~1.350) — klein genug für eine Session, gutes Testnetz (1419 Tests), Verdacht auf Eigenbau statt Stdlib/SQLAlchemy.
2. **Chat-Kern `components/` Teilpaket Chat/Messages** — frisch durch die Pin-Runden berührt, danach der Rest in Teilpaketen.
