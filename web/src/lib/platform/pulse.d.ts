/**
 * Shape of `window.pulse` — the API the Electron preload script
 * (`desktop/electron/preload.ts`) exposes via contextBridge (E1a + E1b).
 *
 * Keep this in sync with `desktop/electron/preload.ts`. The GSR method
 * signatures intentionally mirror `gsr.ts`'s `GsrStartArgs` / `Gsr*` response
 * types — but we keep the bridge surface loosely typed (responses as
 * `Promise<unknown>`, args as `unknown`) so the sidecar protocol can evolve
 * without touching the preload; `gsr.ts` does the precise casting on its side.
 *
 * `window.pulse` is `undefined` in a plain browser — always optional-chain it.
 */

/** Async sidecar event payload (`{ev:..,...}`). The narrow union lives in
 *  `$lib/stream/gsr.ts` (`GsrEvent`); here it's just "some object". */
export type PulseGsrEvent = Record<string, unknown>;

/** Persistent key-value store (E1c) — backed by `<userData>/pulse-stream.json`
 *  in the Electron main process (`desktop/electron/store.ts`). Used by
 *  `$lib/stream/persistence.ts`. Values are JSON-serialisable; reads return
 *  `unknown` and the caller casts. */
export interface PulseStoreApi {
  get(key: string): Promise<unknown>;
  getAll(): Promise<Record<string, unknown>>;
  /** Synchronous snapshot of the whole store (boot-time fast path for the
   *  multi-server list). Backed by `store:getAllSync` (sendSync IPC). */
  getAllSync(): Record<string, unknown>;
  set(key: string, value: unknown): Promise<void>;
  /** Atomically write multiple key-value pairs in one IPC round-trip
   *  (finding 158). Values must be JSON-serialisable. */
  setAll(values: Record<string, unknown>): Promise<void>;
}

/** Welcher Linux-Sidecar läuft — und warum. Spiegelt `LinuxBackendInfo` in
 *  `desktop/electron/sidecar.ts`.
 *   - `rust`/`default`  → Normalfall.
 *   - `gsr`/`forced`    → bewusst auf den älteren Weg zurückgestellt.
 *   - `gsr`/`fallback`  → Rust-Binary fehlt, automatisch zurückgefallen;
 *                         `detail` trägt die Resolver-Fehlermeldung. */
export interface PulseLinuxBackend {
  kind: 'rust' | 'gsr';
  reason: 'default' | 'forced' | 'fallback';
  detail?: string;
}

export interface PulseGsrApi {
  health(): Promise<unknown>;
  gpuInfo(): Promise<unknown>;
  /** Enumerate display monitors (Windows + macOS — Linux uses the portal picker). */
  listMonitors(): Promise<unknown>;
  /** Enumerate capturable windows (macOS source picker). */
  listWindows(): Promise<unknown>;
  listApplicationAudio(): Promise<unknown>;
  buildArgv(args: unknown): Promise<unknown>;
  /** Start a stream in the given slot (0 = primary, 1 = a second concurrent
   *  stream e.g. a second monitor). Defaults to slot 0. */
  start(args: unknown, slot?: number): Promise<unknown>;
  /** Stop the stream in the given slot (default 0). */
  /** `grund` ist reine Diagnose — er landet in der Protokollzeile des Befehls
   *  (`sidecar-log-befehle.ts`) und wird vom Sidecar ignoriert. */
  stop(slot?: number, grund?: string): Promise<unknown>;
  /** Welcher Linux-Sidecar läuft und warum. `null` auf anderen Plattformen
   *  oder wenn gar kein Sidecar auffindbar ist. Startet nichts. */
  backend(): Promise<PulseLinuxBackend | null>;
  /**
   * Fernsteuerung, HOST-Seite: Eingabe-Frames in den Sidecar des gemeinten
   * Stream-Platzes einspielen. Der Renderer empfaengt sie als `remote_input`
   * auf seiner App-WebSocket und reicht sie unveraendert weiter — der
   * Hauptprozess hat keine Verbindung zum Gateway.
   *
   * Antwort wie ueberall hier lose typisiert; `$lib/remote/sidecarInput.ts`
   * wertet daraus nur `ok` aus. **`ok:false` heisst fail-closed** — der Sidecar
   * hat die Eingabe-Sitzung stillgelegt, und der Renderer beendet daraufhin die
   * Fernsteuerung.
   *
   * Fehlt in aelteren Shells, deshalb optional: ohne sie kann dieser Rechner
   * nicht ferngesteuert werden, und der Renderer laesst die Sitzung fallen.
   */
  remoteInput?(
    slot: number,
    sessionId: string,
    frames: string[],
    /** Ein ANDERER Stream-Platz meldet gerade Vorrang des Hosts — die Frames
     *  werden dann auch dort verworfen (`$lib/remote/vorrang.ts`). */
    hostAktiv?: boolean,
  ): Promise<unknown>;
  /** Sitzungsende — der Sidecar gibt alles Gedrueckte frei. Ohne diesen Ruf
   *  bliebe nach einem Abbruch eine Taste gedrueckt. Idempotent. */
  remoteInputEnd?(): Promise<unknown>;
  /** Subscribe to sidecar events. Each event carries a `slot` field tagged by
   *  the main process so the renderer can route it to the right stream. Returns
   *  an unsubscribe function. */
  onEvent(cb: (ev: PulseGsrEvent) => void): () => void;
}

/** Payload for `pulse.notify.show()` — mention/DM toast. The renderer is
 *  responsible for gating these on `document.hidden || !document.hasFocus()`;
 *  main shows unconditionally when called.
 *
 *  Linux quirk: `icon` MUST be a local file path (or omitted). HTTP(s) URLs
 *  are silently dropped by main — Electron/libnotify can't async-fetch them. */
export interface PulseNotifyShowPayload {
  title: string;
  body: string;
  icon?: string;
  channel_id: string;
  guild_id?: string | null;
  message_id: string;
  /** Explicit click destination (SPA path). When set, overrides the
   *  channel-derived URL — friend-event notifications open /app/friends. */
  target_url?: string;
}

/** Payload delivered to `pulse.notify.onClick()` listeners. Main has already
 *  raised + focused the window by the time this fires; the renderer just
 *  needs to navigate to the channel/message. */
export interface PulseNotifyClickPayload {
  channel_id: string;
  guild_id?: string | null;
  message_id: string;
  /** Set when the notification carried an explicit target (friend events). */
  target_url?: string | null;
}

export interface PulseNotifyApi {
  /** Show a system notification. Returns an internal id (mostly for pattern
   *  consistency with the GSR bridge — the renderer doesn't need it today). */
  show(payload: PulseNotifyShowPayload): Promise<string>;
  /** Subscribe to notification clicks. Returns an unsubscribe function. */
  onClick(cb: (data: PulseNotifyClickPayload) => void): () => void;
}

/** Invite deep-link payload — delivered by main after strict URL validation.
 *  `hostname` is a bare FQDN (e.g. "howispulse.com"), NOT a full URL.
 *  `code` is the invite code (alphanumeric, 6-64 chars). The frontend shows a
 *  disclaimer before touching the server. */
export interface PulseInvitePayload {
  hostname: string;
  code: string;
}

/** Invite deep-link bridge (Phase 5.3). Exposed via preload on pulse://invite URLs. */
export interface PulseInviteApi {
  /** Subscribe to incoming invite deep-links. Returns an unsubscribe function. */
  onLink(cb: (data: PulseInvitePayload) => void): () => void;
  /** Pull any deep-link that arrived before onMount / the onLink listener was
   *  registered (finding 156). Returns the buffered payload or null. */
  getPending(): Promise<PulseInvitePayload | null>;
}

/** Auto-Update bridge (Windows packaged builds). Main (`updater.ts`) runs
 *  electron-updater and downloads updates itself; the renderer only shows the
 *  „Update bereit" banner and triggers the immediate restart. `onReady` never
 *  fires in dev / browser / on Linux (main gates the updater on app.isPackaged
 *  && win32). Optional on `PulseApi` — only present under Electron. */
export interface PulseUpdatesApi {
  /** An update was found on the server (download in progress). Returns an unsubscribe function. */
  onAvailable(cb: (data: { version: string }) => void): () => void;
  /** Download progress of the current update (0–100). Returns an unsubscribe function. */
  onProgress(cb: (data: { percent: number }) => void): () => void;
  /** Update downloaded and ready to install. `autoRestart=true` ⇒ main installs +
   *  restarts automatically (only within the start-up window). Returns an unsubscribe function. */
  onReady(cb: (data: { version: string; autoRestart: boolean }) => void): () => void;
  /** Install the downloaded update and restart now (banner button). */
  restartNow(): Promise<void>;
  /** Manually re-trigger an update check (the start-up check runs automatically). */
  check(): Promise<void>;
}

/** Display-sleep inhibitor bridge. The renderer (`$lib/platform/wakeLock`)
 *  refcounts leases and toggles this on the 0↔1 boundary while a watch-party /
 *  HQ stream is actively playing; main holds one `powerSaveBlocker`. Returns
 *  whether the blocker is currently active. */
export interface PulsePowerApi {
  keepAwake(on: boolean): Promise<boolean>;
}

/** Native clipboard image access (paste). The sandboxed remote renderer can't
 *  read a pasted image's bytes itself (size 0), so this returns the current
 *  clipboard image as PNG bytes via the main process. Null when the clipboard
 *  holds no image. Optional — only present under a current Electron shell. */
export interface PulseClipboardApi {
  readImage(): Promise<Uint8Array | null>;
}

/** Native dropped-file byte access (drag & drop). Resolves a genuinely dropped
 *  `File` to its OS path (via webUtils, in the preload) and reads the bytes in
 *  main — recovering the content the sandboxed renderer sees as 0 bytes.
 *  Returns null for non-file Files (JS-constructed, no OS path) or on error. */
export interface PulseFilesApi {
  readDropped(file: File): Promise<Uint8Array | null>;
}

/** OS-global keyboard shortcuts (background toggles). The renderer hands main
 *  the background-capable bindings (voice/stream toggles), already converted to
 *  Electron accelerators, and dispatches `onTrigger` ids through its own handler
 *  registry — so they fire while Pulse is unfocused. Main-side in `shortcuts.ts`.
 *  Optional — only present under a current Electron shell. */
export interface PulseShortcutsApi {
  /** Replace the registered global accelerators. Push on boot + on every rebind. */
  setGlobal(list: Array<{ id: string; accelerator: string }>): Promise<void>;
  /** Fires with the action id when a registered global shortcut is pressed.
   *  Returns an unsubscribe function. */
  onTrigger(cb: (id: string) => void): () => void;
}

/** Antwort von `pulse.accessibility.isTrusted()`. */
export interface PulseAccessibilityResult {
  /** Ist DIESER Prozess (also der vom Hauptprozess gestartete Sidecar,
   *  s. `main.ts::wireAccessibility`) aktuell fuer Eingabe-Injektion vertraut?
   *  Ausserhalb von macOS immer `true` — dort gibt es keine Huerde. */
  trusted: boolean;
  /** Nur gesetzt, wenn `trusted === false`. Der vorgeschriebene Hinweistext
   *  (main-seitig gebaut, damit er nie neu erfunden und dabei verkuerzt wird):
   *  die Freigabe haengt an der Code-Signatur, das mac-DMG ist nur ad-hoc
   *  signiert, und nach jedem Update bleibt der Haken in den
   *  Systemeinstellungen SICHTBAR STEHEN, obwohl er nicht mehr gilt. Eine
   *  Anzeige, die nur "Freigabe fehlt" sagt, fuehrt dazu, dass jemand den
   *  bestehenden (wirkungslosen) Haken anklickt und sich wundert. */
  hint?: string;
}

/**
 * macOS-Anstoss zur Bedienungshilfen-Freigabe (Fernsteuerung, Host-Seite).
 *
 * Sitzt im Electron-Hauptprozess statt im Sidecar, weil TCC die Freigabe dem
 * VERANTWORTLICHEN Prozess zuordnet: ein vom Hauptprozess gestarteter
 * Sidecar erbt Pulses Freigabe, der Systemdialog nennt also "Pulse" statt
 * eines Sidecar-Binaernamens (gemessen,
 * `docs/plans/2026-08-23-macos-eingabe-messungen.md`, Messung 1). Der
 * Sidecar selbst prueft nur noch einmal live nach, ob die geerbte Freigabe
 * fuer IHN gilt (`mac-hq-sidecar/src/berechtigung.rs`), fragt aber nie nach.
 */
export interface PulseAccessibilityApi {
  /**
   * `prompt=true` wirft bei fehlender Freigabe EINMALIG den macOS-Systemdialog
   * auf (pro Prozess-Lebensdauer merkt sich macOS, dass schon gefragt wurde)
   * — deshalb nur auf eine Nutzerhandlung hin rufen, nie automatisch beim
   * Gesundheitscheck. `prompt=false`/weggelassen fragt nur den Ist-Zustand ab.
   */
  isTrusted(prompt?: boolean): Promise<PulseAccessibilityResult>;
}

// ── Host-Lifecycle types (③a) ────────────────────────────────────────────────

/** Zustand des lokalen Self-Host-Stacks (Phasen-Modell). */
export type HostPhase =
  | 'idle'
  | 'checking-network'
  | 'opening-door'
  | 'preparing'
  | 'going-live'
  | 'live'
  | 'needs-your-help'
  | 'not-possible-here'
  | 'something-paused'
  | 'needs-windows-setup'
  // Ablöse-Erkennung: periodischer Creds-Check fand ein eindeutiges 401 —
  // ein Re-Bootstrap auf einem ANDEREN Gerät hat clientSecret rotiert.
  // Terminal, bis der User "Gerät zurücksetzen" klickt (host:unpair).
  | 'superseded';

/** Phasen-Ereignis, das HostLifecycle via host:phase an den Renderer pusht. */
export interface HostPhaseEvent {
  phase: HostPhase;
  /** step: Fortschritts-Schritt innerhalb von 'preparing' (login/pull/run/health). */
  detail?: { relayUrl?: string; ports?: number[]; step?: string };
}

/** Optionen für window.pulse.host.start(). */
export interface HostStartOpts {
  /** Electron userData-Pfad (app.getPath('userData')). Wird intern an LocalBackendManager gereicht. */
  userData?: string;
  [key: string]: unknown;
}

/** Sanitisierter Pairing-Status (keine Secrets). */
export interface PairingStatus {
  paired: boolean;
  hostname?: string;
  instanceId?: string;
  relaySubdomain?: string | null;
}

/** Ergebnis von host.pair(). */
export interface PairResult {
  paired: boolean;
  error?: string;
  status?: PairingStatus;
}

/** Ergebnis von host.provision(). needsTakeoverConfirm: Bootstrap wurde schon
 *  einmal eingelöst — es läuft vermutlich ein eingerichteter Server auf einem
 *  anderen Gerät; Übernahme erst nach explizitem zweiten Aufruf mit
 *  `{ confirmTakeover: true }`. */
export interface ProvisionResult {
  ok: boolean;
  error?: string;
  needsTakeoverConfirm?: boolean;
}

/** Cloud-Registrierungs-Status (Directory-Heartbeat). true = registriert &
 *  auffindbar, false = läuft noch/offline, null = kein Signal (Netz/Session). */
export interface HostCloudStatus {
  registered: boolean | null;
}

/** "Deine Daten"-Karte: belegte Volume-Größe + Datum des letzten Exports. */
export interface HostDataInfo {
  sizeBytes: number | null;
  lastBackupAt: number | null;
}

/** Ergebnis von host.exportData(). canceled = Save-Dialog abgebrochen. */
export interface HostExportResult {
  ok: boolean;
  error?: string;
  canceled?: boolean;
}

/** Ergebnis von host.giveUp(). cloudDeleted null = bewusst übersprungen
 *  (superseded-Zustand); false = liegengeblieben → UI verweist auf den
 *  Client-Weg (Einstellungen → Self-Host → Meine Instanzen). */
export interface HostGiveUpResult {
  ok: boolean;
  cloudDeleted: boolean | null;
  dataDeleted: boolean | null;
  errors: string[];
}

/** Host-Lifecycle-Bridge (③a/③c). Steuert den lokalen Self-Host-Stack vom Renderer aus. */
export interface PulseHostApi {
  /** Stack starten — triggert die Phasen-Sequenz (checking-network → … → live / Fehler-Phase). */
  start(opts?: HostStartOpts): Promise<void>;
  /** Stack sauber stoppen → Phase 'idle'. */
  stop(): Promise<void>;
  /** Letztes Phasen-Ereignis abrufen (Snapshot, kein Subscribe). */
  getStatus(): Promise<HostPhaseEvent>;
  /** Zustands-Abgleich mit dem echten Container (überlebt App-Neustarts
   *  dank `--restart unless-stopped`) — hebt die Phase bei Bedarf auf 'live'. */
  refresh(): Promise<HostPhaseEvent>;
  /** Phasen-Events abonnieren. Gibt eine Unsubscribe-Funktion zurück. */
  onPhase(cb: (e: HostPhaseEvent) => void): () => void;
  /** Cloud-Bootstrap-Token einlösen und Pairing-Credentials speichern. */
  pair(bootstrapToken: string): Promise<PairResult>;
  /** Gespeicherten Pairing-Status abrufen (keine Secrets). */
  getPairing(): Promise<PairingStatus>;
  /** Login-basierte Auto-Provision (Server-App). Ohne `confirmTakeover` pausiert
   *  sie mit `needsTakeoverConfirm`, wenn schon ein Server eingerichtet ist. */
  provision(opts?: { confirmTakeover?: boolean }): Promise<ProvisionResult>;
  /** Cloud-Registrierungs-Status (Directory-Heartbeat) einmalig abfragen. */
  cloudStatus(): Promise<HostCloudStatus>;
  /** Cloud-Status-Updates abonnieren (60s-Poll aus dem Main-Prozess). */
  onCloudStatus(cb: (r: HostCloudStatus) => void): () => void;
  /** Autostart beim Anmelden — Schalter-Zustand (Store ist die Wahrheit). */
  getAutostart(): Promise<{ enabled: boolean }>;
  /** Autostart setzen/entfernen (Win/Mac: Login-Items; Linux: XDG-Autostart). */
  setAutostart(enabled: boolean): Promise<{ ok: boolean }>;
  /** "Deine Daten": belegte Volume-Größe + Datum des letzten Exports. */
  dataInfo(): Promise<HostDataInfo>;
  /** Alles exportieren (Save-Dialog → Container-Stopp → tar → Neustart). */
  exportData(): Promise<HostExportResult>;
  /** Export-Schritte abonnieren (stopping/exporting/restarting). */
  onExportStep(cb: (step: string) => void): () => void;
  /** "Server aufgeben": Container + Cloud-Registrierung + Pairing entfernen,
   *  optional inkl. lokaler Daten. Best-effort — Teilfehler im Ergebnis. */
  giveUp(opts?: { deleteData?: boolean }): Promise<HostGiveUpResult>;
  /** Pairing-Credentials löschen. */
  unpair(): Promise<void>;
  /** Gibt es eine Container-Runtime (Host-Podman/Docker)? Ohne die zeigt die
   *  App-Hosting-Karte den Setup-Hinweis statt des Start-Knopfs. */
  runtimeAvailable(): Promise<boolean>;
  /** Windows-Erststart-Assistent: WSL2 mit Admin-Abfrage installieren
   *  (Phase 'needs-windows-setup'). Nach ok ist meist ein Neustart nötig. */
  setupWindows(): Promise<{ ok: boolean }>;
}

/** OS-global keyboard shortcuts (background toggles). The renderer hands main
 *  the background-capable bindings (voice/stream toggles), already converted to
 *  Electron accelerators, and dispatches `onTrigger` ids through its own handler
 *  registry — so they fire while Pulse is unfocused. Main-side in `shortcuts.ts`.
 *  Optional — only present under a current Electron shell. */
export interface PulseShortcutsApi {
  /** Replace the registered global accelerators. Push on boot + on every rebind. */
  setGlobal(list: Array<{ id: string; accelerator: string }>): Promise<void>;
  /** Fires with the action id when a registered global shortcut is pressed.
   *  Returns an unsubscribe function. */
  onTrigger(cb: (id: string) => void): () => void;
}

export interface PulseApi {
  platform: 'electron';
  /** 'server' = Pulse Server-App (deren Login-Phase lädt die Web-App remote —
   *  darüber brandet sich die Login-Seite anders). Optional: ältere Shells
   *  liefern das Feld nicht → Client-Verhalten. */
  appMode?: 'client' | 'server';
  appVersion: string;
  /** Host OS as Node's `process.platform` (`win32` | `darwin` | `linux` | …).
   *  Authoritative platform signal for the native-update check
   *  (`$lib/platform/nativeUpdate`), which maps it to the `native.json` keys.
   *  Optional: shells built before this field fall back to UA detection. */
  os?: string;
  /** Echter Rechnername (Hostname) fürs Geräte-Label, z.B. "michaels-thinkpad".
   *  Nur die Desktop-App kann ihn lesen (im Browser gibt es keine API dafür).
   *  Optional: ältere Shells liefern ihn nicht → Fallback aufs OS. */
  deviceName?: string;
  store: PulseStoreApi;
  gsr: PulseGsrApi;
  /** Nativer HQ-Player (streaming/pulse-player). Nur unter Electron, und
   *  auch dort nur, wenn das Binary vorhanden ist — vorher `available()`
   *  fragen und sonst auf den `<video>`-Weg zurueckfallen. */
  player?: PulsePlayerApi;
  notify: PulseNotifyApi;
  invite?: PulseInviteApi;
  updates?: PulseUpdatesApi;
  power?: PulsePowerApi;
  shortcuts?: PulseShortcutsApi;
  clipboard?: PulseClipboardApi;
  files?: PulseFilesApi;
  /** macOS-Anstoss zur Bedienungshilfen-Freigabe (Fernsteuerung, Host-Seite).
   *  Nur unter Electron vorhanden; ausserhalb von macOS liefert sie stets
   *  `{trusted:true}` zurueck. */
  accessibility?: PulseAccessibilityApi;
  /** Host-Lifecycle-Bridge (③a). Nur unter Electron vorhanden. */
  host?: PulseHostApi;
  /** Tray-Status overlay: Renderer pusht Status + gerendertes Badge-Image;
   *  Main setzt Tooltip-Text + OS-Badge-Counter (macOS/Windows; Linux
   *  ignoriert den Counter, der Tooltip zeigt die Zahl trotzdem). */
  tray?: PulseTrayApi;
}

/** Payload für `pulse.tray.setStatus()`. Alle Felder optional — main filtert
 *  ungültige Typen und wendet den letzten gültigen Zustand an. */
export interface PulseTrayStatus {
  /** Mic ist aus (kein Audio-Send). PTT-off zählt NICHT — PTT ist semantisch
   *  keine Stummschaltung, sondern Hold-to-Talk. */
  muted?: boolean;
  /** Deaf (alle Remote-Audio gemutet). Impliziert visuell „mute" — gewinnt
   *  bei aktiver Auswahl gegen `muted`. */
  deafened?: boolean;
  /** Anzahl ungelesener Nachrichten. Treibt den OS-Badge-Counter (falls > 0)
   *  und den Tooltip-Text. */
  unread?: number;
  /** Anzahl @-Erwähnungen. Hat Vorrang vor `unread` für den Badge (Erwähnungen
   *  sind dringender); beide sind tooltipsichtbar. */
  mentions?: number;
}

export interface PulseTrayApi {
  setStatus(s: PulseTrayStatus): void;
  /** Ersetzt das Tray-Icon durch ein im Renderer gerendertes PNG (Canvas →
   *  data: URL). Trägt den dynamischen Badge (Counter / @). Main validiert
   *  das `data:image/`-Präfix. Liefert false bei ungültigem Input, sonst true. */
  setImage(dataUrl: string): Promise<boolean>;
}

/** Antwortrahmen des Players — identisch zum Sidecar-Protokoll. */
export interface PulsePlayerResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/** Zur Laufzeit umschaltbare Wiedergabe-Einstellungen. Nur gesetzte Felder
 *  wirken; der Player laesst alles andere unveraendert. */
export interface PulsePlayerOptions {
  /** Ziel-Fuellstand des Jitter-Puffers (0-2000 ms). */
  jitter_ms?: number;
  /** Debanding-Staerke 0.0-1.0. Glaettet Kompressions-Banding. */
  deband?: number;
  dither?: boolean;
  /** 1.0 = ganzes Bild, bis 16.0. */
  zoom?: number;
  pan_x?: number;
  pan_y?: number;
  volume?: number;
  av_offset_ms?: number;
  /** Standbild ohne Verbindungsabbruch. */
  paused?: boolean;
  /** Hardware-Decode erzwingen/verbieten; weglassen = automatisch. */
  hwdec?: boolean;
}

export interface PulsePlayerApi {
  /** false, wenn das Binary fehlt — dann NICHT umschalten. */
  available(): Promise<boolean>;
  health(): Promise<PulsePlayerResult>;
  open(params: {
    url: string;
    title?: string;
    fullscreen?: boolean;
    options?: PulsePlayerOptions;
  }): Promise<PulsePlayerResult>;
  close(session: number): Promise<PulsePlayerResult>;
  /** Fernsteuerung: Anzeigetext des Eingabewegs fürs Statistik-Feld
   *  („Direktverbindung" / „Serverweg — …"). Nur Anzeige — die
   *  Zustandsmaschine lebt in `$lib/remote/p2p.ts`. Optional wie `input`: die
   *  Web-App wird remote geladen, eine ältere Shell kennt die Brücke also
   *  nicht — dann bleibt nur die Anzeige aus. */
  transportStatus?(session: number, transport: string): Promise<PulsePlayerResult>;
  /** Fernsteuerung: Form des Host-Zeigers auf den lokalen Zeiger des Fensters
   *  setzen („text", „ns-resize", …) — das, was das Cursor-Echo aus dem Bild
   *  nimmt (`$lib/remote/zeigerform.ts`). Optional aus demselben Grund wie
   *  `transportStatus`: eine ältere Shell kennt die Brücke nicht, dann bleibt
   *  es beim Standardpfeil.
   *
   *  `bild` traegt die Pixel fuer Zeiger, die kein Name abbildet
   *  (Werkzeugzeiger von Schnitt-, Bild- und 3D-Programmen). Der Player nimmt
   *  sie, wenn er sie bauen kann, und faellt sonst auf `shape` zurueck. Eine
   *  aeltere Shell reicht das Feld nicht durch — dann greift ebenfalls `shape`. */
  pointerShape?(session: number, shape: string, bild?: unknown): Promise<PulsePlayerResult>;
  /** Fernsteuerung: die Bildschirme des fernen Rechners fuers Menue am Griff.
   *  Optional wie `pointerShape` — eine aeltere Shell kennt den Op nicht, und
   *  dann bleibt das Menue eben ohne Bildschirmliste. */
  screens?(session: number, screens: unknown[]): Promise<PulsePlayerResult>;
  /** Darf dieser Zuschauer eine Fernsteuerung anfragen? Zeigt den Knopf in der
   *  Bedienleiste des Fensters; der Klick kommt als `player:remoteRequest`. */
  anfragbar?(session: number, anfragbar: boolean): Promise<PulsePlayerResult>;
  setOption(session: number, key: string, value: unknown): Promise<PulsePlayerResult>;
  setOptions(session: number, options: PulsePlayerOptions): Promise<PulsePlayerResult>;
  /** Zaehler plus `decoder`, `hardware_decode`, `surface_format` — damit ist
   *  von aussen belegbar, welcher Decoder und welche Bittiefe anliegen. */
  stats(session: number): Promise<PulsePlayerResult>;
  /** Fenster nach vorne holen. Unter Wayland darf sich ein Fenster nicht selbst
   *  nach vorne zwingen — der Compositor entscheidet, die Antwort sagt nur, dass
   *  die Bitte angekommen ist. */
  focus(session: number): Promise<PulsePlayerResult>;
  /** Mitschnitt starten. Zielpfad bestimmt der Hauptprozess, er steht als
   *  `path` in der Antwort. */
  record(session: number): Promise<PulsePlayerResult>;
  stopRecord(session: number): Promise<PulsePlayerResult>;
  /** Letzte `seconds` Sekunden aus dem Ringpuffer sichern (1-60). */
  clip(session: number, seconds?: number): Promise<PulsePlayerResult>;
  onEvent(cb: (ev: unknown) => void): () => void;
  /** Fernsteuerung — Eingabe-Erfassung im Player-Fenster. Fehlt in aelteren
   *  Shells, deshalb optional. */
  input?: PulsePlayerInputApi;
}

/** Die Huelle des Eingabewegs auf dem Serverweg — Byte-Format und Grenzen in
 *  `docs/plans/2026-08-12-input-wire-protokoll-v2.md`. Der Renderer setzt diese
 *  Nachricht **unveraendert** auf seiner bestehenden Gateway-WebSocket ab; der
 *  Hauptprozess hat keine eigene Verbindung dorthin. */
export interface PulseRemoteInputNachricht {
  op: 'remote_input';
  /** Die per Consent bestaetigte Fernsteuerungs-Sitzung. */
  session_id: string;
  /** Welcher der gleichzeitig laufenden Streams des Hosts gemeint ist. */
  slot: number;
  /** Base64-Frames, in Reihenfolge — hoechstens 32 je Nachricht (der
   *  Hauptprozess teilt bereits auf). */
  frames: string[];
}

export interface PulsePlayerInputApi {
  /** Erfassung einschalten. Erst danach gehen Frames heraus. `pointerLock`
   *  faengt den Zeiger im Fenster (Spiele): dann werden relative statt
   *  absoluter Bewegungen gesendet. Ob der Fang wirklich gelang, steht als
   *  `pointer_lock` in der Antwort. */
  start(
    session: number,
    sessionId: string,
    slot?: number,
    pointerLock?: boolean,
  ): Promise<PulsePlayerResult>;
  /** Erfassung ausschalten. Fuer alles Gedrueckte kommt danach noch das
   *  Hoch-Ereignis ueber `onFrames` — ohne das bliebe beim Host eine Taste
   *  haengen. */
  stop(session: number): Promise<PulsePlayerResult>;
  /** Fertige Nachrichten zum Absetzen. Liefert eine Abmelde-Funktion. */
  onFrames(cb: (nachricht: PulseRemoteInputNachricht) => void): () => void;
}

declare global {
  interface Window {
    pulse?: PulseApi;
  }
}
