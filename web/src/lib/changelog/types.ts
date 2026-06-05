/** Ein Changelog-Eintrag aus static/changelog.json. `id` ist der opake
 * Vergleichsschlüssel (neuester Eintrag = entries[0]); items/intro/outro
 * tragen den jeweils gewählten Fun-Stil. */
export interface ChangelogEntry {
  id: string;
  date: string;
  style: string;
  title: string;
  intro?: string;
  items: string[];
  outro?: string;
}

/** Defensive Strukturprüfung — die Datei ist repo-eigen, aber ein kaputter
 * Eintrag (Tippfehler beim Pflegen) darf den App-Start nie blockieren. */
export function isChangelogEntry(e: unknown): e is ChangelogEntry {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.title === 'string' &&
    typeof o.style === 'string' &&
    Array.isArray(o.items) &&
    o.items.every((i) => typeof i === 'string')
  );
}
