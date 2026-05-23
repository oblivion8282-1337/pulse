/**
 * `streamChat` section — side-panel open-state for the watch view.
 * Device-scoped (it's a layout preference).
 */
import type { SectionConfig } from '../types';

export type StreamChatSettings = {
  panelOpen: boolean;
};

export const DEFAULTS_STREAM_CHAT: StreamChatSettings = {
  panelOpen: true
};

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export const STREAM_CHAT_SECTION: SectionConfig<StreamChatSettings> = {
  defaults: DEFAULTS_STREAM_CHAT,
  parse(raw) {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<StreamChatSettings>;
    return { panelOpen: bool(p.panelOpen, DEFAULTS_STREAM_CHAT.panelOpen) };
  }
};
