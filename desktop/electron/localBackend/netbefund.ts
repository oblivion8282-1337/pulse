/**
 * Die Deutung dessen, was ein TLS-Handschlag hergibt — reine Rechnung, damit
 * sie prüfbar ist (`desktop/test/localBackend/netbefund.test.ts`).
 *
 * **Warum das im Desktop liegt und nicht im Web.** Der Browser maskiert jeden
 * Verbindungsfehler zu einem einzigen `TypeError: Failed to fetch`: ein
 * abgelaufenes Zertifikat, ein Zertifikat auf den falschen Namen, ein toter
 * Port und ein nicht auflösender Name sehen dort identisch aus. Node kann den
 * Handschlag selbst führen und das Zertifikat LESEN, ohne es zu akzeptieren —
 * damit wird aus „nicht erreichbar" ein Satz, mit dem der Betreiber etwas
 * anfangen kann.
 *
 * Ein falsch ausgestelltes Zertifikat ist beim Self-Hosten kein Randfall: der
 * eingebettete Caddy holt eines nur, wenn der DNS-Eintrag schon steht und Port
 * 80 offen ist (`09-init-caddy.sh`, Modus `auto`) — beides Dinge, die beim
 * ersten Anlauf regelmäßig noch nicht zutreffen.
 */

/** Was der Handschlag über das Zertifikat der Gegenseite verrät. */
export type Zertifikatslage = {
  /** Namen, für die das Zertifikat gilt: CN plus alle SAN-DNS-Einträge. */
  namen: string[];
  /** `notAfter` als Millisekunden seit Epoche, oder `null` wenn unlesbar. */
  gueltigBis: number | null;
  /** Fehlercode von Node, wenn die Kette NICHT verifiziert werden konnte. */
  fehler: string | null;
};

/** Ein Befund mit genau einer zugehörigen Handlung. */
export type Zertifikatsbefund =
  | 'gueltig'
  | 'laeuft-bald-ab'
  | 'abgelaufen'
  | 'falscher-name'
  | 'selbstsigniert'
  | 'kette-unvollstaendig'
  | 'unbekannter-fehler';

/** Unter dieser Restlaufzeit wird gewarnt (Caddy erneuert bei 30 Tagen). */
export const WARNFRIST_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Passt ein Zertifikatsname auf einen Hostnamen?
 *
 * Platzhalter decken **genau eine** Ebene ab (RFC 6125): `*.firma.de` gilt für
 * `chat.firma.de`, aber weder für `firma.de` selbst noch für
 * `a.chat.firma.de`. Wer das großzügiger auslegt, erklärt ein Zertifikat für
 * gültig, das der Browser gleich darauf ablehnt — und schickt den Betreiber
 * genau dorthin, wo er nichts findet.
 */
export function passtName(zertName: string, host: string): boolean {
  const z = zertName.trim().toLowerCase();
  const h = host.trim().toLowerCase();
  if (!z || !h) return false;
  if (z === h) return true;
  if (!z.startsWith('*.')) return false;

  const rest = z.slice(2);
  if (!rest.includes('.')) return false; // `*.de` deckt nichts ab
  if (!h.endsWith(`.${rest}`)) return false;
  // Genau eine Ebene: der Teil vor `.rest` darf keinen Punkt mehr enthalten.
  const label = h.slice(0, h.length - rest.length - 1);
  return label.length > 0 && !label.includes('.');
}

/**
 * Node-Fehlercodes, die eine eigene Handlung nach sich ziehen. Alles andere
 * fällt bewusst auf `unbekannter-fehler` — einen Code zu raten wäre schlimmer
 * als zuzugeben, dass wir ihn nicht kennen.
 */
const FEHLERCODES: Record<string, Zertifikatsbefund> = {
  CERT_HAS_EXPIRED: 'abgelaufen',
  ERR_TLS_CERT_ALTNAME_INVALID: 'falscher-name',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'selbstsigniert',
  SELF_SIGNED_CERT_IN_CHAIN: 'selbstsigniert',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'kette-unvollstaendig',
  UNABLE_TO_GET_ISSUER_CERT: 'kette-unvollstaendig',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'kette-unvollstaendig',
};

/**
 * Deutet die Lage. `jetzt` wird hereingereicht, damit der Test nicht von der
 * Uhr abhängt.
 */
export function deuteZertifikat(
  host: string,
  lage: Zertifikatslage,
  jetzt: number,
): Zertifikatsbefund {
  // Der Namensvergleich geht VOR die Fehlercodes, wenn beides zutrifft: ein
  // Zertifikat auf den falschen Namen ist die konkretere Auskunft, und
  // Node meldet dafür je nach Weg mal ALTNAME_INVALID, mal gar nichts (etwa
  // wenn ohne `servername` verbunden wurde).
  if (lage.namen.length > 0 && !lage.namen.some((n) => passtName(n, host))) {
    return 'falscher-name';
  }
  if (lage.fehler) return FEHLERCODES[lage.fehler] ?? 'unbekannter-fehler';
  if (lage.gueltigBis !== null) {
    if (lage.gueltigBis <= jetzt) return 'abgelaufen';
    if (lage.gueltigBis - jetzt < WARNFRIST_MS) return 'laeuft-bald-ab';
  }
  return 'gueltig';
}

/**
 * Liest die Namen aus einem `getPeerCertificate()`-Ergebnis: CN plus die
 * DNS-Einträge des SAN-Feldes.
 *
 * `subjectaltname` kommt als eine Zeile der Form `DNS:a.de, DNS:*.a.de,
 * IP Address:1.2.3.4` — nur die `DNS:`-Einträge zählen für den Namensvergleich.
 */
export function zertifikatsNamen(zert: {
  subject?: { CN?: string };
  subjectaltname?: string;
}): string[] {
  const namen: string[] = [];
  const cn = zert.subject?.CN;
  if (cn) namen.push(cn);
  for (const teil of (zert.subjectaltname ?? '').split(',')) {
    const t = teil.trim();
    if (t.toUpperCase().startsWith('DNS:')) namen.push(t.slice(4));
  }
  // Dubletten raus (CN steht meistens auch im SAN) — ohne Reihenfolge zu ändern.
  return [...new Set(namen)];
}
