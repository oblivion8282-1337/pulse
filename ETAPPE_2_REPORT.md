# Etappe 1.5 + 2 — Report

**Branch:** `night-team-2026-05-11`
**Worktree:** `~/Dokumente/discord-clone/.claude/worktrees/night-team`
**Commits:** `40cab85` (Etappe 1.5: shadcn-svelte), `055706e` (Etappe 2: Voice-Frontend)

## Status: ERFOLGREICH

- Etappe 1.5 (shadcn-svelte nachrüsten) — verifiziert OK durch e2-verify
- Etappe 2 (Voice-Frontend mit LiveKit) — implementiert, autonom soweit testbar verifiziert
- `pnpm check` → 0 Errors, 0 Warnings · `pnpm build` → grün · Playwright E2E → 7/7 grün (keine Regression)

---

## Etappe 1.5 — shadcn-svelte

`pnpm dlx shadcn-svelte@latest init` (base color **neutral**, CSS-Variablen, Aliases auf `$lib/*`, Style `vega`) + `add button input label dialog dropdown-menu context-menu scroll-area separator tooltip avatar sonner alert badge`.

### Umbau (alle `data-testid` erhalten)
- **Login / Register** (`routes/login`, `routes/register`): `<Button>` + `<Input>` + `<Label>` + `<Alert>` statt der Eigenbau-`btn-primary`/`input-base`-Klassen
- **CreateGuildDialog / CreateChannelDialog**: shadcn `Dialog` — die alte Prop-API (`open` / `onClose` / `onCreate`) bleibt erhalten, intern via `onOpenChange`-Bridge
- **GuildList**: shadcn `Tooltip` auf jedem Guild-Icon (zeigt Guild-Name, `side="right"`), lucide `PlusIcon` für den "+"-Button
- **ChannelList**: shadcn `ContextMenu` (Rechtsklick auf Channel) mit "Kanal umbenennen" + destructive "Kanal löschen" — **UI-only**, beide Items zeigen einen `svelte-sonner`-Toast "noch nicht verfügbar" (Backend hat keine DELETE/PATCH-Channel-Route)
- **MessageItem**: shadcn `Avatar` + `AvatarFallback` statt Eigenbau-Kreis
- **MessageInput**: shadcn `Button` (icon, `SendHorizontalIcon`)
- **app/+layout**: sign-out als shadcn `Button` (secondary, `LogOutIcon`)
- **root +layout.svelte**: `<Toaster theme="dark" position="bottom-right" richColors>` gemountet

### Theming
`src/app.css`: shadcn-Semantik-Tokens (`--background`, `--card`, `--primary`, …) im `.dark {}`-Block auf die Discord-Dark-Palette gemappt (`#1e1f22` Base, `#5865f2` Accent, …). Tailwind v4 + shadcn koexistieren über die korrekte `@import`-Reihenfolge. Dark-Mode bleibt Default (`<html class="dark">` in `app.html`, unverändert). Die rohen `--color-bg-*` / `--color-text-*` Tokens bleiben für Layout-Flächen erhalten (Tailwind-Utilities `bg-bg-base`, `text-text-bright`, …).

---

## Etappe 2 — Voice-Frontend (LiveKit)

### Stack-Picks (aus PLAN.md Section 2)
| Lib | Version | Genutzt für |
|---|---|---|
| `livekit-client` | 2.18.9 | LiveKit JS SDK (`Room`, Events, `track.attach()`) |
| `@livekit/components-core` | 0.12.13 | installiert, **aber nicht aktiv genutzt** — siehe Abweichung unten |
| `@svelte-put/shortcut` | 4.1.0 | PTT-Hotkey ("V") |

**`@ricky0123/vad-web` / `@jitsi/rnnoise-wasm` NICHT installiert** — laut Task optional. AEC / NS / AGC laufen über die `getUserMedia`-Defaults (`echoCancellation: true, noiseSuppression: true, autoGainControl: true` in `audioCaptureDefaults`). Eine spätere Polish-Stufe kann rnnoise-wasm drauflegen.

### Abweichung von PLAN.md (dokumentiert)
PLAN.md schlägt vor, `@livekit/components-core`-Observables in Svelte-Runes zu wrappen. Stattdessen abonniert `lib/voice/livekit.svelte.ts` die rohen LiveKit-`Room`/`Participant`-Events direkt und spiegelt den relevanten State in `$state`-Felder. Grund: die components-core-Observables sind RxJS-basiert und für React-Hooks geformt; der direkte Event-Ansatz ist in Svelte sauberer, etwa gleich viel Code, und braucht keine RxJS-Subscription-Verwaltung. Das Paket bleibt als Dependency installiert (kann bei Bedarf nachträglich genutzt werden).

### Komponenten
- **`web/src/lib/voice/livekit.svelte.ts`** — `VoiceRoom`-Klasse, module-global als `voice` exportiert (eine aktive Voice-Verbindung gleichzeitig, wie Discord). Reaktiver State: `channelId`, `channelName`, `state` (LiveKit `ConnectionState`), `error`, `participants` (`VoiceParticipant[]` — identity / name / userId / isLocal / isSpeaking / audioLevel / micMuted / connectionQuality), `micEnabled`, `deafened`, `pttMode`, `outputDevices`, `selectedOutputDeviceId`. Methoden: `connect(channelId, channelName)` (holt Token vom `/api/voice/token`, dialt LiveKit, publisht Mic standardmäßig — außer PTT-Mode an), `disconnect()`, `setMicEnabled` / `toggleMic`, `setPttMode` / `pttPress` / `pttRelease`, `setDeafened` / `toggleDeafen`, `setOutputDevice`. Remote-Audio: `track.attach()` in versteckte `<audio>`-Elemente, `el.muted` für Deafen. 200 ms-Polling von `participant.audioLevel` für smoothen Speaking-Glow.
- **`web/src/lib/api/voice.ts`** — `getVoiceToken(channelId, kind)` → `POST /api/voice/token`
- **`web/vite.config.ts`** — `/api/voice` Proxy → `http://127.0.0.1:8003`
- **`web/src/lib/api/client.ts`** — `endpoint: 'voice'` Variante, `VOICE_BASE`
- **`web/src/lib/components/VoiceChannelView.svelte`** — rechte Spalte, sichtbar wenn ein Voice-Channel aktiv ist. Header (Volume-Icon, Channel-Name, Status-Text "Sprach-Kanal · N Teilnehmer" / "Verbinde…" / "Fehler: …"). Teilnehmer-Grid (`VoiceParticipantTile`). Control-Bar: Mic-Toggle, Deafen-Toggle, PTT-Toggle (alle mit `Tooltip`), Audio-Output-`<select>` (nur wenn >1 Gerät), "Verlassen"-Button. Auto-Connect beim Mount (genau einmal pro Channel, **kein Retry-Loop bei Fehler** — dann erscheint ein "Beitreten"-Button). PTT via `@svelte-put/shortcut` (`keydown` "V" → Mic an, `keyup` "V" → Mic aus; nur wenn PTT-Mode aktiv; ignoriert `<input>`/`<textarea>`/contentEditable).
- **`web/src/lib/components/VoiceParticipantTile.svelte`** — `Avatar` mit Initial, Speaking-Glow als `box-shadow` aus `audioLevel`, Name (+"du" bei `isLocal`), `MicOffIcon` wenn stumm
- **`web/src/lib/components/ChannelList.svelte`** — zwei Sektionen "Text-Kanäle" / "Sprach-Kanäle"; Voice-Channels mit `Volume2Icon` + grünem Punkt wenn `voice` mit diesem Channel verbunden ist
- **`web/src/lib/components/CreateChannelDialog.svelte`** — Channel-Typ-Auswahl (Text / Sprache) als Button-Paar; `onCreate(name, type)`
- **`web/src/routes/app/guilds/[guildId]/channels/[channelId]/+page.svelte`** — rendert `VoiceChannelView` bei `type === 1`, sonst `ChatView`; für Voice-Channels werden keine WS-Subscription und keine Message-History geladen; `createChannel(name, type)`
- **`web/src/routes/app/+layout.svelte`** — sign-out und `onDestroy` machen jetzt auch `voice.disconnect()`

### Backend
Der `POST /token`-Endpoint im voice-signaling-Service existierte schon aus Phase E (Body `{channel_id, kind}` → `{token, ws_url, room}`, JWKS-Auth, LiveKit-AccessToken via `livekit-api`, TTL 4 h, Room `channel-<id>`). **Kein Webhook-Receiver / Redis-State nachgezogen** — laut Task optional; das Frontend nutzt LiveKit's eigene Participant-Events statt eines server-seitigen "wer-in-welchem-Channel"-States.

### Stack-Fix (wichtig)
Der laufende voice-signaling-Prozess (:8003) lief beim Start dieser Session mit `LIVEKIT_API_SECRET=devsecret_devsecret_devsecret_32b`, aber `infra/livekit/livekit.yaml` und `.env` definieren `devkey: devsecretdevsecretdevsecretdevsecret`. → LiveKit lehnte alle Tokens ab ("invalid token: error in cryptographic primitive"). **:8003 wurde neu gestartet mit den korrekten Keys aus `.env`** (`LIVEKIT_API_KEY=devkey`, `LIVEKIT_API_SECRET=devsecretdevsecretdevsecretdevsecret`, `LIVEKIT_URL=ws://localhost:7880`). `.env` / `livekit.yaml` sind die Single Source of Truth.

---

## Wie der User Voice testet (manuell — Voice-QUALITÄT ist nicht autonom testbar)

**Voraussetzungen:** Backend + LiveKit + Vite laufen (siehe unten "Stack-Zustand"), und du brauchst **mindestens 2 Browser-Tabs / Profile** (am besten 3) sowie ein **Mikrofon** (der Browser fragt nach der Mic-Permission).

1. Tab 1: `http://127.0.0.1:5173` → registrieren als User 1 → Server erstellen ("general" wird automatisch angelegt)
2. Tab 1: in der mittleren Spalte das **"+"** im Channel-Header klicken → im Dialog **"Sprache"** wählen → Name z.B. `lounge` → "Erstellen". Du landest direkt im Voice-Channel und wirst (nach Mic-Permission-Prompt) verbunden — dein Avatar erscheint im Grid, Status zeigt "Sprach-Kanal · 1 Teilnehmer".
3. Tab 2 (Inkognito / anderes Profil): registrieren als User 2.
4. Tab 1: User 2 zur Guild hinzufügen. Schnellster Weg in der DevTools-Konsole von Tab 1 (User-2-ID siehst du im `/me`-Endpoint auf `:8001` oder im Access-Token von Tab 2 — als **String**):
   ```js
   const t = localStorage.getItem('dcc.tokens.access');
   await fetch('/api/chat/guilds/<GUILD_ID>/members', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
     body: JSON.stringify({ user_id: '<USER2_ID_ALS_STRING>' })
   });
   ```
5. Tab 2: navigiere zu `/app/guilds/<GUILD_ID>/channels/<VOICE_CHANNEL_ID>` und **reload**. User 2 verbindet sich → beide Tabs sollten jetzt **beide Avatare** im Grid zeigen ("2 Teilnehmer").
6. **Audio testen:** in einem Tab sprechen → im anderen Tab solltest du es hören, und der Avatar des Sprechenden sollte einen grünen Glow-Ring bekommen (Speaking-Indicator). (Tipp: zwei echte Geräte oder Kopfhörer benutzen, sonst Rückkopplung.)
7. **Controls testen** (untere Leiste):
   - **Mic-Button**: stummschalten → der andere Tab zeigt ein Mic-Off-Icon an deinem Avatar, hört dich nicht mehr.
   - **Deafen-Button** (Kopfhörer): mutet *lokal* alle anderen — du hörst niemanden mehr.
   - **PTT-Button** (Radio-Icon): aktiviert Push-to-Talk → dein Mic geht aus; jetzt **"V" gedrückt halten** = Mic an für die Dauer; loslassen = Mic aus. Nochmal klicken = zurück zu offenem Mic.
   - **Audio-Ausgabe-Dropdown** (nur wenn >1 Ausgabegerät): wechselt das Wiedergabe-Gerät.
   - **"Verlassen"**: trennt die Verbindung → der andere Tab sieht deinen Avatar verschwinden; du bekommst einen "Beitreten"-Button.
8. **Nice-to-have prüfen:** Wenn du (verbunden) zu einem Text-Channel wechselst, bleibt die Voice-Verbindung aktiv — der Voice-Channel in der Kanal-Liste behält einen kleinen grünen Punkt. "Verlassen" gibt es dann wieder, wenn du zum Voice-Channel zurücknavigierst.
9. **Mit 3 Tabs:** wiederhole Schritt 3-5 für User 3 — alle drei sollten sich gegenseitig hören und im Grid sehen.

---

## Bekannte Bugs / Limitationen

1. **Voice-Qualität nicht autonom getestet** — kein Mikrofon / keine echten Peers im Headless-Test. Verifiziert wurde nur: Verbindungsaufbau, Token-Flow, Teilnehmer-Sync zwischen Tabs, Mic/Deafen/PTT-State-Toggles, Disconnect-Propagation (alles mit Fake-Mic). Ob Audio wirklich ankommt + AEC/NS greifen → User testet.
2. **Kein server-seitiger Voice-State** — voice-signaling hat keinen Webhook-Receiver / Redis-State. Wer in welchem Voice-Channel ist, weiß nur LiveKit; das Frontend liest es aus den Room-Events. Für Presence-Anzeigen in der Channel-Liste anderer User (Discord zeigt Teilnehmer unter dem Voice-Channel-Namen) wäre der Webhook nötig — Etappe 4+.
3. **Voice-Reconnect bei LiveKit-Ausfall** — LiveKit reconnectet selbst (eigene Logik), aber wenn die WS dauerhaft wegfällt, landet der State auf `disconnected` und der User muss "Beitreten" klicken. Nicht E2E-getestet.
4. **Token-Expiry während aktiver Voice-Verbindung** — der LiveKit-Token hat 4 h TTL; ein langlebiges Gespräch über 4 h hinaus würde getrennt. Kein Refresh-Flow für LiveKit-Tokens implementiert (MVP-Vereinfachung).
5. **`pr-28`-Hack** in der Voice-Control-Bar — hält den "Verlassen"-Button frei vom fixed positionierten "Abmelden"-Button unten rechts. Beide Buttons sind ein Layout-Quirk; ein sauberer User-Footer in der ChannelList (Discord-Style) wäre die richtige Lösung — bewusst nicht in dieser Etappe gemacht (Scope).
6. **Channel-Rename/Delete** weiterhin UI-only (ContextMenu zeigt Toast) — Backend-Routen fehlen, gilt für Text- und Voice-Channels.
7. **`@livekit/components-core` installiert aber ungenutzt** — siehe "Abweichung" oben. Könnte man entfernen oder später nutzen.

## Übersprungene Items (mit Begründung)
- `@ricky0123/vad-web` (Silero-VAD) — laut Task optional; PTT + offenes Mikro reichen für MVP, VAD wäre für Voice-Activation-Mode.
- `@jitsi/rnnoise-wasm` — laut Task optional; getUserMedia-NS-Default reicht erstmal.
- voice-signaling Webhook-Receiver — laut Task: "Optional, wenn Zeit knapp: skip".
- Screen-Sharing, GSR-Integration, Mobile-PWA — explizit Etappe 3+, nicht angefasst.

---

## Stack-Zustand (für den User)

Beim Übergeben dieser Etappe laufen:
- **auth-svc** :8001 (Background-Prozess)
- **chat-gateway** :8002 (Background-Prozess)
- **voice-signaling** :8003 (Background-Prozess, **neu gestartet** mit `LIVEKIT_API_KEY=devkey` / `LIVEKIT_API_SECRET=devsecretdevsecretdevsecretdevsecret`)
- **Postgres** :5434 (Container `dcc_night_postgres`, healthy)
- **Redis** :6380 (Container `dcc_night_redis`, healthy)
- **LiveKit** :7880 (Container `dcc_night_livekit`, gestartet via `docker compose --profile voice up -d`)
- **Vite-Dev-Server** :5173 → `http://127.0.0.1:5173`

### Frischer Start (falls nötig)
```bash
cd ~/Dokumente/discord-clone/.claude/worktrees/night-team

# Infra:
docker compose --profile voice up -d            # Postgres + Redis + LiveKit

# Backend (3 Terminals oder als Background-Prozesse):
# Env aus .env: POSTGRES_PASSWORD, JWT_PRIVATE_KEY_FILE/JWT_PUBLIC_KEY_FILE (absolute Pfade zu secrets/jwt_*.pem),
#               REDIS_URL=redis://localhost:6380/0, AUTH_JWKS_URL=http://127.0.0.1:8001/.well-known/jwks.json
cd services/auth          && uv run uvicorn dcc_auth.app:app           --host 127.0.0.1 --port 8001
cd services/chat-gateway  && uv run uvicorn dcc_chat_gateway.app:app   --host 127.0.0.1 --port 8002
# voice-signaling MUSS mit den LiveKit-Keys aus .env / infra/livekit/livekit.yaml laufen:
cd services/voice-signaling && \
  LIVEKIT_API_KEY=devkey \
  LIVEKIT_API_SECRET=devsecretdevsecretdevsecretdevsecret \
  LIVEKIT_URL=ws://localhost:7880 \
  AUTH_JWKS_URL=http://127.0.0.1:8001/.well-known/jwks.json \
  uv run uvicorn dcc_voice_signaling.app:app --host 127.0.0.1 --port 8003

# Frontend:
cd web && pnpm dev --host 127.0.0.1 --port 5173
# -> http://127.0.0.1:5173

# Tests:
uv run pytest                       # Backend (alle grün)
cd web && pnpm exec playwright test  # Frontend E2E (7/7 grün)
cd web && pnpm check                 # 0 Errors
cd web && pnpm build                 # grün
```

---

## git log --oneline (relevante Commits)
```
055706e etappe-2: voice frontend with livekit
40cab85 etappe-1.5: shadcn-svelte components
afa50fa phase-final: night-run report
4517a19 phase-e: voice-signaling skeleton + livekit dev container
709a636 phase-d: Playwright E2E + signout fix + 64-bit ID precision fix
1b21761 phase-c: SvelteKit 5 frontend (login + chat shell)
ca7d92a phase-b: auth-svc + chat-gateway + tests (44 green)
63494a2 phase-a: repo skeleton (workspaces, snowflake, docker)
```
