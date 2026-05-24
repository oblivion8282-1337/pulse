/**
 * Plugin-Konflikt-Detektor — pure-Function Set-Differenz über die
 * `[plugin.uses]`-Whitelists aller geladenen Manifeste.
 *
 * Zwei Plugins kollidieren, wenn sie sich auf demselben Resource-Slot
 * überlappen, d.h. denselben WS-Op, Channel oder denselben Settings-
 * Section-Namen deklarieren. Die Registries (Schritt 2c / Schritt 3)
 * würden im Konfliktfall den jeweils letzten Eintrag gewinnen lassen
 * (WS-Handler: last-wins; Settings-Section: first-wins) — beides ist
 * für den User kein erwünschtes Verhalten, deshalb visualisiert das
 * Plugin-Manager-UI (Schritt 6) die Überlappungen.
 *
 * Bewusst pure ohne Registry-Zugriff: Input = Manifest-Liste, Output =
 * Conflict-Liste. So kann das UI Konflikte auch über deaktivierte
 * Plugins ankündigen (Vorschau-Modus) — der Vergleichspartner muss
 * nicht aktiviert sein, nur sein Manifest muss bekannt sein.
 */
import type { PluginManifest } from './manifest-types';

/** Welche Manifest-Felder zur Konflikt-Suche verglichen werden. Reihenfolge
 *  bestimmt die Sortierung der Resource-Labels in der UI. */
export type ConflictResourceKind = 'ws_ops' | 'channels' | 'settings_sections' | 'ui_slots';

export interface Conflict {
  /** Resource-Typ — z.B. `'ws_ops'` für einen kollidierenden WS-Op-Code. */
  kind: ConflictResourceKind;
  /** Konkreter Resource-Identifier — z.B. `'status:set'` oder `'tamagotchi'`. */
  resource: string;
  /** Plugin-Namen die diesen Slot deklarieren (≥2, sortiert). */
  plugins: string[];
}

const KINDS: ConflictResourceKind[] = [
  'ws_ops',
  'channels',
  'settings_sections',
  'ui_slots'
];

/**
 * Berechne alle Konflikte über die übergebenen Manifeste. Nur Plugins, deren
 * Name im optionalen `activeNames`-Set steht, werden gegeneinander geprüft
 * (Default: alle). Das UI nutzt das, um zwischen "Konflikt mit aktivem Plugin"
 * (= echtes Problem) und "Konflikt mit anderem deaktivierten Plugin"
 * (= reine Hint) zu unterscheiden.
 *
 * Komplexität: O(plugins × resources_per_plugin) — Map-Aufbau, kein
 * paarweises Diff. Für realistische Plugin-Counts (≤ einige Dutzend) ist
 * das O(n²)-Pendant auch fine, der Map-Pfad ist nur kosmetisch sauberer.
 */
export function detectConflicts(
  manifests: PluginManifest[],
  activeNames?: ReadonlySet<string>
): Conflict[] {
  const out: Conflict[] = [];
  for (const kind of KINDS) {
    const byResource = new Map<string, string[]>();
    for (const m of manifests) {
      if (activeNames && !activeNames.has(m.name)) continue;
      const slots = m.uses[kind] ?? [];
      for (const slot of slots) {
        const list = byResource.get(slot) ?? [];
        if (!list.includes(m.name)) list.push(m.name);
        byResource.set(slot, list);
      }
    }
    for (const [resource, plugins] of byResource) {
      if (plugins.length < 2) continue;
      out.push({
        kind,
        resource,
        plugins: [...plugins].sort()
      });
    }
  }
  return out;
}

/**
 * Gruppiere Konflikte nach Plugin-Name. Returnt ein Dictionary
 * `{ pluginName: Conflict[] }` — handy, um in einer Plugin-Karte alle
 * Konflikte zeigen zu können, die dieses Plugin betreffen.
 */
export function conflictsByPlugin(conflicts: Conflict[]): Record<string, Conflict[]> {
  const out: Record<string, Conflict[]> = {};
  for (const c of conflicts) {
    for (const name of c.plugins) {
      const list = out[name] ?? [];
      list.push(c);
      out[name] = list;
    }
  }
  return out;
}

/** Hübsches Label für eine Konflikt-Kind — UI-Bequemlichkeit. */
export function conflictKindLabel(kind: ConflictResourceKind): string {
  switch (kind) {
    case 'ws_ops':
      return 'WS-Op';
    case 'channels':
      return 'Channel';
    case 'settings_sections':
      return 'Settings-Section';
    case 'ui_slots':
      return 'UI-Slot';
  }
}
