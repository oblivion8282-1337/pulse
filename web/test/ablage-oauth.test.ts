import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
	OAuthFehler,
	autorisierungsUrl,
	auffrischeZugang,
	erzeugePkce,
	tauscheCodeAus,
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
