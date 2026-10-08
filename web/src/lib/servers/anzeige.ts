/**
 * Wie heißt ein Server in der Leiste, und steht er überhaupt drin? — reine
 * Rechnung, importfrei (prüfbar mit `pnpm test:unit`, Muster wie
 * `erstellrecht.ts`).
 *
 * **Name (2026-10-08).** Ein Heim-Server stand für jeden, der ihn nie geöffnet
 * hatte, als `rapid-comet-58ed.relay…` in der Leiste: den Namen kannte nur der
 * Server selbst, und der ready-Rahmen, der ihn liefert, kommt erst nach einer
 * Verbindung. Jetzt meldet der Server seinen Namen an die Cloud, und die
 * liefert ihn mit `/me/instances` und live per `instance_status`. Vorrang:
 * dieser Cloud-Name (`anzeigename`, immer der neueste), dann der Name aus dem
 * letzten ready-Rahmen (`server_name`), dann die Adresse.
 *
 * **Sichtbarkeit (Entscheid 2026-10-08).** Ein gestoppter Heim-Server
 * verschwindet aus der Leiste — für alle, auch für den Betreiber. Nur
 * `origin === 'app_host'` mit ausdrücklichem `online === false`: VPS-Server
 * melden sich nicht beim Telefonbuch, und ein unbekannter Zustand
 * (`undefined`/`null`, ältere Cloud) darf NICHT ausblenden — sonst wäre die
 * Leiste auf einen Schlag leer, obwohl alle Server laufen.
 */

export interface AnzeigeEintrag {
  isCloud: boolean;
  label: string;
  hostname: string;
  server_name: string | null;
  anzeigename?: string | null;
  origin?: 'vps' | 'app_host' | null;
  online?: boolean | null;
}

export function anzeigeName(e: AnzeigeEintrag): string {
  if (e.isCloud) return e.label;
  return e.anzeigename || e.server_name || e.hostname;
}

export function istSichtbar(e: AnzeigeEintrag): boolean {
  if (e.isCloud) return true;
  return !(e.origin === 'app_host' && e.online === false);
}
