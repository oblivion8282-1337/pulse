import { isCapacitorIOS } from './runtime';

/**
 * iOS-Audio-Session-Steuerung (Hülle) — natives Gegenstück zu
 * `setVoiceActive` auf Android (audioRoute.ts).
 *
 * WARUM: iOS killt die Audio-Session beim Sperren des Displays, und der
 * `voiceChat`-Modus (iOS-eigenes Echo-Auslösen + Bluetooth-Mikrofon) wird
 * vom Browser-Stack nicht gesetzt. Das native Plugin (App/AudioSession-
 * Plugin.swift, im App-Target auto-registriert) steuert die Prozess-Session.
 *
 * Browser und Electron: No-op.
 */

interface AudioSessionPlugin {
  setVoiceActive(options: { aktiv: boolean }): Promise<void>;
  setPlaybackMode(): Promise<void>;
}

function plugin(): AudioSessionPlugin | null {
  if (typeof window === 'undefined') return null;
  const cap = (window as Window & { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor;
  return (cap?.Plugins?.AudioSessionPlugin as AudioSessionPlugin | undefined) ?? null;
}

/** Voice-Modus (Mikro + Echo-Auslösen + Bluetooth) an/aus. */
export async function iosVoiceAktiv(aktiv: boolean): Promise<void> {
  if (!isCapacitorIOS()) return;
  const p = plugin();
  if (!p) return;
  await p.setVoiceActive({ aktiv }).catch(() => undefined);
}

/** Playback-Modus (Watch-/Stream-Ton ohne Mikro). */
export async function iosPlaybackModus(): Promise<void> {
  if (!isCapacitorIOS()) return;
  const p = plugin();
  if (!p) return;
  await p.setPlaybackMode().catch(() => undefined);
}
