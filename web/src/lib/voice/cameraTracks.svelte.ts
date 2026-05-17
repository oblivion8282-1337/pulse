import type { RemoteParticipant, RemoteVideoTrack } from 'livekit-client';
import { nameFor } from './identity';

/** A remote camera (webcam) video track from one participant. */
export type CameraTrack = {
  identity: string;
  name: string;
  track: RemoteVideoTrack;
};

/** Bookkeeping for remote `Track.Source.Camera` video tracks. Simpler than
 *  ScreenShareTracks — cameras don't carry a companion audio track (mic is
 *  separate). */
export class CameraTracks {
  list = $state<CameraTrack[]>([]);

  add(track: RemoteVideoTrack, p: RemoteParticipant): void {
    if (this.list.some((c) => c.identity === p.identity)) return;
    this.list = [...this.list, { identity: p.identity, name: nameFor(p), track }];
  }

  remove(sid: string): void {
    this.list = this.list.filter((c) => c.track.sid !== sid);
  }

  clear(): void {
    this.list = [];
  }
}
