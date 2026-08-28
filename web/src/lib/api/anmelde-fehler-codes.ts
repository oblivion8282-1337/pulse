/**
 * Die Ablehnungsgründe, die `POST /session` zurückgeben kann — und der Nachweis,
 * dass jeder davon einen eigenen Text hat.
 *
 * **Warum es diese Datei gibt.** Der Vorgängerweg kannte seine Gründe ebenfalls
 * (`cert-invalid`, `rate-limited`, `join-closed`, `network`), warf sie aber weg
 * und zeigte „Anmeldung abgelaufen oder Server nicht erreichbar". Am 2026-08-28
 * kostete das zwei Stunden Fehlersuche an einem vollkommen gesunden Server: Alle
 * zehn Glieder der Erreichbarkeitsprüfung grün, Instanz aktiv, Zertifikat
 * gültig — und die App sagte trotzdem „nicht erreichbar".
 *
 * **Importfrei** (s. `pnpm test:unit`-Falle in `CLAUDE.md`). Hier steht nur die
 * Liste und die Zuordnung auf die Meldungsschlüssel; die Anzeige liegt in
 * `anmelde-fehler.ts`. Dadurch ist ein fehlender Text ein roter Test statt einer
 * nichtssagenden Meldung im Betrieb.
 */

export const ABLEHNUNGSCODES = [
  'ticket_expired',
  'ticket_replayed',
  'ticket_wrong_audience',
  'ticket_wrong_issuer',
  'ticket_wrong_purpose',
  'ticket_invalid',
  'ticket_malformed',
  'jwks_cold',
  'join_locked',
  'join_not_permitted',
  'instance banned',
  'instance_suspended',
  'instance_deleted',
  'network',
] as const;

export type Ablehnungscode = (typeof ABLEHNUNGSCODES)[number];

/**
 * Schlüssel im Paraglide-Katalog je Code.
 *
 * Zwei Codes teilen sich einen Text, wo der Handgriff derselbe ist:
 * `ticket_invalid` und `ticket_malformed` bedeuten für den Nutzer dasselbe
 * („noch einmal versuchen"), und die Unterscheidung nützt nur beim Lesen der
 * Server-Logs.
 */
export const MELDUNGSSCHLUESSEL: Record<Ablehnungscode, string> = {
  ticket_expired: 'anmeldung_ticket_abgelaufen',
  ticket_replayed: 'anmeldung_ticket_verbraucht',
  ticket_wrong_audience: 'anmeldung_ticket_falscher_server',
  ticket_wrong_issuer: 'anmeldung_ticket_falscher_aussteller',
  ticket_wrong_purpose: 'anmeldung_ticket_ungueltig',
  ticket_invalid: 'anmeldung_ticket_ungueltig',
  ticket_malformed: 'anmeldung_ticket_ungueltig',
  jwks_cold: 'anmeldung_server_ohne_cloud',
  join_locked: 'anmeldung_server_geschlossen',
  join_not_permitted: 'anmeldung_kein_zugang',
  'instance banned': 'anmeldung_gesperrt',
  instance_suspended: 'anmeldung_instanz_gesperrt',
  instance_deleted: 'anmeldung_instanz_geloescht',
  network: 'anmeldung_netzfehler',
};

/**
 * Gründe, bei denen ein erneuter Versuch von selbst hilft.
 *
 * Sie brauchen keine Handlung des Nutzers — ein abgelaufenes oder bereits
 * eingelöstes Ticket wird beim nächsten Anlauf einfach neu geholt. Alle anderen
 * verlangen etwas: eine Einladung, einen erreichbaren Server, ein Gespräch mit
 * dem Betreiber.
 */
export const VON_SELBST_HEILBAR: readonly Ablehnungscode[] = [
  'ticket_expired',
  'ticket_replayed',
  'network',
];

export function hatTextFuerJedenCode(): boolean {
  return ABLEHNUNGSCODES.every((c) => !!MELDUNGSSCHLUESSEL[c]);
}

export function istAblehnungscode(wert: unknown): wert is Ablehnungscode {
  return typeof wert === 'string' && (ABLEHNUNGSCODES as readonly string[]).includes(wert);
}
