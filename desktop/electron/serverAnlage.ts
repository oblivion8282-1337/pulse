// serverAnlage.ts — Selbstbedienungs-Anlage des Heim-Servers (2026-09-27).
//
// Reine Entscheidungs-Helfer für `serverProvision.ts`: hat der User noch keine
// aktive App-Host-Instanz, legt die Provisionierung selbst eine an
// (POST /me/instances — kein Antrag, keine Freischaltung). Diese Datei ist
// bewusst electron-frei, damit sie `node --test` prüfen kann (Muster wie
// serverGiveUp.ts / serverCloudStatus.ts).

/** Ergebnis-Klassen des POST /me/instances (Selbstbedienung). */
export type AnlageErgebnis =
  | { art: 'ok'; instanzId: string }
  | { art: 'konflikt' } // 409: Konto hat schon einen Server (Race mit Liste)
  | { art: 'fehler'; status: number };

/** Findet die aktive app_host-Instanz in der /me/instances-Antwort. */
export function aktiveAppHostInstanz(liste: unknown): { id: string } | null {
  if (!Array.isArray(liste)) return null;
  const treffer = (
    liste as { id: string; status: string; origin?: string }[]
  ).find((i) => i.status === 'active' && i.origin === 'app_host');
  return treffer ? { id: treffer.id } : null;
}

/** Bewertet die Antwort des Anlage-Endpoints. 201 mit Instanz-Shell → ok;
 *  409 → Konflikt (Liste neu lesen); alles andere inkl. Transport-Fehler
 *  (Status 0) → Fehler. */
export function bewerteAnlage(status: number, json: unknown): AnlageErgebnis {
  if (status === 201 && json && typeof json === 'object') {
    const instanz = (json as { instance?: { id?: string } }).instance;
    if (typeof instanz?.id === 'string' && instanz.id) {
      return { art: 'ok', instanzId: instanz.id };
    }
  }
  if (status === 409) return { art: 'konflikt' };
  return { art: 'fehler', status };
}
