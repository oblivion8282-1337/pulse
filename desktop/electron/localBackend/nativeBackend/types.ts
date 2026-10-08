/**
 * Typen für das native Windows-Backend (kein Container, kein WSL2).
 *
 * Port-Vertrag: bewusst IDENTISCH mit dem allinone-Container-Internraum
 * (8001-8005, 5432, 6379, 9000, 7880, 8889, 8080) — das Caddyfile-Template
 * des Images hardcodet genau diese Ports beim reverse_proxy, und der
 * Env-Vertrag (07-render-env.sh) ebenso. Native=True heißt also: dieselbe
 * Topologie, nur ohne Linux-Kernel dazwischen. Öffentliche Medien-Ports
 * (7882-7892/udp, 8189/udp, 1936/tcp, 7900/udp) bleiben die veröffentlichten
 * Werte — portMapper.ts (NAT-PMP) und die Client-ICE-Erwartungen hängen an
 * genau diesen Zahlen.
 */

export interface NativeDataDirs {
  root: string;
  pg: string;
  redis: string;
  weedMaster: string;
  weedVolume: string;
  weedFiler: string;
  uploadsAvatars: string;
  uploadsGuildIcons: string;
  secrets: string;
  certs: string;
  backups: string;
  run: string;
}

/** Interne Dienste-Ports — MIRROR des Container-Internraums (siehe oben). */
export const NATIVE_PORTS = {
  postgres: 5432,
  garnet: 6379,
  weedMaster: 9333,
  weedVolume: 9334,
  weedFiler: 8888,
  s3: 9000,
  auth: 8001,
  chat: 8002,
  voice: 8003,
  media: 8004,
  mtxHook: 8005,
  livekitApi: 7880,
  livekitRtcTcp: 7881,
  caddyHttp: 8080,
  caddyDesktop: 55580,
} as const;

/** Öffentliche Medien-Ports — MUSS mit MEDIA_PORT_ARGS (containerBackend-
 *  Manager) und portMapper.ts synchron bleiben. */
export const NATIVE_MEDIA_PORTS = {
  livekitUdpStart: 7882,
  livekitUdpEnd: 7892,
  mtxWebrtcUdp: 8189,
  rtmps: 1936,
  directAdapter: 7900,
} as const;

export interface NativeSecrets {
  postgresPassword: string;
  /** Passwort für Garnet (Redis-Ersatz) — steht in run/garnet.conf und in
   *  REDIS_URL, nie in argv. */
  garnetPassword: string;
  /** Zugang zu MediaMTX' Steuer-API (:9997), geprüft vom auth-hook. */
  mediamtxApiPassword: string;
  internalServiceToken: string;
  certChallengeSecret: string;
  minioUser: string;
  minioPassword: string;
  jwtPrivateKeyPath: string;
  jwtPublicKeyPath: string;
  sessionSigningKeyPath: string;
  livekitApiKey: string;
  livekitApiSecret: string;
}

/** Duck-typed Spawn-Spec — kompatibel zum SupervisedProcess des nativen
 *  Managers, ohne Import-Zirkel zu process.ts. */
export interface ServiceSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Gibt true zurück, wenn der Prozess healthy ist. */
  healthCheck: () => Promise<boolean>;
  restartMax?: number;
}
