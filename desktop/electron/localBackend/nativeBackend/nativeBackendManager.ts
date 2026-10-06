/**
 * NativeBackendManager — gleiche öffentliche Oberfläche wie
 * ContainerBackendManager, treibt aber KEINEN Container: der komplette
 * Pulse-Server läuft als überwachter Prozessbaum nativ auf dem Gerät
 * (Windows-first; kein WSL2, keine Virtualisierung).
 *
 * Ablauf von start():
 *   Dirs+Secrets → Configs rendern (+RTMPS-Cert) → Postgres (initdb →
 *   supervised Start → alembic) → Rest des Baums mit Health-Gates →
 *   Health-Poll auf den Desktop-Port. stop() fährt in umgekehrter Reihenfolge
 *   ab, Postgres via pg_ctl fast stop.
 *
 * Secrets (client_secret, DB-Passwort) landen NUR in 0600-Dateien unter dem
 * Datenverzeichnis — nie in argv, nie in Logs.
 */

import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

import electron from 'electron';

import type { BootstrapCreds } from '../pairing.ts';
import { waitFor, httpHealth, tcpProbe } from '../health.ts';
import {
  nativeRoot,
  datenDirs,
  venvPython,
  serviceDir,
  templatesDir,
} from './paths.ts';
import { ensureNativeSecrets } from './secrets.ts';
import { renderNativeEnv } from './envContract.ts';
import {
  renderLivekitYaml,
  renderMediamtxYml,
  renderWeedS3Config,
  renderCaddyfile,
  renderFrpcToml,
} from './configs.ts';
import { nativeComponents } from './components.ts';
import { SupervisedProcess } from './processes.ts';
import {
  ensureInitDb,
  waitForPostgres,
  ensureDatabases,
  runMigrations,
  pgCtlStop,
} from './postgres.ts';
import { NATIVE_PORTS } from './types.ts';

const execFileAsync = promisify(execFile);

/** userData aus dem Electron-Default-Import — unter bare Node (Unit-Tests)
 *  liefert electron einen String ohne .app, daher das Duck-Typing. */
function userDataPfad(): string | undefined {
  return (electron as { app?: { getPath?: (k: string) => string } }).app?.getPath?.('userData');
}

/** Welt-Suffix (Multi-Account) — Spiegel von setzeContainerWelt. */
let nativeWelt: string | null = null;
export function setzeNativeWelt(key: string | null): void {
  nativeWelt = key;
}
function weltSuffix(): string {
  return nativeWelt ? `-${nativeWelt}` : '';
}

function datenRoot(userData: string): string {
  return join(userData, 'pulse-host', `data${weltSuffix()}`);
}

/** Rekursives du — für die "Deine Daten"-Karte (Volume-Size-Ersatz). */
function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) total += dirSizeBytes(p);
    else total += st.size;
  }
  return total;
}

/** RTMPS-Selbstsign-Cert via gebündeltem Python (cryptography). */
async function ensureRtmpsCert(
  certDir: string,
  hostname: string,
  venvPy: string,
): Promise<void> {
  if (existsSync(join(certDir, 'mediamtx.crt')) && existsSync(join(certDir, 'mediamtx.key'))) return;
  mkdirSync(certDir, { recursive: true });
  const helper = join(nativeRoot(), 'gen_selfsigned_cert.py');
  await execFileAsync(venvPy, [helper, join(certDir, 'mediamtx.crt'), join(certDir, 'mediamtx.key'), hostname])
    .catch((e) => { throw new Error(`[native] RTMPS-Cert fehlgeschlagen: ${e.message}`); });
}

export class NativeBackendManager {
  private processes: SupervisedProcess[] = [];

  /** Oberflächen-Parität mit ContainerBackendManager — main.ts ruft setzeCreds
   *  auf beiden Managern auf. Nativ ohne Wirkung: es gibt keinen Abschieds-Call
   *  beim Stopp (der Herzschlag läuft über den direct-adapter), und die Creds
   *  kommen je start() direkt herein. */
  setzeCreds(_creds: BootstrapCreds | null): void {}

  /** Native Runtime — immer vorhanden, solange die Binaries gebündelt sind. */
  async runtime(): Promise<{ kind: 'native' } | null> {
    return { kind: 'native' };
  }

  async runtimeAvailable(): Promise<boolean> {
    try {
      nativeRoot(); // wirft nur, wenn PULSE_NATIVE_ROOT fehlt
      venvPython();
      return true;
    } catch {
      return false;
    }
  }

  async vmIp(): Promise<string | null> {
    return null; // keine VM — Dienste binden native Interfaces
  }

  /** Live-Erkennung: unser Prozessbaum steht UND der Chat antwortet. */
  async isContainerRunning(): Promise<boolean> {
    if (this.processes.length === 0) return false;
    return httpHealth(`http://127.0.0.1:${NATIVE_PORTS.caddyDesktop}/api/chat/health`).catch(() => false);
  }

  /** Update-Lauf: Binaries kommen mit dem App-Update — der 24h-Check des
   *  Main-Prozesses deckt sie ab. Kein eigener Image-Pull nötig. */
  async checkImageUpdate(): Promise<'none'> {
    return 'none';
  }

  async ensureRelay(): Promise<void> {
    // Keine VM — UDP-Relay entfällt (die WSL/gvproxy-Sonderwege existieren
    // nativ nicht: Dienste binden direkt auf den Host-Interfaces).
  }

  async start(opts: {
    userData: string;
    creds: BootstrapCreds;
    adminEmail?: string;
    onProgress?: (step: string) => void;
  }): Promise<void> {
    const { userData, creds, adminEmail, onProgress } = opts;
    const progress = onProgress ?? (() => {});

    if (!await this.runtimeAvailable()) {
      throw new Error('native binaries fehlen (resources-native) — fetch-win-native.ps1 ausführen');
    }

    // 0. Sauberer Zustand: Reste eines abgestürzten Vorlaufs killen (pidfiles).
    await this.recojeAlteLauefe(userData);

    const dirs = datenDirs(datenRoot(userData));
    for (const d of [dirs.root, dirs.redis, dirs.weedMaster, dirs.weedVolume, dirs.weedFiler, dirs.uploadsAvatars, dirs.uploadsGuildIcons, dirs.secrets, dirs.backups, dirs.run]) {
      mkdirSync(d, { recursive: true });
    }

    progress('init');
    const secrets = ensureNativeSecrets(dirs.secrets);
    // Öffentlicher Name wie im Container (containerBackendManager:238): mit
    // Relay-Tunnel ist die Subdomain der öffentlich erreichbare Host (der
    // Tunnel routet nur sie) — creds.hostname (app-<id>.relay…) wäre stumm.
    // LIVEKIT_URL/WHEP/JWT-Issuer/CORS hängen alle an diesem Namen.
    const publicHostname = creds.relaySubdomain ?? creds.hostname;
    const env = renderNativeEnv(dirs, secrets, {
      hostname: publicHostname,
      instanceId: creds.instanceId,
      ownerId: creds.ownerId,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      cloudOrigin: creds.cloudOrigin,
      adminEmail,
    });

    // 1. Configs rendern.
    const livekitYamlPath = join(dirs.run, 'livekit.yaml');
    const mediamtxYmlPath = join(dirs.run, 'mediamtx.yml');
    const caddyfilePath = join(dirs.run, 'Caddyfile');
    const weedS3JsonPath = join(dirs.run, 'weed-s3.json');
    writeFileSync(livekitYamlPath, renderLivekitYaml(secrets, NATIVE_PORTS.voice), { encoding: 'utf-8' });
    writeFileSync(mediamtxYmlPath, renderMediamtxYml(publicHostname, dirs.certs, NATIVE_PORTS.mtxHook), { encoding: 'utf-8' });
    writeFileSync(caddyfilePath, renderCaddyfile(NATIVE_PORTS.caddyHttp, NATIVE_PORTS.caddyDesktop, templatesDir()), { encoding: 'utf-8' });
    const signingKey = randomBytes(32).toString('base64');
    writeFileSync(weedS3JsonPath, renderWeedS3Config(secrets.minioUser, secrets.minioPassword, signingKey), { encoding: 'utf-8' });
    await ensureRtmpsCert(dirs.certs, publicHostname, venvPython());
    // Steuerungs-Relay (App-Hosting): nur mit vollständigen Relay-Creds —
    // sonst bleibt frpc aus (wie der schlafende frpc-longrun im Image).
    const frpcTomlPath = creds.relaySubdomain && creds.relayServerAddr && creds.relayTunnelToken
      ? join(dirs.run, 'frpc.toml')
      : null;
    if (frpcTomlPath) {
      writeFileSync(
        frpcTomlPath,
        renderFrpcToml(creds.relaySubdomain!, creds.relayServerAddr!, creds.relayTunnelToken!, NATIVE_PORTS.caddyHttp),
        { encoding: 'utf-8', mode: 0o600 },
      );
    }

    // 2. Prozessbaum — initdb VOR dem Start, Migrationen danach (06-run-
    //    migrations-Äquivalent): Postgres zuerst, dann Schema, dann Rest.
    progress('run');
    ensureInitDb(dirs, secrets);

    const specs = nativeComponents({ dirs, secrets, env, identity: {
      hostname: publicHostname,
      instanceId: creds.instanceId,
      ownerId: creds.ownerId,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      cloudOrigin: creds.cloudOrigin,
      adminEmail,
    }, livekitYamlPath, mediamtxYmlPath, caddyfilePath, weedS3JsonPath, frpcTomlPath });

    const [pgSpec, ...restSpecs] = specs;
    // Port-Kollisions-Gate: antwortet auf 5432 schon ein FREMDES Postgres,
    // würde dessen tcpProbe unser Health-Gate erfüllen und die Diagnose
    // kryptisch werden ("password authentication failed") — besser hier klappen.
    if (await tcpProbe(NATIVE_PORTS.postgres)) {
      throw new Error(
        `Port ${NATIVE_PORTS.postgres} ist bereits belegt (anderes Postgres?) — ` +
        'der Pulse-Server braucht den Port exklusiv.',
      );
    }
    const pg = new SupervisedProcess({
      ...pgSpec,
      gracefulStop: async () => { pgCtlStop(dirs); },
    });
    this.processes = [pg];
    await pg.start();
    writePidFile(dirs.run, 'postgres', pg.pid);

    // 3. Schema + Migrationen.
    progress('migrate');
    waitForPostgres();
    ensureDatabases(secrets);
    runMigrations(venvPython(), {
      auth: serviceDir('auth'),
      chat: serviceDir('chat-gateway'),
    }, secrets);

    // 4. Rest des Baums, jedes Glied mit Health-Gate.
    for (const spec of restSpecs) {
      const proc = new SupervisedProcess(spec);
      this.processes.push(proc);
      await proc.start();
      writePidFile(dirs.run, spec.name, proc.pid);
    }

    // 5. Health-Poll (Erststart braucht Startup der Services) — gleiche Route
    //    wie beim Container (caddyDesktop = desktop-seitiger Publish-Port).
    progress('health');
    await waitFor(
      () => httpHealth(`http://127.0.0.1:${NATIVE_PORTS.caddyDesktop}/api/chat/health`),
      240_000,
      3_000,
    );
  }

  async stop(): Promise<void> {
    if (this.processes.length === 0) return;
    // Umgekehrter Startreihenfolge abfahren — chat-gateway zuerst, Postgres zuletzt.
    for (const proc of [...this.processes].reverse()) {
      await proc.stop().catch(() => {});
    }
    this.processes = [];
  }

  /** give-up "Server aufgeben": Prozesse stoppen, Daten LÖSCHEN. */
  async removeContainer(): Promise<void> {
    await this.stop();
  }

  async removeDataVolume(): Promise<boolean> {
    const userData = userDataPfad();
    if (!userData) throw new Error('userData unbekannt — Datenverzeichnis wird nicht gelöscht');
    const root = datenRoot(userData);
    if (basename(root) !== `data${weltSuffix()}`) throw new Error('unerwarteter Datenpfad — Abbruch');
    await rm(root, { recursive: true, force: true });
    return true;
  }

  /** host:dataInfo für den nativen Pfad. */
  async dataInfo(): Promise<{ sizeBytes: number | null; lastAutoBackupAt: number | null }> {
    const userData = userDataPfad();
    if (!userData) return { sizeBytes: null, lastAutoBackupAt: null };
    const dirs = datenDirs(datenRoot(userData));
    let lastAutoBackupAt: number | null = null;
    try {
      const backups = readdirSync(dirs.backups).filter((f) => f.endsWith('.sql') || f.endsWith('.dump') || f.endsWith('.sql.gz'));
      if (backups.length) {
        lastAutoBackupAt = Math.max(...backups.map((f) => statSync(join(dirs.backups, f)).mtimeMs));
      }
    } catch { /* keine Backups */ }
    return { sizeBytes: dirSizeBytes(dirs.root), lastAutoBackupAt };
  }

  /** Export: Datenverzeichnis als tar (Windows-eigenes bsdtar). */
  async exportData(tarPath: string): Promise<{ ok: boolean; error?: string }> {
    const userData = userDataPfad();
    if (!userData) return { ok: false, error: 'userData unbekannt' };
    const root = datenRoot(userData);
    if (!existsSync(root)) return { ok: false, error: 'keine Daten vorhanden' };
    await execFileAsync('tar', ['-cf', tarPath, '-C', root, '.']);
    return { ok: true };
  }

  /** Import: tar entpacken, Datenverzeichnis vorher leeren. */
  async importData(tarPath: string): Promise<{ ok: boolean; error?: string }> {
    const userData = userDataPfad();
    if (!userData) return { ok: false, error: 'userData unbekannt' };
    const root = datenRoot(userData);
    await rm(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    await execFileAsync('tar', ['-xf', tarPath, '-C', root]);
    return { ok: true };
  }

  /**
   * Reste eines abgestürzten Vorlaufs: pidfiles lesen, PIDs killen. Nötig,
   * weil Windows Kindprozesse NICHT mit dem Elternteil stirbt — nach einem
   * Electron-Crash würden sonst Ports blockiert bleiben.
   */
  private async recojeAlteLauefe(userData: string): Promise<void> {
    const runDir = datenDirs(datenRoot(userData)).run;
    if (!existsSync(runDir)) return;
    for (const f of readdirSync(runDir)) {
      if (!f.endsWith('.pid')) continue;
      const raw = readFileSync(join(runDir, f), 'utf8').trim();
      const pid = Number(raw);
      if (Number.isInteger(pid) && pid > 0) {
        await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F']).catch(() => {});
      }
      rmSync(join(runDir, f), { force: true });
    }
  }
}

function writePidFile(runDir: string, name: string, pid: number | null): void {
  if (pid) writeFileSync(join(runDir, `${name}.pid`), String(pid), { encoding: 'utf8' });
}
