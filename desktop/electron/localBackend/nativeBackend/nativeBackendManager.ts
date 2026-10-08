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
 * Secrets landen NUR in Dateien unter dem Datenverzeichnis — nie in argv/Logs.
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
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
  renderGarnetConf,
} from './configs.ts';
import { nativeComponents } from './components.ts';
import { SupervisedProcess } from './processes.ts';
import {
  ensureInitDb,
  waitForPostgres,
  ensureDatabases,
  runMigrations,
  pgCtlStop,
  postgresStartFehler,
} from './postgres.ts';
import { NATIVE_PORTS } from './types.ts';
import { raeumeAlteLaeufe, loeschePidDateien, schreibePidDatei } from './laufreste.ts';
import { belegtePorts, portBelegtFehler } from './portPruefung.ts';
import { exportiereDaten, importiereDaten, type TransferErgebnis } from './datenTransfer.ts';

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
  await execFileAsync(venvPy, [helper, join(certDir, 'mediamtx.crt'), join(certDir, 'mediamtx.key'), hostname], { timeout: 60_000 })
    .catch((e) => { throw new Error(`[native] RTMPS-Cert fehlgeschlagen: ${e.message}`); });
}

export class NativeBackendManager {
  private processes: SupervisedProcess[] = [];
  /** run/ des laufenden Baums — stop() räumt dort die PID-Dateien weg. */
  private runDir: string | null = null;

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

    const dirs = datenDirs(datenRoot(userData));
    // 0. Reste eines abgestürzten Vorlaufs beenden (nur nachweislich eigene,
    //    laufreste.ts), dann alle festen Ports prüfen — mit zweiter Chance,
    //    falls ein gerade beendeter Rest seinen Port noch hält.
    const beendet = await raeumeAlteLaeufe(dirs.run);
    let belegt = await belegtePorts((port) => tcpProbe(port));
    if (belegt.length && beendet > 0) {
      await new Promise((r) => setTimeout(r, 2000));
      belegt = await belegtePorts((port) => tcpProbe(port));
    }
    if (belegt.length) throw portBelegtFehler(belegt);

    for (const d of [dirs.root, dirs.redis, dirs.weedMaster, dirs.weedVolume, dirs.weedFiler, dirs.uploadsAvatars, dirs.uploadsGuildIcons, dirs.secrets, dirs.backups, dirs.run]) {
      mkdirSync(d, { recursive: true });
    }

    progress('init');
    const secrets = ensureNativeSecrets(dirs.secrets);
    // Öffentlicher Name wie im Container (containerEnv.ts, renderContainerEnv): mit
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
    const garnetConfPath = join(dirs.run, 'garnet.conf');
    writeFileSync(livekitYamlPath, renderLivekitYaml(secrets, NATIVE_PORTS.voice), { encoding: 'utf-8' });
    writeFileSync(mediamtxYmlPath, renderMediamtxYml(publicHostname, dirs.certs, NATIVE_PORTS.mtxHook), { encoding: 'utf-8' });
    writeFileSync(caddyfilePath, renderCaddyfile(NATIVE_PORTS.caddyHttp, NATIVE_PORTS.caddyDesktop, templatesDir()), { encoding: 'utf-8' });
    const signingKey = randomBytes(32).toString('base64');
    writeFileSync(weedS3JsonPath, renderWeedS3Config(secrets.minioUser, secrets.minioPassword, signingKey), { encoding: 'utf-8' });
    writeFileSync(garnetConfPath, renderGarnetConf(secrets.garnetPassword), { encoding: 'utf-8', mode: 0o600 });
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
    await ensureInitDb(dirs, secrets);

    const specs = nativeComponents({ dirs, secrets, env, identity: {
      hostname: publicHostname,
      instanceId: creds.instanceId,
      ownerId: creds.ownerId,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      cloudOrigin: creds.cloudOrigin,
      adminEmail,
    }, livekitYamlPath, mediamtxYmlPath, caddyfilePath, weedS3JsonPath, garnetConfPath, frpcTomlPath });

    const [pgSpec, ...restSpecs] = specs;
    this.runDir = dirs.run;
    const pg = new SupervisedProcess({
      ...pgSpec,
      gracefulStop: () => pgCtlStop(dirs),
    });
    this.processes = [pg];
    mitPidDatei(pg, dirs.run, pgSpec.name, pgSpec.command);
    await pg.start().catch((e: Error) => { throw postgresStartFehler(e, pg.stderrEnde()); });

    // 3. Schema + Migrationen.
    progress('migrate');
    await waitForPostgres();
    await ensureDatabases(secrets);
    await runMigrations(venvPython(), {
      auth: serviceDir('auth'),
      chat: serviceDir('chat-gateway'),
    }, secrets);

    // 4. Rest des Baums, jedes Glied mit Health-Gate.
    for (const spec of restSpecs) {
      const proc = new SupervisedProcess(spec);
      this.processes.push(proc);
      mitPidDatei(proc, dirs.run, spec.name, spec.command);
      await proc.start();
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
    // Gestoppt heißt: keine PID-Datei mehr. Bliebe sie stehen, zielte der
    // nächste Start (womöglich nach einem Neustart mit recycelten PIDs) auf
    // fremde Prozesse.
    if (this.runDir) loeschePidDateien(this.runDir);
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

  /** Export: Datenverzeichnis als tar (datenTransfer.ts — ohne run/). */
  async exportData(tarPath: string): Promise<TransferErgebnis> {
    const userData = userDataPfad();
    if (!userData) return { ok: false, error: 'userData unbekannt' };
    return exportiereDaten(datenRoot(userData), tarPath);
  }

  /** Import: entpacken neben dem Bestand, prüfen, säubern, tauschen
   *  (datenTransfer.ts). Der Bestand bleibt bei jedem Fehler erhalten. */
  async importData(tarPath: string): Promise<TransferErgebnis> {
    const userData = userDataPfad();
    if (!userData) return { ok: false, error: 'userData unbekannt' };
    return importiereDaten(datenRoot(userData), tarPath);
  }
}

/** PID-Datei bei JEDEM Spawn (auch Supervisor-Neustarts) neu schreiben —
 *  mit Image-Pfad und Startzeit, damit ein späteres Aufräumen prüfen kann,
 *  ob die PID noch zu uns gehört (laufreste.ts). */
function mitPidDatei(proc: SupervisedProcess, runDir: string, name: string, image: string): void {
  proc.onSpawn((pid) => {
    try {
      schreibePidDatei(runDir, name, { pid, image, gestartet: Date.now() });
    } catch (e) {
      console.error(`[native] PID-Datei für ${name} nicht schreibbar:`, e);
    }
  });
}
