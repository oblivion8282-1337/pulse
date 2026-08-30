/**
 * Integrationstest für die Ablage-Adapter gegen ECHTE Server — bewusst
 * kein Unit-Test (braucht laufende Gegenstellen, deshalb eigener Aufruf):
 *
 *   pnpm test:ablage-int
 *
 * Erwartete Umgebung (Voreinstellungen passen zum SSH-Tunnel auf den
 * Hetzner-Dev-Stack, siehe infra/dev-remote/README.md):
 *
 *   ABLAGE_INT_S3_WIRT      Default http://127.0.0.1:9100   (Tunnel → minio:9000)
 *   ABLAGE_INT_S3_EIMER     Default pulse-ablage-int
 *   ABLAGE_INT_S3_REGION    Default us-east-1
 *   ABLAGE_INT_S3_SCHLUESSEL / ABLAGE_INT_S3_GEHEIMNIS      (Pflicht)
 *   ABLAGE_INT_DAV_URL      Default http://127.0.0.1:8888/remote.php/dav/files/admin
 *   ABLAGE_INT_DAV_BENUTZER Default admin
 *   ABLAGE_INT_DAV_PASSWORT Default pulse-int-2026
 *
 * Jeder Lauf legt einen frischen Ordner/Präfix an (Zeitstempel) und räumt
 * nichts weg — Wegwerfdaten auf einem Dev-Stack.
 */

import { s3Adapter, signiereAnfrage } from '../src/lib/ablage/s3.ts';
import { webdavAdapter } from '../src/lib/ablage/webdav.ts';
import { AblageGeschirr } from './ablage-geschirr.ts';

function umgebung(name: string, vorgabe?: string): string | null {
	return process.env[name] ?? vorgabe ?? null;
}

async function testeS3(geschirr: AblageGeschirr, lauf: string): Promise<void> {
	console.log('\n== S3 / MinIO ==');
	const wirt = umgebung('ABLAGE_INT_S3_WIRT', 'http://127.0.0.1:9100');
	const eimer = umgebung('ABLAGE_INT_S3_EIMER', 'pulse-ablage-int');
	const region = umgebung('ABLAGE_INT_S3_REGION', 'us-east-1');
	const schluessel = umgebung('ABLAGE_INT_S3_SCHLUESSEL');
	const geheimnis = umgebung('ABLAGE_INT_S3_GEHEIMNIS');
	if (!schluessel || !geheimnis) {
		console.error('  ✖ S3-Zugang fehlt (ABLAGE_INT_S3_SCHLUESSEL/GEHEIMNIS setzen) — S3 übersprungen');
		geschirr.pruefe('S3-Zugang vorhanden', false);
		return;
	}

	// Bucket anlegen, falls es ihn nicht gibt (409 = existiert schon).
	const anbindung = { wirt: wirt!, region: region!, schluessel: schluessel!, geheimnis: geheimnis! };
	const bucketKopf = await signiereAnfrage(anbindung, 'PUT', `/${eimer!}`, {}, new Date(), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', null);
	const bucketAntwort = await fetch(`${wirt!}/${eimer!}`, { method: 'PUT', headers: bucketKopf });
	geschirr.pruefe('Bucket bereit', bucketAntwort.ok || bucketAntwort.status === 409, `HTTP ${bucketAntwort.status}`);

	const adapter = s3Adapter({
		wirt: wirt!,
		region: region!,
		eimer: eimer!,
		praefix: `int-${lauf}/`,
		schluessel: schluessel!,
		geheimnis: geheimnis!,
	});
	await geschirr.rundeAuf('S3: Schreiber/Leser/Nachzug', adapter, lauf);
}

async function testeWebdav(geschirr: AblageGeschirr, lauf: string): Promise<void> {
	console.log('\n== WebDAV / Nextcloud ==');
	const url = umgebung('ABLAGE_INT_DAV_URL', 'http://127.0.0.1:8888/remote.php/dav/files/admin');
	const benutzer = umgebung('ABLAGE_INT_DAV_BENUTZER', 'admin');
	const passwort = umgebung('ABLAGE_INT_DAV_PASSWORT', 'pulse-int-2026');
	const adapter = webdavAdapter({
		basis: url!,
		ordner: `Pulse/int-${lauf}/kanal`,
		benutzer: benutzer!,
		passwort: passwort!,
	});
	await geschirr.rundeAuf('WebDAV/Nextcloud: Schreiber/Leser/Nachzug', adapter, lauf);
}

const lauf = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const geschirr = new AblageGeschirr();
try {
	await testeS3(geschirr, lauf);
} catch (fehler) {
	geschirr.pruefe('S3 ohne Katastrophe', false, fehler instanceof Error ? fehler.message : String(fehler));
}
try {
	await testeWebdav(geschirr, lauf);
} catch (fehler) {
	geschirr.pruefe('WebDAV ohne Katastrophe', false, fehler instanceof Error ? fehler.message : String(fehler));
}
const rot = geschirr.fehler();
console.log(rot === 0 ? '\nALLE INTEGRATIONSPRÜFUNGEN GRÜN' : `\n${rot} PRÜFUNGEN ROT`);
process.exit(rot === 0 ? 0 : 1);
