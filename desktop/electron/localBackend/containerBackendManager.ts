/**
 * Container-Backend-Manager: startet den kompletten Pulse-Server als EINEN
 * allinone-Container (ersetzt die frühere native Prozess-Orchestrierung —
 * das Image initialisiert Postgres/Secrets/Migrationen selbst, frpc für den
 * Relay-Tunnel läuft seit Phase 0.1 im Image).
 *
 * Ablauf von start():
 *   Runtime finden → Env-Datei rendern (nur die PULSE_*-Pairing-Werte) →
 *   Registry-Login (Instanz-Creds) → pull → alten Container ersetzen → run →
 *   Health-Poll. stop() stoppt den Container; das /data-Volume bleibt.
 *
 * Secrets (client_secret, Tunnel-Token) landen NUR in der 0600-Env-Datei und
 * im --password-stdin-Login — nie in argv, nie in Logs.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// `node --test` (Unit-Gate) zieht 'electron' als CJS-String-Export (Pfad zum
// Binary) — ein BENANNTER `app`-Import bricht dort schon das Modul-Laden und
// reißt die reinen Funktions-Tests mit ab. Der Default-Import liefert unter
// Electron das echte API-Objekt (.app vorhanden) und unter bare Node einen
// String (.app fehlt → wie „packaged nicht prüfbar").
import electron from 'electron';

import type { BootstrapCreds } from './pairing.ts';
import { detectRuntime, ensureMachine, rtExec, type ContainerRuntime } from './containerRuntime.ts';
import { waitFor, httpHealth } from './health.ts';
import { startUdpRelay } from './udpRelay.ts';
import { startTcpRelay } from './tcpRelay.ts';
import { startUdpGatewayRelay, probeGateway, type UdpGatewayRelay } from './udpGateway.ts';
import { UDP_GATEWAY_SNIPPET } from './udpGatewaySnippet.ts';
import { hostLanIpv4s, istMirrored, vmIpAusIpAusgabe } from './hostNetz.ts';
import { discoverGateway } from './gateway.ts';
import {
  RELAY_TCP_PORTS, RELAY_UDP_PORTS, UDP_MEDIA_PORTS, macTcpPortArgs, mediaPortArgs,
} from './medienPorts.ts';
import { RelaySteuerung, type RelayZiel, type RelayZustand } from './relaySteuerung.ts';
import { pullMitWegwerfLogin } from './registryAuth.ts';
import { abschiedsKoerper, abschiedsUrl, renderContainerEnv, resolveImage, updateVerdict } from './containerEnv.ts';

// Bestands-Exporte (Tests, Aufrufer) — die Quellen liegen jetzt in hostNetz.ts,
// medienPorts.ts und containerEnv.ts.
export { hostLanIpv4s, vmIpAusIpAusgabe, RELAY_UDP_PORTS, UDP_MEDIA_PORTS };
export {
  abschiedsKoerper, abschiedsUrl, DEFAULT_IMAGE, renderContainerEnv, resolveImage, updateVerdict,
} from './containerEnv.ts';
export type { RelayZustand };

export const CONTAINER_NAME = 'pulse-host';
export const DATA_VOLUME = 'pulse-host-data';

// ── macOS-Medienpfad (gvproxy) ──────────────────────────────────────────────
// Die podman-machine auf macOS published UDP nicht in die VM (nachgewiesen
// 2026-10-03: Pakete an published UDP-Ports kommen nie im Container an, auch
// nicht nach Outbound-Aktivität) — die UDP-Publishes aus mediaPortArgs() sind
// dort toter Ballast. Stattdessen: kein UDP-Publish, dafür der TCP-Port des
// UDP-Gateways (s6-Service im Image, nur 127.0.0.1), und die Server-App
// bindet die Medien-UDP-Ports selbst und kapselt jeden Client-Flow per
// TCP-Frames dorthin (udpGateway.ts). Windows bleibt beim host-networking-
// Weg mit dem VM-IP-Relay, Linux beim klassischen Publish (nativer NAT).
export const UDP_GATEWAY_PORT = 55981;

// ── Benutzer-Welten ─────────────────────────────────────────────────────────
// Jedes Cloud-Konto bekommt auf diesem Gerät seine EIGENE Welt: eigener
// Container-Name, eigenes Daten-Volume, eigene Env-Datei. Umgeschaltet wird
// über die Anmeldung in der Server-App (`setzeContainerWelt`) — der Container
// des abgemeldeten Benutzers wird gestoppt, sein Volume (und damit seine
// Communities) bleibt unangetastet und ist bei der nächsten Anmeldung wieder
// da. `null` = die Legacy-Welt (Suffix-los): der Bestands-Server der ersten
// Stunde gehört dem Konto, das auch die unverschlüsselten Bestands-Creds
// besitzt — so bleibt die bestehende Installation ohne Migration erhalten.
let containerWelt: string | null = null;

export function setzeContainerWelt(key: string | null): void {
  containerWelt = key;
}

export function containerName(): string {
  return CONTAINER_NAME + (containerWelt ? `-${containerWelt}` : '');
}

export function datenVolume(): string {
  return DATA_VOLUME + (containerWelt ? `-${containerWelt}` : '');
}

/** Welt-Verzeichnisname für die Env-Datei (unter userData) — dasselbe Namens-
 *  schema wie der Container der Welt. */
export function weltVerzeichnis(): string {
  return containerName();
}

/** Host-Port für den behind-proxy-HTTP des Containers (nur 127.0.0.1 —
 *  öffentlicher Zugang läuft über den Relay-Tunnel im Container). Bewusst
 *  hoch/ephemer, analog zu den alten nativen Default-Ports. */
export const HOST_HTTP_PORT = 55580;

export class ContainerBackendManager {
  private rt: ContainerRuntime | null = null;
  /** Windows-Host-Relays (UDP + TCP) in die VM — Lebenszyklus s. relaySteuerung.ts. */
  private readonly relays = new RelaySteuerung({
    udp: (vmIp, bindIps) => startUdpRelay(RELAY_UDP_PORTS, vmIp, console.log, { bindIps }),
    tcp: (vmIp) => startTcpRelay(RELAY_TCP_PORTS, vmIp),
  });
  /** userData des letzten start() — für die Wegwerf-Registry-Anmeldung im
   *  Update-Check (registryAuth.ts). */
  private userData: string | null = null;
  /** Pairing-Creds des letzten start() bzw. von setzeCreds — für den
   *  Abschieds-Call in stop() (Telefonbuch-Eintrag sofort löschen statt 300 s
   *  „online“-Lüge, 2026-10-03) und die Registry-Anmeldung des Update-Checks. null, wenn dieser Prozess den Server nie gestartet hat
   *  (Boot-Abgleich adoptiert einen laufenden Container ohne start()). */
  private creds: BootstrapCreds | null = null;
  private gatewayRelay: UdpGatewayRelay | null = null;

  /** Runtime lazy erkennen + cachen (einmal gefunden, bleibt sie stehen). */
  private async ensureRuntime(): Promise<ContainerRuntime | null> {
    if (!this.rt) this.rt = await detectRuntime();
    return this.rt;
  }

  /** IP der podman-machine-VM — Ziel der Host-Relays (nur Windows/WSL2).
   *  null auf Linux/Docker/macOS oder wenn die Abfrage scheitert (fail-soft:
   *  kein Relay). macOS seit 2026-09-28 bewusst AUS: applehv-Maschinen netzen
   *  gvproxy-seitig (VM-IP vom Host aus unerreichbar, s. Kommentar beim
   *  Netzwerk-Modus), der Container publiziert seine Ports direkt — ein Relay
   *  aufs Nichts kollidierte sogar mit gvproxy auf 1936. */
  private async machineVmIp(rt: ContainerRuntime): Promise<string | null> {
    if (rt.kind !== 'podman') return null;
    if (process.platform !== 'win32') return null;
    // Interface NICHT anfassen, ganze Ausgabe parsen: WSL2 heißt es eth0, aber
    // Podman 6 auf macOS (applehv-VM) nennt es enp0s1 — fixiert brach der Mac-
    // Erststart mit "VM-IP nicht ermittelbar" ab (E2E 2026-09-28). Die erste
    // globale IPv4 ist die VM-Adresse, egal wie das Interface heißt.
    const r = await rtExec(rt, ['machine', 'ssh', 'ip -4 addr show'], {
      timeoutMs: 20_000,
    }).catch(() => null);
    return r?.code === 0 ? vmIpAusIpAusgabe(r.stdout) : null;
  }

  /** Host-Relays in die VM abgleichen (Single-Flight, Ziel-Vergleich,
   *  Mirrored-Erkennung — s. relaySteuerung.ts). Ohne VM (Linux/Docker/macOS)
   *  ein No-op. Public, weil auch der Boot-Zustands-Abgleich (main.ts,
   *  Container lief über den App-Neustart hinweg weiter) und jeder
   *  host:refresh die Relays nachziehen; nach einem WSL-Neustart mit neuer
   *  VM-IP startet derselbe Aufruf sie gegen die neue Adresse neu. */
  ensureRelay(vmIp?: string | null): Promise<void> {
    return this.relays.abgleichen(async (): Promise<RelayZiel | null> => {
      const rt = await this.ensureRuntime();
      if (!rt) return null;
      // start() reicht die schon ermittelte VM-IP durch (spart den zweiten
      // machine-ssh-Call); sonst selbst ermitteln.
      const ip = vmIp ?? await this.machineVmIp(rt);
      if (!ip) return null;
      const gateway = await discoverGateway().catch(() => null);
      return { vmIp: ip, bindIps: hostLanIpv4s(undefined, { gateway, vmIp: ip }), mirrored: istMirrored(ip) };
    });
  }

  /** Diagnose-Stand der Host-Relays: Ziel-VM-IP, Bind-Adressen, Mirrored-
   *  Flag und die wirklich gebundenen Ports. Leer außerhalb des VM-Betriebs. */
  relayZustand(): RelayZustand {
    return this.relays.zustand();
  }

  /** userData des letzten start(), sonst Electrons Pfad (Adoption ohne
   *  start(), „Server aufgeben" nach App-Neustart); unter bare Node null. */
  private userDataPfad(): string | null {
    return this.userData
      ?? (electron as { app?: { getPath?(n: string): string } }).app?.getPath?.('userData')
      ?? null;
  }

  /** Für das UI-Gating: gibt es überhaupt eine Runtime? (gecacht nach Erfolg) */
  async runtimeAvailable(): Promise<boolean> {
    return (await this.ensureRuntime()) !== null;
  }

  /** Erkannte Runtime (lazy) — für Plattform-Prereq-Checks (WSL-Assistent). */
  async runtime(): Promise<ContainerRuntime | null> {
    return this.ensureRuntime();
  }

  /** IP der podman-machine-VM vom Host aus — Ziel des Health-Polls und der
   *  Host-Relays, wenn der Container mit `--network host` IN der VM läuft
   *  (Windows). null auf anderen Plattformen oder bei Abfrage-Fehler. */
  async vmIp(): Promise<string | null> {
    const rt = await this.runtime();
    return rt ? await this.machineVmIp(rt) : null;
  }

  async start(opts: {
    userData: string;
    creds: BootstrapCreds;
    adminEmail?: string;
    onProgress?: (step: string) => void;
  }): Promise<void> {
    const { userData, creds, adminEmail, onProgress } = opts;
    const progress = onProgress ?? (() => {});
    this.creds = creds;
    this.userData = userData;

    const rt = await this.ensureRuntime();
    if (!rt) {
      throw new Error('no container runtime found (podman/docker)');
    }

    // 0. Win/Mac + Podman: Linux-VM hochfahren (Linux/Docker: No-op).
    await ensureMachine(rt, progress);

    // 1. Env-Datei (0600) — einzige Stelle mit Klartext-Secrets auf der Platte,
    //    und nur bis `run` sie gelesen hat (gelöscht in Schritt 5). Vorher
    //    löschen: `mode` greift nur beim ANLEGEN, eine Altdatei behielte
    //    sonst ihre Rechte. (Windows ignoriert `mode`; dort schützt allein das
    //    Benutzerprofil, deshalb zählt das sofortige Löschen doppelt.)
    const dir = join(userData, weltVerzeichnis());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const envFile = join(dir, 'container.env');
    // Gleiche Bedingung wie der Netz-Modus in Schritt 4 (hostNet): nur im
    // VM-Betrieb muss die Host-IP in den Container gerendert werden. Linux
    // lässt STUN/srflx laufen — dort ist der Internetweg damit bewiesen.
    // macOS ebenfalls: LiveKit/LiveMedia kündigen statt der Container-IP die
    // Mac-LAN-IP an, an der das Host-UDP-Gateway-Relay lauscht (gvproxy
    // reicht UDP nicht durch — Windows-Voice-Muster, mac-Nachbau 2026-10-03).
    const vmBetrieb = process.platform !== 'linux' && rt.kind === 'podman';
    const hostNet = rt.kind === 'podman' && process.platform === 'win32';
    const vmIp = hostNet ? await this.machineVmIp(rt) : null;
    if (hostNet && !vmIp) {
      throw new Error('podman-machine-VM-IP nicht ermittelbar (host-Networking)');
    }
    const gateway = await discoverGateway().catch(() => null);
    const lanIps = hostLanIpv4s(undefined, { gateway, vmIp });
    const vmAnnounceIp = vmBetrieb ? lanIps[0] : undefined;
    rmSync(envFile, { force: true });
    writeFileSync(envFile, renderContainerEnv(creds, adminEmail, lanIps, vmAnnounceIp, hostNet), {
      encoding: 'utf8',
      mode: 0o600,
    });

    const { image, local } = resolveImage();
    if (!local) {
      // 2.+3. Registry-Login mit den Instanz-Creds + Pull, beides gegen eine
      // Wegwerf-Anmeldedatei (registryAuth.ts). Beim Erststart mehrere
      // hundert MB, danach Digest-Check (= Update).
      const r = await pullMitWegwerfLogin({
        rt, image, benutzer: creds.clientId, passwort: creds.clientSecret,
        basisVerzeichnis: dir,
        onLogin: () => progress('login'),
        onPull: () => progress('pull'),
      });
      if (!r.ok) {
        rmSync(envFile, { force: true });
        throw new Error(r.schritt === 'login'
          ? `registry login failed (exit ${r.code})`
          : `image pull failed (exit ${r.code})`);
      }
    }

    // 4. Netzwerk-Modus wählen. Nur Windows (podman machine/WSL2): --network
    //    host, weil rootless podman auf der WSL-VM eingehendes UDP NICHT über
    //    published Ports in den Container leitet (TCP schon) — Direktpfad +
    //    Voice bekämen nie ein Paket. Mit host-Networking bindet der Container
    //    direkt auf der VM-Host-IP; von dort trägt der UDP-Relay (ensureRelay)
    //    das Paket vom Windows-Host in die VM. Das setzt voraus, dass der Host
    //    die VM-IP erreicht — unter WSL2 tut er das.
    //
    //    **macOS NICHT mehr auf diesem Weg** (E2E 2026-09-28): Podman-Maschinen
    //    auf arm-Macs sind applehv (5.8 wie 6.x, default) und netzen über
    //    gvproxy im USERSPACE — die VM-IP (192.168.127.2, enp0s1) ist vom Host
    //    aus grundsätzlich nicht erreichbar, rootful ändert daran nichts. Der
    //    host-net-Weg mündete dort in "VM-IP nicht ermittelbar"/unerreichbare
    //    Dienste. macOS fährt deshalb den klassischen Publish-Pfad (wie
    //    Linux/Docker): gvproxy leitet published TCP UND UDP weiter, die
    //    Medien-Ports stehen auf 0.0.0.0 (LAN-erreichbar), HTTP auf
    //    127.0.0.1:55580. Ob Lande-Voice/Direktpfad-UDP über gvproxy in
    //    Produktqualität läuft, muss ein Realgeräte-Test zeigen — offener
    //    Punkt, nicht vom Boot-E2E gedeckt.
    //    (hostNet/vmIp sind schon in Schritt 1 ermittelt.)
    // macOS (gvproxy): UDP-Publishes raus (kommen nie an), dafür den
    // TCP-Port des UDP-Gateways — nur 127.0.0.1, der Weg ist Loopback.
    const udpViaGateway = process.platform === 'darwin';
    let netArgs: string[];
    if (hostNet) {
      netArgs = ['--network', 'host'];
    } else if (udpViaGateway) {
      netArgs = [
        '-p', `127.0.0.1:${HOST_HTTP_PORT}:8080`,
        ...macTcpPortArgs(),
        '-p', `127.0.0.1:${UDP_GATEWAY_PORT}:${UDP_GATEWAY_PORT}/tcp`,
      ];
    } else {
      netArgs = ['-p', `127.0.0.1:${HOST_HTTP_PORT}:8080`, ...mediaPortArgs()];
    }

    // 5. Alten Container ersetzen (Recreate statt Restart → nimmt frisch
    //    gepullte Images + Env-Änderungen mit; /data lebt im Named Volume).
    progress('run');
    //    Die Env-Datei braucht nur `run`: die Runtime liest sie beim Anlegen
    //    und legt die Werte in der Container-Konfiguration ab (auch
    //    `--restart unless-stopped` liest sie nicht erneut) — danach weg.
    await rtExec(rt, ['rm', '-f', containerName()], { timeoutMs: 60_000 });
    const run = await rtExec(rt, [
      'run', '-d',
      '--name', containerName(),
      '--restart', 'unless-stopped',
      '--env-file', envFile,
      '-v', `${datenVolume()}:/data`,
      ...netArgs,
      image,
    ], { timeoutMs: 120_000 }).finally(() => rmSync(envFile, { force: true }));
    if (run.code !== 0) {
      throw new Error(`container start failed (exit ${run.code}): ${run.stderr.slice(0, 400)}`);
    }

    // 6. Health-Poll — Erststart braucht initdb + Migrationen (Image-Healthcheck
    //    rechnet mit 120s start-period; wir geben 240s). waitFor wirft bei Timeout.
    //    host-Networking: 8080 liegt auf der VM-Host-IP; Publish: auf 127.0.0.1.
    progress('health');
    const healthHost = hostNet ? vmIp : '127.0.0.1';
    const healthPort = hostNet ? 8080 : HOST_HTTP_PORT;
    await waitFor(
      () => httpHealth(`http://${healthHost}:${healthPort}/api/chat/health`),
      240_000,
      3_000,
    );

    // 7. Windows: Host-Relays in die VM (Portlisten: medienPorts.ts) — UDP für
    //    Direktpfad/Voice/WHEP, TCP für RTMPS (localhost:1936) und LiveKits
    //    ICE-TCP 7881. Mit `--network host` binden sie nur in der VM.
    await this.ensureRelay(vmIp);

    // 8. macOS: UDP-Medien-Ports am Host binden und per TCP-Frames durch das
    //    Container-Gateway reichen (udpViaGateway — gvproxy leitet UDP nicht).
    //    Gateway fehlt (altes Image) → einmalig per exec -d nachstarten.
    if (udpViaGateway) {
      const gwHost = '127.0.0.1';
      const bereit = await probeGateway(gwHost, UDP_GATEWAY_PORT);
      if (!bereit) {
        progress('gateway');
        const exec = await rtExec(
          rt,
          ['exec', '-d', containerName(), '/opt/pulse/venv/bin/python3', '-c', UDP_GATEWAY_SNIPPET],
          { timeoutMs: 30_000 },
        );
        if (exec.code !== 0) {
          throw new Error(`udp-gateway exec fehlgeschlagen: ${exec.stderr.slice(0, 300)}`);
        }
        const ok = await waitFor(() => probeGateway(gwHost, UDP_GATEWAY_PORT), 20_000, 1_000).catch(() => false);
        if (!ok) throw new Error('udp-gateway im Container nicht erreichbar');
      }
      this.gatewayRelay = await startUdpGatewayRelay(
        UDP_MEDIA_PORTS, gwHost, UDP_GATEWAY_PORT,
        (msg) => console.log(msg),
      );
    }
  }

  async stop(): Promise<void> {
    // Abschied SOFORT und parallel zum Container-Stopp lostreten: bei App-
    // -Ende (before-quit feuert fire-and-forget) hält nur der zweite Quit-
    // -Handler (Sidecar-Backstop) den Prozess kurz am Leben — ein Abschied
    // NACH dem bis zu 20 s langen `podman stop` käme zu spät.
    // ponytail: Ein letzter Adapter-Herzschlag kann das ~1–2-s-SIGTERM-Fenster
    // (bei 120-s-Takt) theoretisch überholen und den Eintrag neu anlegen —
    // dann greift der clientseitige Dial-Deckel; kein Datenproblem.
    void this.meldeDirektOffline();
    this.relays.close();
    this.gatewayRelay?.close();
    this.gatewayRelay = null;
    const rt = await this.ensureRuntime();
    if (!rt) return;
    // -t 20: Postgres im Container sauber runterfahren lassen.
    await rtExec(rt, ['stop', '-t', '20', containerName()], {
      timeoutMs: 60_000,
    }).catch(() => {});
  }

  /** Pairing-Creds nachziehen (Adoption eines laufenden Containers ohne
   *  start() in dieser Sitzung, Benutzer-/Weltwechsel in main.ts) — ohne sie
   *  bliebe der Abschied beim Stopp stumm, und der Update-Check meldet 'none'
   *  (er meldet sich seit 2026-10-08 je Lauf frisch an der Registry an). */
  setzeCreds(creds: BootstrapCreds | null): void {
    this.creds = creds;
  }

  /** Sagt der Cloud „ich gehe jetzt offline“ — löscht den Telefonbuch-Eintrag
   *  sofort, statt ihn bis zur Online-Schwelle (300 s) „online“ lügen zu
   *  lassen: in diesem Fenster würden Clients auf den toten UDP-Port dialen
   *  und die vollen ICE-Timeouts verbrennen (2026-10-03). Auth wie der
   *  Herzschlag des Adapters: Pairing-Creds (client_id + client_secret).
   *  Fire-and-forget, 2-s-Deckel; Fehler egal (Worst Case = Status quo). */
  private async meldeDirektOffline(): Promise<void> {
    const c = this.creds;
    if (!c) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2_000);
    try {
      await fetch(abschiedsUrl(c), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(abschiedsKoerper(c)),
        signal: ctl.signal,
      });
    } catch {
      /* offline/Cloud down — der Eintrag altert wie bisher von allein */
    } finally {
      clearTimeout(timer);
    }
  }

  /** Update-Check im Betrieb: Image pullen (Login gegen eine Wegwerf-
   *  Anmeldedatei, registryAuth.ts — ohne Pairing-Creds kein Check) und die Image-ID des laufenden
   *  Containers mit der des frisch gepullten Images vergleichen. Jeder Fehler
   *  (offline, Registry down, Container weg) → 'none' — nächster Versuch beim
   *  nächsten Intervall, kein Alarm. Dev-Image-Override (PULSE_HOST_IMAGE)
   *  überspringt den Check komplett (kein Registry-Realm für Dev-Creds). */
  async checkImageUpdate(): Promise<'update' | 'none'> {
    const { image, local } = resolveImage();
    if (local) return 'none';
    const rt = await this.ensureRuntime();
    if (!rt) return 'none';
    const c = this.creds;
    const basis = this.userDataPfad();
    if (!c || !basis) return 'none';
    const pull = await pullMitWegwerfLogin({
      rt, image, benutzer: c.clientId, passwort: c.clientSecret,
      basisVerzeichnis: join(basis, weltVerzeichnis()),
    }).catch(() => null);
    if (!pull?.ok) return 'none';
    const running = await rtExec(
      rt, ['inspect', containerName(), '--format', '{{.Image}}'], { timeoutMs: 15_000 },
    ).catch(() => null);
    const pulled = await rtExec(
      rt, ['image', 'inspect', image, '--format', '{{.Id}}'], { timeoutMs: 15_000 },
    ).catch(() => null);
    if (running?.code !== 0 || pulled?.code !== 0) return 'none';
    return updateVerdict(running.stdout, pulled.stdout);
  }

  /** Läuft der `pulse-host`-Container gerade (unabhängig davon, ob diese
   *  App-Instanz ihn selbst gestartet hat — `--restart unless-stopped`
   *  überlebt App-/Host-Neustarts)? argv-Array, keine Shell-Interpolation.
   *  `inspect` auf einen fehlenden Container liefert exit != 0 → false. */
  async isContainerRunning(): Promise<boolean> {
    const rt = await this.ensureRuntime();
    if (!rt) return false;
    const r = await rtExec(
      rt,
      ['inspect', containerName(), '--format', '{{.State.Running}}'],
      { timeoutMs: 15_000 },
    ).catch(() => null);
    return r?.code === 0 && r.stdout.trim() === 'true';
  }

  /** "Server aufgeben": Container komplett entfernen (sauberer Stop zuerst,
   *  dann rm -f — ein fehlender Container ist kein Fehler). Ohne das rm würde
   *  `--restart unless-stopped` ihn beim nächsten Host-Boot wiederbeleben. */
  async removeContainer(): Promise<void> {
    const rt = await this.ensureRuntime();
    if (!rt) return;
    await this.stop();
    await rtExec(rt, ['rm', '-f', containerName()], { timeoutMs: 60_000 }).catch(() => {});
    // Env-Datei mit client_secret/Tunnel-Token: seit 2026-10-08 löscht start()
    // sie gleich nach `run`; Altinstallationen haben sie noch liegen.
    const basis = this.userDataPfad();
    if (basis) rmSync(join(basis, weltVerzeichnis(), 'container.env'), { force: true });
  }

  /** Daten-Volume löschen (nur nach removeContainer — sonst "volume in use").
   *  true bei Erfolg; ein bereits fehlendes Volume zählt als Erfolg. */
  async removeDataVolume(): Promise<boolean> {
    const rt = await this.ensureRuntime();
    if (!rt) return false;
    const exists = await rtExec(rt, ['volume', 'inspect', datenVolume()], { timeoutMs: 15_000 })
      .catch(() => null);
    if (exists?.code !== 0) return true; // schon weg — nichts zu tun
    const r = await rtExec(rt, ['volume', 'rm', datenVolume()], { timeoutMs: 60_000 })
      .catch(() => null);
    return r?.code === 0;
  }
}
