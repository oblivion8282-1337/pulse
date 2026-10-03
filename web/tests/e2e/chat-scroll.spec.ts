import { test, expect, type Page } from '@playwright/test';

/**
 * Kleben am Listenende — die beiden Fehler, die einander ausschlossen
 * (Herleitung in `src/lib/nachrichten/klebezustand.ts`):
 *
 * 1. Wer nach oben rollt, muss oben BLEIBEN, auch wenn eine Nachricht kommt.
 *    Chromium animiert einen Rad-Tick über mehrere Frames; die ersten liegen
 *    noch in der Toleranzzone am Ende. Playwrights `mouse.wheel` springt
 *    dagegen in einem Schritt (headless wie headed, nachgemessen) — deshalb
 *    stellt der Test die Zwischenframes selbst nach: ein `wheel`-Ereignis,
 *    dann sechs Schritte à 20 px per requestAnimationFrame. Genau so sah
 *    der Fehler bis zum 2026-09-07 aus: die Nachricht zog die Ansicht
 *    zurück ans Ende.
 * 2. Wer unten steht, muss bei einer Sendeserie unten BLEIBEN — die
 *    Gleitfahrt ans Ende erzeugt selbst Zwischenframes, die nicht als
 *    Hochrollen gelten dürfen (der Fall vom 2026-09-04).
 */

const ts = Date.now();
const USER = {
	username: `scroll_${ts}`,
	email: `scroll_${ts}@dcc-test.example.com`,
	password: 'sup3r-secret-pass'
};

// Der Scroll-Container der virtuellen Liste (virtua legt ihn direkt in den Rahmen).
const VIEWPORT = '[data-testid=message-list] > div';

async function register(page: Page, user = USER) {
	await page.goto('/register');
	await page.getByTestId('reg-username').fill(user.username);
	await page.getByTestId('reg-email').fill(user.email);
	await page.getByTestId('reg-password').fill(user.password);
	await page.getByTestId('reg-submit').click();
	await page.waitForURL(/\/app/);
	await page
		.locator('[data-testid=backup-onboarding-skip-btn]')
		.click({ timeout: 2500 })
		.catch(() => undefined);
}

/** Nachrichten per REST einliefern (10/s ist die Serverbremse). */
async function sende(page: Page, channelId: string, texte: string[], abstandMs = 115) {
	const fehl = await page.evaluate(
		async ([cid, texte, abstand]) => {
			const token = localStorage.getItem('dcc.tokens.access');
			let fehl = 0;
			for (const content of texte) {
				const r = await fetch(`/api/chat/channels/${cid}/messages`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
					body: JSON.stringify({ content, nonce: null, reply_to_id: null, attachment_ids: [] })
				});
				if (r.status !== 201 && r.status !== 200) fehl++;
				await new Promise((r) => setTimeout(r, abstand));
			}
			return fehl;
		},
		[channelId, texte, abstandMs] as const
	);
	expect(fehl).toBe(0);
}

async function lage(page: Page) {
	return page.evaluate((sel) => {
		const el = document.querySelector(sel) as HTMLElement;
		return { top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight) };
	}, VIEWPORT);
}

/** Ein Rad-Tick nach oben, wie Chromium ihn animiert: Ereignis, dann Frames. */
async function animierterRadTickNachOben(page: Page) {
	await page.evaluate(async (sel) => {
		const el = document.querySelector(sel) as HTMLElement;
		el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
		for (let i = 0; i < 6; i++) {
			await new Promise((r) => requestAnimationFrame(r));
			el.scrollTop -= 20;
		}
	}, VIEWPORT);
}

test.describe.serial('Nachrichtenliste: Kleben am Ende', () => {
	let page: Page;
	let guildId = '';
	let channelId = '';

	test.beforeAll(async ({ browser }) => {
		page = await (await browser.newContext()).newPage();
	});

	test('Vorbereitung: Community mit einem vollen Kanal', async () => {
		test.setTimeout(60_000);
		await register(page);
		await page.locator('[data-testid^="guild-create-menu-"]').first().click();
		await page.getByTestId('guild-create').click();
		await page.getByTestId('create-guild-name').fill('Scroll');
		await page.getByTestId('create-guild-submit').click();
		await page.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);
		const teile = new URL(page.url()).pathname.split('/');
		guildId = teile[3];
		channelId = teile[5];
		// Genug Zeilen, dass die Liste das Sichtfenster deutlich übersteigt.
		await sende(
			page,
			channelId,
			Array.from({ length: 60 }, (_, i) =>
				Array.from({ length: 1 + (i % 3) }, (_, k) => `Zeile ${i}.${k}`).join('\n')
			)
		);
	});

	test('nach einem animierten Rad-Tick nach oben bleibt die Ansicht oben, auch wenn eine Nachricht kommt', async () => {
		await page.goto(`/app/guilds/${guildId}/channels/${channelId}`);
		await expect(page.getByTestId('active-channel-name')).toBeVisible();
		// Öffnen landet unten; die Anfangs-Fahrt muss abgeschlossen sein.
		await expect.poll(async () => (await lage(page)).top, { timeout: 5000 }).toBeGreaterThan(0);
		await page.waitForTimeout(800);
		const unten = await lage(page);
		expect(unten.top).toBe(unten.max);

		await animierterRadTickNachOben(page);
		await page.waitForTimeout(300);
		const oben = await lage(page);
		expect(oben.top).toBe(unten.max - 120);

		await sende(page, channelId, ['neu, waehrend oben gelesen wird']);
		// Die Gleitfahrt ans Ende bräuchte ~0,5 s; wer nach 1,5 s noch oben
		// steht, wurde nicht gezogen.
		await page.waitForTimeout(1500);
		const danach = await lage(page);
		expect(danach.top).toBe(oben.top);
		expect(danach.max).toBeGreaterThan(oben.max);
	});

	test('wer unten steht, bleibt bei einer Sendeserie unten', async () => {
		test.setTimeout(60_000);
		await page.goto(`/app/guilds/${guildId}/channels/${channelId}`);
		await expect(page.getByTestId('active-channel-name')).toBeVisible();
		await expect.poll(async () => (await lage(page)).top, { timeout: 5000 }).toBeGreaterThan(0);
		await page.waitForTimeout(800);

		// Ein Abstand unterhalb der Gleitdauer: jede neue Zeile trifft in die
		// laufende Fahrt der vorigen — der Fall, der bis 2026-09-04 das Kleben
		// abriss und die Ansicht 650 px über dem Ende stehen liess.
		await sende(
			page,
			channelId,
			Array.from({ length: 12 }, (_, i) => `Serie ${i}`),
			200
		);
		await page.waitForTimeout(1500);
		const ende = await lage(page);
		expect(ende.top).toBe(ende.max);
	});
});

test.describe.serial('Nachrichtenliste: Hochscrollen durch nachgeladene Historie', () => {
	// Der Dauer-Bug „er springt kurz zurück und scrollt erst dann nach oben"
	// (2026-10-03 untersucht): Die Liste virtualisiert; ungemessene Zeilen
	// zählten mit dem Pauschalwert 48px zur Scrollhöhe. Beim Hochscrollen
	// durch nachgeladene (ungemessene) Historie ersetzte JEDE Messung die
	// Schätzung durch die echte Höhe — mehrzeilige Nachrichten sind 2–4×
	// höher — und jede Korrektur ÜBER dem Sichtfenster schob die Ansicht
	// sichtbar zurück. Der Fix: pro-Eintrag-Schätzung aus der Zeilenzahl
	// (`schaetzeHoehe` in MessageList) über den virtua-Patch
	// (patches/virtua.patch, Prop `itemSizeEstimate`).
	//
	// Dieser Test war vor dem Fix rot: die Fahrten unten zeigten Dutzende
	// Rückkorrekturen von +26..+142px; danach null. Erlaubt bleibt allein der
	// große Positions-Sprung beim Nachladen selbst (Einfügen über dem
	// Sichtfenster hält die Position — scrollHeight wächst um Tausende).
	const USER2 = {
		username: `scrollup_${ts}`,
		email: `scrollup_${ts}@dcc-test.example.com`,
		password: 'sup3r-secret-pass'
	};

	// rAF-Recorder: Scroll-Lage + Scrollhöhe pro Frame (wie chat-overscroll).
	const RECORDER = `
(() => {
  window.__rec = [];
  window.__t0 = Date.now();
  const tick = () => {
    const vp = document.querySelector('${VIEWPORT}');
    if (vp) {
      window.__rec.push({
        t: Date.now() - window.__t0,
        top: Math.round(vp.scrollTop),
        sh: Math.round(vp.scrollHeight)
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
`;

	type Rahmen = { t: number; top: number; sh: number };

	let page: Page;
	let guildId = '';
	let channelId = '';

	test.beforeAll(async ({ browser }) => {
		const ctx = await browser.newContext();
		await ctx.route('**/changelog.json', (r) => r.fulfill({ json: { entries: [] } }));
		await ctx.addInitScript(RECORDER);
		page = await ctx.newPage();
	});

	test('Vorbereitung: Kanal mit gemischter, langer Historie', async () => {
		test.setTimeout(120_000);
		await register(page, USER2);
		await page.locator('[data-testid^="guild-create-menu-"]').first().click();
		await page.getByTestId('guild-create').click();
		await page.getByTestId('create-guild-name').fill('ScrollUp');
		await page.getByTestId('create-guild-submit').click();
		await page.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);
		const teile = new URL(page.url()).pathname.split('/');
		guildId = teile[3];
		channelId = teile[5];
		// 180 ein- bis achtzeilige Nachrichten: Initial-Fenster 50, danach
		// Nachladen in 100er-Seiten — die Zone, in der der Bug zuschlug.
		// Gemischte Höhen maximieren den Schätzfehler einer Pauschalwert-Karte.
		await sende(
			page,
			channelId,
			Array.from({ length: 180 }, (_, i) =>
				Array.from({ length: 1 + (i % 8) }, (_, k) => `Zeile ${i}.${k}`).join('\n')
			)
		);
	});

	test('Hochscrollen durch die Nachlade-Zone ohne sichtbares Zurückspringen', async () => {
		test.setTimeout(120_000);
		await page.goto(`/app/guilds/${guildId}/channels/${channelId}`);
		await page.getByTestId('active-channel-name').waitFor();
		// Öffnen landet unten; Pin abwarten, Mess-Sperre fällt spätestens nach 300ms.
		await expect
			.poll(async () => (await lage(page)).top, { timeout: 5000 })
			.toBeGreaterThan(0);
		await page.waitForTimeout(800);
		await page.evaluate(() => { (window as any).__rec = []; });

		// Fahrt nach oben: 110 echte Rad-Ticks reichen durchs 50er-Startfenster
		// in die Nachlade-Zone und durch den frisch nachgeladenen Bereich.
		const box = await page.locator(VIEWPORT).boundingBox();
		await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
		for (let i = 0; i < 110; i++) {
			await page.mouse.wheel(0, -120);
			await page.waitForTimeout(70);
		}
		await page.waitForTimeout(500);

		const rec: Rahmen[] = await page.evaluate(() => (window as any).__rec ?? []);
		expect(rec.length).toBeGreaterThan(100);

		// Nachgeladen worden sein muss die Fahrt — sonst prüft sie nichts.
		const prependSpruenge = rec.filter((f, i) => i > 0 && f.sh - rec[i - 1].sh > 1000);
		expect(prependSpruenge.length).toBeGreaterThanOrEqual(1);

		// Das Bug-Bild: top STEIGT um mehr als eine Textzeile (>15px), OHNE
		// dass gerade tausende Pixel Historie über dem Fenster eingefügt wurden.
		const rucke: { t: number; dt: number }[] = [];
		for (let i = 1; i < rec.length; i++) {
			const dt = rec[i].top - rec[i - 1].top;
			const dsh = rec[i].sh - rec[i - 1].sh;
			if (dt > 15 && dsh <= 1000) rucke.push({ t: rec[i].t, dt });
		}
		expect(
			rucke,
			`Rückkorrekturen beim Hochscrollen (top-Sprünge >15px ohne Prepend): ${JSON.stringify(rucke)}`
		).toEqual([]);
	});
});
