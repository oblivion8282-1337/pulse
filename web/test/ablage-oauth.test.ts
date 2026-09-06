import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
	AnmeldungAbgelaufenFehler,
	OAuthFehler,
	autorisierungsUrl,
	auffrischeZugang,
	erzeugeAuffrischendesHolen,
	erzeugePkce,
	tauscheCodeAus,
	type Zugang,
} from '../src/lib/ablage/oauth.ts';

describe('Ablage-OAuth: PKCE', () => {
	it('erzeugt einen Prüfener samt passender S256-Herausforderung', async () => {
		const pkce = await erzeugePkce();
		assert.ok(pkce.pruefer.length >= 43);
		assert.ok(!pkce.pruefer.includes('+') && !pkce.pruefer.includes('/') && !pkce.pruefer.includes('='));
		const verdau = await globalThis.crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(pkce.pruefer) as unknown as ArrayBuffer,
		);
		const erwartet = btoa(String.fromCharCode(...new Uint8Array(verdau)))
			.replaceAll('+', '-')
			.replaceAll('/', '_')
			.replaceAll('=', '');
		assert.equal(pkce.herausforderung, erwartet);
	});

	it('baut Autorisierungs-URLs mit sortierten, kodierten Parametern', () => {
		const url = autorisierungsUrl('https://anbieter.example/autorisieren', {
			client_id: 'k-1',
			scope: 'a b',
		});
		assert.equal(url, 'https://anbieter.example/autorisieren?client_id=k-1&scope=a+b');
	});
});

function festerHolen(antwortBody: object | string, status = 200): { holen: typeof fetch; rufe: { url: string; init: RequestInit }[] } {
	const rufe: { url: string; init: RequestInit }[] = [];
	const holen: typeof fetch = async (eingabe, init) => {
		rufe.push({ url: String(eingabe), init: init ?? {} });
		const koerper = typeof antwortBody === 'string' ? antwortBody : JSON.stringify(antwortBody);
		return new Response(koerper, { status, headers: { 'Content-Type': 'application/json' } });
	};
	return { holen, rufe };
}

describe('Ablage-OAuth: Token-Endpunkte', () => {
	it('tauscht den Code formkodiert aus und liest Zugang samt Nachspiel', async () => {
		const { holen, rufe } = festerHolen({
			access_token: 'z-t-1',
			refresh_token: 'n-t-1',
			expires_in: 3600,
		});
		const zugang = await tauscheCodeAus(holen, 'https://anbieter.example/token', {
			code: 'der-code',
			grant_type: 'authorization_code',
			code_verifier: 'der-pruefer',
			client_id: 'k-1',
		});
		assert.deepEqual(zugang, { zugangsToken: 'z-t-1', nachspieleToken: 'n-t-1', gueltigSekunden: 3600 });
		assert.equal(rufe.length, 1);
		assert.equal(rufe[0].init.method, 'POST');
		const koerper = String(rufe[0].init.body);
		assert.ok(koerper.includes('code=der-code'));
		assert.ok(koerper.includes('code_verifier=der-pruefer'));
	});

	it('wirft die Anbieter-Ablehnung als OAuthFehler mit Beschreibung', async () => {
		const { holen } = festerHolen(
			{ error: 'invalid_grant', error_description: 'Code verbraucht' },
			400,
		);
		await assert.rejects(
			() => tauscheCodeAus(holen, 'https://anbieter.example/token', { code: 'x' }),
			(f: unknown) => f instanceof OAuthFehler && f.fehler === 'invalid_grant' && f.beschreibung === 'Code verbraucht',
		);
	});

	it('spielt mit grant_type refresh_token nach und behält das Formular bei', async () => {
		const { holen, rufe } = festerHolen({ access_token: 'z-t-2', refresh_token: 'n-t-2' });
		const zugang = await auffrischeZugang(holen, 'https://anbieter.example/token', 'n-t-alt', {
			client_id: 'k-1',
		});
		assert.equal(zugang.zugangsToken, 'z-t-2');
		const koerper = String(rufe[0].init.body);
		assert.ok(koerper.includes('grant_type=refresh_token'));
		assert.ok(koerper.includes('refresh_token=n-t-alt'));
		assert.ok(koerper.includes('client_id=k-1'));
	});
});

describe('Ablage-OAuth: Auffrisch-Weg', () => {
	it('frischt nach einem 401 genau einmal auf und wiederholt danach den ursprünglichen Aufruf', async () => {
		let holAufrufe = 0;
		const basisHolen: typeof fetch = async () => {
			holAufrufe += 1;
			return holAufrufe === 1
				? new Response('nicht autorisiert', { status: 401 })
				: new Response('geglückt', { status: 200 });
		};
		let auffrischAufrufe = 0;
		const neuerZugang: Zugang = { zugangsToken: 'neu-1' };
		const geändert: Zugang[] = [];
		const holen = erzeugeAuffrischendesHolen(
			basisHolen,
			() => ({ zugangsToken: 'alt-1', nachspieleToken: 'nach-1' }),
			async (nachspieleToken) => {
				auffrischAufrufe += 1;
				assert.equal(nachspieleToken, 'nach-1');
				return neuerZugang;
			},
			(z) => geändert.push(z),
		);
		const antwort = await holen('https://api.example/x', { headers: { Authorization: 'Bearer alt-1' } });
		assert.equal(antwort.status, 200);
		assert.equal(holAufrufe, 2, 'ursprünglicher Aufruf plus genau eine Wiederholung');
		assert.equal(auffrischAufrufe, 1);
		assert.deepEqual(geändert, [neuerZugang]);
	});

	it('teilt sich bei zwei gleichzeitigen 401 dieselbe Auffrischung', async () => {
		let holAufrufe = 0;
		const basisHolen: typeof fetch = async () => {
			holAufrufe += 1;
			// Die ersten beiden Aufrufe sind die ursprünglichen (beide 401), die
			// beiden danach die Wiederholungen mit dem neuen Token.
			return holAufrufe <= 2
				? new Response('nicht autorisiert', { status: 401 })
				: new Response('geglückt', { status: 200 });
		};
		let auffrischAufrufe = 0;
		const holen = erzeugeAuffrischendesHolen(
			basisHolen,
			() => ({ zugangsToken: 'alt-2', nachspieleToken: 'nach-2' }),
			async (): Promise<Zugang> => {
				auffrischAufrufe += 1;
				// Verzögerung, damit der zweite Aufruf mit Sicherheit auf das
				// bereits laufende Versprechen trifft statt auf ein bereits
				// abgeschlossenes.
				await new Promise((r) => setTimeout(r, 5));
				return { zugangsToken: 'neu-2' };
			},
		);
		const [a, b] = await Promise.all([holen('https://api.example/a', {}), holen('https://api.example/b', {})]);
		assert.equal(a.status, 200);
		assert.equal(b.status, 200);
		assert.equal(auffrischAufrufe, 1, 'zwei gleichzeitige 401 dürfen nur eine Auffrischung auslösen');
	});

	it('wirft AnmeldungAbgelaufenFehler ohne Netzaufruf, wenn kein Nachspiel-Token vorliegt', async () => {
		let auffrischAufrufe = 0;
		const basisHolen: typeof fetch = async () => new Response('nicht autorisiert', { status: 401 });
		const holen = erzeugeAuffrischendesHolen(
			basisHolen,
			() => ({ zugangsToken: 'alt-3' }),
			async () => {
				auffrischAufrufe += 1;
				return { zugangsToken: 'unerreicht' };
			},
		);
		await assert.rejects(() => holen('https://api.example/x', {}), AnmeldungAbgelaufenFehler);
		assert.equal(auffrischAufrufe, 0);
	});

	it('wirft AnmeldungAbgelaufenFehler mit Ursache, wenn die Auffrischung selbst scheitert', async () => {
		const basisHolen: typeof fetch = async () => new Response('nicht autorisiert', { status: 401 });
		const ursprungsFehler = new OAuthFehler('invalid_grant');
		const holen = erzeugeAuffrischendesHolen(
			basisHolen,
			() => ({ zugangsToken: 'alt-4', nachspieleToken: 'nach-4' }),
			async () => {
				throw ursprungsFehler;
			},
		);
		await assert.rejects(
			() => holen('https://api.example/x', {}),
			(f: unknown) => f instanceof AnmeldungAbgelaufenFehler && f.cause === ursprungsFehler,
		);
	});

	it('wirft AnmeldungAbgelaufenFehler, wenn auch der aufgefrischte Zugang abgelehnt wird', async () => {
		const basisHolen: typeof fetch = async () => new Response('nicht autorisiert', { status: 401 });
		const holen = erzeugeAuffrischendesHolen(
			basisHolen,
			() => ({ zugangsToken: 'alt-5', nachspieleToken: 'nach-5' }),
			async (): Promise<Zugang> => ({ zugangsToken: 'auch-abgelehnt' }),
		);
		await assert.rejects(() => holen('https://api.example/x', {}), AnmeldungAbgelaufenFehler);
	});

	it('lässt Antworten ungleich 401 unverändert durch', async () => {
		const basisHolen: typeof fetch = async () => new Response('serverfehler', { status: 500 });
		const holen = erzeugeAuffrischendesHolen(
			basisHolen,
			() => ({ zugangsToken: 'alt-6', nachspieleToken: 'nach-6' }),
			async (): Promise<Zugang> => {
				throw new Error('darf hier nicht laufen');
			},
		);
		const antwort = await holen('https://api.example/x', {});
		assert.equal(antwort.status, 500);
	});
});
