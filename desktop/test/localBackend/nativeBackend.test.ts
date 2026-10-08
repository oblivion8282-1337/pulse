import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';

import { renderNativeEnv } from '../../electron/localBackend/nativeBackend/envContract.ts';
import { renderLivekitYaml, renderMediamtxYml, renderWeedS3Config, renderCaddyfile, renderFrpcToml } from '../../electron/localBackend/nativeBackend/configs.ts';
import { ensureNativeSecrets } from '../../electron/localBackend/nativeBackend/secrets.ts';
import { datenDirs, servicePythonPath } from '../../electron/localBackend/nativeBackend/paths.ts';
import { SupervisedProcess } from '../../electron/localBackend/nativeBackend/processes.ts';
import { nativeComponents } from '../../electron/localBackend/nativeBackend/components.ts';
import { NATIVE_PORTS, NATIVE_MEDIA_PORTS } from '../../electron/localBackend/nativeBackend/types.ts';

const TMP = mkdtempSync(join(tmpdir(), 'pulse-native-test-'));
process.env.PULSE_NATIVE_ROOT = TMP;

const SECRETS = ensureNativeSecrets(join(TMP, 'keys'));
const IDENTITY = {
  hostname: 'heim-1.example', instanceId: '123', ownerId: '7',
  clientId: 'cid', clientSecret: 'SECRET', cloudOrigin: 'https://howispulse.com',
};

test('renderNativeEnv: Container-Port-Vertrag + Pflicht-Variablen', () => {
  const dirs = datenDirs(join(TMP, 'data'));
  const env = renderNativeEnv(dirs, SECRETS, IDENTITY);
  // Ports spiegeln den allinone-Internraum (Caddyfile-Template hardcodet sie)
  assert.equal(env.DATABASE_URL, `postgresql+asyncpg://pulse:${SECRETS.postgresPassword}@127.0.0.1:${NATIVE_PORTS.postgres}/dcc`);
  assert.equal(env.REDIS_URL, `redis://:${SECRETS.garnetPassword}@127.0.0.1:${NATIVE_PORTS.garnet}/0?protocol=2`);
  assert.match(SECRETS.garnetPassword, /^[0-9a-f]{64}$/);
  assert.equal(env.CHAT_GATEWAY_URL, `http://127.0.0.1:${NATIVE_PORTS.chat}`);
  assert.equal(env.LIVEKIT_API_URL, `http://127.0.0.1:${NATIVE_PORTS.livekitApi}`);
  // App-Host-Semantik wie im Container (renderContainerEnv)
  assert.equal(env.PULSE_HOSTNAME, 'heim-1.example');
  assert.equal(env.PULSE_HOST_ORIGIN, 'app_host');
  assert.equal(env.PULSE_TLS_MODE, 'behind-proxy');
  assert.equal(env.MEDIAMTX_INGEST_HOST, '127.0.0.1');
  assert.equal(env.PULSE_RELAY_TUNNEL_TOKEN, '');
  assert.equal(env.S3_ACCESS_KEY, SECRETS.minioUser);
  assert.equal(env.MEDIAMTX_API_USER, 'pulse-media-svc');
  assert.equal(env.MEDIAMTX_API_PASSWORD, SECRETS.mediamtxApiPassword);
  assert.ok(SECRETS.mediamtxApiPassword.length >= 40);
  assert.match(SECRETS.minioUser, /^GK[0-9a-f]{24}$/);
});

test('ensureNativeSecrets: idempotent, Keypairs als PEM lesbar', () => {
  const again = ensureNativeSecrets(join(TMP, 'keys'));
  assert.equal(again.postgresPassword, SECRETS.postgresPassword);
  assert.equal(again.livekitApiKey, SECRETS.livekitApiKey);
  // Public-PEMs müssen parsebar sein (JWKS-/Session-Verifikation)
  createPublicKey(readFileSync(again.jwtPublicKeyPath));
  createPublicKey(readFileSync(join(join(TMP, 'keys'), 'session-token-signing.pub.pem')));
});

test('renderLivekitYaml: STUN-Weg + UDP-Bereich wie die Medien-Ports', () => {
  const yaml = renderLivekitYaml(SECRETS, 8003);
  assert.match(yaml, /use_external_ip: true/);
  assert.match(yaml, /skip_external_ip_validation: true/);
  assert.match(yaml, /port_range_start: 7882/);
  assert.match(yaml, new RegExp(`port_range_end: ${NATIVE_MEDIA_PORTS.livekitUdpEnd}`));
  assert.match(yaml, new RegExp(`${SECRETS.livekitApiKey}: "${SECRETS.livekitApiSecret}"`));
  assert.match(yaml, /http:\/\/127\.0\.0\.1:8003\/webhook/);
  assert.match(yaml, /- "::\/0"/); // IPv6-Kandidaten unterdrückt
  // Signal-API nur Loopback; RTC-Ports sind davon unberührt (siehe configs.ts)
  assert.match(yaml, /bind_addresses:\n  - 127\.0\.0\.1\n/);
  assert.doesNotMatch(yaml, /0\.0\.0\.0/);
});

test('renderMediamtxYml: echte Interfaces (kein VM-Sonderweg) + Auth-Hook', () => {
  const yml = renderMediamtxYml('heim-1.example', join(TMP, 'certs'), NATIVE_PORTS.mtxHook);
  assert.match(yml, /webrtcIPsFromInterfaces: yes/);
  assert.match(yml, /authHTTPAddress: http:\/\/127\.0\.0\.1:8005/);
  assert.match(yml, /rtmpsAddress: :1936/);
  assert.match(yml, /hls: no/);
  // Steuer-API läuft durch den Hook (Passwort), nur metrics/pprof vorbei
  assert.doesNotMatch(yml, /action: api/);
  assert.match(yml, /- action: metrics/);
  assert.match(yml, /moq: no/);
  assert.match(yml, /mediamtx\.crt/);
  // App-Host-Parität (08-init-mediamtx.sh): IPv4-only-Bind gegen die IPv6-
  // Falle + eigene STUN-Server, damit MediaMTX den srflx-Kandidaten selbst
  // ermittelt und durchs Heim-NAT locht.
  assert.match(yml, /webrtcLocalUDPAddress: 0\.0\.0\.0:8189/);
  assert.match(yml, /webrtcICEServers2:/);
  assert.match(yml, /url: stun:stun\.l\.google\.com:19302/);
});

test('renderWeedS3Config: weed-IAM-Format (credentials + sts.signingKey)', () => {
  const cfg = JSON.parse(renderWeedS3Config('GK' + 'ab'.repeat(12), 'pw', 'c2lnbmluZw=='));
  assert.equal(cfg.identities[0].credentials[0].accessKey, 'GK' + 'ab'.repeat(12));
  assert.deepEqual(cfg.identities[0].actions.sort(), ['Admin', 'List', 'Read', 'Write']);
  assert.ok(cfg.sts.signingKey.length > 0);
});

test('renderCaddyfile: behind-proxy-Patch + Desktop-Listener, Zweit-Site entfernt', () => {
  // Template direkt aus dem Repo (Test läuft aus desktop/ heraus)
  const repoTemplate = join(import.meta.dirname ?? '.', '..', '..', '..', 'infra', 'self-host', 's6', 'etc', 'caddy');
  assert.ok(existsSync(join(repoTemplate, 'Caddyfile.template')), 'Caddyfile.template fehlt im Repo');
  const out = renderCaddyfile(8080, 55580, repoTemplate);
  // Beide Listener nur auf Loopback (Klartext-API nicht ins Heimnetz)
  assert.match(out, /http:\/\/127\.0\.0\.1:8080, http:\/\/127\.0\.0\.1:55580 \{/);
  assert.doesNotMatch(out, /^http:\/\/:/m); // keine Site auf allen Interfaces
  assert.match(out, /reverse_proxy 127\.0\.0\.1:8002/); // Route-Parität
  // kein doppelter http://:8080-Site-Block mehr
  assert.equal((out.match(/^http:\/\/:8080 \{/gm) ?? []).length, 0);
});

test('servicePythonPath: alle src-Verzeichnisse, Semikolon-getrennt (Windows)', () => {
  const p = servicePythonPath();
  assert.ok(p.includes('chat-gateway') && p.includes('shared'));
  assert.ok(p.includes(';'));
});

test('nativeComponents: 14 Specs in Abhängigkeitsreihenfolge', () => {
  process.env.PULSE_NATIVE_ROOT = TMP; // venvPython() braucht den Root
  // Dummy-Binaries anlegen — der Test prüft Specs, keine echten Exes.
  const bin = join(TMP, 'native-bin');
  for (const f of [
    join(bin, 'weed.exe'), join(bin, 'caddy.exe'),
    join(bin, 'livekit-server.exe'), join(bin, 'mediamtx.exe'),
    join(bin, 'garnet', 'GarnetServer.exe'), join(bin, 'pg', 'bin', 'postgres.exe'),
    join(TMP, 'python', 'python.exe'),
  ]) {
    mkdirSync(join(f, '..'), { recursive: true });
    if (!existsSync(f)) writeFileSync(f, '');
  }
  const dirs = datenDirs(join(TMP, 'data'));
  const env = renderNativeEnv(dirs, SECRETS, IDENTITY);
  const specs = nativeComponents({
    dirs, secrets: SECRETS, env, identity: IDENTITY,
    livekitYamlPath: join(dirs.run, 'livekit.yaml'),
    mediamtxYmlPath: join(dirs.run, 'mediamtx.yml'),
    caddyfilePath: join(dirs.run, 'Caddyfile'),
    weedS3JsonPath: join(dirs.run, 'weed-s3.json'),
    garnetConfPath: join(dirs.run, 'garnet.conf'),
    frpcTomlPath: null,
  });
  const names = specs.map((s) => s.name);
  assert.deepEqual(names.slice(0, 14), [
    'postgres', 'garnet', 'weed-master', 'weed-volume', 'weed-filer', 'weed-s3',
    'caddy', 'auth', 'media-svc', 'mediamtx-auth-hook', 'voice-signaling',
    'livekit', 'mediamtx', 'chat-gateway',
  ]);
  // direct-adapter optional (Binary fehlt im Test-Root) — Rest fix.
  assert.ok(names.length === 14 || (names.length === 15 && names[14] === 'direct-adapter'));
  // chat-gateway zuletzt, Postgres zuerst (Migrationen)
  assert.equal(names[0], 'postgres');
  assert.equal(names[names.length - 1], 'chat-gateway');
  // Garnet: Passwort über die Config-Datei, nie in argv
  const garnet = specs.find((s) => s.name === 'garnet')!;
  assert.ok(garnet.args.includes('--config-import-path'));
  assert.ok(!garnet.args.includes(SECRETS.garnetPassword));
  // Ohne frpc.toml (VPS/keine Relay-Creds) startet KEIN frpc.
  assert.ok(!names.includes('frpc'));
});

test('nativeComponents: frpc nur mit Relay-Config (Steuerungs-Tunnel)', () => {
  process.env.PULSE_NATIVE_ROOT = TMP;
  const bin = join(TMP, 'native-bin');
  writeFileSync(join(bin, 'frpc.exe'), '');
  const dirs = datenDirs(join(TMP, 'data'));
  const env = renderNativeEnv(dirs, SECRETS, IDENTITY);
  const specs = nativeComponents({
    dirs, secrets: SECRETS, env, identity: IDENTITY,
    livekitYamlPath: join(dirs.run, 'livekit.yaml'),
    mediamtxYmlPath: join(dirs.run, 'mediamtx.yml'),
    caddyfilePath: join(dirs.run, 'Caddyfile'),
    weedS3JsonPath: join(dirs.run, 'weed-s3.json'),
    garnetConfPath: join(dirs.run, 'garnet.conf'),
    frpcTomlPath: join(dirs.run, 'frpc.toml'),
  });
  const frpc = specs.find((s) => s.name === 'frpc');
  assert.ok(frpc, 'frpc-Spec muss mit Relay-Config existieren');
  assert.equal(frpc!.args[0], '-c');
  assert.equal(frpc!.args[1], join(dirs.run, 'frpc.toml'));
});

test('renderFrpcToml: Portierung von 11-render-frpc.sh', () => {
  const toml = renderFrpcToml('clever-cobalt-11af.relay.howispulse.com', 'relay.example.com:7000', 'tok-secret', 8080);
  assert.ok(toml.includes('serverAddr = "relay.example.com"'));
  assert.ok(toml.includes('serverPort = 7000'));
  assert.ok(toml.includes('user = "clever-cobalt-11af.relay.howispulse.com"'));
  assert.ok(toml.includes('metadatas.token = "tok-secret"'));
  assert.ok(toml.includes('loginFailExit = false'));
  assert.ok(toml.includes('type = "http"'));
  assert.ok(toml.includes('localPort = 8080'));
  assert.ok(toml.includes('subdomain = "clever-cobalt-11af"'));
});

test('SupervisedProcess: start/stop + Exit-Callback (echter Kindprozess)', async () => {
  const node = process.execPath;
  const proc = new SupervisedProcess({
    name: 'test-child',
    command: node,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    healthCheck: async () => true,
  });
  let exits = 0;
  proc.onExit(() => { exits++; });
  await proc.start();
  assert.ok(proc.running);
  assert.ok(proc.pid);
  await proc.stop();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!proc.running);
  assert.equal(exits, 1);
});

test('SupervisedProcess: Early-Exit während des Starts wirft sofort', async () => {
  const proc = new SupervisedProcess({
    name: 'test-crasher',
    command: process.execPath,
    args: ['-e', 'process.exit(3)'],
    healthCheck: async () => false,
  });
  await assert.rejects(() => proc.start(), /exited during startup/);
});

// Aufräumen erst nach allen Tests (Test-Runner reihnt aus)
process.on('exit', () => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});
void execFileSync;
