/**
 * Verhindert, dass ein zweiter Aufruf während eines laufenden asynchronen
 * Abrufs einen eigenen Abruf lostritt ODER sich mit einem stillschweigenden
 * „läuft schon" begnügt, ohne das Ergebnis abzuwarten.
 *
 * **Warum das zweite genauso gefährlich ist wie das erste** (Bughunt
 * 2026-08-20, Fix-Runde 2 zu Aufgabe 7): ein Ladewächter, der einem
 * überlappenden Aufrufer sofort zurückgibt, ohne auf den laufenden Abruf zu
 * warten, unterschiebt ihm den alten (oft noch leeren) Zwischenstand als
 * „geladen". Auf dem gemeinsamen Remote-Dev-Stack reisst ein WS-Socket alle
 * paar Minuten ab — jeder Backend-Sync trennt jeden Socket —, und eine neue
 * Verbindung liefert sofort ein neues `ready`. Riss der Socket, während ein
 * `freigaben.laden()` noch auf die HTTP-Antwort wartete (ein WS-Abriss killt
 * die parallele HTTP-Anfrage NICHT), sah ein zweiter, überlappender Aufruf
 * die Liste fälschlich als „geladen, leer" an — und der Umzug der alten
 * lokalen Freigabeliste überschrieb (`freigaben.setzen()`, PUT-Semantik) eine
 * auf dem Server bereits gepflegte, nicht-leere Liste.
 *
 * `dedupliziertLaden` schliesst beide Löcher: ein zweiter Aufruf für denselben
 * Schlüssel bekommt dasselbe Versprechen zurück und wartet auf sein
 * Ergebnis, statt einen zweiten Abruf zu starten oder ungeduldig
 * zurückzukehren. Nach Abschluss — Erfolg oder Fehler — räumt sich der
 * Eintrag selbst auf, damit der nächste Aufruf wieder einen echten Abruf
 * auslöst.
 *
 * Importfrei, damit Nodes Testläufer sie laden kann.
 */
export function dedupliziertLaden<T>(
  laufend: Map<string, Promise<T>>,
  schluessel: string,
  abruf: () => Promise<T>,
): Promise<T> {
  const vorhanden = laufend.get(schluessel);
  if (vorhanden) return vorhanden;
  const lauf = abruf().finally(() => {
    laufend.delete(schluessel);
  });
  laufend.set(schluessel, lauf);
  return lauf;
}
