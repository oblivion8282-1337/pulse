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
| Chat-Kern (ChatView/MessageList/MessageItem/messages-Store u. a.) | ~12–15k Zeilen | 2026-09-01 (Runde 6) | fmtBytes (2×), removeOptimistic (toter Pin-Zweig), MessageReactions-Nachbauten, Emoji-Content 4×, avatarFallbackStyle 4×, snippet-Merge, toter children-Prop, DMChannelList-Config. Offen: snippet/authorName Cross-File-Dedup (kommentierte Entscheidung — Begründung bei nächstem Anfassen prüfen) |
| `web/src/lib/stream/` | ~10.200 Zeilen | 2026-09-01 (Runde 6) | anchorRegistry (3× byte-identisch), PopupDetacher-Basis (detach + watchPartyDetach — manuelle Popup-Probefahrt empfohlen nach Deploy!), meldeSendeFehler, uhrzeitHHMM, stopSlot-Rückgabe. Gesamturteil: außergewöhnlich diszipliniert, kein toter Code |
| Kleinreste (routes/ + friends/account/channels/server + Einzeldateien) | ~12.000 Zeilen | 2026-09-01 (Runde 6) | errText-Nachzügler (popoverActions 14× — Codemod-Lücke), toter showVoiceStack, {#if true}, erstelleCommunity, PopupShell, railNavi, SuchPille 3×, PresenceBadge 5×, AuthCard 6 Seiten, InlineResetPanel, formatLangDatum 3×. OFFEN: Message-Handler-Fabrik (~70 Zeilen, Guild-Kanal ↔ DM 80% wortgleich — erst beim dritten Konsumenten); dev/design-Route (658 Z.) löschen, wenn Button-Migration fertig |
| `_guild_or_404`-Reststellen (8 Routen-Dateien) | 14 Stellen | 2026-09-01 (Runde 5) | Helfer nach `_deps.py` verschoben (guilds.py-Import-Zirkel vermieden), alle 14 umgestellt; abweichende Semantiken (owner/member_invites u. a.) dokumentiert ausgeschlossen |
| `services/auth/` | ~15.000 Zeilen | 2026-09-01 (Runde 5) | Dreifache Cookie-Session-Validierung → eine Kernfunktion (eine Kopie war tot), TokenPair tot, COOKIE_NAME exportiert. Offen: Gate-Helper-Platzierung (nur bei Gelegenheit). Gesamturteil: über dem Schnitt |
| `web/src/lib/remote/` | ~5.200 Zeilen | 2026-09-01 (Runde 5) | Tote Exporte/Verzweigung, AUFFRISCH_MS geteilt, 2 testlose Ein-Zeilen-Module zurückinline. Inline-Deutsch in fehlertexte/vorrang ohne Entscheidungskommentar — Klären |
| `web/src/lib/voice/` + `web/src/lib/ws/` | ~9.100 Zeilen | 2026-09-01 (Runde 5) | meter.ts (3 identische Kopien), guildTeardown (inkl. Bugfix: kicked-Pfad räumte Sounds nicht), applySinkId 2×, Settings-Paket 1×, formatBitrate, toter Code. Offen: voiceDiff/streamDiff-Zusammenzug (grenzwertig) |
| Devices `web/src/lib/devices/` | ~3.600 Zeilen | 2026-09-01 (Runde 4) | Toter laden_-State, errText-Nachbau, restText/Arrays/klemmeMenge dedupliziert (devices ↔ SettingsStandplatz), FieldError 3×, — überwiegend geernte Querverweise |
| Permissions `web/src/lib/permissions/` | ~1.400 Zeilen | 2026-09-01 (Runde 4) | isSorted-Fast-Path mit falscher Begründung gelöscht, vergleichRollen/teileSchlüssel/besitzerId dedupliziert, confirmDialog statt AlertDialog. Sauberes Grüner-Haken-Paket |
| `services/chat-gateway/` routes: guilds.py | 884 Zeilen | 2026-09-01 (Runde 4) | _guild_or_404 (9× hier; 23× projektweit — REST offen!), _publish_guild_event dedupliziert, patch_guild per exclude_unset |
| `services/chat-gateway/` routes: ws_*-Paket | ~2.000 Zeilen | 2026-09-01 (Runde 4) | parse_snowflake_int/ws_manager/ws_err dedupliziert (6/4/3 Kopien, eine tot), Rollen-Snapshot + Position-Prüfung. OFFEN: 5× Kanal-Zugangs-Präambel — riskant, nur mit Testlauf |
| Typing-Indicator (Existenz-Check) | — | 2026-09-01 | Existierte bereits end-to-end — nichts gebaut (Leiter-Sprosse 2) |
| Chat-Kern (ChatView/MessageList/MessageItem/messages-Store u. a.) | ~12–15k Zeilen | 2026-09-01 (Runde 6) | fmtBytes (2×), removeOptimistic (toter Pin-Zweig), MessageReactions-Nachbauten, Emoji-Content 4×, avatarFallbackStyle 4×, snippet-Merge, toter children-Prop, DMChannelList-Config. Offen: snippet/authorName Cross-File-Dedup (kommentierte Entscheidung — Begründung bei nächstem Anfassen prüfen) |
| `web/src/lib/stream/` | ~10.200 Zeilen | 2026-09-01 (Runde 6) | anchorRegistry (3× byte-identisch), PopupDetacher-Basis (detach + watchPartyDetach — manuelle Popup-Probefahrt empfohlen nach Deploy!), meldeSendeFehler, uhrzeitHHMM, stopSlot-Rückgabe. Gesamturteil: außergewöhnlich diszipliniert, kein toter Code |
| Kleinreste (routes/ + friends/account/channels/server + Einzeldateien) | ~12.000 Zeilen | 2026-09-01 (Runde 6) | errText-Nachzügler (popoverActions 14× — Codemod-Lücke), toter showVoiceStack, {#if true}, erstelleCommunity, PopupShell, railNavi, SuchPille 3×, PresenceBadge 5×, AuthCard 6 Seiten, InlineResetPanel, formatLangDatum 3×. OFFEN: Message-Handler-Fabrik (~70 Zeilen, Guild-Kanal ↔ DM 80% wortgleich — erst beim dritten Konsumenten); dev/design-Route (658 Z.) löschen, wenn Button-Migration fertig |
| `_guild_or_404`-Reststellen (8 Routen-Dateien) | 14 Stellen | 2026-09-01 (Runde 5) | Helfer nach `_deps.py` verschoben (guilds.py-Import-Zirkel vermieden), alle 14 umgestellt; abweichende Semantiken (owner/member_invites u. a.) dokumentiert ausgeschlossen |
| `services/auth/` | ~15.000 Zeilen | 2026-09-01 (Runde 5) | Dreifache Cookie-Session-Validierung → eine Kernfunktion (eine Kopie war tot), TokenPair tot, COOKIE_NAME exportiert. Offen: Gate-Helper-Platzierung (nur bei Gelegenheit). Gesamturteil: über dem Schnitt |
| `web/src/lib/remote/` | ~5.200 Zeilen | 2026-09-01 (Runde 5) | Tote Exporte/Verzweigung, AUFFRISCH_MS geteilt, 2 testlose Ein-Zeilen-Module zurückinline. Inline-Deutsch in fehlertexte/vorrang ohne Entscheidungskommentar — Klären |
| `web/src/lib/voice/` + `web/src/lib/ws/` | ~9.100 Zeilen | 2026-09-01 (Runde 5) | meter.ts (3 identische Kopien), guildTeardown (inkl. Bugfix: kicked-Pfad räumte Sounds nicht), applySinkId 2×, Settings-Paket 1×, formatBitrate, toter Code. Offen: voiceDiff/streamDiff-Zusammenzug (grenzwertig) | Erstaunlich diszipliniert: 6 kleine Funde, 5 umgesetzt (formatTimestamp 4×, confirmDialog im RolesEditor, formatBytes, 2× form/Switch), Fund 6 bewusst ausgelassen. Querverweise: ReasonDialog hat HIER keine Verbraucher; RolleDetail-Tab-Leiste einziger Verbraucher, erst bei ui/-Hebung |

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
| `services/chat-gateway/` routes | ~21.600 Zeilen | VOLLSTÄNDIG durchgesehen (Runden 4–8, inkl. dropbox). OFFEN bleibt nur: WS-Zugangs-Präambel (5×, riskant — bewusst zurückgestellt) |
| `services/auth/` | ~15.000 Zeilen | ERLEDIGT (Runde 5). Offen: Gate-Helper-Platzierung (nur bei Gelegenheit) |
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
3. **Rest**: components/dropbox UI (nach Merge der aktiven Arbeit), mobile/ (1.2k), Desktop/Electron + Rust-Sidecars (Plattform-Regeln).
4. **dev/design-Route** (658 Z.) löschen, sobald die Button-Migration abgeschlossen ist.
