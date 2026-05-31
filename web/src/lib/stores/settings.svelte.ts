/**
 * Public settings facade — registers the 8 built-in sections with the
 * registry and re-exposes them as named properties so existing component
 * code (`settings.audio.bitrate`, `settings.setTheme(…)`) keeps working
 * unchanged.
 *
 * The actual reactive state + persistence lives in
 * `lib/settings-registry/` (Phase 3 Plugin-System-Plan). This file is the
 * thin compatibility shim — plugins should NOT import from here; use
 * `$lib/settings-registry` directly.
 */
import { setMode } from 'mode-watcher';
import {
  bindPersistence,
  registerSettingsSection,
  runSignOutHooks,
  type SectionStore
} from '$lib/settings-registry';
import { APPEARANCE_SECTION, type ThemePreference } from '$lib/settings-registry/sections/appearance';
import {
  AUDIO_SECTION,
  clampBitrate,
  clampGateDb,
  clampInputMakeup,
  type AudioSettings,
  type NoiseSuppressionMode,
  VOICE_BITRATE_MIN,
  VOICE_BITRATE_MAX,
  VOICE_BITRATE_STEREO_MIN,
  NOISE_GATE_DB_MIN,
  NOISE_GATE_DB_MAX,
  NOISE_GATE_DB_DEFAULT,
  INPUT_MAKEUP_MIN,
  INPUT_MAKEUP_MAX,
  INPUT_MAKEUP_DEFAULT
} from '$lib/settings-registry/sections/audio';
import {
  VOICE_SECTION,
  clampUserVolume,
  capUserVolumes,
  type VoiceSettings,
  USER_VOLUME_MIN,
  USER_VOLUME_MAX
} from '$lib/settings-registry/sections/voice';
import {
  SCREEN_SHARE_SECTION,
  type ScreenShareCodec,
  type ScreenShareResolution,
  type ScreenShareSettings,
  clampScreenShareFps,
  SCREEN_SHARE_BITRATE_MIN,
  SCREEN_SHARE_BITRATE_MAX,
  SCREEN_SHARE_FPS_MIN,
  SCREEN_SHARE_FPS_MAX
} from '$lib/settings-registry/sections/screenShare';
import {
  STREAM_CHAT_SECTION,
  type StreamChatSettings
} from '$lib/settings-registry/sections/streamChat';
import {
  NOTIFICATIONS_SECTION,
  type NotificationSettings
} from '$lib/settings-registry/sections/notifications';
import { SOUNDS_SECTION } from '$lib/settings-registry/sections/sounds';
import { SHORTCUTS_SECTION } from '$lib/settings-registry/sections/shortcuts';
import { clampSoundVolume, type SoundCategoryKey, type SoundsSettings } from '$lib/sounds/persistence';
import { DEFAULT_SHORTCUTS, type ShortcutsSettings } from '$lib/shortcuts/persistence';
import type { ActionId } from '$lib/shortcuts/actions';

export type {
  NoiseSuppressionMode,
  ThemePreference,
  ScreenShareCodec,
  ScreenShareResolution
};

const STORAGE_KEY = 'dcc.settings';
const LEGACY_SCREENSHARE_KEY = 'dcc.screenShareSettings';

/** Pre-registration: if a legacy `dcc.screenShareSettings` blob exists and
 *  there's no `dcc.settings` yet, fold the legacy data into the root blob
 *  under `screenShare` so `parseScreenShare` picks it up on first register.
 *  Returns whether a legacy entry was migrated (so we can clean it up). */
function migrateLegacyScreenShare(): boolean {
  if (typeof localStorage === 'undefined') return false;
  if (localStorage.getItem(STORAGE_KEY) !== null) return false;
  const legacy = localStorage.getItem(LEGACY_SCREENSHARE_KEY);
  if (!legacy) return false;
  try {
    const parsed = JSON.parse(legacy);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ screenShare: parsed }));
    return true;
  } catch {
    return false;
  }
}

const legacyMigrated = migrateLegacyScreenShare();

// Bind default localStorage persistence (registry idempotently no-ops on SSR).
bindPersistence({
  read() {
    if (typeof localStorage === 'undefined') return {};
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const p = JSON.parse(raw);
      return p && typeof p === 'object' ? p : {};
    } catch {
      return {};
    }
  },
  write(blob) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
      if (legacyMigrated) localStorage.removeItem(LEGACY_SCREENSHARE_KEY);
    } catch {
      /* quota */
    }
  }
});

class SettingsStore {
  // Section handles — built-in sections register at module-init time below.
  #appearance: SectionStore<{ theme: ThemePreference }>;
  #audio: SectionStore<AudioSettings>;
  #voice: SectionStore<VoiceSettings>;
  #screenShare: SectionStore<ScreenShareSettings>;
  #streamChat: SectionStore<StreamChatSettings>;
  #notifications: SectionStore<NotificationSettings>;
  #sounds: SectionStore<SoundsSettings>;
  #shortcuts: SectionStore<ShortcutsSettings>;

  constructor() {
    this.#appearance = registerSettingsSection('appearance', APPEARANCE_SECTION);
    this.#audio = registerSettingsSection('audio', AUDIO_SECTION);
    this.#voice = registerSettingsSection('voice', VOICE_SECTION);
    this.#screenShare = registerSettingsSection('screenShare', SCREEN_SHARE_SECTION);
    this.#streamChat = registerSettingsSection('streamChat', STREAM_CHAT_SECTION);
    this.#notifications = registerSettingsSection('notifications', NOTIFICATIONS_SECTION);
    this.#sounds = registerSettingsSection('sounds', SOUNDS_SECTION);
    this.#shortcuts = registerSettingsSection('shortcuts', SHORTCUTS_SECTION);
  }

  // --- reactive read accessors (delegate to the underlying rune store) ---
  // Each getter is a thin pass-through so the existing component imports
  // (`settings.audio.bitrate`) keep their reactivity — `value` is the
  // `$state`-tracked source from the registry.
  get appearance() {
    return this.#appearance.value;
  }
  get audio() {
    return this.#audio.value;
  }
  get voice() {
    return this.#voice.value;
  }
  get screenShare() {
    return this.#screenShare.value;
  }
  get streamChat() {
    return this.#streamChat.value;
  }
  get notifications() {
    return this.#notifications.value;
  }
  get sounds() {
    return this.#sounds.value;
  }
  get shortcuts() {
    return this.#shortcuts.value;
  }

  /** Pushes the persisted theme preference into mode-watcher. Call once
   *  early on app start. */
  applyTheme(): void {
    setMode(this.appearance.theme);
  }

  // --- appearance setters ---
  setTheme(v: ThemePreference): void {
    this.#appearance.set('theme', v);
    setMode(v);
  }

  // --- audio setters ---
  setInputDevice(id: string, label: string): void {
    this.#audio.patch({ inputDeviceId: id, inputDeviceLabel: label });
  }
  setOutputDevice(id: string, label: string): void {
    this.#audio.patch({ outputDeviceId: id, outputDeviceLabel: label });
  }
  setEchoCancellation(v: boolean): void {
    this.#audio.set('echoCancellation', v);
  }
  setAutoGainControl(v: boolean): void {
    this.#audio.set('autoGainControl', v);
  }
  setNoiseSuppression(v: NoiseSuppressionMode): void {
    this.#audio.set('noiseSuppression', v);
  }
  setNoiseGateThresholdDb(v: number): void {
    this.#audio.set('noiseGateThresholdDb', clampGateDb(v));
  }
  setVoiceBitrateKbps(v: number): void {
    this.#audio.set('voiceBitrateKbps', clampBitrate(v));
  }
  setStereo(v: boolean): void {
    this.#audio.set('stereo', v);
  }
  setInputMakeupGain(v: number): void {
    this.#audio.set('inputMakeupGain', clampInputMakeup(v));
  }
  setLimiterEnabled(v: boolean): void {
    this.#audio.set('limiterEnabled', v);
  }

  // --- voice / PTT setters ---
  setPttMode(v: boolean): void {
    this.#voice.set('pttMode', v);
  }
  setPttKey(v: string): void {
    const key = v.trim().toLowerCase();
    if (key.length === 0) return;
    this.#voice.set('pttKey', key);
  }
  /** Set per-user output gain (0..4). 1.0 is removed from storage (default). */
  setUserVolume(userId: string, v: number): void {
    if (typeof userId !== 'string' || userId.length === 0) return;
    const clamped = clampUserVolume(v);
    // Reassign the whole record so the rune picks up the change.
    const next = { ...this.#voice.value.userVolumes };
    if (clamped === 1) delete next[userId];
    else {
      // Re-insert so the most-recently-touched key is at the end — gives FIFO
      // eviction a rough recency bias.
      delete next[userId];
      next[userId] = clamped;
    }
    this.#voice.set('userVolumes', capUserVolumes(next));
  }
  getUserVolume(userId: string): number {
    return this.#voice.value.userVolumes[userId] ?? 1;
  }

  // --- screen-share setters ---
  setScreenShareCodec(v: ScreenShareCodec): void {
    this.#screenShare.set('codec', v);
  }
  setScreenShareResolution(v: ScreenShareResolution): void {
    this.#screenShare.set('resolution', v);
  }
  setScreenShareFps(v: number): void {
    this.#screenShare.set('fps', clampScreenShareFps(v));
  }
  setScreenShareBitrateMbps(v: number): void {
    this.#screenShare.set(
      'bitrateMbps',
      Math.min(SCREEN_SHARE_BITRATE_MAX, Math.max(SCREEN_SHARE_BITRATE_MIN, v))
    );
  }
  setScreenShareContentHint(v: 'motion' | 'detail'): void {
    this.#screenShare.set('contentHint', v);
  }

  // --- stream-chat setters ---
  setStreamChatPanelOpen(v: boolean): void {
    this.#streamChat.set('panelOpen', v);
  }

  // --- notification setters ---
  setBrowserPushEnabled(v: boolean): void {
    this.#notifications.set('browserPushEnabled', v);
  }
  setNotifyOnMention(v: boolean): void {
    this.#notifications.set('onMention', v);
  }
  setNotifyOnDM(v: boolean): void {
    this.#notifications.set('onDM', v);
  }
  setNotifyOnFriendRequests(v: boolean): void {
    this.#notifications.set('onFriendRequests', v);
  }

  // --- sounds setters ---
  setSoundsMasterEnabled(v: boolean): void {
    this.#sounds.set('masterEnabled', v);
  }
  setSoundsMasterVolume(v: number): void {
    this.#sounds.set('masterVolume', clampSoundVolume(v));
  }
  setSoundCategoryEnabled(cat: SoundCategoryKey, v: boolean): void {
    // Nested record: rebuild the category object so the rune notices.
    this.#sounds.patch({ [cat]: { ...this.#sounds.value[cat], enabled: v } } as Partial<SoundsSettings>);
  }
  setSoundCategoryVolume(cat: SoundCategoryKey, v: number): void {
    this.#sounds.patch({
      [cat]: { ...this.#sounds.value[cat], volume: clampSoundVolume(v) }
    } as Partial<SoundsSettings>);
  }

  // --- shortcut setters ---
  setShortcutBinding(id: ActionId, combo: string): void {
    this.#shortcuts.replace({ overrides: { ...this.#shortcuts.value.overrides, [id]: combo } });
  }
  /** Explicitly unbind an action (binding is `null` — no key fires it). */
  unbindShortcut(id: ActionId): void {
    this.#shortcuts.replace({ overrides: { ...this.#shortcuts.value.overrides, [id]: null } });
  }
  /** Drop the override so the built-in default applies again. */
  resetShortcut(id: ActionId): void {
    const next = { ...this.#shortcuts.value.overrides };
    delete next[id];
    this.#shortcuts.replace({ overrides: next });
  }
  resetAllShortcuts(): void {
    this.#shortcuts.replace({ ...DEFAULT_SHORTCUTS });
  }

  /** Run every registered section's sign-out policy. Replaces the old
   *  hard-coded `resetUserScoped()` — plugin sections participate
   *  automatically via their `onSignOut` config. */
  resetUserScoped(): void {
    runSignOutHooks();
  }
}

export const settings = new SettingsStore();
export {
  VOICE_BITRATE_MIN,
  VOICE_BITRATE_MAX,
  VOICE_BITRATE_STEREO_MIN,
  NOISE_GATE_DB_MIN,
  NOISE_GATE_DB_MAX,
  NOISE_GATE_DB_DEFAULT,
  SCREEN_SHARE_BITRATE_MIN,
  SCREEN_SHARE_BITRATE_MAX,
  SCREEN_SHARE_FPS_MIN,
  SCREEN_SHARE_FPS_MAX,
  USER_VOLUME_MIN,
  USER_VOLUME_MAX,
  INPUT_MAKEUP_MIN,
  INPUT_MAKEUP_MAX,
  INPUT_MAKEUP_DEFAULT
};
