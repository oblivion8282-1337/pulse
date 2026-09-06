/**
 * Aus einem Nextcloud-Freigabe-Link wird ein WebDAV-Zugang.
 *
 * Der Nutzer legt in seiner Nextcloud einen Link mit Schreibrecht an und
 * fuegt ihn hier ein — mehr nicht. Kein Serveradresse-Eintippen, kein
 * Zustimmungsfenster, kein App-Passwort, kein OAuth.
 *
 * Technisch ist so ein Link ein vollwertiger WebDAV-Zugang: das Token dient
 * als Benutzername, das Passwort bleibt leer, und die Basis ist
 * `https://<wirt>/public.php/dav/files/<token>`. Am 2026-08-31 an einer
 * echten Nextcloud gemessen — schreiben 201, lesen 200 mit identischen
 * Bytes, loeschen 204, danach 404; der vorhandene `webdavAdapter` lief
 * unveraendert durch.
 *
 * **Warum nicht Nextclouds eigener Geraete-Anmeldeweg (Login Flow v2):**
 * ebenfalls gemessen, ebenfalls am 2026-08-31. Der Server antwortet mit 200,
 * setzt aber keine einzige CORS-Kopfzeile (Vorabfrage 405). Im Browser ist
 * die Antwort damit nicht lesbar, und den Weg ueber den Pulse-Server zu
 * leiten hiesse, ein frisches App-Passwort durch fremde Haende zu schicken.
 * Der Freigabe-Link war der einfachere Weg und ausserdem schon gebaut.
 *
 * **Der Link ist ein Schluessel in Textform.** Wer ihn hat, darf in diesen
 * Ordner schreiben und daraus loeschen. Er wird deshalb nie geloggt und nie
 * an eine andere Gegenstelle geschickt als die, die in ihm steht. Sein
 * Vorteil gegenueber einem App-Passwort ist der Widerruf: in Nextcloud ein
 * Klick.
 *
 * Importfrei (s. CLAUDE.md zur Falle bei `pnpm test:unit`).
 */

export interface FreigabeZugang {
	/** DAV-Basis, ohne Schraegstrich am Ende. */
	basis: string;
	/** Das Freigabe-Token dient als Benutzername. */
	benutzer: string;
	/** Immer leer — ein oeffentlicher Link hat kein Passwort. */
	passwort: '';
	/** Der Wirt, fuer die Anzeige („Nextcloud auf cloud.example"). */
	wirt: string;
}

export class FreigabeLinkFehler extends Error {
	constructor(meldung: string) {
		super(meldung);
		this.name = 'FreigabeLinkFehler';
	}
}

/**
 * Zerlegt einen eingefuegten Link.
 *
 * Angenommen werden die Formen, die Nextcloud beim Teilen tatsaechlich
 * herausgibt und die ein Nutzer plausibel einfuegt:
 *
 *   https://wirt/s/TOKEN
 *   https://wirt/s/TOKEN/            (Schraegstrich am Ende)
 *   https://wirt/s/TOKEN/download    (der „Herunterladen"-Knopf)
 *   https://wirt/index.php/s/TOKEN   (Aufstellungen ohne huebsche Adressen)
 *   https://wirt/unterpfad/s/TOKEN   (Nextcloud in einem Unterverzeichnis)
 *
 * Alles andere wird abgewiesen. Bewusst nicht geraten: ein Link, den wir
 * falsch deuten, fuehrt zu einer Verbindung, die erst beim ersten Schreiben
 * scheitert — und dann sieht es wie ein Fehler des Servers aus.
 */
export function ausFreigabeLink(eingabe: string): FreigabeZugang {
	const roh = eingabe.trim();
	if (roh === '') {
		throw new FreigabeLinkFehler(
			'Es ist noch kein Link eingefügt. Lege in Nextcloud eine Freigabe mit Schreibrecht auf einen Ordner an und füge den Link hier ein.',
		);
	}

	let url: URL;
	try {
		url = new URL(roh);
	} catch {
		throw new FreigabeLinkFehler(
			'Das sieht nicht nach einer Adresse aus. Erwartet wird der Freigabe-Link aus Nextcloud, etwa https://cloud.example/s/AbCdEf.',
		);
	}

	if (url.protocol !== 'https:') {
		// Kein Dogma, sondern die Folge daraus, dass der Link ein Schluessel
		// ist: ueber http ginge er im Klartext ueber die Leitung.
		throw new FreigabeLinkFehler(
			'Der Link muss mit https:// beginnen — über eine unverschlüsselte Verbindung wäre er mitlesbar.',
		);
	}

	const teile = url.pathname.split('/').filter((t) => t !== '');
	const sitz = teile.lastIndexOf('s');
	if (sitz === -1 || sitz + 1 >= teile.length) {
		throw new FreigabeLinkFehler(
			'In dem Link fehlt der Freigabe-Teil. Erwartet wird etwas wie https://cloud.example/s/AbCdEf.',
		);
	}

	const token = teile[sitz + 1];
	if (!/^[A-Za-z0-9]{4,}$/.test(token)) {
		throw new FreigabeLinkFehler('Der Freigabe-Schlüssel in dem Link sieht nicht richtig aus.');
	}

	// Alles VOR dem `/s/` ist der Ort der Nextcloud — bei einer Aufstellung
	// im Unterverzeichnis gehoert es zur Basis. `index.php` faellt dabei
	// weg: es gehoert zur Adresse der Weboberflaeche, nicht zur DAV-Wurzel.
	const vorher = teile.slice(0, sitz).filter((t) => t !== 'index.php');
	const wurzel = vorher.length > 0 ? `/${vorher.join('/')}` : '';

	return {
		basis: `${url.origin}${wurzel}/public.php/dav/files/${token}`,
		benutzer: token,
		passwort: '',
		wirt: url.host,
	};
}
