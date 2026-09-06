import type { Room } from 'livekit-client';
import { settings } from '$lib/stores/settings.svelte';
import { matchDevice, enumerate } from './devices';
import type { RemoteAudioElements } from './audioElements';
import { hqStreams } from '$lib/stream/hqStreamManager.svelte';

/**
 * Owns the lists of audio input/output devices and the currently selected ones.
 *
 * On (re)enumeration it re-matches the persisted device against the live list
 * (by id → by label → 'default' → first) instead of blindly picking `[0]`, and
 * keeps the LiveKit room + the detached `<audio>` elements pointed at the right
 * sinks/sources.
 */
export class AudioDevices {
  inputs = $state<MediaDeviceInfo[]>([]);
  outputs = $state<MediaDeviceInfo[]>([]);
  selectedInputId = $state<string>('');
  selectedOutputId = $state<string>('');

  #audioEls: RemoteAudioElements;
  /** Called after an input device change so the noise filter can re-attach. */
  #onInputChanged: () => void | Promise<void>;

  constructor(audioEls: RemoteAudioElements, onInputChanged: () => void | Promise<void>) {
    this.#audioEls = audioEls;
    this.#onInputChanged = onInputChanged;
  }

  async setInput(room: Room | null, deviceId: string): Promise<void> {
    this.selectedInputId = deviceId;
    const label = this.inputs.find((d) => d.deviceId === deviceId)?.label ?? '';
    settings.setInputDevice(deviceId, label);
    if (room) {
      try {
        await room.switchActiveDevice('audioinput', deviceId);
        await this.#onInputChanged();
      } catch {
        /* device may have vanished — ignore */
      }
    }
  }

  async setOutput(room: Room | null, deviceId: string): Promise<void> {
    this.selectedOutputId = deviceId;
    const label = this.outputs.find((d) => d.deviceId === deviceId)?.label ?? '';
    settings.setOutputDevice(deviceId, label);
    if (room) {
      try {
        await room.switchActiveDevice('audiooutput', deviceId);
      } catch {
        /* setSinkId not supported in some browsers — ignore */
      }
    }
    await this.#audioEls.setOutputDevice(deviceId);
    // Der HQ-Stream-Ton hängt nicht an `#audioEls` (eigener Audio-Graph, s.
    // `stream/volumeBoost.ts`) und muss deshalb separat mitgenommen werden —
    // sonst bleibt ein zeitgleich gehörter Stream auf dem alten Gerät hängen,
    // während die Voice-Channel-Teilnehmer schon umgeschaltet sind.
    hqStreams.setOutputDevice(deviceId);
  }

  /** Re-enumerate devices and re-match the persisted selections. */
  async refresh(room: Room | null): Promise<void> {
    const [ins, outs] = await Promise.all([enumerate('audioinput'), enumerate('audiooutput')]);
    this.inputs = ins;
    this.outputs = outs;

    const inMatch = matchDevice(ins, settings.audio.inputDeviceId, settings.audio.inputDeviceLabel);
    if (inMatch.deviceId && inMatch.deviceId !== this.selectedInputId) {
      this.selectedInputId = inMatch.deviceId;
      settings.setInputDevice(inMatch.deviceId, inMatch.label);
      if (room) await this.#switch(room, 'audioinput', inMatch.deviceId);
    }

    const outMatch = matchDevice(outs, settings.audio.outputDeviceId, settings.audio.outputDeviceLabel);
    if (outMatch.deviceId && outMatch.deviceId !== this.selectedOutputId) {
      this.selectedOutputId = outMatch.deviceId;
      settings.setOutputDevice(outMatch.deviceId, outMatch.label);
      this.#audioEls.outputDeviceId = outMatch.deviceId;
      if (room) await this.#switch(room, 'audiooutput', outMatch.deviceId);
      await this.#audioEls.setOutputDevice(outMatch.deviceId);
      hqStreams.setOutputDevice(outMatch.deviceId);
    }
  }

  async #switch(room: Room, kind: MediaDeviceKind, deviceId: string): Promise<void> {
    try {
      await room.switchActiveDevice(kind, deviceId);
    } catch {
      /* ignore */
    }
  }
}
