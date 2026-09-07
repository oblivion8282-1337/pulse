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

async function register(page: Page) {
	await page.goto('/register');
	await page.getByTestId('reg-username').fill(USER.username);
	await page.getByTestId('reg-email').fill(USER.email);
	await page.getByTestId('reg-password').fill(USER.password);
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
