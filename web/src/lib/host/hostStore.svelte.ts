// Reaktiver Wrapper über window.pulse.host (③a/③c). Browser/SSR-sicher: ohne
// Electron-Bridge bleibt es inert (phase 'idle', start/stop No-ops).
import { isElectron } from '$lib/platform/runtime';
import type { HostPhase, HostPhaseEvent, PairingStatus } from '$lib/platform/pulse';
import { instancesApi } from '$lib/api/instances';
import { serversStore } from '$lib/api/servers.svelte';

class HostStore {
  phase = $state<HostPhase>('idle');
  detail = $state<HostPhaseEvent['detail']>(undefined);
  pairing = $state<PairingStatus | null>(null);
  instances = $state<{ id: string; hostname: string }[]>([]);
  /** true, wenn der letzte Pairing-Versuch (Mint/Redeem) fehlschlug — die UI
   *  zeigt dann eine ruhige Fehlerzeile. Wird bei jedem neuen start() geräumt. */
  pairError = $state(false);
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
    void instancesApi.listMyInstances()
      .then((list) => {
        this.instances = list
          .filter((i) => i.status === 'active')
          .map((i) => ({ id: i.id, hostname: i.hostname }));
      })
      .catch(() => {});
  }

  async start(instanceId?: string): Promise<void> {
    if (!this.available) return;
    const host = window.pulse!.host!;
    this.pairError = false;
    if (!this.paired) {
      const id = instanceId ?? this.instances[0]?.id;
      if (!id) return;
      try {
        const { token } = await instancesApi.mintBootstrapToken(id);
        const res = await host.pair(token);
        if (!res.paired) { this.pairError = true; return; }
        this.pairing = res.status ?? await host.getPairing();
      } catch {
        this.pairError = true;
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
