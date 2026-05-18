/**
 * Sound asset registry. Files live under `/sounds/<file>.ogg` (web/static/sounds/).
 * Missing files are tolerated by the engine — see `engine.ts`.
 */

export type SoundCategory = 'notification' | 'voice' | 'ui';

export type SoundDef = {
  category: SoundCategory;
  file: string;
  label: string;
};

export const SOUNDS = {
  'notification.message': {
    category: 'notification',
    file: 'notification-message',
    label: 'Neue Nachricht'
  },
  'notification.mention': {
    category: 'notification',
    file: 'notification-mention',
    label: 'Erwähnung'
  },
  'notification.dm': {
    category: 'notification',
    file: 'notification-dm',
    label: 'Direktnachricht'
  },
  'voice.user_join': {
    category: 'voice',
    file: 'voice-user-join',
    label: 'Anderer Nutzer joint'
  },
  'voice.user_leave': {
    category: 'voice',
    file: 'voice-user-leave',
    label: 'Anderer Nutzer verlässt'
  },
  'voice.self_join': {
    category: 'voice',
    file: 'voice-self-join',
    label: 'Eigener Join'
  },
  'voice.self_leave': {
    category: 'voice',
    file: 'voice-self-leave',
    label: 'Eigener Leave'
  },
  'voice.self_mute': {
    category: 'voice',
    file: 'voice-self-mute',
    label: 'Stummgeschaltet'
  },
  'voice.self_unmute': {
    category: 'voice',
    file: 'voice-self-unmute',
    label: 'Mikrofon an'
  },
  'voice.self_deafen': {
    category: 'voice',
    file: 'voice-self-deafen',
    label: 'Selbst betäubt'
  },
  'voice.self_undeafen': {
    category: 'voice',
    file: 'voice-self-undeafen',
    label: 'Sound an'
  },
  'ui.send': {
    category: 'ui',
    file: 'ui-send',
    label: 'Nachricht senden'
  },
  'ui.modal_open': {
    category: 'ui',
    file: 'ui-modal-open',
    label: 'Dialog öffnen'
  }
} as const satisfies Record<string, SoundDef>;

export type SoundId = keyof typeof SOUNDS;

export const SOUND_IDS = Object.keys(SOUNDS) as SoundId[];

export function soundsInCategory(cat: SoundCategory): SoundId[] {
  return SOUND_IDS.filter((id) => SOUNDS[id].category === cat);
}
