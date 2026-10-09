/**
 * Einen schon gelisteten Server an den Cloud-Stand (`GET /me/instances`)
 * angleichen — reine Rechnung, importfrei (nur Typen), prüfbar mit
 * `pnpm test:unit`. Herausgelöst aus `api/servers.svelte.ts` (Größen-Policy).
 *
 * Gibt den angeglichenen Eintrag zurück, oder `null`, wenn nichts abweicht.
 */

export interface NachzugEintrag {
  hostname: string;
  instance_id: string | null;
  label: string;
  notification_mode: 'all' | 'mentions' | 'none';
  origin?: 'vps' | 'app_host' | null;
  role?: 'owner' | 'member' | null;
  anzeigename?: string | null;
  online?: boolean | null;
}

export interface NachzugInstanz {
  id: string;
  notification_mode: 'all' | 'mentions' | 'none';
  origin: 'vps' | 'app_host';
  role: 'owner' | 'member';
  anzeigename?: string | null;
  online?: boolean | null;
}

export function instanzNachzug<E extends NachzugEintrag>(
  e: E,
  inst: NachzugInstanz,
  normalized: string,
): E | null {
  // Der Hostname wechselt bei App-Host-Servern vom synthetischen Platzhalter
  // auf die Relay-Subdomain, sobald das Gerät gepaart ist. Ohne Nachziehen
  // zeigt ein einmal gespeicherter Eintrag für immer auf den toten Host.
  const hostChanged = e.instance_id === inst.id && e.hostname !== normalized;
  // Umgekehrt die instance_id: gleicher Hostname, aber andere/fehlende ID =
  // der Betreiber hat die Instanz unter derselben Adresse NEU registriert
  // (Löschen + frisches Setup). Ohne Nachziehen bleibt die ID der ALTEN
  // (gelöschten) Instanz stehen — der Sweep gelöschter Instanzen
  // (deleted-instance-sweep.ts) entfernt dann einen LEBENDEN Server, und
  // falsch verdrahtete Einträge werden unsweepbar (Vorfall 2026-07-14).
  const idChanged = e.hostname === normalized && e.instance_id !== inst.id;
  const anzeigename = inst.anzeigename ?? null;
  const online = inst.online ?? null;
  if (
    !hostChanged &&
    !idChanged &&
    e.notification_mode === inst.notification_mode &&
    e.origin === inst.origin &&
    e.role === inst.role &&
    (e.anzeigename ?? null) === anzeigename &&
    (e.online ?? null) === online
  ) {
    return null;
  }
  return {
    ...e,
    hostname: hostChanged ? normalized : e.hostname,
    instance_id: idChanged ? inst.id : e.instance_id,
    // Default-Label mitheilen: label war nie ein User-Wunsch, sondern der
    // Hostname zum Add-Zeitpunkt. Custom-Labels (label ≠ hostname) bleiben.
    label: hostChanged && e.label === e.hostname ? normalized : e.label,
    // Cloud = Quelle der Wahrheit für den geräteübergreifenden Modus.
    notification_mode: inst.notification_mode,
    // Herkunft (Direct-only-Weiche) und Rolle (Owner-Transfer) nachziehen —
    // Alt-Einträge haben beide noch nicht.
    origin: inst.origin,
    role: inst.role,
    // Name und Online-Zustand aus der Cloud (lib/servers/anzeige.ts).
    anzeigename,
    online,
  };
}
