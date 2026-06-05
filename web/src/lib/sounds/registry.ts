/**
 * Sound asset registry. Files live under `/sounds/<file>.ogg` (web/static/sounds/).
 * Missing files are tolerated by the engine — see `engine.ts`.
 */

import { m } from '$lib/paraglide/messages.js';

export type SoundCategory = 'notification' | 'voice' | 'ui' | 'stream';

export type SoundDef = {
  category: SoundCategory;
  file: string;
  label: string;
};

export const SOUNDS = {
  'notification.message': {
    category: 'notification',
    file: 'notification-message',
    get label() { return m.sounds_notification_message(); }
  },
  'notification.mention': {
    category: 'notification',
    file: 'notification-mention',
    get label() { return m.sounds_notification_mention(); }
  },
  'notification.dm': {
    category: 'notification',
    file: 'notification-dm',
    get label() { return m.sounds_notification_dm(); }
  },
  'voice.user_join': {
    category: 'voice',
    file: 'voice-user-join',
    get label() { return m.sounds_voice_user_join(); }
  },
  'voice.user_leave': {
    category: 'voice',
    file: 'voice-user-leave',
    get label() { return m.sounds_voice_user_leave(); }
  },
  'voice.self_join': {
    category: 'voice',
    file: 'voice-self-join',
    get label() { return m.sounds_voice_self_join(); }
  },
  'voice.self_leave': {
    category: 'voice',
    file: 'voice-self-leave',
    get label() { return m.sounds_voice_self_leave(); }
  },
  'voice.self_mute': {
    category: 'voice',
    file: 'voice-self-mute',
    get label() { return m.sounds_voice_self_mute(); }
  },
  'voice.self_unmute': {
    category: 'voice',
    file: 'voice-self-unmute',
    get label() { return m.sounds_voice_self_unmute(); }
  },
  'voice.self_deafen': {
    category: 'voice',
    file: 'voice-self-deafen',
    get label() { return m.sounds_voice_self_deafen(); }
  },
  'voice.self_undeafen': {
    category: 'voice',
    file: 'voice-self-undeafen',
    get label() { return m.sounds_voice_self_undeafen(); }
  },
  'stream.user_start': {
    category: 'stream',
    file: 'stream-user-start',
    get label() { return m.sounds_stream_user_start(); }
  },
  'stream.user_stop': {
    category: 'stream',
    file: 'stream-user-stop',
    get label() { return m.sounds_stream_user_stop(); }
  },
  'stream.self_start': {
    category: 'stream',
    file: 'stream-self-start',
    get label() { return m.sounds_stream_self_start(); }
  },
  'ui.send': {
    category: 'ui',
    file: 'ui-send',
    get label() { return m.sounds_ui_send(); }
  },
  'ui.modal_open': {
    category: 'ui',
    file: 'ui-modal-open',
    get label() { return m.sounds_ui_modal_open(); }
  }
} as const satisfies Record<string, SoundDef>;

export type SoundId = keyof typeof SOUNDS;

export const SOUND_IDS = Object.keys(SOUNDS) as SoundId[];

export function soundsInCategory(cat: SoundCategory): SoundId[] {
  return SOUND_IDS.filter((id) => SOUNDS[id].category === cat);
}
