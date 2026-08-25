/**
 * Die Prüfschritte der Erreichbarkeitsprüfung und ihre Befunde — reine
 * Zuordnung auf Text-Schlüssel, ohne Zustand und ohne Nachbarmodule.
 *
 * **Warum importfrei:** nur so erreicht Nodes Testläufer (`pnpm test:unit`) die
 * Datei. Und der Test hier ist mehr als eine Formalie — er hält jeden
 * erzeugbaren Schlüssel gegen BEIDE Sprachdateien. Ein fehlender Text fiele
 * sonst erst dem Nutzer auf, und zwar in dem Moment, in dem er ohnehin schon
 * ein Problem hat.
 *
 * **Die Befund-Schlüssel kommen vom Server** (`selfhost_probe.py` /
 * `selfhost_probe_dienst.py`) und müssen mit ihm synchron bleiben. Ein
 * unbekannter Schlüssel ist kein Fehler: der Server darf neuer sein als der
 * Client. Er fällt dann auf einen allgemeinen Satz zurück, statt eine leere
 * Zeile zu zeigen.
 */

/** Reihenfolge der Schritte, wie der Server sie liefert. */
export const SCHRITTE = [
  'dns',
  'tcp443',
  'tls',
  'health',
  'identitaet',
  'cors',
  'websocket',
  'stun',
  'rtmps',
  'gesamt',
] as const;

/**
 * Die Befunde, für die es einen eigenen Satz gibt — nach Schritt getrennt,
 * weil derselbe Befund je nach Schritt etwas anderes bedeutet: `kein_durchkommen`
 * auf 443 heisst „niemand kommt hinein", auf 3478/udp heisst es „Chat geht,
 * Ton nicht".
 */
const BEFUNDE: Record<string, readonly string[]> = {
  dns: ['name_unbekannt', 'zeigt_ins_private_netz'],
  tcp443: ['kein_durchkommen'],
  tls: [
    'abgelaufen',
    'selbstsigniert',
    'kette_unvollstaendig',
    'falscher_name',
    'nicht_vertrauenswuerdig',
    'handschlag_abgelehnt',
    'kein_handschlag',
  ],
  health: ['keine_antwort', 'server_krank', 'unerwartete_antwort'],
  identitaet: ['keine_auskunft', 'keine_json_antwort', 'fremde_instanz'],
  cors: ['keine_antwort', 'kein_header', 'doppelter_header', 'andere_herkunft'],
  websocket: ['kein_upgrade', 'kein_gateway', 'server_ohne_cloud', 'instanz_gesperrt'],
  stun: ['kein_durchkommen', 'fremde_antwort'],
  rtmps: ['kein_durchkommen'],
  gesamt: ['zeitueberschreitung'],
};

/** Schlüssel für die Überschrift eines Schritts (immer vorhanden). */
export function schrittSchluessel(schritt: string): string {
  return SCHRITTE.includes(schritt as (typeof SCHRITTE)[number])
    ? `diagnose_schritt_${schritt}`
    : 'diagnose_schritt_unbekannt';
}

/**
 * Schlüssel für die Erklärung eines Fehlschlags, oder `null` für einen
 * gelungenen Schritt.
 *
 * Ein unbekannter Befund fällt auf `diagnose_befund_allgemein` — der Server
 * darf neuer sein als der Client, und ein neuer Befund darf keine leere Zeile
 * erzeugen.
 */
export function befundSchluessel(schritt: string, befund: string, ok: boolean): string | null {
  if (ok) return null;
  const bekannt = BEFUNDE[schritt] ?? [];
  return bekannt.includes(befund)
    ? `diagnose_befund_${schritt}_${befund}`
    : 'diagnose_befund_allgemein';
}

/** Jeder Schlüssel, den die beiden Funktionen oben je erzeugen können. */
export function alleSchluessel(): string[] {
  const keys = ['diagnose_schritt_unbekannt', 'diagnose_befund_allgemein'];
  for (const schritt of SCHRITTE) keys.push(`diagnose_schritt_${schritt}`);
  for (const [schritt, befunde] of Object.entries(BEFUNDE)) {
    for (const b of befunde) keys.push(`diagnose_befund_${schritt}_${b}`);
  }
  return keys;
}
