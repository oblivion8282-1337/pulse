// Reaktiver Wrapper über window.pulse.host (③a/③c). Browser/SSR-sicher: ohne
// Electron-Bridge bleibt es inert (phase 'idle', start/stop No-ops).
import { isElectron } from '$lib/platform/runtime';
import type { HostPhase, HostPhaseEvent, PairingStatus } from '$lib/platform/pulse';
import { instancesApi } from '$lib/api/instances';
import { ApiError } from '$lib/api/client';
import { serversStore } from '$lib/api/servers.svelte';

class HostStore {
  phase = $state<HostPhase>('idle');
  detail = $state<HostPhaseEvent['detail']>(undefined);
  pairing = $state<PairingStatus | null>(null);
  instances = $state<{ id: string; hostname: string }[]>([]);
  /** true, wenn der letzte Pairing-Versuch (Mint/Redeem) fehlschlug — die UI
   *  zeigt dann eine ruhige Fehlerzeile. Wird bei jedem neuen start() geräumt. */
  pairError = $state(false);
  /** true, wenn der Mint mit 403 scheiterte = Bootstrap wurde schon einmal
   *  eingelöst (anderes Gerät / Store-Verlust). Die Karte bietet dann den
   *  bewussten „Zugang übertragen"-Pfad an (Mint mit reset=true). */
  pairConsumed = $state(false);
  /** null = noch nicht geprüft; false = keine Container-Runtime (Podman/Docker)
   *  gefunden → UI zeigt den Setup-Hinweis statt des Start-Knopfs. */
  runtimeOk = $state<boolean | null>(null);
  private _wired = false;

  get available(): boolean {
    return isElectron() && typeof window !== 'undefined' && !!window.pulse?.host;
  }

  get paired(): boolean {
    return !!this.pairing?.paired;
  }

  get canHost(): boolean {
    return this.paired || this.instances.length >= 1;
  }

  get needsChoice(): boolean {
    return !this.paired && this.instances.length > 1;
  }

  init(): void {
    if (this._wired || !this.available) return;
    this._wired = true;
    const host = window.pulse!.host!;
    host.onPhase((e: HostPhaseEvent) => {
      this.phase = e.phase;
      this.detail = e.detail;
    });
    void host.getStatus().then((e) => { this.phase = e.phase; this.detail = e.detail; });
    void host.getPairing().then((p) => { this.pairing = p; }).catch(() => {});
    // Ältere Shells haben runtimeAvailable noch nicht → optimistisch true
    // (der Start-Pfad meldet einen echten Fehler dann selbst).
    void host.runtimeAvailable?.().then((ok) => { this.runtimeOk = ok; }).catch(() => {});
    void this.refreshInstances();
  }

  /** Instanz-Liste neu laden (z.B. nachdem die App-Host-Genehmigung gerade eine
   *  Instanz provisioniert hat — ``init`` selbst ist durch ``_wired`` gesperrt).
   *  Best-effort. */
  async refreshInstances(): Promise<void> {
    try {
      const list = await instancesApi.listMyInstances();
      // Nur App-Host-Instanzen anbieten: ein Pairing rotiert das client_secret —
      // auf einer laufenden VPS-Instanz wäre das ein Betriebs-Killer.
      this.instances = list
        .filter((i) => i.status === 'active' && i.origin === 'app_host')
        .map((i) => ({ id: i.id, hostname: i.hostname }));
    } catch {
      /* transient */
    }
  }

  async start(instanceId?: string, opts?: { reset?: boolean }): Promise<void> {
    if (!this.available) return;
    const host = window.pulse!.host!;
    this.pairError = false;
    this.pairConsumed = false;
    if (!this.paired) {
      const id = instanceId ?? this.instances[0]?.id;
      if (!id) return;
      try {
        const { token } = await instancesApi.mintBootstrapToken(id, opts);
        const res = await host.pair(token);
        if (!res.paired) { this.pairError = true; return; }
        this.pairing = res.status ?? await host.getPairing();
      } catch (e) {
        // 403 = Bootstrap bereits eingelöst → statt generisch zu scheitern
        // bietet die Karte den bewussten Übertragen-Pfad an (reset=true).
        if (e instanceof ApiError && e.status === 403) this.pairConsumed = true;
        else this.pairError = true;
        return;
      }
    }
    await host.start({});
  }

  async stop(): Promise<void> {
    if (!this.available) return;
    await window.pulse!.host!.stop();
  }

  async anchorLive(): Promise<void> {
    const p = this.pairing;
    if (!p?.relaySubdomain) return;
    const alreadyAdded = serversStore.servers.some((s) => s.instance_id === p.instanceId);
    if (alreadyAdded) return;
    serversStore.add('https://' + p.relaySubdomain, p.hostname, p.instanceId);
  }
}

export const hostStore = new HostStore();
