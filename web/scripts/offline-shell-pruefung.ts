/**
 * Deterministische Prüfung der Offline-Shell (Übergabe P2.13):
 *
 *   pnpm build
 *   pnpm exec vite preview --host 127.0.0.1 --port 4173   # eigenes Fenster lassen
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/offline-shell-pruefung.ts
 *
 * Ablauf: Seite laden → SW ready + Precache abwarten → Cacheinhalt aus dem
 * Service-Worker heraus vermessen (Playwright kann in den Worker evaluieren) →
 * context.setOffline(true) + reload → Console/Pageerror mitlesen → Prüfen,
 * ob die App-Shell gerendert hat (body-Text vorhanden = Login sichtbar).
 * Exit 0 = Shell gerendert, Exit 1 = offline toter Bildschirm.
 */

import { chromium, type BrowserType } from '@playwright/test';

const BASIS = process.env.PULSE_OFFLINE_SHELL_URL ?? 'http://127.0.0.1:4173';

const melde = (...zeilen: string[]) => console.log(zeilen.join('\n'));

/**
 * Bundled Playwright-Chromium, sonst der installierte Brave (gleiche
 * Chromium-Basis, reicht für SW + Offline-Emulation). Ersteres fehlt auf
 * Rechnern ohne `playwright install` — der CDN-Download ist nicht überall
 * erreichbar, der fall back hält die Prüfung lauffähig.
 */
async function starteBrowser() {
	if (chromium.executablePath()) {
		try {
			return await chromium.launch();
		} catch {
			/* weiter zum Brave */
		}
	}
	return chromium.launch({ executablePath: '/usr/bin/brave', headless: true } as Parameters<BrowserType['launch']>[0]);
}

async function holeCacheBericht(sw: {
	evaluate<T>(fn: () => T): Promise<T>;
}): Promise<{ schluessel: string[]; startJs: string | null; startGroesse: number | null; startHeader: Record<string, string> | null }> {
	return sw.evaluate(async () => {
		const namen = await caches.keys();
		const name = namen.find((k) => k.startsWith('pulse-cache-'));
		if (!name) return { schluessel: [], startJs: null, startGroesse: null, startHeader: null };
		const cache = await caches.open(name);
		const schluessel = (await cache.keys()).map((r) => new URL(r.url).pathname).sort();
		const startPfad = schluessel.find((p) => /\/entry\/start\..*\.js$/.test(p)) ?? null;
		let startGroesse: number | null = null;
		let startHeader: Record<string, string> | null = null;
		if (startPfad) {
			const hit = await cache.match(startPfad);
			if (hit) {
				startGroesse = (await hit.arrayBuffer()).byteLength;
				startHeader = Object.fromEntries([...hit.headers.entries()]);
			}
		}
		return { schluessel, startJs: startPfad, startGroesse, startHeader };
	});
}

const browser = await starteBrowser();
try {
	const kontext = await browser.newContext();
	const seite = await kontext.newPage();

	const konsole: string[] = [];
	seite.on('console', (m) => konsole.push(`[console.${m.type()}] ${m.text()}`));
	seite.on('pageerror', (e) => konsole.push(`[pageerror] ${e.message}`));
	seite.on('requestfailed', (r) => konsole.push(`[requestfailed] ${r.url()} — ${r.failure()?.errorText}`));

	await seite.goto(BASIS + '/', { waitUntil: 'load' });

	// Auf Kontrolle durch den SW warten (Registration passiert im load-Event).
	await seite.evaluate(() => navigator.serviceWorker.ready);
	await seite.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				if (navigator.serviceWorker.controller) return resolve();
				const t = setTimeout(() => reject(new Error('kein controller nach 10s')), 10_000);
				navigator.serviceWorker.addEventListener('controllerchange', () => {
					clearTimeout(t);
					resolve();
				});
			})
	);

	// Precache abwarten: Schlüsselzahl muss sich beruhigt haben UND der
	// start-Entry muss liegen (der Pfad steht im modulepreload des HTML).
	const sw = await (async () => {
		for (let i = 0; i < 40; i++) {
			const w = kontext.serviceWorkers()[0];
			if (w) return w;
			await seite.waitForTimeout(250);
		}
		throw new Error('Playwright sah keinen ServiceWorker im Kontext');
	})();

	let vorher = -1;
	let stabil = 0;
	for (let i = 0; i < 60; i++) {
		const bericht = await holeCacheBericht(sw);
		const hatStart = bericht.schluessel.some((p) => /\/entry\/start\..*\.js$/.test(p));
		if (bericht.schluessel.length === vorher && hatStart) {
			stabil++;
			if (stabil >= 3) break;
		} else {
			stabil = 0;
			vorher = bericht.schluessel.length;
		}
		await seite.waitForTimeout(500);
	}

	const bericht = await holeCacheBericht(sw);
	melde(
		`Cache nach Precache: ${bericht.schluessel.length} Einträge`,
		`start-Entry im Cache: ${bericht.startJs} (${bericht.startGroesse} Bytes)`,
		`start-Header: ${JSON.stringify(bericht.startHeader)}`,
		'--- Console bis hierher:',
		...(konsole.length ? konsole : ['(leer)'])
	);
	konsole.length = 0;

	// Der eigentliche Befund: offline neu laden.
	await kontext.setOffline(true);
	await seite.reload({ waitUntil: 'load' }).catch(() => konsole.push('[reload] warf/timeout'));
	await seite.waitForTimeout(4000);

	const zustand = await seite.evaluate(() => ({
		titel: document.title,
		bodyKinder: document.body.children.length,
		knoten: document.body.querySelectorAll('*').length,
		struktur: document.body.innerHTML.slice(0, 400),
		bodyText: document.body.innerText.trim().slice(0, 200)
	}));

	// Belegt, dass die Entry-Module auch offline AUS DEM CACHE ladbar sind
	// (der ursprüngliche Befund sah hier Fehler + ein nicht existierendes
	// „importModule"-Global).
	const importe = await seite.evaluate(async () => {
		const preloads = [...document.querySelectorAll('link[rel="modulepreload"]')]
			.map((l) => (l as HTMLLinkElement).href)
			.filter((h) => /entry\/(start|app)\./.test(h));
		const ergebnis: string[] = [];
		for (const url of preloads) {
			try {
				const mod = await import(/* @vite-ignore */ url);
				ergebnis.push(`${url} → OK (${Object.keys(mod).join(',')})`);
			} catch (e) {
				ergebnis.push(`${url} → FEHLER: ${String((e as Error)?.message ?? e)}`);
			}
		}
		return ergebnis;
	});

	melde(
		'--- Nach Offline-Reload:',
		`titel="${zustand.titel}" bodyKinder=${zustand.bodyKinder} knoten=${zustand.knoten}`,
		`struktur=${JSON.stringify(zustand.struktur)}`,
		`bodyText=${JSON.stringify(zustand.bodyText)}`,
		'--- Dynamische Imports offline:',
		...importe,
		'--- Console offline:',
		...(konsole.length ? konsole : ['(leer)'])
	);

	const shellGerendert = zustand.knoten > 3 && zustand.bodyText.length > 0;
	melde(shellGerendert ? 'ERGEBNIS: GRUEN — Shell offline gerendert.' : 'ERGEBNIS: ROT — offline toter Bildschirm.');
	process.exitCode = shellGerendert ? 0 : 1;
} finally {
	await browser.close();
}
