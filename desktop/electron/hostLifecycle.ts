// Host-Lifecycle: verkettet ① + ②b zu einer menschlichen Phasen-Sequenz.
// classifyHostOutcome ist die reine Entscheidung nach der Diagnose — voll testbar.

export type HostPhase =
  | 'idle' | 'checking-network' | 'opening-door' | 'preparing'
  | 'going-live' | 'live' | 'needs-your-help' | 'not-possible-here' | 'something-paused'
  | 'needs-windows-setup';

export interface HostPhaseEvent {
  phase: HostPhase;
  /** step: Fortschritts-Schritt innerhalb von 'preparing' (login/pull/run/health)
   *  — der erste Pull lädt mehrere hundert MB, die UI soll das benennen können. */
  detail?: { relayUrl?: string; ports?: number[]; step?: string };
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
  constructor(deps: HostDeps) { this.deps = deps; }

  onPhase(cb: (e: HostPhaseEvent) => void): void { this._cbs.push(cb); }
  getStatus(): HostPhaseEvent { return this._last; }

  private _emit(phase: HostPhase, detail?: HostPhaseEvent['detail']): void {
    this._last = { phase, detail };
    for (const cb of this._cbs) { try { cb(this._last); } catch { /* ignore */ } }
  }

  async start(): Promise<void> {
    try {
      const pre = (await this.deps.checkPrereqs?.()) ?? 'ok';
      if (pre !== 'ok') {
        this._emit(pre);
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
          this._emit('preparing');
          await this.deps.startBackend({
            media: true,
            onProgress: (step) => this._emit('preparing', { step }),
          });
          this._emit('going-live');
          this._emit('live', { relayUrl: this.deps.relayUrl() ?? undefined });
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
}
