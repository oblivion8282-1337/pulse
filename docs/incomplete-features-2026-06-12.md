# Pulse — Halb-fertige Features: Priorisierter Befund-Report

Stand: 2026-06-12 (gekürzt 2026-06-25: 6 erledigte Befunde entfernt) | Bestätigt: 68 | False Positives: 3

---

## Gruppe 1: Setzbar aber wirkungslos

Features, die der User konfigurieren kann, ohne dass die Einstellung irgendeinen Effekt hat.

---

**cam_resolution_max / cam_fps_max — rein client-seitig, kein Server-Enforcement**
Admin setzt die Limits; sie landen über Capabilities-API als `getUserMedia`-Hint — ein modifizierter Client ignoriert sie. `voice-signaling/token.py` setzt keine Video-Grants mit Auflösungsschranke.
`routes/admin.py` / `capabilities.py:52` → `livekit.svelte.ts:680` (client-only)
Aufwand: mittel (Token-seitige Grant-Parameter + voice-signaling/capabilities-Kopplung)

---

**dm_policy wird gespeichert, aber bei DM-Erstellung nicht enforced**
User stellt NOBODY/FRIENDS_ONLY ein; `POST /dm-channels` in `dms.py` prüft nur Blockierung, nie `dm_policy` des Ziel-Users.
`privacy.py:144` → nirgends (kein Leser in dms.py)
Aufwand: klein (ein Guard in dms.py)

---

**ScreenShare-ContentHint hat im HQ-GSR-Pfad keine Wirkung**
Einstellung in SettingsScreenShare, angewendet im LiveKit-WebRTC-Pfad — `gsr.ts`, `sidecar.ts` und `control.py` lesen `contentHint` nicht; `GsrStartArgs` hat kein entsprechendes Feld.
`settings.svelte.ts:269` → `livekit.svelte.ts:619/625` (nur LiveKit-Pfad)
Aufwand: klein (Feld in GsrStartArgs + Mapping in buildStartArgs + sidecar-Handling)

---

**Auto-Connect: startMuted=false hardcoded — kein User-Toggle**
`autoconnect.svelte.ts:113` sendet immer `{ startMuted: false }`; kein Settings-Key, kein UI-Toggle. Hot-Mic-Risiko beim App-Start nicht abstellbar.
`autoconnect.svelte.ts:113` → `livekit.svelte.ts:386` (konsumiert, aber unkonfigurierbar)
Aufwand: klein (Settings-Key + Toggle in SettingsAudioVideo)

---

**acr_values='mfa' Cert-Issuance Step-Up: Parameter nie übergeben**
Backend-Gate in `routes_credentials.py:154` gibt 403 bei fehlendem MFA — aber alle drei Frontend-Aufrufer (`cert-rotation.svelte.ts:53`, `issue-flow.ts:173+218`) übergeben nur zwei Argumente. Step-Up für echte Nutzer dauerhaft tot.
`credentials.ts:90` → nirgends (nur in Tests ausgelöst)
Aufwand: klein (dritter Parameter an kritischen Issue-Stellen + MFA-Redirect)

---

**Roles/Overwrite-Permissions — Channel-level Gates stale nach role_updated**
`role_updated`-Event updated `_snapshotsCache` (plain Map, kein `$state`); `channelPermissions.resolveForUser()` greift nicht-reaktiv darauf zu → `$derived`-Blöcke in `HqStreamButton`, `VoiceControlBar`, `ScreenShareModeButton` werden nicht neu ausgewertet.
`roles.py:180` → `guild.ts:51` → `channelPermissions.svelte.ts:84` (non-reaktiv)
Aufwand: klein (Signal/$state in roles-Store oder explizites Invalidieren)

---

**Settings-Registry Server-Sync — Infrastruktur komplett, kein SectionConfig nutzt sie**
`writesServer()` gibt für alle 8 Sections `false` zurück; `schedulePushSection()` wird nie aufgerufen; `GET /preferences` nie ausgeführt. Cross-Device-Sync ist funktionslos.
`settings.svelte.ts:141` (alle Sections ohne `persistence`-Feld) → nirgends
Aufwand: klein (persistence:'server' in mindestens einer SectionConfig setzen)

---

**Channel-Topic in patchChannel — setzbar per API, kein UI-Pfad**
Backend persistiert, `ChatView.svelte` rendert — aber `RenameChannelDialog.svelte` kennt kein Topic-Input, `patchChannel` wird nirgends mit `topic` aufgerufen.
`channels.py:238` / `chat.ts:196` → `ChatView.svelte:366` (nur Anzeige)
Aufwand: klein (Topic-Feld im RenameChannelDialog)

---

**Avatar-Upload fehlt im Profil-Tab (SettingsProfile)**
`AvatarUploadDialog` + `POST /me/avatar` vollständig implementiert — einziger Einstieg ist das UserFooter-Dropdown. `SettingsProfile.svelte` hat kein Upload-Element.
`UserFooter.svelte:109` → nirgends in SettingsProfile
Aufwand: klein (AvatarUploadDialog in SettingsProfile einbinden)

---

**WatchChatPanel: Message-Reactions fehlen**
Emoji-Picker im Composer ist vollständig verdrahtet. Reactions fehlen: kein `MessageReactions`-Component, kein reactions-Feld in `WatchChatMessage`, kein Backend-Endpoint in `watch_chat.py`.
`WatchChatPanel.svelte:125` (plain li-Rendering) → nirgends
Aufwand: mittel (Backend-Endpoint + WS-Events + Frontend-Integration)

---

**Watcher-Zählbadge angekündigt, aber nicht gerendert**
`watchersIn(channelId)` korrekt befüllt; Store-Kommentar nennt explizit `"a 'X watching' count"` als Verwendungszweck — wird nirgends angezeigt.
`watchWatchers.svelte.ts:14` → `WatchPartyTile.svelte:175` (nur Handoff-Filter)
Aufwand: klein (Badge-Render im Tile-Header)

---

**HLS (.m3u8) im Dialog versprochen, aber vom Source-Parser abgelehnt**
`en.json:2102+2109` listen `.m3u8` als gültig auf; `NATIVE_SUFFIX` deckt nur `mp4|webm`; Ablehnung ist mit Test `test_parse_rejects_hls_m3u8()` fixiert. UI/Implementierungs-Diskrepanz.
`en.json:2102` → `source.ts:16` (abgelehnt)
Aufwand: klein (entweder i18n-String korrigieren oder hls.js + MSE-Pfad bauen — Letzteres ist groß)

---

**start_seconds aus YouTube-URL — für Twitch-VOD ignoriert**
`?t=`-Parameter in Twitch-VOD-URLs wird weder im Backend noch im Frontend geparst; `WatchSourceTwitch` hat kein `start_seconds`-Feld; TwitchPlayer übergibt keinen `time:`-Parameter.
`watch_source.py:122` (nur YouTube) → `ws_watch.py:117` (position=0 für Twitch)
Aufwand: klein (start_seconds für Twitch parsen + TwitchPlayer time-Parameter)

---

**Öffentliche Community-Adresse — SvelteKit-Route /c/[handle] fehlt**
Backend vollständig (`public_community.py`, Migration 0034); Frontend-API-Funktionen vorhanden — aber `web/src/routes/c/[handle]/+page.svelte` existiert nicht. Direkter Browser-Aufruf landet auf SPA-Root.
`public_community.py:95` → nirgends (kein SvelteKit-Route-File)
Aufwand: mittel (Route + Vorschau-Seite + Login-Redirect-Mechanismus)

---

**Guild attachment_max_size_bytes / attachment_max_count_per_message — kein Editor**
Enforcement in `attachments.py:104` korrekt; kein PATCH-Parameter, kein Admin-Handler (nur dm_*), kein Frontend-Editor. Wert steckt dauerhaft auf server_default.
`models/guilds.py:35` → `attachments.py:104` (nur Enforcement, nicht setzbar)
Aufwand: klein (PATCH-Feld in GuildPatchIn + Admin-UI-Element)

---

**WHEP-Viewer: Membership-Check auf MediaMTX-Ebene fehlt**
Chat-Gateway prüft Membership beim URL-Abruf; `mediamtx-auth-hook/routes.py:221` gibt bei read/playback bedingungslos 200 zurück. Wer die WHEP-URL kennt, kann den Stream ohne Mitgliedschaft abrufen.
`streaming.py:158` (URL-Gate) → `routes.py:221` (Stream-Gate fehlt)
Aufwand: mittel (Token-im-URL-Schema oder signierter WHEP-Redirect + auth-hook-Prüfung)

---

**ModQueue 'triaged'-Status: definiert aber nie setzbar**
`GET ?status=triaged` möglich, gibt aber immer leere Liste zurück — kein Endpoint setzt diesen Status. Kein Tab, kein Button im Frontend.
`moderation.ts:16` / `mod_queue.py:131` → nirgends schreibbar
Aufwand: klein (PATCH-Endpoint + Tab + Button)

---

**target_channel_id in ReportInput — kein UI-Pfad setzt den Wert**
Backend vollständig verdrahtet (DB, Validation, Mod-Queue-Scoping); `ReportMessageDialog` übergibt nur `target_message_id`. Kein "Channel melden"-Einstieg.
`moderation.ts:43` → nirgends (kein UI-Aufrufer mit channel_id)
Aufwand: klein (optionaler Einstieg im Channel-Kontextmenü)

---

**Embed-Karte für reine User-Meldungen (ohne Nachricht) nicht erreichbar**
Backend akzeptiert `target_user_id` ohne `target_message_id`; `ReportMessageDialog` hat non-optionales `messageId`-Prop. Kein "User melden"-Button im Profil-Popover.
`reports.py:45` → nirgends (kein User-only-Aufrufer)
Aufwand: klein ("User melden"-Button + optionales messageId-Prop oder separater Dialog)

---

## Gruppe 2: Tote und unbenutzte Teile

Implementierter Code ohne Consumer — wird nie aufgerufen.

---

**Mention-Candidates-Endpoint ohne Frontend-Consumer**
`GET /guilds/{id}/mention-candidates` vollständig implementiert, korrekt registriert — `MentionAutocomplete.svelte` lädt immer die komplette Mitgliederliste und filtert lokal.
`mention_search.py:35` → nirgends (nur Backend-Tests)
Aufwand: klein (Frontend-API-Funktion + Swap in MentionAutocomplete)

---

**isHdrCodec — exportiert, nirgends konsumiert**
Hilfsfunktion für einen HDR-Codec-Modus; `CODEC_VALUES` bietet nur h264/av1 an. Kein UI-Gating, kein buildStartArgs-Aufruf, `@noble/curves` nicht installiert.
`settings.svelte.ts:115` → nirgends
Aufwand: keine (toter Code; entweder entfernen oder HDR-Codec-Modus bauen — Letzteres groß)

---

**available_profiles: gefetcht, aber kein UI-Consumer**
`loadCatalogs()` befüllt `available_profiles`; direkt danach wird `profile_name='Custom'` und `use_overrides=true` hardgesetzt — das Profil-Konzept wird vollständig umgangen.
`settings.svelte.ts:299` → nirgends
Aufwand: keine (Feld entfernen oder Profil-Picker bauen)

---

**mediamtx_srt_port — konfigurierbar, Consumer durch Protokoll-Pattern blockiert**
Einziger Lesepfad in `_push_url()` ist durch `pattern=^rtmp$` unerreichbar; auch chat-gateway-Pattern `^(rtmp|srt)$` ist folgenlos. Bewusst deaktiviert (UDP ohne TLS).
`config.py:50` → `_push_url()` (unerreichbar)
Aufwand: keine (aufräumen: Feld + SRT-Zweig entfernen oder SRT-Sicherheitskonzept erarbeiten)

---

**Ed25519-Fallback (@noble/curves) — toter JSDoc-Kommentar-Zweig**
Kommentar beschreibt `{ type: 'noble', ... }` Union-Zweig; `StoredKeypair = WebCryptoKeypair` (kein Union), `@noble/curves` nicht installiert, `FINAL-DECISION`-Kommentar streicht Fallback.
`keypair.svelte.ts:11` → nirgends
Aufwand: keine (Kommentar auf Ist-Stand kürzen)

---

**redirect_uris auf RegisteredInstance — OAuth-Flow nie implementiert**
Feld in DB, nicht in `InstanceOut`, kein `/authorize`- oder `/token`-Endpoint. Relikt eines geplanten OAuth-Delegation-Flows.
`models_instances.py:48` → nirgends
Aufwand: keine (Feld entfernen oder OAuth-Delegation bauen — Letzteres groß)

---

**Abuse-Report / Instance-Complaint hat kein Frontend**
Vier auth-svc-Endpoints vollständig implementiert — kein API-Client-Wrapper, kein Admin-Widget, kein "Missbrauch melden"-Button.
`routes_complaints.py:1` → nirgends
Aufwand: groß (Admin-UI + "Melden"-Button + E-Mail-Infrastructure)

---

**ModQueue AuditLog-Labels ban/kick — Dead Code**
`ACTION_LABELS["ban"]` und `ACTION_LABELS["kick"]` in `AuditLogViewer.svelte` definiert; kein Backend schreibt diese `action_type`-Werte. Werden nie vom `fmtAction()`-Renderer getroffen.
`AuditLogViewer.svelte:25` → nirgends schreibbar
Aufwand: keine (Labels erst aktivieren wenn Dispatch implementiert ist, s. Gruppe 1)

---

**deactivate_plugin() — exportiert, nie aufgerufen**
Funktion ist `pass` (vollständiger No-op); Admin-DELETE nutzt `_drop_manager_record()`/`forget()`. Der Enforcement-Pfad läuft über `plugin_allowlist`-frozenset, nicht Registry-Cleanup.
`loader.py:420` → nirgends
Aufwand: keine (entweder entfernen oder für sauberes Registry-Cleanup implementieren)

---

**Konflikt-Detektor — vollständig implementiert, kein UI-Consumer**
`detectConflicts`, `conflictsByPlugin`, `conflictKindLabel` sind re-exportiert; kein Svelte-Component importiert oder ruft sie auf.
`conflict-detector.ts:51` → nirgends
Aufwand: mittel (Plugin-Manager-UI Schritt 6 mit Warn-Badges)

---

**TOML/manifest.ts Sync-Prüfung im CI fehlt**
Kommentar verspricht CI-Enforcement in Schritt 6; kein Script in `scripts/`, kein Step in `.github/workflows/`. Stiller Drift jederzeit möglich.
`plugins/hello/manifest.ts:6` → nirgends im CI
Aufwand: klein (Vergleichs-Script + CI-Step)

---

**failedActivate-Flag ohne UI-Oberfläche**
Flag wird bei Fehlerpfaden gesetzt (`registry.ts:180/209`); kein Component liest es. Ausgefallene Plugins für Admin unsichtbar.
`registry.ts:180` → nirgends
Aufwand: klein (Badge/Toast in GuildPluginsEditor oder AdminPlugins)

---

**Multi-Pod Allowlist-Sync: Publish vorhanden, Subscribe fehlt**
`redis.publish("plugin:allowlist:changed", ...)` wird bei Admin-PUT/DELETE gefeuert; `pubsub.py` subscribed diesen Channel nie. Im Single-Pod-Betrieb irrelevant; bei horizontal Scale-out würden andere Pods den Snapshot nie aktualisieren.
`admin_plugins_publish.py:47` → nirgends (kein subscriber)
Aufwand: klein (Subscribe + Handler in pubsub.py)

---

**JWKS-Pin-Reset DELETE /internal/jwks-pin — nie registriert**
Nur in Docstring (`Phase 4 stub`) und WARNING-Log referenziert; kein `@app.delete`-Handler in `app.py`. Operator-Gegenmassnahme: Pin-Datei per SSH löschen + Restart.
`jwks_pinning.py:20` → nirgends
Aufwand: klein (Delete-Route registrieren)

---

**Mention-Candidates — Backend fertig, Frontend nutzt Full-Member-Load**
(Duplikat-Eintrag bestätigt; identisch mit obigem Befund — zählt einmal.)

---

**Server-side OG/Open-Graph Unfurl (Stufe 2 Link-Previews)**
Roadmap-Kommentar in `providers.ts:10`; kein Backend-Endpoint, keine SSRF-Härtung, kein Redis-Cache, kein Bild-Proxy.
`providers.ts:10` → nirgends
Aufwand: groß (eigener Unfurl-Microservice + SSRF-Mitigation + Bild-Proxy)

---

**Tamagotchi alive/xp/level fehlen im HTTP-GET-Response-Modell**
`TamagotchiState` (guild_plugins.py) deklariert nur 5 Felder; WS-Pfad sendet alle 7 korrekt. Beim initialen Laden zeigt Widget immer `alive=true / level=1 / xp=0` bis erstes WS-Update.
`guild_plugins.py:232` → `store.ts:145` (Fallback-Werte)
Aufwand: klein (3 Felder zu TamagotchiState + _DEFAULT_TAMAGOTCHI hinzufügen)

---

## Gruppe 3: Stubs und TODOs

Bewusst dokumentierte, nicht implementierte Features.

---

**Globaler PTT-Shortcut (Desktop)**
`initDesktopPtt()` gibt `() => {}` zurück. Kein IPC-Kanal, kein `globalShortcut`, kein `uiohook-napi`. In-Window-PTT (VoiceChannelView + @svelte-put/shortcut) ist der einzige aktive Pfad.
`ptt.ts:26` → `+layout.svelte:117` (No-op-Disposer)
Aufwand: groß (uiohook-napi + IPC-Bridge main→preload→renderer)

---

**Windows-Sidecar: "Desktop + Mikrofon" (DesktopPlusMicrophone) — Stage-7-Mixer**
`wasapi.rs:324` gibt `Err("not yet wired")` zurück. Frontend-Guards blenden Modus auf Windows aus; `list_profiles` advertised ihn trotzdem. Direkter RPC-Aufruf crasht den Muxer.
`start.rs:148` → `wasapi.rs:324` (Err-Stub)
Aufwand: groß (Stage-7-Mixer: zwei AudioClients + Mixer-Thread)

---

**Complaint-Forward sendet keine E-Mail an Self-Host-Admin (Phase-5)**
`forward_complaint()` setzt nur Status + resolution_note. `contact_email` nicht auf `RegisteredInstance`; kein SMTP-Aufruf. Frontend für /admin/complaints fehlt vollständig.
`routes_complaints.py:186` → nirgends
Aufwand: mittel (contact_email auf RegisteredInstance + SMTP-Glue + Admin-UI)

---

**Electron Server-Store: localStorage statt window.pulse.store (Phase 4.3)**
`servers.svelte.ts` schreibt/liest immer `window.localStorage`, kein isElectron()-Branch. `window.pulse.store` (chmod 600) ist fertig (preload.ts, store.ts), wird von `persistence.ts` für Stream-Settings genutzt — nicht für Server-Liste.
`servers.svelte.ts:89` → nirgends (`window.pulse.store` ungenutzt hier)
Aufwand: klein (isElectron()-Branch in loadFromStorage/saveToStorage)

---

**Electron-IDB-Partition 'persist:pulse' fehlt**
`BrowserWindow` in `main.ts:186` hat kein `partition`-Feld; IndexedDB läuft in default-In-Memory-Session — Keypair, Cert, Profile-Statement gehen bei Neustart verloren.
`identity/index.ts:6` (TODO) → `main.ts:186` (kein partition)
Aufwand: klein (partition: 'persist:pulse' in webPreferences)

---

**version_policy min_version: Poller läuft, Enforcement-Consumer fehlt (Phase 4)**
Poller schreibt `chat:cloud_policy:current` alle 6h in Redis; `get_cached_policy()` wird nur in Tests aufgerufen. Frontend vergleicht gegen hardcodierte Konstante `MIN_SERVER_VERSION='0.8.0'`, nicht gegen den gepollten Wert.
`cloud_policy_poller.py:67` → nirgends (nur Tests)
Aufwand: mittel (Wert in hello-Frame einbauen + Frontend-Vergleich dynamisch machen)

---

**JWKS-Status-Healthcheck ohne Admin-UI-Banner (Phase 4)**
`app.state.jwks_changed_unexpectedly` korrekt gesetzt und über `/internal/jwks-status` zurückgegeben; kein Frontend-Code, kein Admin-Banner, kein WS-Broadcast konsumiert den Wert.
`jwks_pinning.py:199` → nirgends im Frontend
Aufwand: mittel (Admin-Banner-Component + Polling oder WS-Push)

---

**Audit-Log-Einträge für ban/kick/message_delete/role_change fehlen**
Lese/Render-Pipeline fertig (DB-Tabelle, GET-Endpoint, AuditLogViewer.svelte mit ACTION_LABELS). Keine der Write-Stellen in bans.py/guilds.py/roles.py/messages.py ruft `write_audit_log` auf.
`audit_log.py:27` → `AuditLogViewer.svelte:25` (Labels vorhanden, DB-Einträge fehlen)
Aufwand: klein (write_audit_log-Aufrufe in bans/guilds/roles/messages)

---

**Role-Permissions-Broadcast (Phase 3)**
Server-seitiger `_ws_perms`-Cache wird lazy invalidiert; kein proaktives Signal an Members, deren VIEW_CHANNEL sich geändert hat. Channel bleibt in der Sidebar bis zur nächsten Navigation.
`roles.py:180` → `pubsub_perm_filter.py:162` (lazy, kein Push)
Aufwand: mittel (diff der VIEW_CHANNEL-Änderungen berechnen + dediziertes Event pushen)

---

**Tamagotchi Pet-Umbenennung: name-Feld ohne Rename-Op/-UI**
Name wird persistiert, über alle State-Transitionen mitgeführt, im Widget angezeigt — kein `tamagotchi:rename`-WS-Op, kein Handler, kein UI-Input.
`mechanics.py:29` → `TamagotchiWidget.svelte:86` (nur Anzeige)
Aufwand: klein (Op in plugin.toml + Backend-Handler + Widget-Input)

---

**Stream-Sound-Dateien fehlen (3 Assets)**
`stream.user_start`, `stream.user_stop`, `stream.self_start` vollständig verdrahtet (Registry + streamDiff.ts) — `.ogg`-Dateien nicht in `web/static/sounds/`. Stilles No-op durch engine.ts #missing-Fallback.
`registry.ts:72` → `streamDiff.ts:32` (Code ok, Assets fehlen)
Aufwand: keine (3 .ogg-Dateien erstellen und einchecken)

---

**Notification Icon (Avatar) — Avatar-Cache fehlt**
IPC-Pfad vollständig verdrahtet; alle 4 Call-Sites übergeben `iconUrl` nie. `sanitiseIcon()` würde HTTP(S)-URLs ohnehin ablehnen — nur lokale Pfade innerhalb `process.resourcesPath` erlaubt.
`inPage.ts:123` → `notify.ts:118` (Feld immer undefined)
Aufwand: mittel (Avatar-Download-Cache + sichere Lokalisierung in resourcesPath)

---

**UI-Slot-Registry (plugin.uses.ui_slots) — Forward-Stub**
Feld deklariert, Konflikt-Detektor kennt es — kein Slot-Dispatcher, kein `registerSlot`, kein Render-Point. TamagotchiWidget ist hardcoded ins Channel-Layout verdrahtet.
`manifest-types.ts:26` → nirgends (kein Dispatcher)
Aufwand: groß (generisches Slot-Framework, Schritt 8 der Roadmap)

---

**Tamagotchi-Widget hardcoded statt via Slot-Registry**
`{#if showTamagotchi}`-Block direkt in `+page.svelte:526` mit Kommentar "bewusste Schuld bis zu einem späteren PR". Jedes neue Plugin-Widget müsste manuell ergänzt werden.
`+page.svelte:526` → nirgends (kein generischer Dispatcher)
Aufwand: mittel (abhängig von UI-Slot-Registry; ohne diese: kleiner Plugin-Hook)

---

**Bot-API / WASM-Plugin-Host (Stufe B)**
Nur Planungstext in `PLUGIN_ROADMAP.md`. Kein Code, keine Routen, keine Migrations, keine Prozess-Isolation. Externe Plugins strukturell nicht möglich.
`docs/PLUGIN_ROADMAP.md:749` → nirgends
Aufwand: groß (Stufe B der Plugin-Roadmap)

---

**Plugin-Migrations-API (eigene DB-Tabellen für Plugins)**
Nur Roadmap-Eintrag (`Schritt 8`). Kein `migrations`-Feld im Manifest, kein Loader-Pfad, kein Alembic-Scan.
`docs/PLUGIN_ROADMAP.md:752` → nirgends
Aufwand: groß (Migrations-Framework für Plugins)

---

**Cross-Pod Watch-Party — Watcher-Registry und Host-Lifecycle in-process**
Drei in-process Komponenten ohne Redis-Backing: Watcher-Menge, `next_host()`-Kandidaten, Grace-Timer. Bei Multi-Pod würde Host-Promotion scheitern. Im aktuellen Single-Pod-Prod kein aktives Problem.
`watch_registry.py:13` → nirgends cross-pod
Aufwand: groß (Redis-backed Watcher-Registry + verteilter Grace-Timer)

---

**Complaint Forward / Admin-Complaints — Gesamtlücke**
(Mehrfach bestätigt unter verschiedenen Titeln; zusammengefasst: kein Frontend, kein SMTP, `contact_email` nicht auf `RegisteredInstance` — alles unter Gruppe 1 bzw. Gruppe 3 separat aufgeführt.)

---

**setPlaybackRate bei Twitch-Player ist No-op — Nudge-Band-Korrektur**
`TwitchPlayer.svelte:123` ist expliziter Stub (Twitch Embed API exponiert playbackRate nicht). Drift 0,1–2,0 s bleibt bestehen bis Hard-Seek (>=2,0 s) greift. Bewusst dokumentiert.
`TwitchPlayer.svelte:123` → `sync.ts:270` (No-op-Empfänger)
Aufwand: keine (API-Limitation; allenfalls Nudge-Band für Twitch auf Hard-Seek-Schwelle absenken)

---

**SRT als Ingest-Option — bewusst deaktiviert (UDP/TLS-Sicherheitsentscheidung)**
`_push_url()`-SRT-Zweig real implementiert (beide Sidecars verstehen SRT); durch `pattern=^rtmp$` in media-svc unerreichbar. Sicherheitskommentar dokumentiert Grund.
`routes.py:108` (Pattern-Gate) → `_push_url():145` (unerreichbar)
Aufwand: mittel (Token-Verschleierungsstrategie für SRT-streamid + Pattern erweitern)

---

*Bestätigt: 68 | False Positives: 3*
