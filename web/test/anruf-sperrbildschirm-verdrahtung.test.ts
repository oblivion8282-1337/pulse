import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Anrufe-Epic E — Sperrbildschirm-Notification, Verdrahtungs-Vertrag:
 * Store-Signal (`ankommen`/`beenden`/`aktion`-Event), natives `Anruf`-Plugin,
 * phoneCall-FGS mit Full-Screen-Intent + CallStyle und die Manifest-Einträge
 * müssen dieselben Namen tragen. Die Dateien werden als Text gelesen, weil die
 * Java-Seite den Capacitor-/Android-Stack und der Store ($state-Runes,
 * livekit-client) den Vite-Build voraussetzen — beides im Node-Läufer nicht
 * nachzubilden. Bricht die Verdrahtung (Umbenennen, Entfernen), schlägt der
 * Test fehl.
 */

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const lies = (pfad: string) => readFileSync(join(webRoot, pfad), 'utf8');

const store = lies('src/lib/anrufe/anruf.svelte.ts');
const plugin = lies(
  '../mobile/android/app/src/main/java/com/howispulse/app/AnrufPlugin.java'
);
const service = lies(
  '../mobile/android/app/src/main/java/com/howispulse/app/CallForegroundService.java'
);
const manifest = lies('../mobile/android/app/src/main/AndroidManifest.xml');

test('Store signalisiert ankommen/beenden und hört auf das aktion-Event', () => {
  assert.match(store, /registerPlugin<AnrufNativPlugin>\('Anruf'\)/);
  // eingehend() kündigt nativ an; #aufräumen() beendet (deckt ablehnen,
  // auflegen, call_ende, Klingel-Timeout ab), annehmen() nach dem Verbinden.
  assert.match(store, /void nativAnkommen\(evt\.call_id, gegenstelle\)/);
  assert.match(store, /void nativBeenden\(\);/);
  assert.match(store, /addListener\('aktion'/);
});

test('Natives Anruf-Plugin trägt dieselben Methoden- und Event-Namen', () => {
  assert.match(plugin, /@CapacitorPlugin\(name = "Anruf"\)/);
  assert.match(plugin, /public void ankommen\(/);
  assert.match(plugin, /public void beenden\(/);
  assert.match(plugin, /notifyListeners\("aktion"/);
});

test('FGS zeigt CallStyle-Notification mit Full-Screen-Intent und Anruf-Typ', () => {
  assert.match(service, /CATEGORY_CALL/);
  assert.match(service, /VISIBILITY_PUBLIC/);
  assert.match(service, /setFullScreenIntent\(/);
  assert.match(service, /CallStyle\.forIncomingCall\(/);
  assert.match(service, /FOREGROUND_SERVICE_TYPE_PHONE_CALL/);
});

test('Manifest: Permissions und Service/Receiver eingetragen', () => {
  assert.match(manifest, /android\.permission\.USE_FULL_SCREEN_INTENT/);
  assert.match(manifest, /android\.permission\.FOREGROUND_SERVICE_PHONE_CALL/);
  assert.match(manifest, /android\.permission\.MANAGE_OWN_CALLS/);
  assert.match(manifest, /android:name="\.CallForegroundService"/);
  assert.match(manifest, /foregroundServiceType="phoneCall"/);
  assert.match(manifest, /android:name="\.CallForegroundService\$AktionsEmpfaenger"/);
});
