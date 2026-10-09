// Host-Lifecycle: verkettet ① + ②b zu einer menschlichen Phasen-Sequenz.
// classifyHostOutcome ist die reine Entscheidung nach der Diagnose — voll testbar.

export type HostPhase =
  | 'idle' | 'checking-network' | 'opening-door' | 'preparing'
  | 'going-live' | 'live' | 'needs-your-help' | 'not-possible-here' | 'something-paused'
  | 'needs-windows-setup'
  // Ablöse-Erkennung: der periodische Creds-Check (main.ts) fand ein
  // eindeutiges 401 gegen den Registry-Token-Realm — clientSecret wurde durch
  // einen Re-Bootstrap auf einem ANDEREN Gerät rotiert. Terminal, bis der
  // User "Gerät zurücksetzen" klickt (host:unpair → resetToIdle()).
  | 'superseded';

/** Warum die Phase 'superseded' ist: 'rotated' = Re-Bootstrap auf einem anderen
 *  Gerät hat clientSecret rotiert (Geräte-Umzug); 'deleted' = die Instanz wurde
 *  auf der Cloud gelöscht — das Pairing ist wertlos, die UI bietet dann "Neu
 *  einrichten" statt des Umzugs-Hinweises an. */
export type SupersededReason = 'rotated' | 'deleted';

export interface HostPhaseEvent {
  phase: HostPhase;
  /** step: Fortschritts-Schritt innerhalb von 'preparing' (login/pull/run/health)
   *  — der erste Pull lädt mehrere hundert MB, die UI soll das benennen können. */
  detail?: {
    relayUrl?: string; ports?: number[]; step?: string; reason?: SupersededReason;
    /** 'something-paused': Klartext-Grund aus dem Backend (belegter Port,
     *  fehlendes Docker-Recht, gescheitertes Update …) — vorher landete er
     *  nur in console.error, die UI sagte bloß „Pause". */
    fehler?: string;
  };
}

export type ReachVerdict = 'reachable' | 'needs-forwarding' | 'cgnat' | 'unknown';
export type MapVerdict = 'mapped' | 'partial' | 'cgnat' | 'unsupported';

export function classifyHostOutcome(
  reach: ReachVerdict, map: MapVerdict | null,
): { outcome: 'go' | 'needs-your-help' | 'not-possible-here' | 'something-paused' } {
  if (reach === 'cgnat' || map === 'cgnat') return { outcome: 'not-possible-here' };
  if (reach === 'unknown') return { outcome: 'something-paused' };
  if (reach === 'reachable') return { outcome: 'go' };
  // reach === 'needs-forwarding': only a working port-mapping lets us host.
  if (map === 'mapped') return { outcome: 'go' };
  return { outcome: 'needs-your-help' };
}

export interface ReachResult { verdict: ReachVerdict; publicIp: string | null }
export interface MapResult { verdict: MapVerdict; openPorts: number[]; failedPorts: number[] }

export interface HostDeps {
  /** Optionale Plattform-Voraussetzung VOR allem anderen (Windows: WSL2 für
   *  podman machine). 'needs-windows-setup' → eigene Karte mit dem
   *  Erststart-Assistenten statt einer generischen Fehlerphase.
   *  'not-possible-here' → nativer Backend-Pfad ohne gebündelte Binaries. */
  checkPrereqs?(): Promise<'ok' | 'needs-windows-setup' | 'not-possible-here'>;
  startBackend(opts: { media: boolean; onProgress?: (step: string) => void }): Promise<void>;
  stopBackend(): Promise<void>;
  checkReachability(): Promise<ReachResult>;
  mapPorts(stunIp: string | null): Promise<MapResult>;
  relayUrl(): string | null;
}

export class HostLifecycle {
  private _last: HostPhaseEvent = { phase: 'idle' };
  private _cbs: Array<(e: HostPhaseEvent) => void> = [];
  private readonly deps: HostDeps;
  private readonly opts: { holePunch?: boolean };
  /** Der gerade laufende exklusive Ablauf — Start, Update-Recreate oder
   *  Export/Import (Single-Flight, Scan 2026-10-08). Ohne ihn startete ein
   *  Kontowechsel (`wendeBenutzerAn` → `start()`) und der fast gleichzeitige
   *  `host:me`-Abgleich den Server zweimal — nativ liefen dann zwei Postgres
   *  auf demselben Datenverzeichnis. Linux-Scan: das tägliche Update und ein
   *  Import liefen an der Sperre vorbei — ein Abmelden während des Updates
   *  hinterließ einen laufenden Server, ein Start mitten im Import ein
   *  Postgres auf einem Volume, das gerade getauscht wird. */
  private _laufend: Promise<void> | null = null;
  constructor(
    deps: HostDeps,
    /** holePunch: Server-App — LiveKit/MediaMTX löst die Medien-Verbindung per
     *  ICE/STUN selbst (Cone-NAT, bewiesen); das Erreichbarkeits-Gate + Port-
     *  Mapping entfällt. Direkt zum Container-Start. */
    opts: { holePunch?: boolean } = {},
  ) { this.deps = deps; this.opts = opts; }

  onPhase(cb: (e: HostPhaseEvent) => void): void { this._cbs.push(cb); }
  getStatus(): HostPhaseEvent { return this._last; }

  private _emit(phase: HostPhase, detail?: HostPhaseEvent['detail']): void {
    this._last = { phase, detail };
    for (const cb of this._cbs) { try { cb(this._last); } catch { /* ignore */ } }
  }

  /** Gemeinsamer Abschluss: Container starten (mit Progress) → going-live → live.
   *  Wird sowohl im Lochungs-Modus (direkt) als auch nach erfolgreichem
   *  Erreichbarkeits-/Mapping-Gate (outcome 'go') durchlaufen. */
  private async _runBackend(): Promise<void> {
    this._emit('preparing');
    await this.deps.startBackend({
      media: true,
      onProgress: (step) => this._emit('preparing', { step }),
    });
    this._emit('going-live');
    this._emit('live', { relayUrl: this.deps.relayUrl() ?? undefined });
  }

  /** Startet die Sequenz — oder hängt sich an den schon laufenden Ablauf an. */
  start(): Promise<void> {
    return this._laufend ?? this._exklusiv(() => this._starte());
  }

  private _exklusiv(fn: () => Promise<void>): Promise<void> {
    const lauf = fn().finally(() => {
      if (this._laufend === lauf) this._laufend = null;
    });
    this._laufend = lauf;
    return lauf;
  }

  /** Klartext-Grund für die UI, gekürzt — Backend-Fehler können lange
   *  stderr-Auszüge tragen. */
  private _pause(err: unknown, wo: string): void {
    const text = err instanceof Error ? err.message : String(err);
    console.error(`[host] ${wo}:`, text);
    this._emit('something-paused', { fehler: text.slice(0, 300) });
  }

  /** Wartet eine laufende Start-Sequenz ab (No-Op ohne). Für Aufrufer, die den
   *  Backend-Zustand erst NACH einem laufenden Start beurteilen dürfen. */
  async warteAufStart(): Promise<void> {
    await this._laufend?.catch(() => {});
  }

  private async _starte(): Promise<void> {
    try {
      const pre = (await this.deps.checkPrereqs?.()) ?? 'ok';
      if (pre !== 'ok') {
        this._emit(pre);
        return;
      }
      // Lochungs-Modus (Server-App): Medien lochen sich per WebRTC-ICE selbst,
      // kein Erreichbarkeits-Gate / Port-Mapping nötig — direkt zum Container.
      if (this.opts.holePunch) {
        await this._runBackend();
        return;
      }
      this._emit('checking-network');
      const reach = await this.deps.checkReachability();

      let map: MapResult | null = null;
      if (reach.verdict === 'needs-forwarding') {
        this._emit('opening-door');
        map = await this.deps.mapPorts(reach.publicIp);
      }
      const { outcome } = classifyHostOutcome(reach.verdict, map?.verdict ?? null);

      switch (outcome) {
        case 'not-possible-here':
          this._emit('not-possible-here');
          return;
        case 'something-paused':
          this._emit('something-paused');
          return;
        case 'needs-your-help':
          this._emit('needs-your-help', { ports: map?.failedPorts ?? [] });
          return;
        case 'go':
          await this._runBackend();
          return;
      }
    } catch (err) {
      this._pause(err, 'Startfehler');
    }
  }

  async stop(): Promise<void> {
    // Erst die laufende Sequenz abwarten: ein Stopp mitten im Start ließe den
    // Rest der Sequenz danach weiterlaufen und den Server wieder hochfahren.
    await this.warteAufStart();
    try { await this.deps.stopBackend(); } catch { /* best-effort */ }
    this._emit('idle');
  }

  /** Zustands-Abgleich beim App-Start/-Refresh: `_last` lebt nur in-memory,
   *  weiß also nach einem Electron-Neustart nichts vom Container, der dank
   *  `--restart unless-stopped` weiterlief. Hebt die Phase direkt auf 'live',
   *  OHNE die Sequenz (checking-network → … ) erneut zu durchlaufen — nur
   *  wenn wir noch bei 'idle' stehen, sonst würde eine laufende Sequenz oder
   *  ein bereits erkannter 'superseded'-Zustand überschrieben. */
  markLive(relayUrl: string | null): void {
    // Auch aus 'something-paused': scheiterte der Start, weil der Docker-
    // Daemon beim Login noch nicht lief, und kam der Container danach per
    // Restart-Policy doch hoch, blieb die UI sonst für immer auf „Pause"
    // (Linux-Scan 2026-10-08). Eine laufende Sequenz schützt `_laufend`.
    if (this._laufend) return;
    if (this._last.phase !== 'idle' && this._last.phase !== 'something-paused') return;
    this._emit('live', { relayUrl: relayUrl ?? undefined });
  }

  /** Ablöse bestätigt (main.ts hat den Container bereits gestoppt) — Phase
   *  terminal auf 'superseded' setzen, damit die UI den Hinweis + Reset-Knopf
   *  zeigt statt weiter "Bereit"/"Server starten". `reason` steuert den
   *  UI-Text: 'rotated' (Umzugs-Hinweis) vs. 'deleted' (Neu-einrichten).
   *  Entscheidung 6.6 (Phasen-Wache) gilt weiter: der Ablöse-Check darf eine
   *  LAUFENDE Start-Sequenz nicht auf 'superseded' kippen — erlaubt aus
   *  'idle' und 'live'; alle anderen Phasen sind Nutzer-Entscheidungen. */
  markSuperseded(reason: SupersededReason = 'rotated'): void {
    this._emit('superseded', { reason });
  }

  /** "Gerät zurücksetzen" nach einer Ablöse: nur die Phase zurück auf 'idle'
   *  — kein weiterer Backend-Stop nötig, der lief bereits vor 'superseded'. */
  resetToIdle(): void {
    this._emit('idle');
  }

  /** Update-Recreate im Betrieb: das neue Image ist bereits gepullt (Manager),
   *  der bestehende Start-Pfad übernimmt das Recreate (rm -f + run + health —
   *  das /data-Volume bleibt). Nur aus 'live' heraus; der 'update'-Step vor
   *  dem eigentlichen Ablauf lässt die UI "Update wird installiert …" zeigen
   *  statt eines generischen Neustarts. */
  applyUpdate(): Promise<void> {
    if (this._last.phase !== 'live' || this._laufend) return Promise.resolve();
    return this._exklusiv(async () => {
      this._emit('preparing', { step: 'update' });
      try {
        await this._runBackend();
      } catch (err) {
        this._pause(err, 'Update-Fehler');
      }
    });
  }

  /** Export/Import: Backend anhalten (falls es lief), `op` ausführen, danach
   *  wieder starten — als exklusiver Ablauf, damit weder ein Start noch ein
   *  Update dazwischenkommt. Ein `stop()` währenddessen wartet bis zum Ende
   *  und gewinnt dann: der Server bleibt aus. */
  async pausiertFuer<T>(
    laeuft: () => Promise<boolean>,
    op: (schritt: (s: 'stopping' | 'restarting') => void) => Promise<T>,
    schritt: (s: 'stopping' | 'restarting') => void = () => {},
  ): Promise<T> {
    await this.warteAufStart();
    let ergebnis!: T;
    let fehler: unknown = null;
    await this._exklusiv(async () => {
      const lief = await laeuft().catch(() => false);
      try {
        if (lief) { schritt('stopping'); await this.deps.stopBackend(); }
        ergebnis = await op(schritt);
      } catch (err) {
        fehler = err;
      }
      // Der Neustart gehört IN den exklusiven Ablauf: draußen liefe er
      // parallel zu einem `stop()`, das gerade auf das Ende gewartet hat.
      if (lief) { schritt('restarting'); await this._starte(); }
    });
    if (fehler !== null) throw fehler;
    return ergebnis;
  }
}
