/**
 * Reine Filterentscheidung fuer `nachladen.ts::reconciliereAeltereSeite` —
 * importfrei, damit Nodes Testlaeufer sie direkt prueft, ohne `nachladen.ts`
 * zu importieren (das haengt an `$lib/stores/messages.svelte` und ueber
 * `./index` an `$lib/stores/directMessages.svelte`, deren `$state()` beim
 * Modul-Top-Level scheitern wuerde, s. CLAUDE.md „Die Falle").
 *
 * Bughunt 2026-08-28, FIX 3: ein Hochscroll-Nachladen liest bei Erfolg lokal
 * eine Seite aus und stoesst DANACH einen unbeobachteten Hintergrund-
 * Abgleich mit dem Server an (`reconciliereAeltereSeite`). Trifft waehrend
 * dieser Anfrage ein `message_delete` fuer dieselbe Seite ein, setzt der
 * lokale Handler dafuer sofort einen Grabstein. Der Server liefert geloeschte
 * Nachrichten grundsaetzlich NICHT aus (`serverZuPosten` in `index.ts`) —
 * seine (schon unterwegs gewesene) Antwort kennt die Loeschung also nicht,
 * und ein blindes Upsert (`verlaufPutSaetze`, s. `db.ts`) wuerde den frischen
 * Grabstein wieder auf „nicht geloescht" zuruecksetzen: die geloeschte
 * Nachricht kaeme lokal zurueck. `ohneFrischeGrabsteine` nimmt deshalb genau
 * die IDs heraus, die UNMITTELBAR VOR dem Schreiben lokal als Grabstein
 * gefunden wurden — kein rechnerischer Ausschluss des Zeitfensters (dafuer
 * bruachte es eine Transaktion ueber Lesen+Schreiben, die ausserhalb dieses
 * Scopes liegt), aber die Pruefung erfolgt ohne weiteren `await` dazwischen,
 * unmittelbar vor dem `put`.
 */

export function ohneFrischeGrabsteine<T extends { id: string }>(
  vomServer: T[],
  frischGeloeschteIds: ReadonlySet<string> | readonly string[]
): T[] {
  const grabsteine =
    frischGeloeschteIds instanceof Set ? frischGeloeschteIds : new Set(frischGeloeschteIds);
  if (grabsteine.size === 0) return vomServer;
  return vomServer.filter((n) => !grabsteine.has(n.id));
}
