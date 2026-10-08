/**
 * Vorab-Prüfung der festen TCP-Ports des nativen Backends.
 *
 * Warum vor dem Start: die Health-Gates sind tcpProbes. Lauscht auf 6379
 * schon ein fremdes Redis (oder auf 9000 ein fremder S3), meldet das Gate
 * „gesund“, obwohl unser Garnet gar nicht starten konnte — und die Dienste
 * reden danach mit dem fremden Dienst. Das lässt sich hinterher kaum noch
 * diagnostizieren; vorher ist es eine klare Meldung.
 *
 * Geprüft wird per Verbindungsversuch auf 127.0.0.1, nicht per Probe-Bind:
 * Windows erlaubt ein Bind auf 127.0.0.1:X auch dann, wenn ein anderer
 * Prozess 0.0.0.0:X hält (ohne SO_EXCLUSIVEADDRUSE) — ein Probe-Bind meldete
 * den Port also fälschlich frei. UDP-Ports (LiveKit-Medien, MediaMTX-ICE,
 * direct-adapter) lassen sich so nicht prüfen und bleiben außen vor.
 */

import { NATIVE_PORTS, NATIVE_MEDIA_PORTS } from './types.ts';

/** weed leitet seinen gRPC-Port als HTTP-Port + 10000 ab (Vorgabe von
 *  -port.grpc) — steht in keiner Config hier, kollidiert aber genauso.
 *  Caddys Admin-API (localhost:2019) fehlt bewusst: das Template schaltet
 *  sie ab (`admin off`). */
type FesterPort = { port: number; dienst: string };

export const FESTE_TCP_PORTS: readonly FesterPort[] = [
  { port: NATIVE_PORTS.postgres, dienst: 'Postgres' },
  { port: NATIVE_PORTS.garnet, dienst: 'Garnet (Redis)' },
  { port: NATIVE_PORTS.weedMaster, dienst: 'weed master' },
  { port: NATIVE_PORTS.weedMaster + 10000, dienst: 'weed master gRPC' },
  { port: NATIVE_PORTS.weedVolume, dienst: 'weed volume' },
  { port: NATIVE_PORTS.weedVolume + 10000, dienst: 'weed volume gRPC' },
  { port: NATIVE_PORTS.weedFiler, dienst: 'weed filer' },
  { port: NATIVE_PORTS.weedFiler + 10000, dienst: 'weed filer gRPC' },
  { port: NATIVE_PORTS.s3, dienst: 'S3 (weed)' },
  { port: NATIVE_PORTS.auth, dienst: 'auth' },
  { port: NATIVE_PORTS.chat, dienst: 'chat-gateway' },
  { port: NATIVE_PORTS.voice, dienst: 'voice-signaling' },
  { port: NATIVE_PORTS.media, dienst: 'media-svc' },
  { port: NATIVE_PORTS.mtxHook, dienst: 'mediamtx-auth-hook' },
  { port: NATIVE_PORTS.livekitApi, dienst: 'LiveKit' },
  { port: NATIVE_PORTS.livekitRtcTcp, dienst: 'LiveKit RTC/TCP' },
  { port: NATIVE_PORTS.caddyHttp, dienst: 'Caddy' },
  { port: NATIVE_PORTS.caddyDesktop, dienst: 'Caddy (Verwaltung)' },
  // MediaMTX: API, WebRTC/HTTP, RTMP, RTMPS (configs.ts::renderMediamtxYml)
  { port: 9997, dienst: 'MediaMTX-API' },
  { port: 8889, dienst: 'MediaMTX WebRTC' },
  { port: 1935, dienst: 'MediaMTX RTMP' },
  { port: NATIVE_MEDIA_PORTS.rtmps, dienst: 'MediaMTX RTMPS' },
  // RTSP schaltet renderMediamtxYml nicht ab → MediaMTX-Vorgabe :8554.
  { port: 8554, dienst: 'MediaMTX RTSP' },
];

/** Alle belegten Ports (parallel geprüft). */
export async function belegtePorts(
  probe: (port: number) => Promise<boolean>,
  ports: readonly FesterPort[] = FESTE_TCP_PORTS,
): Promise<FesterPort[]> {
  const ergebnisse = await Promise.all(ports.map(async (p) => ((await probe(p.port)) ? p : null)));
  return ergebnisse.filter((p): p is FesterPort => p !== null);
}

export function portBelegtFehler(belegt: readonly FesterPort[]): Error {
  const liste = belegt.map((p) => `${p.port} (${p.dienst})`).join(', ');
  return new Error(
    `Diese Ports sind schon von einem anderen Programm belegt: ${liste}. ` +
    'Der Pulse-Server braucht sie exklusiv — das andere Programm beenden ' +
    '(z. B. ein lokal installiertes Postgres, Redis oder einen zweiten Pulse-Server) ' +
    'und erneut starten.',
  );
}
