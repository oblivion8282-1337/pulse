/**
 * Reine Rechnung (importfrei, s. CLAUDE.md „Die Falle"): zieht aus einer
 * WebDAV-Freigabe-Basis das Token zurück, das `freigabeLink.ts::
 * ausFreigabeLink` beim Verbinden hineingebaut hat
 * (`https://<wirt>/public.php/dav/files/<token>`, Design §2.3).
 *
 * **Warum das ueberhaupt noetig ist:** der Server speichert nur die Basis
 * (`ablage_kanal.py::setze_freigabe_adresse`, „Die Adresse verlaesst diesen
 * Server nie wieder"), nicht Benutzername/Passwort separat — die gibt es
 * bei einem oeffentlichen Nextcloud-Link ohnehin nicht getrennt, das Token
 * IST der Benutzername (`webdavAdapter`s Basic-Auth, leeres Passwort). Ein
 * Mitglied, das die Basis ueber das Postfach bekommt (Design §3.1), muss
 * also aus GENAU dieser Zeichenkette den Benutzernamen zurueckgewinnen, um
 * denselben `webdavAdapter` bauen zu koennen, den auch der Ersteller nutzt.
 *
 * Nimmt das letzte, nicht-leere Pfadsegment — bei
 * `.../public.php/dav/files/<token>` ist das exakt das Token. Eine Basis,
 * die dieser Form nicht folgt (anderer Anbieter, von Hand editiert), liefert
 * kein zuverlaessiges Ergebnis mehr; der Aufrufer verlaesst sich hier bewusst
 * NICHT auf ein Rateergebnis, s. `kanalLeseweg.ts`.
 */
export function tokenAusWebdavBasis(basis: string): string {
	const segmente = basis.split('/').filter((teil) => teil !== '');
	return segmente[segmente.length - 1] ?? '';
}
