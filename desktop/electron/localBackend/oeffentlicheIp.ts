/**
 * Öffentliche IPv4 des Heim-Servers für LiveKit — fest vorgegeben statt per
 * STUN in LiveKit selbst, und bei einem Wechsel nachgezogen.
 *
 * Warum fest vorgegeben (Linux-Test 2026-10-08): Mit `use_external_ip`
 * schaltet LiveKit 1.13.3 für Firefox auf „nur die öffentliche Adresse" um
 * (pkg/rtc/transport.go). Ein Firefox-Gast im selben Heimnetz braucht dann
 * Hairpin-NAT, das die Fritz!Box nicht kann — ICE scheitert. Mit `node_ip`
 * greift die Sonderbehandlung nicht; LAN- und öffentliche Adresse stehen
 * beide in der Antwort.
 *
 * Warum nachziehen: Heimanschlüsse haben keine feste IP (Zwangstrennung,
 * Router-Neustart). LiveKit ermittelte die Adresse auch mit STUN nur beim
 * Start — nach einem Wechsel kündigte es bis zum nächsten Neustart eine tote
 * Adresse an. Der Abgleich hier vergleicht die aktuelle Adresse mit der
 * gesetzten und startet bei Abweichung NUR LiveKit neu (laufende Gespräche
 * reißen kurz ab — nach einem IP-Wechsel sind sie ohnehin tot).
 *
 * Importfrei — der Node-Testläufer prüft die Entscheidung ohne Netz.
 */

/** Taugt `ip` als öffentliche LiveKit-Adresse? Nackte IPv4, nicht privat,
 *  nicht Loopback/Link-local, nicht CGNAT (100.64/10 — dort hilft eine
 *  feste Adresse nichts, der Anschluss ist von außen ohnehin nicht direkt
 *  erreichbar). */
export function taugtAlsOeffentlicheIp(ip: string | null | undefined): ip is string {
  if (!ip || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  if (ip.split('.').some((t) => Number(t) > 255)) return false;
  if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

export interface IpAbgleichDeps {
  /** Aktuelle öffentliche Adresse (STUN) — null bei Fehlschlag. */
  ermittle(): Promise<string | null>;
  /** In LiveKit gesetzte Adresse — '' = keine (STUN-Weg), null = nicht lesbar. */
  gesetzte(): Promise<string | null>;
  /** Adresse setzen und LiveKit neu starten. */
  setze(ip: string): Promise<void>;
}

export type IpAbgleichErgebnis = 'gleich' | 'gesetzt' | 'unbekannt';

/** Ein Abgleichsschritt. 'unbekannt': STUN lieferte nichts Brauchbares oder
 *  die gesetzte Adresse ist nicht lesbar — dann wird NICHTS angefasst (eine
 *  Netzstörung soll LiveKit nicht neu starten). */
export async function gleicheOeffentlicheIpAb(deps: IpAbgleichDeps): Promise<IpAbgleichErgebnis> {
  const aktuell = await deps.ermittle().catch(() => null);
  if (!taugtAlsOeffentlicheIp(aktuell)) return 'unbekannt';
  const gesetzt = await deps.gesetzte().catch(() => null);
  if (gesetzt === null) return 'unbekannt';
  if (gesetzt === aktuell) return 'gleich';
  await deps.setze(aktuell);
  return 'gesetzt';
}
