/**
 * Container-Backend-Manager: startet den kompletten Pulse-Server als EINEN
 * allinone-Container (ersetzt die frühere native Prozess-Orchestrierung —
 * das Image initialisiert Postgres/Secrets/Migrationen selbst, frpc für den
 * Relay-Tunnel läuft seit Phase 0.1 im Image).
 *
 * Ablauf von start():
 *   Runtime wählen (runtimeWahl.ts) → Registry-Login + pull → Env-Datei →
 *   alten Container ersetzen → run → Health-Poll (scheitert ein Update daran:
 *   zurück zur alten Fassung). stop() stoppt den Container; /data bleibt.
 *
 * Secrets (client_secret, Tunnel-Token) landen NUR in der 0600-Env-Datei und
 * im --password-stdin-Login — nie in argv, nie in Logs.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// `node --test` (Unit-Gate) zieht 'electron' als CJS-String-Export (Pfad zum
// Binary) — ein BENANNTER `app`-Import bricht dort schon das Modul-Laden und
// reißt die reinen Funktions-Tests mit ab. Der Default-Import liefert unter
// Electron das echte API-Objekt (.app vorhanden) und unter bare Node einen
// String (.app fehlt → wie „packaged nicht prüfbar").
import electron from 'electron';

import type { BootstrapCreds } from './pairing.ts';
import { ensureMachine, rtExec, runtimeCandidates, type ContainerRuntime } from './containerRuntime.ts';
import { ermittleRuntime, type RuntimeMerker } from './runtimeWahl.ts';
import {
  entferneDatenVolume, entferneImage, gleicheImageId, imageIdVon, legeContainerAn, machineVmIp, netzArgs,
  pruefeImageUpdate, raeumeVerwaistes, starteMacGateway,
} from './containerLauf.ts';
import { containerName, frueherGestartet, weltVerzeichnis } from './containerWelt.ts';
import { waitFor, httpHealth } from './health.ts';
import { startUdpRelay } from './udpRelay.ts';
import { startTcpRelay } from './tcpRelay.ts';
import type { UdpGatewayRelay } from './udpGateway.ts';
import { hostLanIpv4s, istMirrored, vmIpAusIpAusgabe } from './hostNetz.ts';
import { discoverGateway } from './gateway.ts';
import {
  HOST_HTTP_PORT, RELAY_TCP_PORTS, RELAY_UDP_PORTS, UDP_GATEWAY_PORT, UDP_MEDIA_PORTS,
} from './medienPorts.ts';
import { RelaySteuerung, type RelayZiel, type RelayZustand } from './relaySteuerung.ts';
import { pullMitWegwerfLogin } from './registryAuth.ts';
import { meldeDirektOffline, renderContainerEnv, resolveImage, udpGatewayAusFuer } from './containerEnv.ts';
import { gleicheContainerIpAb, oeffentlicheIpFuerStart } from './containerIpAbgleich.ts';

// Bestands-Exporte (Tests, Aufrufer) — die Quellen liegen in hostNetz.ts,
// medienPorts.ts, containerEnv.ts und containerWelt.ts.
export { hostLanIpv4s, vmIpAusIpAusgabe, RELAY_UDP_PORTS, UDP_MEDIA_PORTS, HOST_HTTP_PORT, UDP_GATEWAY_PORT };
export type { RuntimeMerker } from './runtimeWahl.ts';
export {
  abschiedsKoerper, abschiedsUrl, DEFAULT_IMAGE, renderContainerEnv, resolveImage, updateVerdict,
} from './containerEnv.ts';
export type { RelayZustand };
export {
  CONTAINER_NAME, DATA_VOLUME, containerName, datenVolume, setzeContainerWelt, weltVerzeichnis,
} from './containerWelt.ts';

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
   *  Abschieds-Call in stop() und die Registry-Anmeldung des Update-Checks.
   *  null, wenn dieser Prozess den Server nie gestartet hat (Boot-Abgleich
   *  adoptiert einen laufenden Container ohne start()). */
  private creds: BootstrapCreds | null = null;
  private gatewayRelay: UdpGatewayRelay | null = null;
  /** Wo der Server angelegt wurde (runtimeWahl.ts) — main.ts verdrahtet ihn
   *  mit dem Store. Ohne Merker: Podman vor Docker, Bestand zählt. */
  private merker: RuntimeMerker | null = null;
  /** Klartext, warum gerade keine Runtime trägt (null = keiner bekannt). */
  private rtProblem: string | null = null;

  setzeRuntimeMerker(merker: RuntimeMerker | null): void {
    this.merker = merker;
    this.rt = null; // neu wählen: die Merkung kann die Wahl ändern
  }

  /** Runtime lazy wählen + cachen (einmal gefunden, bleibt sie stehen; ein
   *  Fehlschlag wird NICHT gecacht — der Docker-Dienst kommt beim Anmelden
   *  oft erst nach der App hoch). */
  private async ensureRuntime(): Promise<ContainerRuntime | null> {
    if (this.rt) return this.rt;
    const basis = this.userDataPfad();
    const wahl = await ermittleRuntime(
      runtimeCandidates(), this.merker?.lesen() ?? null, basis !== null && frueherGestartet(basis),
    );
    this.rt = wahl.rt;
    this.rtProblem = wahl.problem;
    if (wahl.rt && wahl.ausBestand) this.merker?.schreiben(wahl.rt.kind);
    return this.rt;
  }

  /** Klartext für die Oberfläche, warum der Server gerade keine Runtime hat
   *  (Docker-Dienst aus, kein Gruppenrecht, Podman ohne subuid, gemerkte
   *  Runtime verschwunden) — null, wenn eine Runtime bereitsteht ODER
   *  schlicht keine installiert ist (dafür gibt es den Einrichtungs-Hinweis). */
  async runtimeProblem(): Promise<string | null> {
    return (await this.ensureRuntime()) ? null : this.rtProblem;
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
      const ip = vmIp ?? await machineVmIp(rt);
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
    return rt ? await machineVmIp(rt) : null;
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
    if (!rt) throw new Error(this.rtProblem ?? 'no container runtime found (podman/docker)');
    // Geheimnis-Reste eines abgebrochenen Laufs (App-Ende im Pull/run).
    raeumeVerwaistes(userData);

    // 0. Win/Mac + Podman: Linux-VM hochfahren (Linux/Docker: No-op).
    await ensureMachine(rt, progress);

    // 1. Netz + Env-Inhalt. Nur im VM-Betrieb wird die Host-IP in den
    //    Container gerendert (Linux lässt STUN/srflx laufen). macOS ebenfalls:
    //    LiveKit/LiveMedia kündigen die Mac-LAN-IP an, an der das Host-UDP-
    //    Gateway-Relay lauscht (Windows-Voice-Muster, mac-Nachbau 2026-10-03).
    //    Netz-Modus je Plattform: containerLauf.ts::netzArgs.
    const dir = join(userData, weltVerzeichnis());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const envFile = join(dir, 'container.env');
    const vmBetrieb = process.platform !== 'linux' && rt.kind === 'podman';
    const hostNet = rt.kind === 'podman' && process.platform === 'win32';
    const vmIp = hostNet ? await machineVmIp(rt) : null;
    if (hostNet && !vmIp) {
      throw new Error('podman-machine-VM-IP nicht ermittelbar (host-Networking)');
    }
    const gateway = await discoverGateway().catch(() => null);
    const lanIps = hostLanIpv4s(undefined, { gateway, vmIp });
    const envInhalt = renderContainerEnv(
      creds, adminEmail, lanIps, vmBetrieb ? lanIps[0] : undefined, udpGatewayAusFuer(),
      await oeffentlicheIpFuerStart(),
    );

    const { image, local } = resolveImage();
    if (!local) {
      // 2.+3. Registry-Login mit den Instanz-Creds + Pull gegen eine Wegwerf-
      // Anmeldedatei (registryAuth.ts). Beim Erststart mehrere hundert MB.
      const r = await pullMitWegwerfLogin({
        rt, image, benutzer: creds.clientId, passwort: creds.clientSecret,
        basisVerzeichnis: dir,
        onLogin: () => progress('login'),
        onPull: () => progress('pull'),
      });
      if (!r.ok) {
        throw new Error(r.schritt === 'login'
          ? `registry login failed (exit ${r.code})`
          : `image pull failed (exit ${r.code})`);
      }
    }

    // 4. Alten Container ersetzen (containerLauf.ts::legeContainerAn — dort
    //    auch, warum die Env-Datei erst JETZT, nach dem Pull, entsteht).
    const netArgs = netzArgs(hostNet);
    const anlegen = (img: string): Promise<void> =>
      legeContainerAn(rt, { envFile, envInhalt, netArgs, image: img });
    progress('run');
    // Image des Vorgängers merken: fällt das neue durch den Health-Check,
    // geht es mit ihm zurück, statt den Server in einer Neustart-Schleife zu
    // lassen.
    const altesImage = await imageIdVon(rt, containerName());
    await anlegen(image);
    this.merker?.schreiben(rt.kind);
    const neuesImage = await imageIdVon(rt, containerName());
    const istUpdate = altesImage !== null && neuesImage !== null && !gleicheImageId(altesImage, neuesImage);

    // 5. Health-Poll — Erststart braucht initdb + Migrationen (Image-Healthcheck
    //    rechnet mit 120s start-period; wir geben 240s). host-Networking: 8080
    //    liegt auf der VM-Host-IP; Publish: auf 127.0.0.1.
    progress('health');
    const healthUrl = hostNet
      ? `http://${vmIp}:8080/api/chat/health`
      : `http://127.0.0.1:${HOST_HTTP_PORT}/api/chat/health`;
    const gesund = (): Promise<void> => waitFor(() => httpHealth(healthUrl), 240_000, 3_000);
    try {
      await gesund();
    } catch (err) {
      if (!istUpdate || !altesImage) throw err;
      // Rückweg: die alte Fassung auf demselben Volume. Offen: hat die neue
      // vor dem Scheitern schon Migrationen gefahren, läuft die alte gegen
      // ein neueres Schema — besser als gar kein Server, aber nicht garantiert.
      progress('rollback');
      await anlegen(altesImage);
      const alteLaeuft = await gesund().then(() => true, () => false);
      if (alteLaeuft) await this.nachStart(rt, vmIp, progress);
      throw new Error(alteLaeuft
        ? 'Update fehlgeschlagen — die neue Server-Fassung startete nicht, die alte Fassung läuft wieder.'
        : 'Update fehlgeschlagen — die neue Server-Fassung startete nicht, und auch die alte Fassung kommt nicht mehr hoch.');
    }
    // Abgelöstes Image freigeben (sonst sammeln sich je Update ~900 MB an).
    // Nicht beim Dev-Override: dort kann die alte ID ein getaggtes Image sein.
    if (istUpdate && altesImage && !local) await entferneImage(rt, altesImage);
    await this.nachStart(rt, vmIp, progress);
  }

  /** Nach einem gesunden Container: Windows-Host-Relays in die VM
   *  (Portlisten: medienPorts.ts; mit `--network host` binden die Dienste nur
   *  in der VM), macOS: das UDP-Gateway-Relay (containerLauf.ts). */
  private async nachStart(rt: ContainerRuntime, vmIp: string | null, progress: (step: string) => void): Promise<void> {
    await this.ensureRelay(vmIp);
    if (process.platform !== 'darwin') return;
    this.gatewayRelay?.close();
    this.gatewayRelay = null;
    this.gatewayRelay = await starteMacGateway(rt, progress);
  }

  async stop(): Promise<void> {
    // Abschied SOFORT und parallel zum Container-Stopp lostreten: bei App-
    // -Ende (before-quit feuert fire-and-forget) hält nur der zweite Quit-
    // -Handler (Sidecar-Backstop) den Prozess kurz am Leben — ein Abschied
    // NACH dem bis zu 20 s langen `podman stop` käme zu spät.
    // ponytail: Ein letzter Adapter-Herzschlag kann das ~1–2-s-SIGTERM-Fenster
    // (bei 120-s-Takt) theoretisch überholen und den Eintrag neu anlegen —
    // dann greift der clientseitige Dial-Deckel; kein Datenproblem.
    void meldeDirektOffline(this.creds);
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

  /** Update-Check im Betrieb: Image pullen (Login gegen eine Wegwerf-
   *  Anmeldedatei, registryAuth.ts — ohne Pairing-Creds kein Check) und die
   *  Image-ID des laufenden Containers mit der des frisch gepullten Images
   *  vergleichen (containerLauf.ts::pruefeImageUpdate). Jeder Fehler
   *  (offline, Registry down, Container weg) → 'none' — nächster Versuch beim
   *  nächsten Intervall, kein Alarm. Dev-Image-Override (PULSE_HOST_IMAGE)
   *  überspringt den Check komplett (kein Registry-Realm für Dev-Creds). */
  async checkImageUpdate(): Promise<'update' | 'none'> {
    const { image, local } = resolveImage();
    if (local) return 'none';
    const rt = await this.ensureRuntime();
    const basis = this.userDataPfad();
    if (!rt || !this.creds || !basis) return 'none';
    return pruefeImageUpdate(rt, image, this.creds, join(basis, weltVerzeichnis()));
  }

  /** Läuft der `pulse-host`-Container gerade (unabhängig davon, ob diese
   *  App-Instanz ihn selbst gestartet hat — `--restart unless-stopped`
   *  überlebt App-/Host-Neustarts)? argv-Array, keine Shell-Interpolation.
   *  `inspect` auf einen fehlenden Container liefert exit != 0 → false. */
  /** Öffentliche IP ↔ LiveKit nachziehen (containerIpAbgleich.ts). */
  async abgleichOeffentlicheIp(): Promise<string> {
    const rt = await this.ensureRuntime();
    return rt ? gleicheContainerIpAb(rt) : 'nicht-zustaendig';
  }

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
    if (basis) raeumeVerwaistes(basis);
  }

  /** Daten-Volume löschen (nur nach removeContainer — sonst "volume in use").
   *  true bei Erfolg; ein bereits fehlendes Volume zählt als Erfolg. */
  async removeDataVolume(): Promise<boolean> {
    const rt = await this.ensureRuntime();
    return rt ? entferneDatenVolume(rt) : false;
  }
}
