# Pulse — Ideen-Sammlung & Monetarisierungs-Strategie

*Brainstorm vom 2026-05-18 zwischen Michael & Claude. Dies ist kein PLAN.md (= verbindlich), sondern ein Optionen-Steinbruch für spätere Entscheidungen. Pro Idee: Kurz-Pitch + warum es zu Pulse passt. Keine Reihenfolge oder Priorisierung implizit — die wenigen Empfehlungen am Ende der Datei sind als solche markiert.*

---

## 1. Roadmap-Reste (in PLAN.md §10 / §17 schon erwähnt — „halb-zugesagt")

- **Roles + Permissions-UI** — DB-Felder laut PLAN reserviert. Pro-Guild-Rollen sind der größte Discord-Parity-Sprung mit wenig Architektur-Neudesign.
- **Push-Notifications (Web-Push + Service-Worker)** — ohne kommen wir auf Mobile nicht in den Hintergrund-Use-Case. ~2-3 Tage echt.
- **Global-PTT auf Electron** via `uiohook-napi` — heute nur In-Window-PTT, was außerhalb des Fokus stört. CLAUDE.md flaggt es als bekannten Gap.
- **Notifications-IPC in `desktop/electron/main.ts`** — native OS-Banner für DMs/Mentions, ~10 Zeilen.
- **macOS + Windows Electron-Builds** — Web-First ist gut, aber HQ-Streaming ist Linux-only (siehe Memory `project_windows_capture_research`).
- **Mobile-PWA-Touch-Pass** — Sidebar als Drawer, Long-Press-Reactions, Virtual-Keyboard-Layout-Fixes.
- **2FA (TOTP)** + Session-Management-UI („meine aktiven Geräte / abmelden") — Vorab-Schritte für das Identity-Konzept.

## 2. Chat-Polish (Discord-Parity-Schiene)

- **Threads / Reply-Chains** mit eigener Read-Position.
- **Mentions** (`@user`, `@here`, `@channel`) inkl. Highlight + Read-State-Pop. Koppelt sich direkt an Push-Notifications.
- **Suche** — Postgres-FTS pro Guild reicht für v1; pgvector erst wenn jemand semantische Suche will.
- **Pinned Messages + Bookmarks/Saved Messages.**
- **Custom Emoji + Sticker pro Guild** — Emoji-Picker und S3-Upload existieren beide schon.
- **Markdown-Renderer mit Sanitizer** — `marked` + `DOMPurify` (nicht `svelte-markdown` blind — siehe Anti-Patterns).
- **Typing-Indicator** — günstig via Redis-Pub/Sub + WS-Frame.
- **Server-Discovery + öffentliche Invite-Listing.**
- **User-Status (Online/Idle/DND/Custom)** — `MemberActivityHeader` existiert, das Datum dahinter müsste in `voicePresence`/`ws.py` ergänzt werden.
- **„Spiel das ich gerade spiele"** als Custom-Status-Feld (Free-Text + Icon, kein Rich-Presence).

## 3. Voice & Audio (USP-Schiene)

- **30-Sekunden-Voice-Replay (lokal).** Ringbuffer der eigenen empfangenen Mix-Audio. Button „was hat Anna grad gesagt?" → spielt letzte 30s lokal nochmal ab. Niemals server-seitig.
- **Live-Untertitel via lokales Whisper.** Voice + Stream-Audio → Whisper.cpp → Overlay im VoiceParticipantTile bzw. WhepPlayer. Accessibility + „leise lassen während Baby schläft".
- **Spatial Audio nach Tile-Position.** Web Audio `StereoPanner` pro Participant, ~3 Zeilen Code. Sofort spürbar.
- **Hot-Mic-Floating-Indicator.** Mini-Always-on-Top Electron-Fenster: Mic on/off, Stream live, in welchem Channel. „Ich rede seit 5 Min in toten Channel" wird unmöglich.
- **AI-Catchup „was lief während ich weg war".** Button am ungelesenen-Trennstrich → lokales/Remote-LLM fasst N neue Messages in 3 Bullets zusammen, mit @deinName-Highlight.
- **Soundboard** für Voice-Channel (lokale Files → LiveKit-Track injizieren).
- **Karaoke-Mode.** Server-side YouTube + Vocals-Removal (Spleeter) + Pitch-Tracking → Live-Score wie SingStar. Watch-Party-Engine + Voice-Mix-Engine + Pitch-Worklet.
- **Voice-Memes.** Reaktionen sind nicht nur Emoji sondern 5s-Audio-Snippets. In Voice-Channels in den Mix gespielt.
- **Ambient-Audio-Bed pro Channel.** Regen, Lagerfeuer, Café, Lo-Fi. Server-side gemixed als zweite LiveKit-Track.
- **Real-Time Voice-Translation.** Whisper → Translation → TTS, lokal. Du sprichst DE, dein FR-Freund hört auf FR (mit ~3s Delay).
- **Whisper-Mode im offenen Channel.** Klick auf Avatar → 1:1-Audio-Lane neben dem Channel-Mix, andere hören dich gedämpft.
- **Lurker-Lobby.** Voice-Channel-Modus „still anwesend": alle muted, Presence sichtbar, kein Audio. Co-Working ohne Sprech-Druck.
- **Driving-Mode.** Mobile-PWA-Skin: Voice-Only, riesige Buttons, eingehende Messages werden vorgelesen, Antworten per Voice-to-Text.
- **MIDI im Voice-Channel.** Web-MIDI → eigener LiveKit-Audio-Track. Jam-Sessions mit Pulse-Latenz.
- **AI-Auto-Mute „Hund-Bell-Filter / Tippen-Filter"** über RNNoise hinaus.
- **Auto-Mute by Activity.** System erkennt „User tippt aktiv in anderem Fenster" → Mic-mute. Whitelist konfigurabel.

## 4. HQ-Streaming (Differenzierung gegen Discord/Twitch)

- **Shared Cursors auf Streams.** Viewer-Cursors als bunte Pointer-Overlays über dem WHEP-Tile. Code-Review-/Coaching-Killer. Pointer-Position über existierenden WS-Channel.
- **Multi-Source Co-Stream.** Zwei GSR-Streamer im selben Voice-Channel → media-svc legt die beiden Pfade zu einem WHEP-Stream zusammen (FFmpeg `hstack`). Zuschauer sieht Split-Screen.
- **Webcam-PiP im GSR-Stream.** GSR kann mehrere Sources; im Sidecar `v4l2`-Webcam als Overlay-Region adden.
- **Stream-Region-Capture / Crop.** Im HQ-Dialog Rechteck-Picker („nur dieses Browser-Fenster"). GSR-`argv` kennt das, Sidecar muss nur durchreichen.
- **Stream-Reactions** als Emoji-Burst-Overlays auf dem Stream-Tile.
- **„Mit-Schauen"-Indikator + Zuschauerzahl pro Stream-Tile.**
- **Stream-Recording lokal mitschneiden** (Viewer, opt-in, Host kann verbieten) via `MediaRecorder` auf WHEP-Track.
- **Highlight-Clip-Hotkey.** Rollender 30s-Buffer in media-svc, F8 → MP4-Clip im Channel mit Auto-Thumbnail. Twitch-Clips ohne Twitch. Bonus: KI-Auto-Clip bei Reactions-Spike.
- **Stream-Scene-Switcher (Pulse-intern, nicht OBS).** 2-3 Presets pro Streamer: „Game only", „Game + Webcam-PiP", „Just Chatting". GSR-`argv` neu bauen + Hot-Reload <500ms.
- **Webcam-Background-Blur/Replace im Browser.** MediaPipe-Selfie-Segmentation lokal, Web-Worker + Canvas.
- **Heart-Rate-Stream-Overlay.** WebBluetooth zu Polar/Wahoo/Apple-Watch → BPM-Zahl im HQ-Stream-Overlay. Streamer der Horror-Game spielt = sichtbarer Puls = Viewer-Vibe.
- **Per-User Stream-Quality-Vote.** Viewer-Aggregat „bitte Bitrate hoch/runter", Streamer sieht's.

## 5. Watch-Party (eigenständige Schiene, etwas vernachlässigt)

- **Watch-Party Reaction-Heatmap + Highlights-Replay.** Reactions mit Sync-Timestamp speichern → nach Party „Best Moments"-Replay nur der Reactions-Peaks.
- **Time-Shift Watch-Party.** Du joinst 90 min zu spät. App spielt dir die Party im Zeitversatz ab (Stream + Chat + Reactions + Voice) und „fängt dich ein" am Live-Punkt. Sync-Engine kann das fast schon — fehlt Per-User-Clock-Offset.
- **Cinema Mode.** „Lichter aus"-Button: UI faded auf reine Tile-Sicht, Letterbox, near-black Theme-Override, Reactions als floatende Emojis über dem Video (Twitch-Style), alle synchron.
- **DJ-Mode mit Shared Queue.** Voice-Channel hat Musik-Slot. Jeder kann YT/Spotify in Queue werfen, synchron im Voice-Mix (eigener LiveKit-Track). Skip-Vote per Reactions. Discord-Music-Bots sind tot — first-class hier.
- **Stream-Together-Modus für Watch-Party-Hosts.** Host kann live einen GSR-HQ-Stream daneben legen (Director-Commentary).
- **Spotify/SoundCloud-Player** für Watch-Party ergänzen, gleicher Sync-Mechanismus.
- **Bookmark-with-Voice-Comment.** Rechtsklick auf Video-Timestamp → 10s-Voice-Notiz, gerendert als pinbare Karte im Watch-Chat mit „Springe zu Sekunde 1247".

## 6. Modi & Coworking (öffnet neue Zielgruppe)

- **Pomodoro-Voice-Channels.** Channel-Modus „Focus": serverseitiger Timer, alle hörbar aber gemutet in Work-Phase, auto-unmuted in Break. Ambient-Track (Regen/Café) vom Server injiziert. Killt Focusmate/Flow.club-Use-Case.
- **Channel-Whiteboard (Excalidraw-Klon).** Pro Channel persistentes Brett (CRDT via Yjs, in Postgres). Tab neben „Chat"/„Voice"/„Watch".
- **Knock-to-Join.** Voice-Channel kann „closed" sein → Anfrage-Button statt direkter Join. Bessere Semantik als Discord-Stages.
- **Slow-Mode-Channel für Long-form-Vibe.** Max 1 Post pro User pro Stunde. Erzwingt nachdenkliche Diskussion.
- **Sub-Channels nur sichtbar wenn man im Voice ist.** Du joinst „Gaming" → temporäre Sub-Channels „Strats"/„Memes"/„Music-Queue" für aktuell-Anwesende. Channel-Hierarchie als Location, nicht als Tree.

## 7. Spiele (eingebaut)

- **Werewolf/Among-Us-Mode.** Voice-Channel mit Round-State: „Nacht" → Rollen-Pairs hören nur sich, „Tag" → alle unmuted. Auto-moderiert.
- **Skribbl/Drawing-Game.** Minimaler Aufwand on top vom Whiteboard.
- **Trivia-Engine pro Server.** Admins importieren Question-Packs (JSON), Kahoot-artig.
- **Hand-Gesture-Reactions.** MediaPipe Hand-Tracking → Daumen hoch in Kamera → ❤️ in Chat. Für Voice-Calls beim Kochen/Sport: Game-Changer.

## 8. Zeit, Anonymität, Memory

- **Time-Capsule-Channel.** Posts mit „sichtbar ab"-Datum. An sich selbst, an Server, an User. Niemand baut das, alle wollen das.
- **Confession-Box / Anonymous-Channel.** Posts ohne Author. Admin kann nachträglich enthüllen (Mod-Tool).
- **„On this day" + Server-Yearbook.** Auto-generierte Jahres-Recap: meist-genutzte Reactions, längste Voice-Session, Top-Watch-Party. Spotify-Wrapped-Energie für Friend-Server.
- **Vanish-DMs.** DM-Mode mit Auto-Delete 24h nach Lesen (echtes `DELETE`).
- **Burner-Identities pro Server.** Ein Account, pro Server eine eigene Persona (Name, Avatar, Pronouns). Server-Owner sieht's, andere nicht.

## 9. AI als Server-Bewohner

- **Persistent AI-Charakter pro Server.** Nicht „ChatGPT-Bot", sondern eine Persona mit Backstory die der Owner schreibt. Reagiert auf @-Mentions, hat Erinnerung pro User, hat Meinungen. Lokales Modell.
- **Stream-Commentary-Bot.** Vision-Modell läuft live über deinen Stream und kommentiert im Stream-Chat. Twitch hat das nicht.
- **Semantic Auto-Mod.** „blockiere Hassrede" als Regel statt 400 Word-Filter. Mod-Audit zeigt warum.
- **„Antwort im Stil von X".** 3 Vorschläge wie „sowas wie das was Tom letzte Woche geschrieben hätte". Für müde Async-DMs.

## 10. Office-Crossover (das niemand richtig löst)

- **Built-in Wiki pro Server.** Markdown-Pages mit Channel-Verlinkung. Notion-leicht. Self-hosted Communities sterben oft an „wo dokumentieren wir Onboarding".
- **Events + Calendar mit RSVP.** iCal-Feed pro Guild, RSVP-Reactions als first-class, Voice-Channel-Auto-Open zur Event-Zeit. Discord-Events sind halbgar.
- **Native Polls.** Multi-Choice + Ranked-Choice + Deadline + DM-Reminder.
- **Echtzeit-Tabellen-Mode für Channel.** Statt Messages ein Google-Sheets-artiges Brett (Yjs-CRDT). Inventar, Tier-Lists, Schichtpläne.
- **Code-Sandbox-Embeds.** Code-Block mit `js`-Tag bekommt „Run"-Button → läuft in Sandbox-Iframe.
- **Git/CI-Live-Feed-Channel.** Webhook-Endpoint mit echten UI-Karten + Action-Buttons (nicht der Discord-Webhook-Standard).
- **Pro-Server JS-Plugin-Sandbox.** Kleine JS-Snippets (Web-Worker-sandboxed) reagieren auf Events (`onMessage`, `onJoin`). Pulse als Plattform.

## 11. Identität & Avatar

- **3D-Avatare im Voice (VRM-Upload).** VRChat-light: Tile = animierter 3D-Avatar, Mund-Sync zur Mic-Amplitude, optional Face-Tracking via MediaPipe.
- **2D-PNGTuber-Lite.** Wenn 3D zu viel: Sprites für „Mund zu/auf/blinkt", reagiert auf Mic-Amplitude.
- **„Now Playing" mit Album-Art.** Status zeigt Album-Cover + Progress-Bar. Spotify Web-API / MPRIS / AppleScript pro Plattform, alle landen im selben State.

## 12. Cross-Server / Federation

- **Server-Allianzen.** Zwei Server pairen → ein Channel in beiden sichtbar, beide Sides können posten. Discord scheiterte dran weil zu groß — kleine Pulse-Cluster sind richtige Größe.
- **Server-Federation Light.** DMs an `@user@pulse.anderer-host.de`. ActivityPub muss nicht sein, simples Per-Instance-Trust-Pairing reicht.
- **Server-Fork.** Owner klickt „Fork" → kompletter Server (Channels, Roles, Settings, Whiteboard, Wiki) wird geklont, Members bekommen optionale Einladung.
- **Public Read-Only-Mirror eines Channels.** Per-Channel-Toggle → öffentliche URL rendert Messages als Blog/Forum-View, indexierbar, RSS-Feed.

## 13. Hardware / Physisch

- **LED-Strip-Sync (Hue/OpenRGB/Govee).** Mentions blitzen lila, Voice-Activity pulst grün, Reaction-Bomb = Zimmer rot.
- **Stream-Deck-Plugin (Elgato JS-SDK).** Channels, Mic-Mute, PTT, Scene-Switcher, Highlight-Clip als physische Buttons.

## 14. Atmosphäre / Surreal

- **Tageszeit-adaptives Server-Theme.** UI wärmer abends, kälter morgens, dunkler nachts. Subtil. Bonus: Wetter eures Channel-Standorts färbt das Theme leicht.
- **Server-Tamagotchi / Vibe-Meter.** Kleines persistentes Wesen am Sidebar-Fuß lebt von Aktivität. Viel Chat = glücklich, tot = schläft. Owner lieben sichtbare Metriken die nicht wie Metriken aussehen.
- **3D-Server-Karte.** „Map"-Tab pro Guild: Channels als Inseln, Aktivität = Höhe + Leuchten. Voice-Channels mit Personen pulsen. Für große Server der einzige Weg „wo passiert grad was" zu sehen.
- **Reaction-Bombs.** 5 Leute innerhalb 2s dasselbe Emoji → Effekt eskaliert über alle Bildschirme (Konfetti, Wackeln, Sound). Auto-Hype-Generator.

## 15. Real-World-Bridge

- **Calendar-Sync mit Auto-DND.** Pulse liest iCal/Google → setzt Voice-DND automatisch in Meetings, postet „bin in Meeting bis 15:00" bei Pings.
- **SOS-Channel mit GPS-Share.** Wandergruppen, Festival-Crews: ein Tap → letzter Standort an alle im Channel + Push-Notif.

## 16. Wirtschaft als Feature (nicht als Monetarisierung)

- **Tipping in den Stream.** Viewer schickt 5€ während HQ-Stream → animiertes Overlay durch Stream + Voice-TTS liest Nachricht vor. Stripe-Connect / SEPA.
- **Async Voice-Threads** — eigenständige Kommunikations-Primitive: Frage als 20s-Voice-Clip im Chat, Antworten als 20s-Voice-Replies. Killer für verteilte Teams.

---

## 16.5 Härtung & Privacy (Brainstorm 2026-05-18, Michael+Claude)

*Trail einer Diskussion die mit „E2EE fehlt momentan oder?" begann. Kein PLAN, sondern Optionen-Map mit Tradeoffs.*

### Was Pulse heute hat
TLS für alle Wire-Connections, Argon2id für Passwörter, RS256-JWT (Key in File `chmod 0644`), Session-Management mit Device-List + Revoke (commit `6fbe736`). **Postgres-Volume und MinIO-Volume liegen Klartext auf der VPS-Disk. Kein automatisiertes Backup-System. 2FA fehlt.**

### Full-E2EE für Chat — *jetzt verworfen*
Tradeoffs zu massiv für ein Discord-artiges Produkt:
- Volltextsuche bricht (User erwartet das)
- Neue Member sehen History → bei MLS/Signal-Modell strukturell hart
- Push-Notif-Previews unmöglich
- Multi-Device-Key-Sync ist eine eigene Forschungsarbeit
- Self-Host-Story („dein Server, deine Kontrolle") liefert eh schon 80% der Privacy-Wirkung ohne diese Komplexität

Selektives E2EE (DMs only, Guild-Chat Klartext) wäre der Kompromiss — *falls überhaupt*. Nicht jetzt.

### Voice-Only-E2EE — *auf dem Tisch, technisch elegant*
LiveKit unterstützt es nativ (`setE2EEEnabled` + Insertable Streams + AES-GCM). Voice ist der einfache Fall weil:
- Audio ist flüchtig → Session-Keys reichen, keine Persistenz
- Keine Simulcast/Transcoding-Pipeline die bricht (Audio-Single-Layer)
- RFC 6464 Audio-Level-Extension bleibt sichtbar → „wer-redet-gerade" funktioniert weiter
- Recording/SIP-Bridge gibt's in Pulse eh nicht → kein Verlust
- Browser-Support 2026 ist gut (Chrome/FF 119+/Safari 17+/Electron)

**Drei Probleme die echte Architektur-Arbeit kosten:**

1. **Trust-Bootstrap / Phantom-Participant-Risk.** Server-Owner könnte theoretisch einen Phantom in den Room injizieren der den Room-Key per Ratcheting bekommt. Wäre aber als regulärer Participant im UI sichtbar — also kein *silent* Mithören. Akzeptables Risiko ohne Safety-Numbers-UX.
2. **HQ-Stream (MediaMTX) bleibt Klartext.** Anderer Protokoll-Pfad, MediaMTX muss RTMP demuxen → strukturell kein E2EE möglich ohne komplett anderes Transport. UI-Falle: User aktiviert „Voice-E2EE", denkt Channel sei sicher, startet aber dann einen HQ-Stream der serverseitig lesbar ist. Muss klar kommuniziert oder im E2EE-Mode deaktiviert werden.
3. **Browser-Screenshare via LiveKit.** Wenn E2EE pro Room gilt: Screenshare auch verschlüsselt, kein Server-Side-Simulcast mehr. Drei Lösungen besprochen (Per-Track-Flag, zwei Rooms, MediaMTX-WHIP-Pfad) — **alle vom User abgelehnt** als „nicht so gut". Status: ungelöst, blockiert Voice-E2EE in seiner sauberen Form.

**Aufwand falls jemals umgesetzt:** ~Wochenende für Basis, +1 Woche für Safety-Numbers-Verification-UI.

### At-Rest-Encryption — *Spektrum, kein Schalter*

**Postgres TDE existiert nicht in vanilla.** Vier Layer mit echten Tradeoffs:

- **Volume-LUKS auf VPS:** Theater, weil Key beim Boot verfügbar sein muss → liegt auf der Maschine. Ohne TPM/Remote-Unlock (Hetzner-VPS hat beides nicht standardmäßig) kein echter Gewinn gegen Hypervisor-Snapshot.
- **`pgcrypto` Column-Encryption:** Selektiv (z.B. nur DM-Inhalte). Schützt gegen DB-Dump-Leak. Volltextsuche bricht in den verschlüsselten Spalten, Key-Rotation ist Migration. App-Compromise = Game Over.
- **Encrypted Backups:** *Der billigste reale Win.* Schützt den häufigsten Vektor („Backup landet wo es nicht hingehört"). Live-DB bleibt aber Klartext.
- **Confidential Computing** (SEV-SNP/TDX): Overkill, Hetzner-Standard hat's nicht.

### „Laufende DB verschlüsseln" — *strukturell unmöglich stärker als At-Rest*

Intuitiv klingt „DB ist verschlüsselt *während* sie läuft" nach mehr Schutz als „Files at rest verschlüsselt". **Ist es aber nicht** — und das ist eine physikalische Eigenschaft, kein Implementierungs-Versäumnis:

Postgres muss Queries ausführen → muss Daten lesen → braucht Klartext im RAM → braucht den Schlüssel im RAM. Wer Zugriff auf den laufenden Prozess hat (Root, Container-Escape, Memory-Dump), hat auch den Schlüssel. **Jede „running DB encryption"-Lösung schützt gegen dasselbe Threat-Model wie At-Rest: Cold-Disk-Acquisition. Niemals gegen laufenden Server-Compromise.**

Optionen die's konkret gibt:

- **Cybertec PostgreSQL TDE / EDB Advanced Server.** Echte Block-Level-Encryption *innerhalb* von Postgres. Kosten: offizielles `postgres:16-alpine`-Image verlassen, eigener Update-Pfad statt Watchtower-`:latest`, kleinerer Community-Support, ~5-10% IO-Overhead. **Schutzwirkung identisch zu Volume-LUKS** — nur an einer anderen Schicht. Lohnt sich auf einer Hetzner-VPS exakt genauso wenig.
- **HSM-backed Column-Encryption** (`pgcrypto` mit Schlüssel im YubiHSM/Cloud-KMS). Spannender weil der Key den HSM **nie verlässt** — kompromittierter Pulse-Server kann während Zugriff decrypten, aber kein Massen-Decrypt auf geklautem DB-Dump nach Rauswurf. Kosten: HSM-Hardware (~600€ YubiHSM) oder monatliche KMS-Kosten, Performance-Hit pro Decrypt-Roundtrip. Realistisch nur für selektive Spalten (DM-Inhalte), nicht „alle Messages immer".
- **Confidential Computing** (siehe oben) — schützt RAM gegen Hypervisor, aber nicht gegen In-VM-Compromise. Provider-Support fehlt für Pulse-Stack.
- **Searchable / Homomorphic Encryption.** Operiert auf Ciphertext. 100-10000× langsamer, bricht Indizes, kann kaum Range-Queries oder JOINs. Forschungs-Niveau. **Nicht realistisch.**

**Kerngedanke:** „laufender Server soll Klartext nicht haben" geht nur mit (a) E2EE — Client-Side-Krypto, Server sieht's nie, oder (b) Hardware-Enklave — Hardware versteckt RAM vorm Operator. Beides mit den schon dokumentierten Tradeoffs. Es gibt keine dritte Option auf der Software-Schicht — das ist eine fundamentale Eigenschaft davon, dass ein Server etwas mit den Daten *tun* muss.

### Encrypted Backups — *konkretes Plan-Skelett, awaiting greenlight*

Stand der Entscheidungen aus dem Gespräch:
- **Tool:** `restic` (Dedup + Inkremental + Integrity + eigene Encryption integriert → kein `age` zusätzlich)
- **Scope:** Postgres + MinIO + avatars + guild_icons — alles in einem Sidecar
- **Ziel:** erstmal lokal (`pulse_backups`-Volume), Multi-Backend-ready via `RESTIC_REPOSITORY`-URI-Switch
- **MinIO:** Snapshot via `mc mirror` → restic (konsistenter als Direct-Read am Volume-Layout)
- **Frequenz:** PG täglich 04:00 UTC, MinIO alle 6h, avatars/icons täglich

Phasen (ungestartet):
1. restic-Passphrase generieren (`openssl rand -base64 32`), in Password-Manager + Papier
2. Service `pulse_backup` in `infra/prod/docker-compose.yml`
3. `infra/prod/backup/Dockerfile`: alpine + restic + postgresql-client + mc + tini
4. `infra/prod/backup/backup.sh` mit Tags (`pg`, `minio`, `avatars`)
5. Busybox-crond für Schedule
6. `pulse_backups`-Volume im Compose
7. `RESTIC_PASSWORD` + `RESTIC_REPOSITORY` in `.env.example`
8. `infra/prod/backup/restore.md` mit Recovery-Runbook
9. **Restore-Drill auf Laptop** vor Production-Aktivierung (ein Backup nicht restored = kein Backup)
10. `DEPLOY.md` updaten + TODO: „lokales Repo → Off-Host-Move" (lokal allein ist kein echtes Backup; Disk-Loss = beides weg)
11. Monitoring: `/repo/last-backup-ok`-Timestamp-File als Healthcheck

Server-Compromise-Hardening (später): Append-Only via `rest-server` oder S3-IAM-Lock — sonst kann ein kompromittierter Sidecar das Repo löschen.

### Was *jetzt* ohne Feature-Verzicht passieren sollte (Priorisierung)

1. **Encrypted Backups** — Phase 1 oben, ~Wochenend-Setup, größter Sicherheits-pro-Aufwand-Punkt
2. **2FA / Passkeys** — Auth ist heute 1FA, ist die größte echte Lücke
3. **Audit-Log für Admin-Aktionen** — Transparenz statt Verhinderung, Trust-Building für Member auf fremden Servern (Matrix macht's so)
4. **Disappearing Messages** als Channel-Opt-In — Discord-Feature, reduziert Blast-Radius retrospektiv, kein Krypto
5. **Reproducible Builds + Image-Signing** (Sigstore/Cosign) — Supply-Chain-Schutz, passt zum Self-Host-Ethos; Flatpak ist schon GPG-signed, Docker-Images noch nicht

### Verworfen oder geparkt

- Full-Chat-E2EE (Feature-Verlust zu hoch)
- Browser-Screenshare entkoppeln von LiveKit (User abgelehnt)
- Volume-LUKS auf VPS (Theater ohne TPM/Remote-Unlock)
- Confidential Computing (Provider-Support fehlt)

---

## 17. Monetarisierung

### Drei Modelle die zu Pulse passen

#### A. Managed Hosting (Free → Pro → Team)
Quasi schon angefangen via `pulse.unicutmedia.com`. Skalierung beherrschbar, meiste Leute *wollen* nicht selbst hosten.

- **Free:** kleine Server (≤30 Members), Standard-Voice/Chat, keine HQ-Stream-Cloud-Capacity
- **Pro (5-10€/Monat pro Owner):** unlimited Members, Custom-Domain, Custom-Logo/Theme, mehr Attachment-Storage, längere Retention
- **Team (~30€/Monat):** Audit-Log, SSO, garantierte Uptime, prio Support

Tradeoff: Du wirst Ops-Mensch für andere. Aber kein anderes OSS-Modell skaliert so vorhersehbar.

#### B. Cloud-Add-ons für Self-Hoster (die Goldgrube)
Self-Host gratis, aber bestimmte Features brauchen Cloud-Komponente die teuer/nervig im Eigenbetrieb ist:

- **Push-Notification-Relay** (APNS/FCM) — ~2€/Monat pro Self-Host-Instance
- **AI-Features** (Transcription, Translation, Catchup-Summary, Stream-Commentary) — auf eurer GPU-Infra, pay-per-use oder Flat
- **Backup-Service** (DB+S3 → B2/Wasabi automatisch)
- **Pulse-Network-Identity** (`pulse.com`-SSO aus `IDENTITY_CONCEPT.md` — Minecraft-Modell)
- **Federation-Bridge** (DMs zwischen Self-Host-Instanzen routen)

Vorteil: Self-Hoster zahlen *gerne* für Convenience-Cloud-Bits ohne sich gegängelt zu fühlen. Bitwarden-Modell.

#### C. Hybrid-Lizenz (AGPL oder BSL + Commercial)
Open für Personal/kleine Communities, kommerzielle Nutzung ab Seat-Count oder Hosted-Reselling braucht Lizenz.

- **AGPL-3.0:** wer modifiziert *und* anbietet muss Code offenlegen → schützt vor „großer Anbieter forkt + hostet Pulse-Pro". MongoDB-Start, GitLab heute.
- **BSL:** „4 Jahre nur ihr dürft hosten, danach Apache" — Sentry, CockroachDB, HashiCorp. Härter aber durchsetzbar.
- **Commons Clause auf MIT:** „nutzbar, nicht für Verkauf der Software". Leichteste, juristisch grauer.

Memory `project_pulse_license_status.md` sagt: keine LICENSE-Datei da. → Lizenz-Wahl jetzt = keinerlei Painful-Relicensing später (Elastic-Pain vermeiden).

### Anti-Modelle für Pulse

- ❌ **Reine Donations.** Deckt nie Vollzeit für Consumer-Produkte.
- ❌ **Werbung im Hosted-Service.** Tötet Friend-Server-Vibes. Discord hat's auch nicht — kein Zufall.
- ❌ **Pure Consulting/Support.** Skaliert mit dir, nicht mit Software. Nur Slack-Konkurrent-Pfad, anderer Markt.
- ❌ **NFTs / Crypto als Kerngeschäft.** Wäre 2021. SEPA/Stripe-Tipping als Feature ja, als Säule nein.

### Pulse-spezifische Goldnuggets

1. **HQ-Streaming-Cloud-Capture.** Heute Linux+Electron-only weil GSR. Ein gehosteter Capture-Service wo Mac/Windows-User per Browser-Screenshare den Stream zu eurem MediaMTX schicken + ihr GPU-encodet → bezahlter Service. Doppelter Win: Mac/Windows-Reichweite ohne Rust-Helper-Build (siehe `project_windows_capture_research`).

2. **Pulse-Network-Identity (`pulse.com`-SSO).** Konzept existiert (`IDENTITY_CONCEPT.md`). Ein Account über alle Self-Host-Instanzen (Minecraft-Modell). Self-Hoster aktiviert für 2€/Monat pro Instance → Avatar-Sync, Cross-Instance-DMs, Friend-Adds across Hosts. **Das ist der Moat den niemand replizieren kann ohne euren Identity-Server.** Sollte als Strategie-Anker behandelt werden, nicht nur als Feature.

3. **Öffentliches Server-Verzeichnis als Opt-in (Entscheidung 2026-07-13: später).** Server bleiben default privat (nur Einladungslink); Betreiber können ihren Server später freiwillig listen lassen — denkbar als Bezahl-Feature oder Teil des Hosting-Abos. Bringt Moderationspflichten mit (Melde-/Prüfwesen), deshalb bewusst zurückgestellt, bis Nachfrage da ist. Passt als Baustein zu Phase 3 (Ökosystem).

### Phasen-Plan (Empfehlung)

- **Phase 1 (erledigt 2026-07-25):** source-available + CLA. Client = PolyForm Perimeter 1.0.0, Server = PolyForm Free Trial 1.0.0 (vorher AGPL-3.0 — die erlaubte jedem, gratis selbst zu betreiben, damit war Self-Hosting als bezahlter Dienst nicht durchsetzbar). CLA gibt weiterhin das Recht für separate Kommerzlizenzen.
- **Phase 2 (~50 zahlende Server-Owner Hosted):** Cloud-Add-ons launchen, beginnend mit Mobile-Push-Relay. Niedriger Preis, geringe Engineering-Last, validiert Zahlungsbereitschaft.
- **Phase 3 (Cloud-Add-ons profitabel):** Pulse-Network-Identity ausrollen. Punkt an dem Pulse vom „Discord-Klon den eine Person betreibt" zum „eigenständiges Ökosystem" wird.
- **Phase 4 (echte Enterprise-Anfragen):** SSO/Audit/SLA-Tier nur reaktiv bauen, nicht spekulativ.

---

## 18. Claude-Favoriten quer durch alle Runden

Falls die Liste oben überwältigt — meine drei „würde ich tatsächlich zuerst bauen":

1. **Shared Cursors auf Streams** — sehr sichtbarer Wow-Moment, kleiner Scope, definiert Pulse sofort gegen Discord.
2. **Pomodoro/Focus-Voice-Modus** — öffnet eine andere Zielgruppe ohne zweite App.
3. **Highlight-Clip-Hotkey** — sofort verständlich, würden Streamer überall benutzen.

Plus als „Story-Pakete" wenn man Marketing denken will:
- *„Pulse = Discord + Coworking":* Pomodoro + Whiteboard + Calendar
- *„Pulse = Discord + Streamer-Suite":* Highlight-Hotkey + Scene-Switcher + LED/Stream-Deck
- *„Pulse = Discord + Spielzeug":* Cinema-Mode + DJ + Werewolf + 3D-Avatare (emotional stärkste, am schwersten zu vermarkten)

---

## 19. Nicht-Ziele dieser Datei

- Keine Verpflichtung. Alles hier ist „könnte man".
- Keine Schätzungen für Aufwand jenseits grob-qualitativ (klein/mittel/groß) — Spec-Arbeit kommt bei konkreter Auswahl.
- Keine PLAN.md-Konkurrenz. PLAN.md beschreibt was ist, hier liegt was sein könnte.
