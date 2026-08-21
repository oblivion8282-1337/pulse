/**
 * Die reine Rechnung hinter „eine Zeile hinzufügen/entfernen" in der
 * Freigabeliste — aus `DeviceFreigaben.svelte` gezogen, damit sie ohne
 * Svelte testbar ist und die Komponente unter der Grössen-Grenze bleibt.
 *
 * Importfrei, damit Nodes eingebauter Testläufer sie direkt laden kann
 * (Muster wie `restzeit.ts`).
 *
 * `freigaben.setzen()` ersetzt immer die GANZE Liste (PUT-Semantik, keine
 * Einzel-Änderung) — diese beiden Funktionen bauen also nicht die neue Zeile
 * allein, sondern die vollständige nächste Liste.
 */

type GrantArtWie = 'user' | 'role' | 'everyone';

interface GrantWie {
  id: string;
  subject_type: GrantArtWie;
  subject_id: string | null;
  expires_at: string | null;
}

interface GrantEingabeWie {
  subject_type: GrantArtWie;
  subject_id: string | null;
  expires_at: string | null;
}

function alsEingabe(g: GrantWie): GrantEingabeWie {
  return { subject_type: g.subject_type, subject_id: g.subject_id, expires_at: g.expires_at };
}

/**
 * Fügt eine neue Zeile hinzu. Eine vorhandene Zeile mit demselben Ziel
 * (Art + Kennung) wird dabei ERSETZT statt verdoppelt — „jeder" hat nur
 * eine sinnvolle Zeile, und ein Nutzer/eine Rolle neu freizugeben ersetzt
 * die alte Geltung statt eine zweite, konkurrierende Frist anzulegen.
 */
export function mitNeuem(vorhandene: GrantWie[], neu: GrantEingabeWie): GrantEingabeWie[] {
  const rest = vorhandene.filter(
    (g) => !(g.subject_type === neu.subject_type && g.subject_id === neu.subject_id),
  );
  return [...rest.map(alsEingabe), neu];
}

/** Entfernt die Zeile mit der gegebenen Kennung. */
export function ohne(vorhandene: GrantWie[], id: string): GrantEingabeWie[] {
  return vorhandene.filter((g) => g.id !== id).map(alsEingabe);
}
