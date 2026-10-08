/**
 * Host-Netz-Auswahl für den Container-Weg: welche Host-IPv4s kündigt der
 * Container an, welche ist die bevorzugte, und läuft WSL im Mirrored-Modus?
 *
 * Reine Funktionen über ein injizierbares `ifaces`-Argument (Form von
 * `os.networkInterfaces()`), damit die Windows-Fälle unter Linux testbar sind.
 * Keine Electron-Imports (node:test-tauglich).
 */

import { networkInterfaces } from 'node:os';

export interface IfaceAdresse {
  family: string;
  address: string;
  internal: boolean;
  netmask?: string;
}
export type IfaceTabelle = Record<string, IfaceAdresse[] | undefined>;

function ipZahl(ip: string): number | null {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

/** Liegt `ziel` im Subnetz von `adresse`/`netmask`? Fehlende/kaputte Maske → false. */
export function imSubnetz(adresse: string, netmask: string | undefined, ziel: string): boolean {
  const a = ipZahl(adresse);
  const m = netmask ? ipZahl(netmask) : null;
  const z = ipZahl(ziel);
  if (a === null || m === null || z === null || m === 0) return false;
  return ((a & m) >>> 0) === ((z & m) >>> 0);
}

/** Adapter, die von Haus aus virtuelle Brücken sind und im LAN nie erreichbar:
 *  Docker/Podman/libvirt unter Linux, der WSL-/Hyper-V-Default-Switch unter
 *  Windows. Bis 2026-10-08 stand hier stattdessen pauschal 172.16.0.0/12 —
 *  das warf echte LANs in diesem Bereich weg und liess ein WSL-NAT im
 *  192.168er-Bereich durch. */
const VIRTUELLE_BRUECKE = /^(docker\d*|br-[0-9a-f]+|virbr\d+|podman\d*|cni-|veth|vEthernet \((WSL|Default Switch))/i;

/** Adapter, die zwar eine Adresse tragen, aber selten der Weg ins LAN sind:
 *  VirtualBox-Host-Only (192.168.56.1), Windows-Hotspot (192.168.137.1,
 *  „LAN-Verbindung* N"), Tailscale/ZeroTier/WireGuard, VMware. Sie fliegen
 *  NICHT raus (ein Tailnet-Gerät erreicht den Host darüber durchaus), rücken
 *  aber hinter alle anderen — denn [0] wird im VM-Betrieb DIE angekündigte
 *  Medien-IP (PULSE_VM_ANNOUNCE_IP). */
const NACHRANGIG = /(virtualbox|vboxnet|vmware|vmnet|tailscale|zerotier|^zt|wireguard|^wg|^utun|^tun|LAN-Verbindung\*|Local Area Connection\*)/i;

/** LAN-IPv4s des Hosts für den Direktpfad-Adapter und die Medien-Ankündigung.
 *  Unter Windows läuft der Container in der podman-machine-VM und sieht nur
 *  deren interne Adresse — seine ICE-Answer wäre ohne diese Liste
 *  kandidatenlos. Reihenfolge:
 *   1. die Adresse, in deren Subnetz das Default-Gateway liegt (`gateway`) —
 *      das ist der Adapter, über den der Host tatsächlich ins Netz geht;
 *   2. übrige Adapter in Aufzählungsreihenfolge;
 *   3. nachrangige (s. NACHRANGIG).
 *  Ausgeschlossen: interne, IPv6, APIPA (169.254.x), virtuelle Brücken
 *  (VIRTUELLE_BRUECKE) und jede Adresse, deren Subnetz die VM-IP enthält
 *  (`vmIp` — das WSL-NAT, egal in welchem Bereich es liegt). Ausnahme davon:
 *  die VM-IP selbst (Mirrored-Modus, s. istMirrored — dann IST sie die
 *  Host-LAN-Adresse). */
export function hostLanIpv4s(
  ifaces: IfaceTabelle = networkInterfaces() as never,
  opts: { gateway?: string | null; vmIp?: string | null } = {},
): string[] {
  const vorn: string[] = [];
  const mitte: string[] = [];
  const hinten: string[] = [];
  const alle = new Set<string>();
  for (const [name, list] of Object.entries(ifaces)) {
    if (VIRTUELLE_BRUECKE.test(name)) continue;
    for (const a of list ?? []) {
      if (a.internal || a.family !== 'IPv4') continue;
      if (a.address.startsWith('169.254.')) continue; // link-local/APIPA
      if (opts.vmIp && a.address !== opts.vmIp && imSubnetz(a.address, a.netmask, opts.vmIp)) continue;
      if (alle.has(a.address)) continue;
      alle.add(a.address);
      if (opts.gateway && imSubnetz(a.address, a.netmask, opts.gateway)) vorn.push(a.address);
      else if (NACHRANGIG.test(name)) hinten.push(a.address);
      else mitte.push(a.address);
    }
  }
  return [...vorn, ...mitte, ...hinten];
}

/** WSL-Mirrored-Modus: die VM teilt die Adapter des Hosts, ihre „VM-IP" ist
 *  eine Host-Adresse. Dann binden die Container-Ports schon am Host — ein
 *  Relay auf denselben Ports bekäme EADDRINUSE, oder (bei 0.0.0.0 gegen eine
 *  konkrete Adresse) leitete Pakete an sich selbst zurück. Geprüft gegen ALLE
 *  nicht-internen Host-IPv4s, nicht gegen die gefilterte Liste. */
export function istMirrored(vmIp: string, ifaces: IfaceTabelle = networkInterfaces() as never): boolean {
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (!a.internal && a.family === 'IPv4' && a.address === vmIp) return true;
    }
  }
  return false;
}

/** Erste globale IPv4 aus einer `ip -4 addr show`-Ausgabe — die Adresse der
 *  podman-machine-VM. Der Interface-Name spielt keine Rolle (WSL2: eth0,
 *  Podman 6/applehv auf macOS: enp0s1), aber die ZUGEORDNETE Schnittstelle
 *  zählt: neuere WSL2-Stände (DNS-Tunneling) legen auf `lo` eine zweite,
 *  globale Pseudo-Adresse (10.255.255.254) — Windows-E2E 2026-10-01.
 *  Loopback-Interfaces werden deshalb als ganze Blöcke übersprungen, nicht nur
 *  127.x. null, wenn keine globale Adresse dabei ist. */
export function vmIpAusIpAusgabe(ausgabe: string): string | null {
  let iface = '';
  for (const zeile of ausgabe.split('\n')) {
    const kopf = zeile.match(/^\s*\d+:\s+(\S+?):/);
    if (kopf) iface = kopf[1].split('@')[0];
    const inet = zeile.match(/inet (\d+\.\d+\.\d+\.\d+)[/\s]/);
    if (inet && iface !== 'lo' && !inet[1].startsWith('127.')) return inet[1];
  }
  return null;
}
