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
};

export const ACTIONS: readonly ActionDef[] = [
  { id: 'nav.quickSwitcher', category: 'navigation', label: m.shortcuts_nav_quick_switcher_label(),
    description: m.shortcuts_nav_quick_switcher_description(), defaultBinding: 'ctrl+k', context: 'global' },
  { id: 'nav.channelUp', category: 'navigation', label: m.shortcuts_nav_channel_up_label(),
    description: m.shortcuts_nav_channel_up_description(), defaultBinding: 'alt+arrowup', context: 'global' },
  { id: 'nav.channelDown', category: 'navigation', label: m.shortcuts_nav_channel_down_label(),
    description: m.shortcuts_nav_channel_down_description(), defaultBinding: 'alt+arrowdown', context: 'global' },
  { id: 'nav.serverUp', category: 'navigation', label: m.shortcuts_nav_server_up_label(),
    description: m.shortcuts_nav_server_up_description(), defaultBinding: 'ctrl+alt+arrowup', context: 'global' },
  { id: 'nav.serverDown', category: 'navigation', label: m.shortcuts_nav_server_down_label(),
    description: m.shortcuts_nav_server_down_description(), defaultBinding: 'ctrl+alt+arrowdown', context: 'global' },
  { id: 'nav.settings', category: 'navigation', label: m.shortcuts_nav_settings_label(),
    description: m.shortcuts_nav_settings_description(), defaultBinding: 'ctrl+,', context: 'global' },
  { id: 'nav.cheatsheet', category: 'navigation', label: m.shortcuts_nav_cheatsheet_label(),
    description: m.shortcuts_nav_cheatsheet_description(), defaultBinding: 'ctrl+/', context: 'global' },

  { id: 'voice.toggleMute', category: 'voice', label: m.shortcuts_voice_toggle_mute_label(),
    description: m.shortcuts_voice_toggle_mute_description(), defaultBinding: 'ctrl+shift+m', context: 'global' },
  { id: 'voice.toggleDeafen', category: 'voice', label: m.shortcuts_voice_toggle_deafen_label(),
    description: m.shortcuts_voice_toggle_deafen_description(), defaultBinding: 'ctrl+shift+d', context: 'global' },
  { id: 'voice.disconnect', category: 'voice', label: m.shortcuts_voice_disconnect_label(),
    description: m.shortcuts_voice_disconnect_description(), defaultBinding: 'ctrl+shift+l', context: 'global' },

  { id: 'composer.bold', category: 'composer', label: m.shortcuts_composer_bold_label(),
    description: '**Text** um Markierung', defaultBinding: 'ctrl+b', context: 'composer' },
  { id: 'composer.italic', category: 'composer', label: m.shortcuts_composer_italic_label(),
    description: '*Text*', defaultBinding: 'ctrl+i', context: 'composer' },
  { id: 'composer.code', category: 'composer', label: m.shortcuts_composer_code_label(),
    description: '`Text`', defaultBinding: 'ctrl+e', context: 'composer' },
  { id: 'composer.codeblock', category: 'composer', label: m.shortcuts_composer_codeblock_label(),
    description: '```…```', defaultBinding: 'ctrl+shift+c', context: 'composer' },
  { id: 'composer.strike', category: 'composer', label: m.shortcuts_composer_strike_label(),
    description: '~~Text~~', defaultBinding: 'ctrl+shift+x', context: 'composer' },

  { id: 'stream.toggleHq', category: 'stream', label: m.shortcuts_stream_toggle_hq_label(),
    description: m.shortcuts_stream_toggle_hq_description(), defaultBinding: 'f9', context: 'global' },
  { id: 'stream.toggleScreenshare', category: 'stream', label: m.shortcuts_stream_toggle_screenshare_label(),
    description: m.shortcuts_stream_toggle_screenshare_description(), defaultBinding: 'f10', context: 'global' },
  { id: 'stream.highlightClip', category: 'stream', label: m.shortcuts_stream_highlight_clip_label(),
    description: m.shortcuts_stream_highlight_clip_description(), defaultBinding: 'f8', context: 'global' }
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
