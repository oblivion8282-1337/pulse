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

export type DiagSchritt =
  | { schritt: 'dns'; ok: boolean; adressen: string[]; fehler?: string }
  | { schritt: 'tcp'; ok: boolean; adresse: string; port: number; fehler?: string }
  | { schritt: 'tls'; ok: boolean; befund: Zertifikatsbefund; namen: string[] }
  | { schritt: 'http'; ok: boolean; status?: number; fehler?: string };

const FRIST_MS = 5000;

/** Bricht ein Versprechen nach `ms` mit `null` ab — jeder Schritt hat eine Grenze. */
function mitFrist<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms).unref?.())]);
}

async function pruefeDns(host: string): Promise<DiagSchritt> {
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
function pruefeTls(host: string, port: number): Promise<DiagSchritt> {
  return new Promise((resolve) => {
    const sock = tlsConnect(
      { host, port, servername: host, rejectUnauthorized: false, timeout: FRIST_MS },
      () => {
        const zert = sock.getPeerCertificate() as {
          subject?: { CN?: string };
          subjectaltname?: string;
          valid_to?: string;
        };
        const namen = zertifikatsNamen(zert);
        const bis = zert.valid_to ? Date.parse(zert.valid_to) : NaN;
        const befund = deuteZertifikat(
          host,
          {
            namen,
            gueltigBis: Number.isNaN(bis) ? null : bis,
            // `authorizationError` trägt den Code, den eine PRÜFENDE
            // Verbindung geliefert hätte — genau die Auskunft, die uns der
            // abgebrochene Handschlag sonst vorenthielte.
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

/** Vollständig geprüfter HTTPS-Abruf — das ist der Schritt, dessen Ergebnis zählt. */
function pruefeHttp(hostname: string): Promise<DiagSchritt> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      `${hostname}/health`,
      { method: 'GET', timeout: FRIST_MS },
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

  const dns = (await mitFrist(pruefeDns(host), FRIST_MS)) ?? {
    schritt: 'dns' as const, ok: false, adressen: [], fehler: 'ETIMEDOUT',
  };
  schritte.push(dns);
  if (!dns.ok || dns.adressen.length === 0) return schritte;

  // Nur die erste Adresse: eine zweite, die anders antwortet, ist ein eigenes
  // (seltenes) Thema und würde die Ausgabe hier nur verdoppeln.
  const tcp = (await mitFrist(pruefeTcp(dns.adressen[0], port), FRIST_MS)) ?? {
    schritt: 'tcp' as const, ok: false, adresse: dns.adressen[0], port, fehler: 'ETIMEDOUT',
  };
  schritte.push(tcp);
  if (!tcp.ok) return schritte;

  schritte.push(
    (await mitFrist(pruefeTls(host, port), FRIST_MS)) ?? {
      schritt: 'tls' as const, ok: false, befund: 'unbekannter-fehler', namen: [],
    },
  );
  schritte.push(
    (await mitFrist(pruefeHttp(hostname), FRIST_MS)) ?? {
      schritt: 'http' as const, ok: false, fehler: 'ETIMEDOUT',
    },
  );
  return schritte;
}
