/**
 * Reine Bausteine des Container-Wegs (aus containerBackendManager.ts
 * herausgezogen, Größen-Policy): Image-Wahl, Env-Rendering, Update-
 * Entscheidung, Abschieds-Call. Keine I/O ausser dem Electron-Default-Import
 * (s. Kommentar dort).
 */

// `node --test` (Unit-Gate) zieht 'electron' als CJS-String-Export (Pfad zum
// Binary) — ein BENANNTER `app`-Import bricht dort schon das Modul-Laden.
// Der Default-Import liefert unter Electron das echte API-Objekt (.app
// vorhanden) und unter bare Node einen String (.app fehlt → wie „packaged
// nicht prüfbar").
import electron from 'electron';

import type { BootstrapCreds } from './pairing.ts';

/** Ziel-URL des Abschieds-Calls (Telefonbuch-Abmeldung, s. meldeDirektOffline). */
export function abschiedsUrl(creds: BootstrapCreds): string {
  return `${creds.cloudOrigin}/api/auth/selfhost/directory/offline`;
}

/** Körper des Abschieds-Calls: Pairing-Identität wie beim Herzschlag des
 *  Adapters (client_id + client_secret als `token`, Route _authed_instance). */
export function abschiedsKoerper(creds: BootstrapCreds): {
  instance_id: string;
  token: string;
  client_id: string;
} {
  return {
    instance_id: creds.instanceId,
    token: creds.clientSecret,
    client_id: creds.clientId,
  };
}

export const DEFAULT_IMAGE = 'registry.howispulse.com/pulse-allinone:edge';

/** Dev/Test-Seam: `PULSE_HOST_IMAGE` zeigt auf ein lokal gebautes Image —
 *  dann entfallen Registry-Login + Pull (Dev-Instanz-Creds existieren im
 *  Prod-Registry-Realm nicht). Prod-Pfad bleibt der Default.
 *
 *  Security-Scan 2026-09-18: Der Override greift NUR in ungepackten Builds
 *  (Muster wie PULSE_URL in main.ts) — mit Env-Kontrolle über einen gepackten
 *  Build liefe sonst ein Angreifer-Image als `pulse-host` und empfinge
 *  Bootstrap-Creds/Relay-Token direkt in seinem Environment
 *  (siehe `renderContainerEnv`). */
export function resolveImage(env: Record<string, string | undefined> = process.env): {
  image: string;
  local: boolean;
} {
  const override = env.PULSE_HOST_IMAGE;
  const isPackaged = (electron as { app?: { isPackaged?: boolean } }).app?.isPackaged ?? false;
  if (override && !isPackaged) return { image: override, local: true };
  if (override) {
    console.warn('[host] PULSE_HOST_IMAGE ignored in packaged build (developer-only override).');
  }
  return { image: DEFAULT_IMAGE, local: false };
}

/** Rendert die kleine Container-Env: nur Pairing-Identität + Relay + TLS-Modus
 *  + Direktpfad-LAN-IPs. Alles Weitere (DB, Secrets, Keys) erzeugt das Image
 *  selbst in /data. `lanIps` kommt vom Aufrufer (hostLanIpv4s()) — als
 *  Parameter, damit die Funktion pur/testbar bleibt.
 *
 *  `vmAnnounceIp` (nur Win/VM-Betrieb gesetzt): DIE Host-LAN-IP, die Dienste
 *  im Container als ICE-Kandidaten ankündigen sollen (LiveKit `node_ip`,
 *  MediaMTX `webrtcAdditionalHosts` — gerendert in 05-init-livekit.sh /
 *  08-init-mediamtx.sh). Im VM-Netz nutzt STUN nichts: die srflx-Adresse
 *  hängt hinter WSL-Doppel-NAT und Hairpin ist tot — der Medienweg läuft
 *  über die Host-UDP-Relays (RELAY_UDP_PORTS). Bewusst EINE IP: LiveKit
 *  nimmt in `node_ip` nur ein IPv4 (zweite → Config-Fehler, LiveKit startet
 *  nicht). [0] aus hostLanIpv4s = die Adresse im Subnetz des
 *  Default-Gateways (s. dort).
 *
 *  `udpGatewayAus` (Windows, `--network host`): das UDP-Gateway im Image
 *  (s6-Dienst, nur für macOS/gvproxy gebraucht) würde sonst auf ALLEN
 *  VM-Adressen lauschen — im WSL-Mirrored-Modus also im LAN. Der Dienst liest
 *  `PULSE_UDP_GATEWAY_DISABLED=true` und bleibt dann untätig; ein Image ohne
 *  diesen Schalter ignoriert die Zeile. */
export function renderContainerEnv(
  creds: BootstrapCreds,
  adminEmail?: string,
  lanIps: string[] = [],
  vmAnnounceIp?: string,
  udpGatewayAus = false,
): string {
  const hostname = creds.relaySubdomain ?? creds.hostname;
  const lines = [
    `PULSE_HOSTNAME=${hostname}`,
    `PULSE_INSTANCE_ID=${creds.instanceId}`,
    `PULSE_INSTANCE_OWNER_ID=${creds.ownerId}`,
    `PULSE_CLOUD_CLIENT_ID=${creds.clientId}`,
    `PULSE_CLOUD_CLIENT_SECRET=${creds.clientSecret}`,
    `PULSE_CLOUD_ORIGIN=${creds.cloudOrigin}`,
    // 10-check will eine nicht-leere Admin-Mail; für App-Hosts ist sie rein
    // informativ (kein SMTP-Versand nötig) → Platzhalter, wenn keine bekannt.
    `PULSE_ADMIN_EMAIL=${adminEmail ?? `admin@${hostname}`}`,
    // Der Relay terminiert TLS — der Container routet nur HTTP intern.
    'PULSE_TLS_MODE=behind-proxy',
    'PULSE_HTTP_PORT=8080',
    // Explizite Herkunfts-Markierung fürs Image: ersetzt die frühere
    // "Relay-Token gesetzt = App-Host"-Heuristik — neue App-Host-Instanzen
    // kommen ohne Relay-Creds (Relay-Fallback abgeschafft).
    'PULSE_HOST_ORIGIN=app_host',
  ];
  // Direktpfad: LAN-IPs des Hosts für die ICE-Answer (s. hostLanIpv4s —
  // ohne sie ist die Answer im podman-machine-Fall kandidatenlos). Nur
  // rendern, wenn welche da sind (leerer Wert = Variable weglassen).
  // Stichtag ist der Container-START: ändert sich die LAN-IP (DHCP), greift
  // der nächste Start/Update-Recreate.
  if (lanIps.length) lines.push(`PULSE_DIRECT_EXTRA_HOST_IPS=${lanIps.join(',')}`);
  // Medien-Ankündigung im VM-Betrieb (Win): ohne sie kündigt LiveKit nur die
  // VM-interne Adresse und WAN/STUN-Adressen, an die kein LAN-/Internet-Gerät
  // durchkommt (Windows-Voice-Fall 2026-10-01).
  if (vmAnnounceIp) lines.push(`PULSE_VM_ANNOUNCE_IP=${vmAnnounceIp}`);
  if (udpGatewayAus) lines.push('PULSE_UDP_GATEWAY_DISABLED=true');
  // Relay-Zeilen nur, wenn ALLE drei Werte da sind (Bestandsinstanzen) —
  // leere PULSE_RELAY_*-Strings gälten im Image als "Relay konfiguriert";
  // das Erkennungsmuster ist FEHLENDE Variablen.
  if (creds.relaySubdomain && creds.relayServerAddr && creds.relayTunnelToken) {
    lines.push(
      `PULSE_RELAY_SUBDOMAIN=${creds.relaySubdomain}`,
      `PULSE_RELAY_SERVER_ADDR=${creds.relayServerAddr}`,
      `PULSE_RELAY_TUNNEL_TOKEN=${creds.relayTunnelToken}`,
    );
  }
  return lines.join('\n') + '\n';
}

/** Reine Update-Entscheidung: unterschiedliche, nicht-leere Image-IDs →
 *  Recreate nötig. Docker prefixt IDs mit "sha256:", Podman nicht — vor dem
 *  Vergleich normalisieren. Unklare Eingaben (leer) → 'none' (fail-safe:
 *  lieber ein Update verpassen als grundlos neu erzeugen). */
export function updateVerdict(runningImageId: string, pulledImageId: string): 'update' | 'none' {
  const norm = (s: string): string => s.trim().replace(/^sha256:/, '');
  const a = norm(runningImageId);
  const b = norm(pulledImageId);
  return a && b && a !== b ? 'update' : 'none';
}

