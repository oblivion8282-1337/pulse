/**
 * Minimal WHEP (WebRTC-HTTP Egress Protocol, `draft-ietf-wish-whep`) client —
 * just enough to play back a MediaMTX HQ stream. Hand-rolled (~120 lines) on
 * purpose: a dependency would be heavier than the protocol itself.
 *
 * Flow (non-trickle, the simplest variant MediaMTX 1.18 supports):
 *  1. `RTCPeerConnection`, `addTransceiver('video'|'audio', recvonly)`.
 *  2. `createOffer()` → `setLocalDescription()` → wait for ICE gathering to
 *     complete (with a short timeout fallback) so the offer carries all
 *     candidates.
 *  3. `POST <whepUrl>` with `Content-Type: application/sdp`, body = the offer
 *     SDP. A 201 response carries the answer SDP in the body and the resource
 *     URL in the `Location` header.
 *  4. `setRemoteDescription({type:'answer', sdp})`.
 *  5. On teardown: `pc.close()` + best-effort `DELETE <resourceUrl>`.
 *
 * Reference for the mechanics: `~/Dokumente/GPU_Screen_Recorder/server/player.html`
 * (a working WHEP player against this exact MediaMTX). We don't copy it; we
 * follow the pattern. Note: anonymous read — no token in the URL (member-auth
 * for reading HQ streams is a later step).
 */

/** Public STUN — MediaMTX with host networking usually doesn't need it, but
 *  it's harmless and helps when the viewer is behind NAT. Mirrors player.html. */
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/** Max time to wait for ICE gathering before POSTing the offer anyway. */
const ICE_GATHERING_TIMEOUT_MS = 2000;

export class WhepError extends Error {
  /** HTTP status if the failure came from the WHEP POST, else 0. */
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'WhepError';
    this.status = status;
  }
}

export interface WhepSession {
  pc: RTCPeerConnection;
  /** Resource URL from the 201 `Location` header (for DELETE on teardown). */
  resourceUrl: string | null;
  /** Tear down: close the peer connection + best-effort DELETE the resource. */
  close(): Promise<void>;
}

async function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, ICE_GATHERING_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

function resolveResourceUrl(whepUrl: string, location: string | null): string | null {
  if (!location) return null;
  try {
    return new URL(location, whepUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Establish a WHEP recv-only session against `whepUrl`.
 *
 * `onTrack` receives the inbound `MediaStream` (attach it to a `<video>`).
 * Throws {@link WhepError} on transport / HTTP / SDP failures — the caller
 * decides whether to retry (e.g. on 404 = publisher not online yet).
 */
export async function connectWhep(
  whepUrl: string,
  onTrack: (stream: MediaStream) => void,
  iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS
): Promise<WhepSession> {
  const pc = new RTCPeerConnection({ iceServers });
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  let trackReceived = false;
  pc.ontrack = (e) => {
    if (e.streams[0] && !trackReceived) {
      trackReceived = true;
      onTrack(e.streams[0]);
    }
  };

  let resourceUrl: string | null = null;
  const session: WhepSession = {
    pc,
    get resourceUrl() {
      return resourceUrl;
    },
    async close() {
      try {
        pc.close();
      } catch {
        /* already closed */
      }
      if (resourceUrl) {
        try {
          await fetch(resourceUrl, { method: 'DELETE' });
        } catch {
          /* best effort — the server times the resource out anyway */
        }
        resourceUrl = null;
      }
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    const sdp = pc.localDescription?.sdp ?? offer.sdp ?? '';

    let res: Response;
    try {
      res = await fetch(whepUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: sdp
      });
    } catch (netErr) {
      throw new WhepError(
        `WHEP server unreachable: ${netErr instanceof Error ? netErr.message : String(netErr)}`
      );
    }
    if (!res.ok) {
      throw new WhepError(`WHEP POST failed: HTTP ${res.status} ${res.statusText}`, res.status);
    }
    resourceUrl = resolveResourceUrl(whepUrl, res.headers.get('Location') ?? res.headers.get('location'));
    const answer = await res.text();
    if (!answer.includes('v=')) {
      throw new WhepError('WHEP answer was not valid SDP');
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  } catch (e) {
    await session.close();
    throw e;
  }
  return session;
}
