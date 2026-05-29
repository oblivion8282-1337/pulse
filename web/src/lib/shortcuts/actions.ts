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
  { id: 'nav.quickSwitcher', category: 'navigation', label: 'Schnell-Wechsler',
    description: 'Channel/Community suchen', defaultBinding: 'ctrl+k', context: 'global' },
  { id: 'nav.channelUp', category: 'navigation', label: 'Channel hoch',
    description: 'Vorheriger Channel in der Community', defaultBinding: 'alt+arrowup', context: 'global' },
  { id: 'nav.channelDown', category: 'navigation', label: 'Channel runter',
    description: 'Nächster Channel in der Community', defaultBinding: 'alt+arrowdown', context: 'global' },
  { id: 'nav.serverUp', category: 'navigation', label: 'Community hoch',
    description: 'Vorherige Community', defaultBinding: 'ctrl+alt+arrowup', context: 'global' },
  { id: 'nav.serverDown', category: 'navigation', label: 'Community runter',
    description: 'Nächste Community', defaultBinding: 'ctrl+alt+arrowdown', context: 'global' },
  { id: 'nav.settings', category: 'navigation', label: 'Einstellungen öffnen',
    description: 'Settings-Dialog', defaultBinding: 'ctrl+,', context: 'global' },
  { id: 'nav.cheatsheet', category: 'navigation', label: 'Shortcut-Übersicht',
    description: 'Diese Liste anzeigen', defaultBinding: 'ctrl+/', context: 'global' },

  { id: 'voice.toggleMute', category: 'voice', label: 'Mikrofon stumm',
    description: 'An/Aus toggeln', defaultBinding: 'ctrl+shift+m', context: 'global' },
  { id: 'voice.toggleDeafen', category: 'voice', label: 'Ton stumm (Deafen)',
    description: 'An/Aus toggeln', defaultBinding: 'ctrl+shift+d', context: 'global' },
  { id: 'voice.disconnect', category: 'voice', label: 'Voice verlassen',
    description: 'Aus dem Voice-Channel raus', defaultBinding: 'ctrl+shift+l', context: 'global' },

  { id: 'composer.bold', category: 'composer', label: 'Fett',
    description: '**Text** um Markierung', defaultBinding: 'ctrl+b', context: 'composer' },
  { id: 'composer.italic', category: 'composer', label: 'Kursiv',
    description: '*Text*', defaultBinding: 'ctrl+i', context: 'composer' },
  { id: 'composer.code', category: 'composer', label: 'Inline-Code',
    description: '`Text`', defaultBinding: 'ctrl+e', context: 'composer' },
  { id: 'composer.codeblock', category: 'composer', label: 'Code-Block',
    description: '```…```', defaultBinding: 'ctrl+shift+c', context: 'composer' },
  { id: 'composer.strike', category: 'composer', label: 'Durchgestrichen',
    description: '~~Text~~', defaultBinding: 'ctrl+shift+x', context: 'composer' },

  { id: 'stream.toggleHq', category: 'stream', label: 'HQ-Stream Start/Stop',
    description: 'Nur Electron + Linux', defaultBinding: 'f9', context: 'global' },
  { id: 'stream.toggleScreenshare', category: 'stream', label: 'Bildschirm teilen',
    description: 'Browser-Screenshare an/aus', defaultBinding: 'f10', context: 'global' },
  { id: 'stream.highlightClip', category: 'stream', label: 'Highlight-Clip',
    description: 'Letzte ~30s clippen (in Arbeit)', defaultBinding: 'f8', context: 'global' }
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
  navigation: 'Navigation',
  voice: 'Sprache',
  composer: 'Editor',
  stream: 'Streaming'
};

export function isValidActionId(id: string): id is ActionId {
  return id in ACTION_BY_ID;
}
