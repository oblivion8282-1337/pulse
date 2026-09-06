import { test } from 'node:test';
import assert from 'node:assert/strict';

// Die Adresse eines Gast-Links muss auf den Server zeigen, auf dem die
// Community LEBT — nicht auf den Ursprung der Seite, von der aus jemand ihn
// erzeugt. Wer von der Cloud aus eine Self-Host-Community verwaltet, baute
// sonst einen Link nach howispulse.com zusammen, wo der Code gar nicht
// existiert: er liegt in der Datenbank des Self-Hosts.
//
// Geprueft wird die reine Rechnung, ohne den Store: der Import von
// `gastLinks.ts` zoege den ganzen API-Klienten mit sich (s. die
// `pnpm test:unit`-Falle in CLAUDE.md). Die Regel ist ein Zweizeiler und
// steht hier deshalb nachgebaut — mit derselben Form wie im Original.

function gastLinkUrl(
	code: string,
	origin: string,
	srv: { isCloud: boolean; hostname: string } | null
): string {
	if (!srv || srv.isCloud) return `${origin}/gast/${code}`;
	const host = srv.hostname.replace(/\/+$/, '');
	return `${host}/gast/${code}`;
}

test('Cloud-Community: der Link zeigt auf den Ursprung der Seite', () => {
	const url = gastLinkUrl('abc', 'https://howispulse.com', {
		isCloud: true,
		hostname: 'https://howispulse.com'
	});
	assert.equal(url, 'https://howispulse.com/gast/abc');
});

test('Self-Host-Community: der Link zeigt auf den Self-Host, nicht auf die Cloud', () => {
	// Der Fall, der den Fehler traegt: die Seite laeuft auf der Cloud, die
	// Community liegt woanders.
	const url = gastLinkUrl('abc', 'https://howispulse.com', {
		isCloud: false,
		hostname: 'https://pulse.firma.de'
	});
	assert.equal(url, 'https://pulse.firma.de/gast/abc');
});

test('ein abschliessender Schraegstrich verdoppelt sich nicht', () => {
	const url = gastLinkUrl('abc', 'https://howispulse.com', {
		isCloud: false,
		hostname: 'https://pulse.firma.de/'
	});
	assert.equal(url, 'https://pulse.firma.de/gast/abc');
});
