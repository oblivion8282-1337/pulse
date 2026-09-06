/**
 * Reine Entscheidung (importfrei, s. CLAUDE.md zur Falle bei
 * `pnpm test:unit`): ist ein Fehlschlag beim DIREKTEN Abruf ein Grund für
 * den Rückfall über Pulse (Entwurf §4.2), oder eine echte Antwort, die
 * keinen Rückfall rechtfertigt?
 *
 * Nur ein Netz-/CORS-Fehler zählt. Genau so ein Fehlschlag hat im Browser
 * eine feste, erkennbare Form: `fetch()` liefert dafür KEINE `Response`,
 * sondern lehnt sein Promise mit einem `TypeError` ab — ohne Statuscode,
 * ohne dass Klient und Server je eine vollständige HTTP-Antwort
 * ausgetauscht hätten (WHATWG-Fetch-Spezifikation, Schritt "HTTP-network-
 * or-cache fetch"; ein von CORS blockierter Abruf läuft im selben Zweig wie
 * ein echter Netzwerkausfall — beide sind vom Klienten aus nicht zu
 * unterscheiden, und beide sollen hier denselben Rückfall auslösen).
 *
 * Eine ECHTE Antwort — 200, 404, 401, 500, was auch immer — hat dagegen
 * einen Statuscode gesehen. Ein Adapter, der aus einem schlechten Status
 * einen eigenen Fehler baut (z. B. `webdavAdapter`s `WebdavFehler` bei
 * einem Nicht-2xx-Status ausserhalb von 404), wirft dafür eine eigene,
 * benannte Fehlerklasse — nie einen `TypeError`. Das ist der Unterschied,
 * an dem diese Funktion hängt: eine Datei, die es wirklich nicht gibt
 * (404), ist bei `AblageAdapter.lese()` ohnehin kein Fehlschlag, sondern
 * `null` — sie kommt hier also gar nicht erst an.
 */
export function istAbprall(fehler: unknown): boolean {
	return fehler instanceof TypeError;
}
