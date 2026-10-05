/**
 * Gegenprobe zur Plattform-Erkennung (`src/lib/platform/runtime.ts`).
 *
 * Anlass (2026-10-05, iOS-Hülle): `isCapacitorAndroid` prüfte nur „irgendein
 * natives Capacitor" — in der iOS-Hülle hätten damit alle Android-Bridges
 * gefeuert (FCM, AudioRoute, Share-Target, Zurück-Taste), deren Java-Plugins
 * dort nicht existieren. Vertrag jetzt: nativ + iOS-UA → ausschließlich
 * `isCapacitorIOS`; nativ + Android-UA → ausschließlich `isCapacitorAndroid`;
 * ohne Capacitor → beides false (purer Browser).
 *
 * `runtime.ts` liest window/navigator erst BEIM Aufruf, deshalb genügt es, die
 * Globals je Test zu setzen (Object.defineProperty, weil Nodes eingebauter
 * `navigator` als Getter daherkommt). Jede Testdatei läuft im eigenen
 * Node-Prozess — kein Auswaschen nötig.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isCapacitorAndroid, isCapacitorIOS } from '../src/lib/platform/runtime.ts';

function setzeUmgebung(capacitor: boolean, ua: string, maxTouchPoints = 0): void {
	const window = capacitor
		? { Capacitor: { isNativePlatform: () => true } }
		: undefined;
	Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
	Object.defineProperty(globalThis, 'navigator', {
		value: { userAgent: ua, maxTouchPoints },
		configurable: true,
	});
}

const UA_ANDROID =
	'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const UA_IPHONE =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
// iPadOS 13+ gibt sich als macOS aus; nur maxTouchPoints verrät das iPad.
const UA_IPAD_MASQUERADE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

describe('Plattform-Erkennung (Capacitor Android vs. iOS)', () => {
	it('purer Browser ohne Capacitor: beides false — egal welche UA', () => {
		for (const ua of [UA_ANDROID, UA_IPHONE, UA_IPAD_MASQUERADE]) {
			setzeUmgebung(false, ua);
			assert.equal(isCapacitorAndroid(), false, ua);
			assert.equal(isCapacitorIOS(), false, ua);
		}
	});

	it('nativ + Android-UA: ausschließlich isCapacitorAndroid (Bestand verhält sich unverändert)', () => {
		setzeUmgebung(true, UA_ANDROID);
		assert.equal(isCapacitorAndroid(), true);
		assert.equal(isCapacitorIOS(), false);
	});

	it('nativ + iPhone-UA: ausschließlich isCapacitorIOS', () => {
		setzeUmgebung(true, UA_IPHONE);
		assert.equal(isCapacitorAndroid(), false);
		assert.equal(isCapacitorIOS(), true);
	});

	it('nativ + iPadOS-Mac-UA (Touch-Mac): ausschließlich isCapacitorIOS', () => {
		setzeUmgebung(true, UA_IPAD_MASQUERADE, 5);
		assert.equal(isCapacitorAndroid(), false);
		assert.equal(isCapacitorIOS(), true);
	});

	it('echtes Mac-Touchpad (maxTouchPoints 0, macOS-UA) zählt nicht als iOS-Gerät', () => {
		setzeUmgebung(true, UA_IPAD_MASQUERADE, 0);
		assert.equal(isCapacitorAndroid(), true);
		assert.equal(isCapacitorIOS(), false);
	});
});
