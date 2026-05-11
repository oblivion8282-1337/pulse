import type { RemoteAudioTrack } from 'livekit-client';

type SinkCapableElement = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };

/**
 * Owns the detached `<audio>` elements for remote participant audio tracks
 * (mic, not screen-share — those live in ScreenShareTile). Keeps them muted
 * when deafened and routes them to the selected output device.
 */
export class RemoteAudioElements {
  #els = new Map<string, HTMLMediaElement>();
  deafened = false;
  outputDeviceId = '';

  /** Called when a remote audio track is subscribed. `onBlocked` fires if autoplay was refused. */
  attach(track: RemoteAudioTrack, onBlocked: () => void): void {
    const sid = track.sid ?? `t-${Math.random()}`;
    const el = track.attach();
    el.autoplay = true;
    el.muted = this.deafened;
    this.#applySink(el, this.outputDeviceId);
    el.style.display = 'none';
    document.body.appendChild(el);
    this.#els.set(sid, el);
    void el.play().catch(onBlocked);
  }

  detach(sid: string): void {
    const el = this.#els.get(sid);
    if (el) {
      el.remove();
      this.#els.delete(sid);
    }
  }

  setDeafened(on: boolean): void {
    this.deafened = on;
    for (const el of this.#els.values()) el.muted = on;
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId;
    for (const el of this.#els.values()) await this.#applySink(el, deviceId);
  }

  /** Re-trigger playback on every attached element (after a user gesture). */
  replayAll(): void {
    for (const el of this.#els.values()) void el.play().catch(() => undefined);
  }

  clear(): void {
    for (const el of this.#els.values()) el.remove();
    this.#els.clear();
  }

  async #applySink(el: HTMLMediaElement, deviceId: string): Promise<void> {
    if (!deviceId) return;
    const anyEl = el as SinkCapableElement;
    if (typeof anyEl.setSinkId === 'function') {
      try {
        await anyEl.setSinkId(deviceId);
      } catch {
        /* setSinkId not supported in some browsers — ignore */
      }
    }
  }
}
