/**
 * Single source of truth for user-rebindable keyboard actions.
 *
 * Defaults live here; user overrides live in `lib/shortcuts/persistence.ts`
 * (persisted via `settings.shortcuts`). Handlers are registered at runtime
 * by feature components via `engine.svelte.ts::register()`.
 *
 * PTT (hold-to-talk) is intentionally NOT in this registry — it needs
 * press+release edge semantics that don't fit the edge-triggered action
 * model. PTT stays as `settings.voice.pttKey`, configured in the Audio tab.
 */
import { m } from '$lib/paraglide/messages.js';

export type ActionCategory = 'navigation' | 'voice' | 'composer' | 'stream';

/** `global` = fires on a window-level keydown.
 *  `composer` = consulted by MessageInput.onKeydown via `lookupComposer()`. */
export type ActionContext = 'global' | 'composer';

export type ActionId =
  | 'nav.quickSwitcher'
  | 'nav.channelUp'
  | 'nav.channelDown'
  | 'nav.serverUp'
  | 'nav.serverDown'
  | 'nav.settings'
  | 'nav.cheatsheet'
  | 'voice.toggleMute'
  | 'voice.toggleDeafen'
  | 'voice.disconnect'
  | 'composer.bold'
  | 'composer.italic'
  | 'composer.code'
  | 'composer.codeblock'
  | 'composer.strike'
  | 'stream.toggleHq'
  | 'stream.toggleScreenshare'
  | 'stream.highlightClip';

export type ActionDef = {
  id: ActionId;
  category: ActionCategory;
  label: string;
  description: string;
  /** Canonical combo string (see `format.ts`). `null` = unbound by default. */
  defaultBinding: string | null;
  context: ActionContext;
  /** Metadata-only: kept in the registry (type/i18n/future re-enable) but not
   *  shown in the cheatsheet/settings and not resolved to a binding. Used to
   *  park a not-yet-built action without leaving a dead key or visible stub. */
  hidden?: boolean;
};

// Alle Aktionen starten UNBELEGT (`defaultBinding: null`), jeder Eintrag bleibt
// aber einzeln re-belegbar. Grund: eine ab Werk gesetzte Kombination kollidiert
// zwangsläufig mit einem System-/Browser-/Fremdprogramm-Kürzel (Strg+Shift+C =
// Entwicklerkonsole, F9/F10 = Aufnahme-Tools, Strg+Shift+M = Firefox' Responsive-
// Modus). Wer ein Kürzel will, vergibt es in den Einstellungen unter „Tastatur".
//
// Selbst gesetzte Belegungen gehen dabei nicht verloren: `effectiveBinding()`
// liest zuerst `overrides`. Nur das *Fehlen* eines Eintrags fällt jetzt auf
// `null` statt auf eine aufgedrängte Kombination zurück.
export const ACTIONS: readonly ActionDef[] = [
  { id: 'nav.quickSwitcher', category: 'navigation', label: m.shortcuts_nav_quick_switcher_label(),
    description: m.shortcuts_nav_quick_switcher_description(), defaultBinding: null, context: 'global' },
  { id: 'nav.channelUp', category: 'navigation', label: m.shortcuts_nav_channel_up_label(),
    description: m.shortcuts_nav_channel_up_description(), defaultBinding: null, context: 'global' },
  { id: 'nav.channelDown', category: 'navigation', label: m.shortcuts_nav_channel_down_label(),
    description: m.shortcuts_nav_channel_down_description(), defaultBinding: null, context: 'global' },
  { id: 'nav.serverUp', category: 'navigation', label: m.shortcuts_nav_server_up_label(),
    description: m.shortcuts_nav_server_up_description(), defaultBinding: null, context: 'global' },
  { id: 'nav.serverDown', category: 'navigation', label: m.shortcuts_nav_server_down_label(),
    description: m.shortcuts_nav_server_down_description(), defaultBinding: null, context: 'global' },
  { id: 'nav.settings', category: 'navigation', label: m.shortcuts_nav_settings_label(),
    description: m.shortcuts_nav_settings_description(), defaultBinding: null, context: 'global' },
  { id: 'nav.cheatsheet', category: 'navigation', label: m.shortcuts_nav_cheatsheet_label(),
    description: m.shortcuts_nav_cheatsheet_description(), defaultBinding: null, context: 'global' },

  { id: 'voice.toggleMute', category: 'voice', label: m.shortcuts_voice_toggle_mute_label(),
    description: m.shortcuts_voice_toggle_mute_description(), defaultBinding: null, context: 'global' },
  { id: 'voice.toggleDeafen', category: 'voice', label: m.shortcuts_voice_toggle_deafen_label(),
    description: m.shortcuts_voice_toggle_deafen_description(), defaultBinding: null, context: 'global' },
  { id: 'voice.disconnect', category: 'voice', label: m.shortcuts_voice_disconnect_label(),
    description: m.shortcuts_voice_disconnect_description(), defaultBinding: null, context: 'global' },

  { id: 'composer.bold', category: 'composer', label: m.shortcuts_composer_bold_label(),
    description: '**Text** um Markierung', defaultBinding: null, context: 'composer' },
  { id: 'composer.italic', category: 'composer', label: m.shortcuts_composer_italic_label(),
    description: '*Text*', defaultBinding: null, context: 'composer' },
  { id: 'composer.code', category: 'composer', label: m.shortcuts_composer_code_label(),
    description: '`Text`', defaultBinding: null, context: 'composer' },
  { id: 'composer.codeblock', category: 'composer', label: m.shortcuts_composer_codeblock_label(),
    description: '```…```', defaultBinding: null, context: 'composer' },
  { id: 'composer.strike', category: 'composer', label: m.shortcuts_composer_strike_label(),
    description: '~~Text~~', defaultBinding: null, context: 'composer' },

  { id: 'stream.toggleHq', category: 'stream', label: m.shortcuts_stream_toggle_hq_label(),
    description: m.shortcuts_stream_toggle_hq_description(), defaultBinding: null, context: 'global' },
  { id: 'stream.toggleScreenshare', category: 'stream', label: m.shortcuts_stream_toggle_screenshare_label(),
    description: m.shortcuts_stream_toggle_screenshare_description(), defaultBinding: null, context: 'global' },
  // Noch nicht gebaut (30s-Roll-Buffer in media-svc fehlt). Versteckt geparkt:
  // nicht im Spickzettel/Einstellungen. Re-enable = `hidden` entfernen.
  { id: 'stream.highlightClip', category: 'stream', label: m.shortcuts_stream_highlight_clip_label(),
    description: m.shortcuts_stream_highlight_clip_description(), defaultBinding: null, context: 'global',
    hidden: true }
];

export const ACTION_BY_ID: Record<ActionId, ActionDef> = Object.fromEntries(
  ACTIONS.map((a) => [a.id, a])
) as Record<ActionId, ActionDef>;

export const CATEGORY_ORDER: readonly ActionCategory[] = [
  'navigation',
  'voice',
  'composer',
  'stream'
];

export const CATEGORY_LABELS: Record<ActionCategory, string> = {
  navigation: m.shortcuts_category_navigation(),
  voice: m.shortcuts_category_voice(),
  composer: m.shortcuts_category_composer(),
  stream: m.shortcuts_category_stream()
};

export function isValidActionId(id: string): id is ActionId {
  return id in ACTION_BY_ID;
}
