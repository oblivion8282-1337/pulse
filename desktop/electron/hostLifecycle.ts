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
  detail?: { relayUrl?: string; ports?: number[]; step?: string; reason?: SupersededReason };
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
   *  Erststart-Assistenten statt einer generischen Fehlerphase. */
  checkPrereqs?(): Promise<'ok' | 'needs-windows-setup'>;
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

  async start(): Promise<void> {
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
      console.error('[host] Startfehler:', (err as Error).message);
      this._emit('something-paused');
    }
  }

  async stop(): Promise<void> {
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
    if (this._last.phase !== 'idle') return;
    this._emit('live', { relayUrl: relayUrl ?? undefined });
  }

  /** Ablöse bestätigt (main.ts hat den Container bereits gestoppt) — Phase
   *  terminal auf 'superseded' setzen, damit die UI den Hinweis + Reset-Knopf
   *  zeigt statt weiter "Bereit"/"Server starten". `reason` steuert den
   *  UI-Text: 'rotated' (Umzugs-Hinweis) vs. 'deleted' (Neu-einrichten). */
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
  async applyUpdate(): Promise<void> {
    if (this._last.phase !== 'live') return;
    this._emit('preparing', { step: 'update' });
    try {
      await this._runBackend();
    } catch (err) {
      console.error('[host] Update-Fehler:', (err as Error).message);
      this._emit('something-paused');
    }
  }
}
