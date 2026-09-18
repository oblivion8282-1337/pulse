/**
 * Netzdiagnose für einen Self-Host-Server — der Teil, den nur Node kann.
 *
 * Der Renderer sieht jeden Fehlschlag als denselben `TypeError: Failed to
 * fetch`. Hier wird die Kette einzeln abgegangen — Namensauflösung, TCP,
 * TLS, HTTP — und jeder Schritt trägt seinen eigenen Befund. Die Deutung des
 * Zertifikats liegt daneben in `netbefund.ts` (dort auch geprüft).
 *
 * Aufgerufen über den IPC-Kanal `netdiag:check`; die Anzeige übernimmt das
 * Web. Ergebnis ist **reine Diagnose** — es öffnet keinen Datenweg und wird
 * nirgends als Vertrauensentscheidung verwendet.
 */

import { lookup } from 'node:dns/promises';
import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { request as httpsRequest } from 'node:https';
import { deuteZertifikat, zertifikatsNamen, type Zertifikatsbefund } from './netbefund.ts';

/** Der DNS-Schritt einzeln benannt: nur er trägt die Adressen, und die Kette
 *  danach braucht sie. Ohne eigenen Namen liefert `pruefeDns` die ganze Union
 *  zurück und `.adressen` ist von aussen nicht mehr erreichbar. */
export type DnsSchritt = { schritt: 'dns'; ok: boolean; adressen: string[]; fehler?: string };

export type DiagSchritt =
  | DnsSchritt
  | { schritt: 'tcp'; ok: boolean; adresse: string; port: number; fehler?: string }
  | { schritt: 'tls'; ok: boolean; befund: Zertifikatsbefund; namen: string[] }
  | { schritt: 'http'; ok: boolean; status?: number; fehler?: string };

const FRIST_MS = 5000;

/** Bricht ein Versprechen nach `ms` mit `null` ab — jeder Schritt hat eine Grenze. */
function mitFrist<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms).unref?.())]);
}

async function pruefeDns(host: string): Promise<DnsSchritt> {
  try {
    const treffer = await lookup(host, { all: true });
    const adressen = treffer.map((t) => t.address);
    return { schritt: 'dns', ok: adressen.length > 0, adressen };
  } catch (e) {
    // ENOTFOUND ist der mit Abstand häufigste Erststart-Fehler: der A-Eintrag
    // steht noch nicht, und ohne ihn holt auch Caddy kein Zertifikat.
    return { schritt: 'dns', ok: false, adressen: [], fehler: (e as NodeJS.ErrnoException).code };
  }
}

function pruefeTcp(adresse: string, port: number): Promise<DiagSchritt> {
  return new Promise((resolve) => {
    const sock = tcpConnect({ host: adresse, port, timeout: FRIST_MS });
    const ende = (ok: boolean, fehler?: string) => {
      sock.destroy();
      resolve({ schritt: 'tcp', ok, adresse, port, fehler });
    };
    sock.once('connect', () => ende(true));
    sock.once('timeout', () => ende(false, 'ETIMEDOUT'));
    sock.once('error', (e) => ende(false, (e as NodeJS.ErrnoException).code));
  });
}

/** True für Adressen, die nie Ziel der Diagnose sein dürfen (SSRF-Schutz).
 *
 * Security-Scan 2026-09-18 — resolve-then-check: der IPC-Kanal `netdiag:check`
 * prüft im main.ts nur das LITERAL gegen interne Namen. Ein öffentlicher FQDN,
 * der per DNS auf eine private IP zeigt (Rebinding, nip.io, Attacker-DNS),
 * ging durch. Nach der Auflösung greift diese Prüfung auf JEDER Adresse des
 * Ergebnisses. Exportiert für den Test (netbefund-Testmuster).
 */
export function istPrivateAdresse(adresse: string): boolean {
  const ip = adresse.toLowerCase();
  // v4-mapped (::ffff:10.0.0.1) auf das eingebettete v4 zurückführen
  if (ip.startsWith('::ffff:')) return istPrivateAdresse(ip.slice('::ffff:'.length));
  if (ip === '::1' || ip === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true; // fc00::/7 — Unique Local
  if (/^fe[89ab][0-9a-f]:/.test(ip)) return true; // fe80::/10 — Link-Local
  const teile = ip.split('.').map(Number);
  if (teile.length === 4 && teile.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = teile;
    return (
      a === 0 || // "this network" — nie ein Server
      a === 10 || // 10/8 privat
      a === 127 || // Loopback
      (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
      (a === 169 && b === 254) || // Link-Local (Cloud-Metadaten!)
      (a === 172 && b >= 16 && b <= 31) || // 172.16/12 privat
      (a === 192 && b === 168) // 192.168/16 privat
    );
  }
  return false;
}

/**
 * Liest das Zertifikat, ohne es zu akzeptieren.
 *
 * `rejectUnauthorized: false` ist hier Absicht und **ausschließlich** hier
 * zulässig: der Zweck ist, ein ABGELEHNTES Zertifikat überhaupt anschauen zu
 * können — ein abgebrochener Handschlag gibt nur „Failed to fetch" her und
 * genau das wollen wir loswerden. Über diese Verbindung geht kein einziges
 * Byte Nutzdaten; sie wird sofort geschlossen. Der HTTP-Schritt darunter läuft
 * mit voller Prüfung, und er ist der, dessen Ergebnis zählt.
 */
function pruefeTls(name: string, adresse: string, port: number): Promise<DiagSchritt> {
  return new Promise((resolve) => {
    // Security-Scan 2026-09-18: verbunden wird auf die GEPRÜFTE Adresse
    // (resolve-then-check in `diagnostiziere`), nicht erneut auf den Namen —
    // sonst klaffe zwischen Prüfung und Handschlag ein zweites DNS-Query
    // (Rebinding-Fenster). `servername` hält SNI und Validierung beim Namen.
    const sock = tlsConnect(
      { host: adresse, port, servername: name, rejectUnauthorized: false, timeout: FRIST_MS },
      () => {
        const zert = sock.getPeerCertificate() as {
          subject?: { CN?: string };
          subjectaltname?: string;
          valid_to?: string;
        };
        const namen = zertifikatsNamen(zert);
        const bis = zert.valid_to ? Date.parse(zert.valid_to) : NaN;
        const befund = deuteZertifikat(
          name,
          {
            namen,
            gueltigBis: Number.isNaN(bis) ? null : bis,
            // `authorizationError` trägt den Code, den eine PRÜFENDE
            // Verbindung geliefert hätte — genau die Auskunft, die uns der
            // abgebrochene Handschlag sonst vorenthält.
            fehler: (sock.authorizationError as unknown as string) || null,
          },
          Date.now(),
        );
        sock.destroy();
        resolve({ schritt: 'tls', ok: befund === 'gueltig', befund, namen });
      },
    );
    const scheitern = () => {
      sock.destroy();
      resolve({ schritt: 'tls', ok: false, befund: 'unbekannter-fehler', namen: [] });
    };
    sock.once('timeout', scheitern);
    sock.once('error', scheitern);
  });
}

/** Vollständig geprüfter HTTPS-Abruf — das ist der Schritt, dessen Ergebnis
 * zählt. Verbunden wird auf die geprüfte Adresse (Rebinding-Fenster zu, s.
 * `pruefeTls`); SNI, Validierung und Host-Header bleiben beim Namen. */
function pruefeHttp(url: URL, adresse: string, port: number): Promise<DiagSchritt> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        method: 'GET',
        timeout: FRIST_MS,
        hostname: adresse,
        port,
        servername: url.hostname,
        path: '/health',
        headers: { host: url.host },
      },
      (res) => {
        res.resume(); // Körper verwerfen, sonst bleibt der Socket offen
        resolve({ schritt: 'http', ok: (res.statusCode ?? 0) < 400, status: res.statusCode });
      },
    );
    req.once('timeout', () => {
      req.destroy();
      resolve({ schritt: 'http', ok: false, fehler: 'ETIMEDOUT' });
    });
    req.once('error', (e) =>
      resolve({ schritt: 'http', ok: false, fehler: (e as NodeJS.ErrnoException).code ?? e.message }),
    );
    req.end();
  });
}

/**
 * Geht die Kette ab und bricht beim ersten harten Fehlschlag ab: ohne
 * Namensauflösung gibt es keine Adresse zum Verbinden, ohne offenen Port
 * keinen Handschlag. Die Schritte danach würden nur dieselbe Ursache ein
 * zweites Mal melden und den Blick vom eigentlichen Befund wegziehen.
 *
 * @param hostname Form `https://chat.firma.de` (wie `normalizeHostname` liefert)
 */
export async function diagnostiziere(hostname: string): Promise<DiagSchritt[]> {
  let url: URL;
  try {
    url = new URL(hostname);
  } catch {
    return [{ schritt: 'dns', ok: false, adressen: [], fehler: 'BAD_URL' }];
  }
  const host = url.hostname;
  const port = url.port ? Number(url.port) : 443;

  const schritte: DiagSchritt[] = [];

  const dns: DnsSchritt = (await mitFrist(pruefeDns(host), FRIST_MS)) ?? {
    schritt: 'dns', ok: false, adressen: [], fehler: 'ETIMEDOUT',
  };
  schritte.push(dns);
  if (!dns.ok || dns.adressen.length === 0) return schritte;

  // Security-Scan 2026-09-18 — resolve-then-check (löst den ponytail:-
  // Aufstieg im main.ts-Handler ein): löst IRGENDEINE Adresse des Namens auf
  // eine private Range auf, wird das Ziel wie ein internes behandelt und
  // nicht mehr angefasst. Alle folgenden Schritte verbinden auf genau die
  // geprüfte erste Adresse — ein zweites DNS-Query zwischen Prüfung und
  // Verbindung gibt es nicht mehr.
  const adresse = dns.adressen[0];
  if (dns.adressen.some(istPrivateAdresse)) {
    schritte.push({ schritt: 'tcp', ok: false, adresse, port, fehler: 'PRIVATE_ADDR' });
    return schritte;
  }

  // Nur die erste Adresse: eine zweite, die anders antwortet, ist ein eigenes
  // (seltenes) Thema und würde die Ausgabe hier nur verdoppeln.
  const tcp = (await mitFrist(pruefeTcp(adresse, port), FRIST_MS)) ?? {
    schritt: 'tcp' as const, ok: false, adresse, port, fehler: 'ETIMEDOUT',
  };
  schritte.push(tcp);
  if (!tcp.ok) return schritte;

  schritte.push(
    (await mitFrist(pruefeTls(host, adresse, port), FRIST_MS)) ?? {
      schritt: 'tls' as const, ok: false, befund: 'unbekannter-fehler', namen: [],
    },
  );
  schritte.push(
    (await mitFrist(pruefeHttp(url, adresse, port), FRIST_MS)) ?? {
      schritt: 'http' as const, ok: false, fehler: 'ETIMEDOUT',
    },
  );
  return schritte;
}
