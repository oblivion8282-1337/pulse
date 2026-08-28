import { test, expect, type Page } from '@playwright/test';

/**
 * Ersetzt den manuellen Schritt aus Etappe-B2-Plan Task 3 Schritt 5
 * (`docs/superpowers/plans/2026-08-28-etappe-b2-klient-veroeffentlicht.md`):
 * "anmelden, und der Server hat danach ein Buendel und Einmalschluessel fuer
 * dieses Geraet." Hier automatisiert ueber die echten `/keys/*`-Routen statt
 * per Blick in die Entwicklerwerkzeuge.
 *
 * Zwei Behauptungen, keine davon durch die andere ersetzbar: das Buendel
 * (`curve25519`) UND ein Einmalschluessel muessen da sein — ein Buendel ohne
 * Vorrat waere fuer einen Absender nutzlos, ein Vorrat ohne Buendel kann
 * server-seitig gar nicht existieren (die Route verlangt ein bestehendes
 * Buendel), aber beides einzeln zu pruefen zeigt genauer, WELCHER der beiden
 * Aufrufe (`PUT /keys/bundle`, `POST /keys/onetime`) ausgeblieben waere.
 */

const ts = Date.now();
const ALICE = {
  username: `alice_krypto_${ts}`,
  email: `alice_krypto_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `bob_krypto_${ts}`,
  email: `bob_krypto_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

async function register(page: Page, u: { username: string; email: string; password: string }) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

/** Liest `device_pubkey` aus dem in `pulse-identity` (IndexedDB) abgelegten
 *  Cert — dieselbe Kennung, mit der der Server das Buendel verzeichnet
 *  (`DeviceKeyBundle.device_pubkey`). ZUERST nachsehen, OB die Datenbank
 *  existiert: `indexedDB.open(name)` ohne Version legt sie sonst leer an und
 *  blockiert die eigene Migration der App — derselbe Fallstrick wie in
 *  `verlauf-lokal.spec.ts::alleSaetze`. */
async function devicePubkey(page: Page): Promise<string> {
  for (let versuch = 0; versuch < 10; versuch += 1) {
    const wert = await page.evaluate(async () => {
      const vorhanden = (await indexedDB.databases()).some((d) => d.name === 'pulse-identity');
      if (!vorhanden) return null;
      return new Promise<string | null>((resolve, reject) => {
        const req = indexedDB.open('pulse-identity');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('identity')) {
            resolve(null);
            return;
          }
          const tx = db.transaction('identity', 'readonly');
          const get = tx.objectStore('identity').get('pulse.identity-cert');
          get.onsuccess = () => {
            const cert = get.result as { claims?: { device_pubkey?: string } } | undefined;
            resolve(cert?.claims?.device_pubkey ?? null);
          };
          get.onerror = () => reject(get.error);
        };
      });
    });
    if (wert) return wert;
    await page.waitForTimeout(300);
  }
  throw new Error('device_pubkey nie in pulse-identity aufgetaucht — Issue-Flow lief nicht durch');
}

interface GeraeteSchluessel {
  device_pubkey: string;
  curve25519: string;
  einmalschluessel: string | null;
  rueckfallschluessel: string | null;
}

async function keysClaimSelf(page: Page, userId: string): Promise<GeraeteSchluessel[]> {
  const antwort = await page.evaluate(async (uid) => {
    const token = localStorage.getItem('dcc.tokens.access');
    const r = await fetch('/api/chat/keys/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ user_ids: [uid] })
    });
    return { status: r.status, body: await r.text() };
  }, userId);
  if (antwort.status !== 200) {
    throw new Error(`keys/claim fehlgeschlagen ${antwort.status}: ${antwort.body}`);
  }
  const geparst = JSON.parse(antwort.body) as Record<string, GeraeteSchluessel[]>;
  return geparst[userId] ?? [];
}

async function currentUserId(page: Page): Promise<string> {
  const value = await page.evaluate(() => {
    const raw = localStorage.getItem('dcc.tokens.access');
    if (!raw) return null;
    const parts = raw.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.sub as string;
  });
  if (!value) throw new Error('no access token found in localStorage');
  return value;
}

test('Anmelden veroeffentlicht Buendel und Einmalschluessel dieses Geraets', async ({ page }) => {
  await page.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));

  await register(page, ALICE);
  const userId = await currentUserId(page);
  const pubkey = await devicePubkey(page);

  // veroeffentlicheSchluessel() laeuft best-effort im Hintergrund
  // (runIssueFlow schluckt Fehler, s. issue-flow.ts) — expect.poll statt
  // eines festen Timeouts, damit der Test nicht von der Netzwerklatenz
  // dieses Laufs abhaengt.
  await expect
    .poll(
      async () => {
        const buendel = await keysClaimSelf(page, userId);
        return buendel.find((b) => b.device_pubkey === pubkey) ?? null;
      },
      { timeout: 15_000 }
    )
    .toMatchObject({
      device_pubkey: pubkey,
      // Das eigene Geraet hat garantiert einen curve25519-Wert — welchen
      // genau ist fuer den Test irrelevant, nur dass er da ist.
      curve25519: expect.any(String)
    });

  const buendel = await keysClaimSelf(page, userId);
  const eigenes = buendel.find((b) => b.device_pubkey === pubkey);
  expect(eigenes).toBeTruthy();
  // Genau EINES der beiden Felder ist gesetzt (Server-Invariante,
  // `GeraeteSchluesselOut`-Docstring): solange der Einmalschluessel-Vorrat
  // nicht leer ist, liefert der Server einen Einmalschluessel, keinen
  // Rueckfallschluessel.
  expect(eigenes!.einmalschluessel).not.toBeNull();
});

test('Rueckfallschluessel erscheint, sobald der Einmalschluessel-Vorrat erschoepft ist', async ({
  page
}) => {
  // Der eigentliche Lueckenschluss dieses PRs (docs/superpowers/specs/
  // 2026-08-28-e2e-dm-design.md §2): vorher blieb `rueckfallschluessel` im
  // Buendel-Rumpf immer leer, und ein Geraet mit erschoepftem Vorrat wurde
  // unerreichbar — `POST /keys/claim` haette fuer dieses Geraet gar nichts
  // mehr geliefert. Dieser Test zieht den Vorrat wirklich leer (statt nur
  // die Byte-Nutzlast zu pruefen, s. `krypto-nutzlast.test.ts`) und
  // verlangt, dass an genau dieser Stelle ein Rueckfallschluessel steht.
  await page.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));

  await register(page, BOB);
  const userId = await currentUserId(page);
  const pubkey = await devicePubkey(page);

  // Erst abwarten, bis das Buendel wirklich veroeffentlicht ist (wie im
  // ersten Test) — sonst waere eine leere Antwort unten nicht von "noch
  // nicht veroeffentlicht" zu unterscheiden.
  await expect
    .poll(
      async () => {
        const buendel = await keysClaimSelf(page, userId);
        return buendel.find((b) => b.device_pubkey === pubkey) ?? null;
      },
      { timeout: 15_000 }
    )
    .toMatchObject({ device_pubkey: pubkey, curve25519: expect.any(String) });

  // Vorrat vollstaendig leerziehen — jeder Claim gegen das eigene Geraet
  // (`darf_schluessel_holen` erlaubt das eigene Konto immer) verbraucht
  // server-seitig GENAU einen Einmalschluessel und liefert ihn in derselben
  // Antwort. NACHFUELL_BATCH ist 30, die Obergrenze hier ist bewusst
  // grosszuegiger, damit der Test nicht an einer internen Zahl haengt, die
  // sich unabhaengig von diesem PR aendern kann.
  for (let versuch = 0; versuch < 200; versuch += 1) {
    const buendel = await keysClaimSelf(page, userId);
    const eigenes = buendel.find((b) => b.device_pubkey === pubkey);
    expect(eigenes).toBeTruthy();
    if (eigenes!.einmalschluessel === null) {
      expect(eigenes!.rueckfallschluessel).toEqual(expect.any(String));
      return;
    }
  }
  throw new Error('Einmalschluessel-Vorrat nach 200 Abholungen immer noch nicht leer');
});
