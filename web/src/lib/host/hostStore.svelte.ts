// Reaktiver Wrapper über window.pulse.host (③a). Browser/SSR-sicher: ohne
// Electron-Bridge bleibt es inert (phase 'idle', start/stop No-ops).
import { isElectron } from '$lib/platform/runtime';
import type { HostPhase, HostPhaseEvent } from '$lib/platform/pulse';

class HostStore {
  phase = $state<HostPhase>('idle');
  detail = $state<HostPhaseEvent['detail']>(undefined);
  private _wired = false;

  get available(): boolean {
    return isElectron() && typeof window !== 'undefined' && !!window.pulse?.host;
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
  }

  async start(): Promise<void> {
    if (!this.available) return;
    await window.pulse!.host!.start({});  // opts-Befüllung = ③c (Cloud-Pairing)
  }

  async stop(): Promise<void> {
    if (!this.available) return;
    await window.pulse!.host!.stop();
  }
}

export const hostStore = new HostStore();
