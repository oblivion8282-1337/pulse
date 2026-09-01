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
| Name-Fallback in Voice/Video-Kacheln | ~500 Zeilen | Runde 1 | 4 Duplikate → `userCache.displayName(id, fallback?)` |
| `errText`-Util projektweit | 89 Stellen, 53 Dateien | Runde 1 | Inline-Ternaries ersetzt; ~54 abweichende Varianten bewusst liegen gelassen |
| Admin-Komponenten `components/admin/` | ~5.400 Zeilen | Runde 2 | StreamLimits-Zusammenzug, Switch, confirmDialog, ReasonDialog (7×), fmtUser/fmtTime, AdminTabBar |
| Typing-Indicator (Existenz-Check) | — | Runde 3 | Existierte bereits end-to-end — nichts gebaut (Sprosse 2) |
| `components/settings/` | ~10.100 Zeilen | Runde 3 | 6 Funde, 5 umgesetzt (formatTimestamp 4×, confirmDialog, formatBytes, 2× form/Switch); Fund 6 bewusst ausgelassen. ReasonDialog hat hier keine Verbraucher |
| Devices `lib/devices/` | ~3.600 Zeilen | Runde 4 | Toter State, errText-Nachbau, restText/Arrays/klemmeMenge geteilt, FieldError 3× |
| Permissions `lib/permissions/` | ~1.400 Zeilen | Runde 4 | isSorted-Fast-Path (falsche Begründung) gelöscht, vergleichRollen/teileSchlüssel/besitzerId geteilt, confirmDialog |
| chat-gateway: guilds.py | 884 Zeilen | Runde 4 | _guild_or_404 (9×), _publish_guild_event geteilt, patch_guild per exclude_unset |
| chat-gateway: ws_*-Paket | ~2.000 Zeilen | Runde 4 | parse_snowflake_int/ws_manager/ws_err geteilt, Rollen-Snapshot + Position-Prüfung. OFFEN: 5× Zugangs-Präambel (riskant) |
| `_guild_or_404`-Reststellen | 14 Stellen | Runde 5 | Helfer nach _deps.py, alle 14 umgestellt |
| `services/auth/` | ~15.000 Zeilen | Runde 5 | Cookie-Validierung 3×→1× (1 Kopie tot), TokenPair tot, COOKIE_NAME exportiert |
| `lib/remote/` | ~5.200 Zeilen | Runde 5 | Tote Exporte/Verzweigung, AUFFRISCH_MS, 2 testlose Module zurückinline. Offen: Inline-Deutsch-Kommentare klären |
| `lib/voice/` + `lib/ws/` | ~9.100 Zeilen | Runde 5 | meter.ts (3 Kopien), guildTeardown + Sound-Bugfix, applySinkId 2×, formatBitrate, toter Code |
| Chat-Kern (ChatView/MessageList/Item/messages-Store) | ~12–15k Zeilen | Runde 6 | fmtBytes 2×, removeOptimistic, MessageReactions-Nachbauten, Emoji-Content 4×, avatarFallbackStyle 4×, snippet-Merge, toter children-Prop, DMChannelList |
| `lib/stream/` | ~10.200 Zeilen | Runde 6 | anchorRegistry (3×), PopupDetacher-Basis (nach Deploy Popup-Probefahrt!), meldeSendeFehler, uhrzeitHHMM, stopSlot. Kein toter Code |
| Kleinreste (routes/ + friends/account/channels/server) | ~12.000 Zeilen | Runde 6 | errText-Nachzügler 14×, toter showVoiceStack, {#if true}, erstelleCommunity, PopupShell, railNavi, SuchPille 3×, PresenceBadge 5×, AuthCard 6×, InlineResetPanel, formatLangDatum 3× |

## Offen — Frontend

| Bereich | Umfang | Notizen |
|---|---|---|
| `web/src/lib/components/` (Kern: Chat, MessageList, Kanäle, DMs) | ~29.000 Zeilen Rest | Größtes Paket, in Teilpakete teilen (Chat/Messages zuerst — Pin-Code sitzt dort frisch) |
| `web/src/lib/components/dropbox/` + `web/src/lib/dropbox` | ~1.600+ Zeilen | Ablage-UI |
| `web/src/lib/components/mobile/` | ~1.200 Zeilen | Mobil-Layouts |
| Rest (account, friends, channels, feedback, ui, form, …) | ~6.000 Zeilen | ui/ ist die Bibliothek selbst — Audit nur als Verbraucher, nicht die Primitives selbst |

## Offen — Backend / Infra

| Bereich | Umfang | Notizen |
|---|---|---|
| `services/chat-gateway/` routes | ~21.600 Zeilen | `dropbox.py` + `_dropbox_helpers.py` PAUSIERT (aktive Entwicklung). guilds.py, ws_*-Paket und `_guild_or_404` vollständig erledigt (Runden 4–5); offen: restliche Routen-Dateien, WS-Zugangs-Präambel (riskant, nur mit Testlauf) |
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

1. **WS-Zugangs-Präambel** (5×, chat-gateway) — riskant markiert, eigene Session mit vollem Testlauf.
2. **Message-Handler-Fabrik** (Runde-6-Fund, ~70 Zeilen) — beim dritten Konsumenten.
3. **Rest**: mobile/ (1.2k), shared/ Backend-Feinsicht, Desktop/Electron + Rust-Sidecars (Plattform-Regeln).
4. **dev/design-Route** (658 Z.) löschen, sobald die Button-Migration abgeschlossen ist.
PAUSIERT: `dropbox.py`/`_dropbox_helpers.py` + `components/dropbox/` — aktive Entwicklung, erst nach Merge.
