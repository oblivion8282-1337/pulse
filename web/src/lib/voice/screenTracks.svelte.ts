import type { RemoteAudioTrack, RemoteParticipant, RemoteVideoTrack } from 'livekit-client';
import { nameFor } from './identity';

/** A remote screen-share track from one participant. */
export type ScreenShareTrack = {
  /** LiveKit participant identity. */
  identity: string;
  /** Display name for the sharer. */
  name: string;
  track: RemoteVideoTrack;
  /** Accompanying screen-share audio track, if published. */
  audioTrack?: RemoteAudioTrack;
};

/**
 * Bookkeeping for remote screen-share video tracks and their (optional)
 * companion audio tracks, which may arrive in either order.
 */
export class ScreenShareTracks {
  list = $state<ScreenShareTrack[]>([]);

  /** Audio tracks subscribed before their video track — keyed by participant identity. */
  #pendingAudio = new Map<string, RemoteAudioTrack>();

  addVideo(track: RemoteVideoTrack, p: RemoteParticipant): void {
    const pending = this.#pendingAudio.get(p.identity);
    this.#pendingAudio.delete(p.identity);
    const existing = this.list.find((s) => s.identity === p.identity);
    if (existing) {
      if (pending && !existing.audioTrack) {
        this.list = this.list.map((st) =>
          st.identity === p.identity ? { ...st, audioTrack: pending } : st
        );
      }
      return;
    }
    this.list = [...this.list, { identity: p.identity, name: nameFor(p), track, audioTrack: pending }];
  }

  removeVideo(sid: string): void {
    const gone = this.list.find((s) => s.track.sid === sid);
    if (gone) this.#pendingAudio.delete(gone.identity);
    this.list = this.list.filter((s) => s.track.sid !== sid);
  }

  addAudio(track: RemoteAudioTrack, p: RemoteParticipant): void {
    if (this.list.some((st) => st.identity === p.identity)) {
      this.#pendingAudio.delete(p.identity);
      this.list = this.list.map((st) => (st.identity === p.identity ? { ...st, audioTrack: track } : st));
    } else {
      this.#pendingAudio.set(p.identity, track);
    }
  }

  removeAudio(track: RemoteAudioTrack): void {
    for (const [identity, t] of this.#pendingAudio) {
      if (t.sid === track.sid) this.#pendingAudio.delete(identity);
    }
    this.list = this.list.map((st) => (st.audioTrack?.sid === track.sid ? { ...st, audioTrack: undefined } : st));
  }

  clear(): void {
    this.list = [];
    this.#pendingAudio.clear();
  }
}
