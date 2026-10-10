# Einladungsseite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein verschickter Einladungslink (`/invite/<code>[?host=<fqdn>]`) führt im Browser, in der Desktop-App und am Handy zu einer Einladung, der man mit einem Klick beitritt — angemeldet oder nicht, mit oder ohne Konto.

**Architecture:** Eine darstellende Karte (`EinladungKarte.svelte`) in zwei Rahmen: eigene Seite außerhalb von `/app` für den Einstieg von außen, Dialog in der App für Chat-Links und den Deep-Link aus dem Browser. Der Rückweg nach Anmeldung, Registrierung und E-Mail-Bestätigung läuft über eine im Browser gemerkte Einladung, die der Dialog im App-Layout aufgreift. Die reine Logik (Link lesen, Host prüfen, Merken, Fehler einordnen) liegt in importfreien Modulen mit Node-Unit-Tests; der Server bekommt eine anonyme Vorschau-Route mit Redis-Bremse.

**Tech Stack:** SvelteKit-SPA (Svelte 5 Runes), Paraglide (de/en), Node-Testläufer (`pnpm test:unit`), Playwright, FastAPI + SQLAlchemy (chat-gateway), pytest, Electron (Deep-Link), Flatpak/electron-builder.

**Spec:** `docs/superpowers/specs/2026-10-10-einladungsseite-design.md` — vor jeder Aufgabe lesen; dieser Plan argumentiert daraus.

## Global Constraints

- Arbeitszweig: `feat/einladungsseite` (enthält schon die Spec und einen **nicht committeten Prototyp** unter `web/src/lib/einladung/`, `web/src/routes/invite/[code]/` und eine Zeile in `web/src/routes/app/+layout.svelte`; die Aufgaben unten ersetzen diese Dateien vollständig).
- Alle sichtbaren Texte über Paraglide, **Deutsch und Englisch**; Katalog `web/messages/{de,en}.json` ist **append-only** (keine Schlüssel umbenennen oder löschen).
- **Echte Umlaute** in Texten, Kommentaren und Commit-Nachrichten; **keine Emojis**, nirgends.
- Module, die per Node getestet werden, sind **importfrei** bis auf Geschwister mit **`.ts`-Endung** (`from './einladungsLink.ts'`), und sie enthalten **kein `$state`** (CLAUDE.md, Abschnitt Frontend-Tests).
- Größen-Policy: Quelltext ≤ 350 Zeilen, Svelte-Komponenten ≤ 250 Zeilen (`PLAN.md` §12.1).
- **Keine neuen Abhängigkeiten.**
- Kein Einladungscode, kein Token in Logs (`console.*`, `structlog`).
- Backend-Tests immer mit `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0` (CLAUDE.md, Tests).
- Eine Änderung unter `desktop/electron/**` oder `desktop/package.json` erreicht Windows-Bestandsclients **nur mit Versionssprung** (CLAUDE.md, Desktop).
- Vor jedem Commit am Ende einer Etappe: `code-simplifier`-Agent über die geänderten Dateien → Checks erneut grün → `bash .claude/hooks/simplify-stamp.sh`.
- Landen nur über `bash scripts/ship.sh`, **erst nach Freigabe durch den Eigentümer** (Merge nach `main` = Prod-Deploy).
- Changelog: neuer Eintrag in `web/static/changelog.json` je Etappe, die ein Nutzer bemerkt; **Stil vom Eigentümer wählen lassen** (zuletzt „Sachlich“).

## Review Focus

1. **Link am Satzende oder in Klammern** (`… /invite/abc12345.`, `(…/invite/abc12345)`) — die Karte erscheint trotzdem, der Klick öffnet den Dialog. Test in Task 1 (`ersteEinladungImText`, `einladungAusUrl`).
2. **Kaputter, alter oder manipulierter Eintrag im Browser-Speicher** (ungültiges JSON, falscher Host, Zeitstempel in der Zukunft, älter als 24 h, Speicher wirft) — wird verworfen, nie ausgeführt, nichts stürzt ab. Test in Task 2.
3. **Strg-/Cmd-/Mittelklick auf einen Einladungslink im Chat** — öffnet weiter einen neuen Tab, wie der Nutzer es will; nur der schlichte Linksklick öffnet den Dialog. Test in Task 1 (`klickAbfangen`).
4. **`?host=` in anderer Schreibweise** (`HTTPS://Pulse.Example.de/`, `?host=howispulse.com`) — derselbe Server bzw. eine Cloud-Einladung, nicht „ungültig“ und nicht „neuer Self-Host“. Test in Task 1 (`zielHost`).
5. **Die anonyme Vorschau verrät keine Kennungen** — keine `guild.id`, kein `channel_id`, jedes „nein“ dieselbe 404. Test in Task 14.

---

## Dateiübersicht

| Datei | Aufgabe | Task |
|---|---|---|
| `web/src/lib/einladung/einladungsLink.ts` (neu, importfrei) | Link lesen, Code/Host prüfen, Adress-Parameter für den Dialog, Klick-Entscheidung | 1 |
| `web/src/lib/einladung/gemerkt.ts` (neu, importfrei) | gemerkte Einladung schreiben/lesen/verwerfen | 2 |
| `web/src/lib/einladung/fehlertext.ts` (neu, importfrei) | HTTP-Status + `detail` → Fehlerart | 3 |
| `web/messages/{de,en}.json` | Texte | 4 |
| `web/src/lib/einladung/EinladungKarte.svelte` | Karte, alle Zustände | 4 |
| `web/src/lib/einladung/laden.ts` | Vorschau laden, beitreten, Fehlertext | 4 |
| `web/src/lib/components/AuthBuehne.svelte` (neu) | Hintergrund von `/login` und `/invite` | 5 |
| `web/src/routes/invite/[code]/+page.svelte` | Seite | 5 |
| `web/src/lib/einladung/EinladungDialog.svelte` | Dialog in der App | 6 |
| `web/src/routes/app/+layout.svelte`, `web/src/lib/stores/auth.svelte.ts` | Dialog einhängen, Abmelden verwirft | 6 |
| `web/src/lib/guilds/joinByInvite.ts`, `InviteEmbed.svelte`, `MessageItem.svelte` | Cloud-Route, Host-Prüfung, gemeinsamer Parser | 7 |
| `web/src/lib/einladung/linkKlick.ts` (neu) | Chat-Klick → Dialog | 8 |
| `web/src/lib/einladung/deepLink.ts` (neu), `web/src/routes/+layout.svelte` | Deep-Link → Dialog oder merken | 9 |
| `web/src/app.html` | Open-Graph-Angaben | 10 |
| `web/tests/e2e/einladungsseite.spec.ts` (neu) | E2E | 11 |
| `services/chat-gateway/src/dcc_chat_gateway/routes/invite_public.py` (neu) | anonyme Vorschau | 13 |
| `desktop/electron/deeplink.ts`, `desktop/test/deeplink.test.ts` (neu) | `pulse://` ohne Host | 15 |
| `packaging/com.howispulse.Pulse.desktop`, `desktop/electron-builder.yml`, `desktop/package.json` | Protokoll beim System, Version | 16 |
| `web/src/routes/c/[handle]/+page.svelte` | dieselbe Karte für `/c/` | 18 |

---

# Etappe 1 — Web

### Task 1: Einladungslinks lesen und prüfen

**Files:**
- Create: `web/src/lib/einladung/einladungsLink.ts`
- Test: `web/test/einladung-link.test.ts`

**Interfaces:**
- Produces:
  - `interface Einladung { code: string; host: string | null }` (`host` = nackter FQDN eines Self-Hosts, `null` = Cloud)
  - `istGueltigerCode(code: string): boolean`
  - `istGueltigerHost(host: string): boolean`
  - `zielHost(roh: string | null, cloudHost: string): string | null | undefined` (`undefined` = ungültig)
  - `einladungAusUrl(url: string, cloudHost: string): Einladung | null`
  - `ersteEinladungImText(text: string, cloudHost: string): { einladung: Einladung; roh: string } | null`
  - `mitEinladung(pfadUndSuche: string, e: Einladung): string`, `ohneEinladung(pfadUndSuche: string): string`
  - `einladungAusParametern(p: URLSearchParams, cloudHost: string): Einladung | 'kaputt' | null`
  - `interface KlickArt { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }`, `klickAbfangen(k: KlickArt): boolean`

- [ ] **Step 1: Write the failing test**

`web/test/einladung-link.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  istGueltigerCode,
  istGueltigerHost,
  zielHost,
  einladungAusUrl,
  ersteEinladungImText,
  mitEinladung,
  ohneEinladung,
  einladungAusParametern,
  klickAbfangen,
  type KlickArt
} from '../src/lib/einladung/einladungsLink.ts';

const CLOUD = 'https://howispulse.com';

test('Code-Form wie im Desktop-Deep-Link', () => {
  assert.equal(istGueltigerCode('abc12345'), true);
  assert.equal(istGueltigerCode('ab_c-12'), true);
  assert.equal(istGueltigerCode('abc12'), false);
  assert.equal(istGueltigerCode('abc12345.'), false);
  assert.equal(istGueltigerCode('a'.repeat(65)), false);
});

test('Host-Prüfung lehnt ab, woran Browser und Python verschieden lesen', () => {
  assert.equal(istGueltigerHost('pulse.beispiel-verein.de'), true);
  for (const h of [
    'evil.example\\@victim.example',
    'user@pulse.example.de',
    'pulse.example.de:8443',
    'pulse.example.de/pfad',
    '192.168.1.1',
    '0x7f.0.0.1',
    '0177.0.0.1',
    'localhost',
    ''
  ]) {
    assert.equal(istGueltigerHost(h), false, h);
  }
});

test('zielHost: Schreibweisen und Cloud', () => {
  assert.equal(zielHost('HTTPS://Pulse.Example.de/', CLOUD), 'pulse.example.de');
  assert.equal(zielHost('pulse.example.de', CLOUD), 'pulse.example.de');
  assert.equal(zielHost('howispulse.com', CLOUD), null);
  assert.equal(zielHost('https://HowIsPulse.com/', CLOUD), null);
  assert.equal(zielHost(null, CLOUD), null);
  assert.equal(zielHost('', CLOUD), null);
  assert.equal(zielHost('evil.example\\@victim.example', CLOUD), undefined);
});

test('einladungAusUrl: Cloud, Self-Host, host an beliebiger Stelle', () => {
  assert.deepEqual(einladungAusUrl('https://howispulse.com/invite/abc12345', CLOUD), {
    code: 'abc12345',
    host: null
  });
  assert.deepEqual(
    einladungAusUrl('https://howispulse.com/invite/abc12345?host=pulse.example.de', CLOUD),
    { code: 'abc12345', host: 'pulse.example.de' }
  );
  assert.deepEqual(
    einladungAusUrl('https://howispulse.com/invite/abc12345?ref=x&host=pulse.example.de', CLOUD),
    { code: 'abc12345', host: 'pulse.example.de' }
  );
  assert.deepEqual(einladungAusUrl('http://127.0.0.1:5173/invite/abc12345', CLOUD), {
    code: 'abc12345',
    host: null
  });
  assert.equal(
    einladungAusUrl(
      'https://howispulse.com/invite/abc12345?host=evil.example%5C%40victim.example',
      CLOUD
    ),
    null
  );
  assert.equal(einladungAusUrl('https://howispulse.com/c/designrunde', CLOUD), null);
  assert.equal(einladungAusUrl('https://howispulse.com/invite/abc12345/mehr', CLOUD), null);
  assert.equal(einladungAusUrl('javascript:alert(1)//invite/abc12345', CLOUD), null);
  assert.equal(einladungAusUrl('kein link', CLOUD), null);
});

test('ersteEinladungImText: Satzzeichen, Klammern, mehrere Links', () => {
  assert.equal(
    ersteEinladungImText('Kommst du? https://howispulse.com/invite/abc12345.', CLOUD)?.einladung
      .code,
    'abc12345'
  );
  assert.equal(
    ersteEinladungImText('(https://howispulse.com/invite/abc12345)', CLOUD)?.einladung.code,
    'abc12345'
  );
  assert.equal(
    ersteEinladungImText('https://example.org/x https://howispulse.com/invite/zzz99999', CLOUD)
      ?.einladung.code,
    'zzz99999'
  );
  assert.equal(
    ersteEinladungImText('  https://howispulse.com/invite/abc12345  ', CLOUD)?.roh,
    'https://howispulse.com/invite/abc12345'
  );
  assert.equal(ersteEinladungImText('nur Text', CLOUD), null);
});

test('mitEinladung / ohneEinladung lassen den Rest der Adresse stehen', () => {
  assert.equal(
    mitEinladung('/app/guilds/1/channels/2?x=1', { code: 'abc12345', host: null }),
    '/app/guilds/1/channels/2?x=1&einladung=abc12345'
  );
  assert.equal(
    mitEinladung('/app', { code: 'abc12345', host: 'pulse.example.de' }),
    '/app?einladung=abc12345&einladung_host=pulse.example.de'
  );
  assert.equal(ohneEinladung('/app?x=1&einladung=abc12345&einladung_host=a.b'), '/app?x=1');
  assert.equal(ohneEinladung('/app?einladung=abc12345'), '/app');
});

test('einladungAusParametern', () => {
  const p = (s: string) => new URLSearchParams(s);
  assert.equal(einladungAusParametern(p(''), CLOUD), null);
  assert.equal(einladungAusParametern(p('einladung=x'), CLOUD), 'kaputt');
  assert.equal(einladungAusParametern(p('einladung=abc12345&einladung_host=1.2.3.4'), CLOUD), 'kaputt');
  assert.deepEqual(einladungAusParametern(p('einladung=abc12345'), CLOUD), {
    code: 'abc12345',
    host: null
  });
  assert.deepEqual(
    einladungAusParametern(p('einladung=abc12345&einladung_host=howispulse.com'), CLOUD),
    { code: 'abc12345', host: null }
  );
});

test('klickAbfangen: nur der schlichte Linksklick', () => {
  const k = (teil: Partial<KlickArt>): KlickArt => ({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    ...teil
  });
  assert.equal(klickAbfangen(k({})), true);
  assert.equal(klickAbfangen(k({ ctrlKey: true })), false);
  assert.equal(klickAbfangen(k({ metaKey: true })), false);
  assert.equal(klickAbfangen(k({ shiftKey: true })), false);
  assert.equal(klickAbfangen(k({ altKey: true })), false);
  assert.equal(klickAbfangen(k({ button: 1 })), false);
  assert.equal(klickAbfangen(k({ defaultPrevented: true })), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test test/einladung-link.test.ts`
Expected: FAIL — `Cannot find module '…/einladungsLink.ts'`

- [ ] **Step 3: Write minimal implementation**

`web/src/lib/einladung/einladungsLink.ts`:

```ts
// Einladungslinks lesen und prüfen — importfrei (Node-Unit-Tests, CLAUDE.md).
//
// EINE Stelle für alle Leser: Nachrichtenanzeige (Karte + Klick), Beitritts-
// feld, Einladungsseite, Dialog, Deep-Link und gemerkte Einladung. Vorher
// hatte jede ihren eigenen Ausdruck, und sie widersprachen sich: MessageItem
// fand `host=` nur als ERSTEN Parameter, parseJoinInput überall.

export interface Einladung {
  code: string;
  /** Nackter FQDN eines Self-Hosts; null = Cloud. */
  host: string | null;
}

/** Code-Form wie `INVITE_CODE_RE` in desktop/electron/deeplink.ts. */
const CODE_RE = /^[A-Za-z0-9_-]{6,64}$/;

export function istGueltigerCode(code: string): boolean {
  return CODE_RE.test(code);
}

/** Maßstab von `isValidFqdn` (desktop/electron/deeplink.ts): mindestens ein
 *  Punkt, nur Label-Zeichen, keine IP in irgendeiner Schreibweise. Damit
 *  fallen auch Port, Userinfo (`@`), Backslash und Pfad heraus — genau die
 *  Zeichen, an denen Pythons `urlsplit` (Cloud) und `new URL` (Browser) einen
 *  Host verschieden lesen: `evil.example\@victim.example` ist für die Cloud
 *  `victim.example`, für den Browser `evil.example` (nachgemessen 2026-10-10). */
export function istGueltigerHost(host: string): boolean {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
  if (/(?:^|\.)0x[0-9a-f]+/i.test(host)) return false;
  if (/(?:^|\.)0\d+(?:\.|$)/.test(host)) return false;
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(host);
}

function nackt(roh: string): string {
  return roh.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/** Zielserver aus einem rohen `host`-Wert: null = Cloud (fehlt, leer oder der
 *  Cloud-Host selbst), undefined = ungültig (Einladung verwerfen). */
export function zielHost(roh: string | null, cloudHost: string): string | null | undefined {
  if (roh === null || roh.trim() === '') return null;
  const h = nackt(roh);
  if (h === nackt(cloudHost)) return null;
  return istGueltigerHost(h) ? h : undefined;
}

/** `…/invite/<code>[?…host=<fqdn>…]` aus einer absoluten URL. Der Origin
 *  zählt nicht: ein Cloud-Link bleibt ein Cloud-Link, wer ihn auch postet. */
export function einladungAusUrl(url: string, cloudHost: string): Einladung | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const m = u.pathname.match(/^\/invite\/([^/]+)\/?$/);
  if (!m || !istGueltigerCode(m[1])) return null;
  const host = zielHost(u.searchParams.get('host'), cloudHost);
  if (host === undefined) return null;
  return { code: m[1], host };
}

const LINK_RE = /https?:\/\/[^\s<>"]+/g;
/** Satzzeichen, die beim Schreiben am Link kleben („…/invite/abc.“, „(…)“). */
const NACHLAUF_RE = /[.,;:!?)\]}'"»]+$/;

/** Erste gültige Einladung in einem Nachrichtentext — für die Karte unter der
 *  Nachricht. `roh` ist der Link ohne angeklebte Satzzeichen. */
export function ersteEinladungImText(
  text: string,
  cloudHost: string
): { einladung: Einladung; roh: string } | null {
  for (const treffer of text.match(LINK_RE) ?? []) {
    const roh = treffer.replace(NACHLAUF_RE, '');
    const einladung = einladungAusUrl(roh, cloudHost);
    if (einladung) return { einladung, roh };
  }
  return null;
}

// Der Dialog in der App öffnet sich über Parameter an der AKTUELLEN Adresse —
// man bleibt, wo man war, und Zurück schließt ihn wieder.
const P_CODE = 'einladung';
const P_HOST = 'einladung_host';

export function mitEinladung(pfadUndSuche: string, e: Einladung): string {
  const u = new URL(pfadUndSuche, 'http://x');
  u.searchParams.set(P_CODE, e.code);
  if (e.host) u.searchParams.set(P_HOST, e.host);
  else u.searchParams.delete(P_HOST);
  return u.pathname + u.search + u.hash;
}

export function ohneEinladung(pfadUndSuche: string): string {
  const u = new URL(pfadUndSuche, 'http://x');
  u.searchParams.delete(P_CODE);
  u.searchParams.delete(P_HOST);
  return u.pathname + u.search + u.hash;
}

/** null = keine Einladung in der Adresse, 'kaputt' = eine, aber ungültig. */
export function einladungAusParametern(
  p: URLSearchParams,
  cloudHost: string
): Einladung | 'kaputt' | null {
  const code = p.get(P_CODE);
  if (code === null) return null;
  if (!istGueltigerCode(code)) return 'kaputt';
  const host = zielHost(p.get(P_HOST), cloudHost);
  return host === undefined ? 'kaputt' : { code, host };
}

export interface KlickArt {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

/** Nur der schlichte Linksklick wird zum Dialog. Strg/Cmd/Umschalt/Alt oder
 *  die mittlere Taste heißen „neuer Tab/neues Fenster“ — das bleibt so. */
export function klickAbfangen(k: KlickArt): boolean {
  return (
    !k.defaultPrevented && k.button === 0 && !k.metaKey && !k.ctrlKey && !k.shiftKey && !k.altKey
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test test/einladung-link.test.ts`
Expected: PASS, 8 Tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/einladung/einladungsLink.ts web/test/einladung-link.test.ts
git commit -m "feat(web): Einladungslinks an einer Stelle lesen und prüfen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Gemerkte Einladung

**Files:**
- Create: `web/src/lib/einladung/gemerkt.ts`
- Test: `web/test/einladung-gemerkt.test.ts`

**Interfaces:**
- Consumes: `Einladung`, `istGueltigerCode`, `istGueltigerHost` aus Task 1.
- Produces:
  - `type Speicher = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>`
  - `SPEICHER_SCHLUESSEL = 'pulse.einladung.gemerkt'`, `HALTBARKEIT_MS = 86_400_000`
  - `browserSpeicher(): Speicher | null`
  - `einladungMerken(s: Speicher | null, e: Einladung, jetzt: number): void`
  - `gemerkteEinladung(s: Speicher | null, jetzt: number): Einladung | null` (verwirft Ungültiges selbst)
  - `gemerkteEinladungVerwerfen(s: Speicher | null): void`

- [ ] **Step 1: Write the failing test**

`web/test/einladung-gemerkt.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  einladungMerken,
  gemerkteEinladung,
  gemerkteEinladungVerwerfen,
  SPEICHER_SCHLUESSEL,
  HALTBARKEIT_MS,
  type Speicher
} from '../src/lib/einladung/gemerkt.ts';

function speicher(): Speicher & { daten: Map<string, string> } {
  const daten = new Map<string, string>();
  return {
    daten,
    getItem: (k) => daten.get(k) ?? null,
    setItem: (k, v) => void daten.set(k, v),
    removeItem: (k) => void daten.delete(k)
  };
}

const T0 = 1_760_000_000_000;

test('merken und wieder lesen', () => {
  const s = speicher();
  einladungMerken(s, { code: 'abc12345', host: 'pulse.example.de' }, T0);
  assert.deepEqual(gemerkteEinladung(s, T0 + 1000), { code: 'abc12345', host: 'pulse.example.de' });
});

test('verfällt nach 24 Stunden und wird dabei gelöscht', () => {
  const s = speicher();
  einladungMerken(s, { code: 'abc12345', host: null }, T0);
  assert.equal(gemerkteEinladung(s, T0 + HALTBARKEIT_MS), null);
  assert.equal(s.daten.has(SPEICHER_SCHLUESSEL), false);
});

test('Zeitstempel in der Zukunft gilt nicht (Uhr verstellt)', () => {
  const s = speicher();
  einladungMerken(s, { code: 'abc12345', host: null }, T0 + 60_000);
  assert.equal(gemerkteEinladung(s, T0), null);
});

test('kaputte oder manipulierte Einträge werden verworfen', () => {
  for (const roh of [
    'kein json',
    'null',
    '"text"',
    JSON.stringify({ code: 'x', host: null, gemerktAm: T0 }),
    JSON.stringify({ code: 'abc12345', host: 'evil.example\\@victim.example', gemerktAm: T0 }),
    JSON.stringify({ code: 'abc12345', host: 7, gemerktAm: T0 }),
    JSON.stringify({ code: 'abc12345', host: null, gemerktAm: 'gestern' })
  ]) {
    const s = speicher();
    s.daten.set(SPEICHER_SCHLUESSEL, roh);
    assert.equal(gemerkteEinladung(s, T0), null, roh);
    assert.equal(s.daten.has(SPEICHER_SCHLUESSEL), false, roh);
  }
});

test('ein Speicher, der wirft, bricht nichts', () => {
  const wirft: Speicher = {
    getItem: () => {
      throw new Error('gesperrt');
    },
    setItem: () => {
      throw new Error('voll');
    },
    removeItem: () => {
      throw new Error('gesperrt');
    }
  };
  einladungMerken(wirft, { code: 'abc12345', host: null }, T0);
  assert.equal(gemerkteEinladung(wirft, T0), null);
  gemerkteEinladungVerwerfen(wirft);
  assert.equal(gemerkteEinladung(null, T0), null);
});

test('verwerfen löscht', () => {
  const s = speicher();
  einladungMerken(s, { code: 'abc12345', host: null }, T0);
  gemerkteEinladungVerwerfen(s);
  assert.equal(gemerkteEinladung(s, T0), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test test/einladung-gemerkt.test.ts`
Expected: FAIL — Modul fehlt.

- [ ] **Step 3: Write minimal implementation**

`web/src/lib/einladung/gemerkt.ts`:

```ts
// Gemerkte Einladung — der Rückweg nach Anmeldung, Registrierung und
// E-Mail-Bestätigung. Importfrei bis auf den Nachbarn (Node-Unit-Tests).
//
// Warum nicht über die Adresse (`/login?redirect=…`): die Registrierung führt
// nach /app, das App-Layout von dort zur Sperrseite „E-Mail bestätigen“, und
// der Bestätigungslink wieder nach /app. Auf jedem dieser Wege ginge der
// Zusammenhang verloren. Der Eintrag im Browser übersteht alle drei, und das
// App-Layout greift ihn auf, sobald der Nutzer angemeldet und bestätigt ist.
import { istGueltigerCode, istGueltigerHost, type Einladung } from './einladungsLink.ts';

export const SPEICHER_SCHLUESSEL = 'pulse.einladung.gemerkt';
export const HALTBARKEIT_MS = 24 * 60 * 60 * 1000;

export type Speicher = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** localStorage, oder null, wenn schon der Zugriff wirft (Privatmodus,
 *  gesperrte Website-Daten). Ohne Speicher fällt nur der Rückweg weg. */
export function browserSpeicher(): Speicher | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function einladungMerken(s: Speicher | null, e: Einladung, jetzt: number): void {
  if (!s) return;
  try {
    s.setItem(SPEICHER_SCHLUESSEL, JSON.stringify({ code: e.code, host: e.host, gemerktAm: jetzt }));
  } catch {
    /* voll oder gesperrt — dann eben ohne Rückweg */
  }
}

export function gemerkteEinladungVerwerfen(s: Speicher | null): void {
  if (!s) return;
  try {
    s.removeItem(SPEICHER_SCHLUESSEL);
  } catch {
    /* gesperrt — es gibt nichts zu tun */
  }
}

/** Die gemerkte Einladung, geprüft wie ein frischer Link. Alles Ungültige
 *  (kaputt, fremd, abgelaufen, aus der Zukunft) wird dabei gelöscht. */
export function gemerkteEinladung(s: Speicher | null, jetzt: number): Einladung | null {
  if (!s) return null;
  let roh: string | null;
  try {
    roh = s.getItem(SPEICHER_SCHLUESSEL);
  } catch {
    return null;
  }
  if (roh === null) return null;
  const e = lesen(roh, jetzt);
  if (!e) gemerkteEinladungVerwerfen(s);
  return e;
}

function lesen(roh: string, jetzt: number): Einladung | null {
  let d: unknown;
  try {
    d = JSON.parse(roh);
  } catch {
    return null;
  }
  if (typeof d !== 'object' || d === null) return null;
  const { code, host, gemerktAm } = d as Record<string, unknown>;
  if (typeof code !== 'string' || !istGueltigerCode(code)) return null;
  if (host !== null && (typeof host !== 'string' || !istGueltigerHost(host))) return null;
  if (typeof gemerktAm !== 'number') return null;
  const alter = jetzt - gemerktAm;
  if (!(alter >= 0 && alter < HALTBARKEIT_MS)) return null;
  return { code, host };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test test/einladung-gemerkt.test.ts`
Expected: PASS, 6 Tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/einladung/gemerkt.ts web/test/einladung-gemerkt.test.ts
git commit -m "feat(web): gemerkte Einladung als Rückweg nach Anmeldung und Bestätigung

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Fehler einordnen

**Files:**
- Create: `web/src/lib/einladung/fehlertext.ts`
- Test: `web/test/einladung-fehlertext.test.ts`

**Interfaces:**
- Produces: `type EinladungFehler = 'ungueltig' | 'email' | 'ausgeschlossen' | 'gesperrt' | 'voll' | 'bremse' | 'abgelehnt' | 'netz'`, `einladungFehler(status: number | null, detail: unknown): EinladungFehler`

- [ ] **Step 1: Write the failing test**

`web/test/einladung-fehlertext.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { einladungFehler } from '../src/lib/einladung/fehlertext.ts';

// Die `detail`-Texte sind die Schnittstelle zum chat-gateway:
// routes/invites.py, guild_caps.py, dcc_shared/token_verify.py.
test('jede Antwort des Servers bekommt ihre eigene Art', () => {
  assert.equal(einladungFehler(404, 'invite invalid or expired'), 'ungueltig');
  assert.equal(einladungFehler(403, 'email verification required'), 'email');
  assert.equal(einladungFehler(403, 'you are banned from this server'), 'ausgeschlossen');
  assert.equal(einladungFehler(403, 'community is suspended'), 'gesperrt');
  assert.equal(einladungFehler(403, 'community member_cap limit reached (50/50)'), 'voll');
  assert.equal(einladungFehler(403, 'join_not_permitted'), 'abgelehnt');
  assert.equal(einladungFehler(429, 'zu viele Anfragen'), 'bremse');
});

test('alles andere ist ein Netz- oder Serverproblem, nie „ungültig“', () => {
  assert.equal(einladungFehler(null, undefined), 'netz');
  assert.equal(einladungFehler(500, 'boom'), 'netz');
  assert.equal(einladungFehler(502, null), 'netz');
  assert.equal(einladungFehler(403, { error: 'x' }), 'abgelehnt');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test test/einladung-fehlertext.test.ts`
Expected: FAIL — Modul fehlt.

- [ ] **Step 3: Write minimal implementation**

`web/src/lib/einladung/fehlertext.ts`:

```ts
// Ordnet eine Server-Antwort einer Fehlerart zu — importfrei (Node-Tests).
//
// Nur ein 404 heißt „Diese Einladung gilt nicht mehr“. Der Prototyp machte
// aus jedem Fehler „ungültig“ — auch aus einem Netzaussetzer und aus der
// E-Mail-Sperre, die den GANZEN chat-gateway für unbestätigte Konten mit 403
// schließt (dcc_shared/token_verify.py).

export type EinladungFehler =
  | 'ungueltig'
  | 'email'
  | 'ausgeschlossen'
  | 'gesperrt'
  | 'voll'
  | 'bremse'
  | 'abgelehnt'
  | 'netz';

export function einladungFehler(status: number | null, detail: unknown): EinladungFehler {
  const d = typeof detail === 'string' ? detail : '';
  if (status === 404) return 'ungueltig';
  if (status === 429) return 'bremse';
  if (status === 403) {
    if (d === 'email verification required') return 'email';
    if (d === 'you are banned from this server') return 'ausgeschlossen';
    if (d === 'community is suspended') return 'gesperrt';
    if (/^community \S+ limit reached/.test(d)) return 'voll';
    return 'abgelehnt';
  }
  return 'netz';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test test/einladung-fehlertext.test.ts`
Expected: PASS, 2 Tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/einladung/fehlertext.ts web/test/einladung-fehlertext.test.ts
git commit -m "feat(web): Fehlerarten für Einladungen statt pauschal „ungültig“

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Texte, Karte und Lader

**Files:**
- Modify: `web/messages/de.json`, `web/messages/en.json`
- Create (ersetzt den Prototyp): `web/src/lib/einladung/EinladungKarte.svelte`, `web/src/lib/einladung/laden.ts`

**Interfaces:**
- Consumes: `Einladung` (Task 1), `EinladungFehler`, `einladungFehler` (Task 3).
- Produces:
  - `EinladungKarte.svelte`: `type EinladungZustand = 'laden' | 'einladung' | 'abgemeldet' | 'email' | 'mitglied' | 'ungueltig' | 'fehler'`, `interface EinladungCommunity { name: string; iconUrl: string | null; mitglieder: number | null }`. Props: `zustand`, `community?`, `host?`, `rahmen?: 'karte' | 'dialog'`, `hinweis?: string | null`, `busy?`, `appKnopf?`, `appGeoeffnet?`, `downloadUrl?: string | null`, Callbacks `onBeitreten`, `onOeffnen`, `onAnmelden`, `onRegistrieren`, `onEmail`, `onApp`, `onZuPulse`, `onErneut`. `data-testid`s: `einladung-karte` (mit `data-zustand`), `einladung-name`, `einladung-host`, `einladung-beitreten`, `einladung-oeffnen`, `einladung-anmelden`, `einladung-registrieren`, `einladung-email`, `einladung-erneut`, `einladung-zu-pulse`, `einladung-hinweis`, `einladung-app`.
  - `laden.ts`: `interface GeladeneEinladung { zustand: EinladungZustand; community: EinladungCommunity | null; guildId: string | null; fehler: EinladungFehler | null }`, `ladeEinladung(e: Einladung): Promise<GeladeneEinladung>`, `ladeEinladungAbgemeldet(e: Einladung): Promise<GeladeneEinladung>`, `type BeitrittsErgebnis = { art: 'ok' } | { art: 'rueckfrage' } | { art: 'fehler'; fehler: EinladungFehler }`, `einladungAnnehmen(e: Einladung, bestaetigt: boolean): Promise<BeitrittsErgebnis>`, `fehlerAus(e: unknown): EinladungFehler`, `fehlerMeldung(f: EinladungFehler, host: string | null): string`.

- [ ] **Step 0: Prototyp aus dem Weg räumen**

Der Prototyp (nicht committet) greift auf Exporte zu, die dieser Task ersetzt, und hielte `pnpm check` bis Task 6 rot. Seite und Dialog kommen in Task 5 und 6 neu.

```bash
rm -f "web/src/routes/invite/[code]/+page.svelte" web/src/lib/einladung/EinladungDialog.svelte
git checkout -- web/src/routes/app/+layout.svelte
git status --short
```

Expected: nur noch `?? web/src/lib/einladung/` (Karte und Lader des Prototyps, die dieser Task überschreibt) und die Dateien aus Task 1–3, falls noch nicht committet.

- [ ] **Step 1: Texte in beide Kataloge eintragen**

Run (aus dem Repo-Root):

```bash
python3 - <<'EOF'
import json, re
neu = {
 "einladung_eyebrow": ("Du wurdest eingeladen", "You've been invited"),
 "einladung_titel_unbekannt": ("Eine Community wartet auf dich", "A community is waiting for you"),
 "einladung_titel_selfhost": ("Community auf eigenem Server", "Community on its own server"),
 "einladung_selfhost_hinweis": ("Beim ersten Beitritt fragt Pulse einmal nach, ob du diesen Server kontaktieren möchtest.", "The first time you join, Pulse asks once whether you want to contact this server."),
 "einladung_beitreten": ("Beitreten", "Join"),
 "einladung_beitreten_laeuft": ("Trete bei …", "Joining …"),
 "einladung_schon_mitglied": ("Du bist schon Mitglied.", "You're already a member."),
 "einladung_oeffnen": ("Community öffnen", "Open community"),
 "einladung_anmelden": ("Anmelden", "Sign in"),
 "einladung_registrieren": ("Konto erstellen", "Create account"),
 "einladung_anmelden_hinweis": ("Nach der Anmeldung kommst du direkt zu dieser Einladung zurück.", "After signing in you'll come straight back to this invitation."),
 "einladung_app_oeffnen": ("In der Desktop-App öffnen", "Open in the desktop app"),
 "einladung_app_hinweis": ("Pulse wird geöffnet. Passiert nichts, ist die App nicht installiert. Dann tritt einfach hier im Browser bei.", "Opening Pulse. If nothing happens, the app isn't installed. Just join here in the browser instead."),
 "einladung_app_download": ("Pulse herunterladen", "Download Pulse"),
 "einladung_email_titel": ("Bestätige zuerst deine E-Mail-Adresse", "Confirm your email address first"),
 "einladung_email_text": ("Danach geht es direkt mit dieser Einladung weiter.", "Then you'll continue right here with this invitation."),
 "einladung_email_knopf": ("E-Mail bestätigen", "Confirm email"),
 "einladung_ungueltig_titel": ("Diese Einladung gilt nicht mehr", "This invitation is no longer valid"),
 "einladung_ungueltig_text": ("Sie ist abgelaufen, wurde zurückgezogen oder schon aufgebraucht. Frag die Person, die dich eingeladen hat, nach einem neuen Link.", "It has expired, was revoked or has already been used up. Ask the person who invited you for a new link."),
 "einladung_zu_pulse": ("Zu Pulse", "Go to Pulse"),
 "einladung_fehler_titel": ("Die Einladung konnte nicht geladen werden", "The invitation couldn't be loaded"),
 "einladung_fehler_netz": ("Keine Verbindung. Versuch es gleich noch einmal.", "No connection. Try again in a moment."),
 "einladung_fehler_server": ("Der Server ist gerade nicht erreichbar.", "The server can't be reached right now."),
 "einladung_fehler_bremse": ("Zu viele Versuche. Warte einen Moment.", "Too many attempts. Wait a moment."),
 "einladung_fehler_ausgeschlossen": ("Du kannst dieser Community nicht beitreten.", "You can't join this community."),
 "einladung_fehler_gesperrt": ("Diese Community ist zurzeit gesperrt.", "This community is currently suspended."),
 "einladung_fehler_voll": ("Diese Community hat keinen Platz mehr.", "This community is full."),
 "einladung_fehler_abgelehnt": ("Der Beitritt wurde abgelehnt.", "Joining was refused."),
 "einladung_erneut": ("Erneut versuchen", "Try again"),
 "einladung_dialog_titel": ("Einladung", "Invitation"),
 "einladung_seitentitel": ("Einladung · Pulse", "Invitation · Pulse"),
 "einladung_seitentitel_name": ("Einladung zu {name} · Pulse", "Invitation to {name} · Pulse"),
 "einladung_host_ungueltig": ("Die Server-Adresse in diesem Link ist ungültig.", "The server address in this link is invalid."),
}
for i, lang in enumerate(("de", "en")):
    p = f"web/messages/{lang}.json"
    s = open(p, encoding="utf-8").read()
    daten = json.loads(s)
    assert not (set(neu) & set(daten)), set(neu) & set(daten)
    block = "".join(f'  {json.dumps(k)}: {json.dumps(v[i], ensure_ascii=False)},\n' for k, v in neu.items())
    anker = re.search(r'^  "invite_embed_member_count_one": .*\n', s, re.M)
    assert anker
    s = s[:anker.end()] + block + s[anker.end():]
    json.loads(s)
    open(p, "w", encoding="utf-8").write(s)
print("ok")
EOF
```

Expected: `ok`. (Der Anker `invite_embed_member_count_one` existiert seit `fc5dc32b`.)

- [ ] **Step 2: Karte schreiben**

`web/src/lib/einladung/EinladungKarte.svelte` (ersetzt den Prototyp vollständig):

```svelte
<!--
  Inhalt einer Community-Einladung — dieselbe Karte auf der Einladungsseite
  (/invite/<code>, Einstieg von außen) und im Dialog in der App (Link im Chat,
  Deep-Link aus dem Browser). Rein darstellend: Daten und Aktionen kommen als
  Props, damit Seite und Dialog gleich aussehen, ohne die Ladelogik zu doppeln.
-->
<script lang="ts" module>
  export type EinladungZustand =
    | 'laden'
    | 'einladung'
    | 'abgemeldet'
    | 'email'
    | 'mitglied'
    | 'ungueltig'
    | 'fehler';
  export interface EinladungCommunity {
    name: string;
    iconUrl: string | null;
    mitglieder: number | null;
  }
</script>

<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import ServerIcon from '@lucide/svelte/icons/server';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import LinkOffIcon from '@lucide/svelte/icons/unlink';
  import WifiOffIcon from '@lucide/svelte/icons/wifi-off';
  import MailIcon from '@lucide/svelte/icons/mail';
  import { anfangsBuchstabe } from '$lib/utils/anfangsBuchstabe';
  import { m } from '$lib/paraglide/messages.js';

  let {
    zustand,
    community = null,
    host = null,
    rahmen = 'karte',
    hinweis = null,
    busy = false,
    appKnopf = false,
    appGeoeffnet = false,
    downloadUrl = null,
    onBeitreten,
    onOeffnen,
    onAnmelden,
    onRegistrieren,
    onEmail,
    onApp,
    onZuPulse,
    onErneut
  }: {
    zustand: EinladungZustand;
    community?: EinladungCommunity | null;
    /** FQDN des Self-Hosts; null = Cloud. */
    host?: string | null;
    rahmen?: 'karte' | 'dialog';
    /** Fehlertext (Zustand 'fehler') bzw. gescheiterter Beitritt. */
    hinweis?: string | null;
    busy?: boolean;
    /** „In der Desktop-App öffnen“ — nur im Browser am Rechner. */
    appKnopf?: boolean;
    appGeoeffnet?: boolean;
    downloadUrl?: string | null;
    onBeitreten?: () => void;
    onOeffnen?: () => void;
    onAnmelden?: () => void;
    onRegistrieren?: () => void;
    onEmail?: () => void;
    onApp?: () => void;
    onZuPulse?: () => void;
    onErneut?: () => void;
  } = $props();

  const titel = $derived(
    community?.name ?? (host ? m.einladung_titel_selfhost() : m.einladung_titel_unbekannt())
  );
  const mitgliederText = $derived(
    community?.mitglieder == null
      ? null
      : community.mitglieder === 1
        ? m.invite_embed_member_count_one({ count: 1 })
        : m.invite_embed_member_count({ count: community.mitglieder })
  );
  const zuPulseText = $derived(
    rahmen === 'dialog' ? m.invite_dialog_close_btn() : m.einladung_zu_pulse()
  );
</script>

<div
  class={rahmen === 'karte'
    ? 'bg-card border-border/60 flex w-full max-w-md flex-col items-center gap-6 rounded-xl border p-8 text-center shadow-2xl'
    : 'flex flex-col items-center gap-6 text-center'}
  data-testid="einladung-karte"
  data-zustand={zustand}
>
  {#if zustand === 'laden'}
    <div class="bg-bg-hover size-20 animate-pulse rounded-full"></div>
    <div class="flex w-full flex-col items-center gap-2">
      <div class="bg-bg-hover h-6 w-40 animate-pulse rounded"></div>
      <div class="bg-bg-hover h-4 w-24 animate-pulse rounded"></div>
    </div>
    <div class="bg-bg-hover h-9 w-full animate-pulse rounded-md"></div>
  {:else if zustand === 'ungueltig' || zustand === 'fehler'}
    <div class="bg-bg-hover text-text-muted flex size-16 items-center justify-center rounded-full">
      {#if zustand === 'ungueltig'}<LinkOffIcon class="size-7" />{:else}<WifiOffIcon class="size-7" />{/if}
    </div>
    <div class="flex flex-col gap-2">
      <h1 class="text-card-foreground text-xl font-semibold">
        {zustand === 'ungueltig' ? m.einladung_ungueltig_titel() : m.einladung_fehler_titel()}
      </h1>
      <p class="text-muted-foreground text-sm" data-testid="einladung-hinweis">
        {zustand === 'ungueltig' ? m.einladung_ungueltig_text() : hinweis}
      </p>
    </div>
    <div class="flex w-full flex-col gap-2">
      {#if zustand === 'fehler'}
        <Button class="w-full" onclick={onErneut} data-testid="einladung-erneut">
          {m.einladung_erneut()}
        </Button>
      {/if}
      <Button variant="outline" class="w-full" onclick={onZuPulse} data-testid="einladung-zu-pulse">
        {zuPulseText}
      </Button>
    </div>
  {:else if zustand === 'email'}
    <div class="bg-primary/15 text-primary flex size-16 items-center justify-center rounded-full">
      <MailIcon class="size-7" />
    </div>
    <div class="flex flex-col gap-2">
      <h1 class="text-card-foreground text-xl font-semibold">{m.einladung_email_titel()}</h1>
      <p class="text-muted-foreground text-sm">{m.einladung_email_text()}</p>
    </div>
    <Button class="w-full" onclick={onEmail} data-testid="einladung-email">
      {m.einladung_email_knopf()}
    </Button>
  {:else}
    <p class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
      {m.einladung_eyebrow()}
    </p>

    {#if !community && host}
      <div class="bg-primary/15 text-primary flex size-20 items-center justify-center rounded-full">
        <ServerIcon class="size-9" />
      </div>
    {:else if community}
      <Avatar.Root class="size-20">
        {#if community.iconUrl}
          <Avatar.Image src={community.iconUrl} alt="" />
        {/if}
        <Avatar.Fallback class="accent-gradient text-primary-foreground text-2xl font-semibold">
          {anfangsBuchstabe(community.name)}
        </Avatar.Fallback>
      </Avatar.Root>
    {:else}
      <img src="/pulse-mark.svg" alt="Pulse" width="80" height="80" class="size-20" />
    {/if}

    <div class="flex flex-col items-center gap-2">
      <h1 class="text-card-foreground text-2xl font-semibold" data-testid="einladung-name">{titel}</h1>
      {#if mitgliederText}
        <p class="text-muted-foreground text-sm">{mitgliederText}</p>
      {/if}
      {#if host}
        <span
          class="bg-primary/15 text-primary inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold"
          data-testid="einladung-host"
        >
          <ServerIcon class="size-3.5 shrink-0" />
          <span class="truncate">{host}</span>
        </span>
      {/if}
    </div>

    {#if host && zustand === 'einladung'}
      <p class="text-muted-foreground text-xs">{m.einladung_selfhost_hinweis()}</p>
    {/if}

    <div class="flex w-full flex-col gap-2">
      {#if zustand === 'einladung'}
        <Button class="w-full" onclick={onBeitreten} disabled={busy} data-testid="einladung-beitreten">
          {busy ? m.einladung_beitreten_laeuft() : m.einladung_beitreten()}
        </Button>
      {:else if zustand === 'mitglied'}
        <p class="text-muted-foreground pb-1 text-sm">{m.einladung_schon_mitglied()}</p>
        <Button class="w-full" onclick={onOeffnen} data-testid="einladung-oeffnen">
          {m.einladung_oeffnen()}
        </Button>
      {:else if zustand === 'abgemeldet'}
        <Button class="w-full" onclick={onAnmelden} data-testid="einladung-anmelden">
          {m.einladung_anmelden()}
        </Button>
        <Button variant="outline" class="w-full" onclick={onRegistrieren} data-testid="einladung-registrieren">
          {m.einladung_registrieren()}
        </Button>
      {/if}
      {#if appKnopf}
        <Button variant="ghost" class="w-full" onclick={onApp} data-testid="einladung-app">
          <MonitorIcon class="size-4" />
          {m.einladung_app_oeffnen()}
        </Button>
      {/if}
    </div>

    {#if hinweis}
      <p class="text-destructive text-sm" role="alert" data-testid="einladung-hinweis">{hinweis}</p>
    {/if}
    {#if appGeoeffnet}
      <p class="bg-bg-input border-border text-muted-foreground w-full rounded-lg border px-3 py-2 text-xs">
        {m.einladung_app_hinweis()}
        {#if downloadUrl}
          <a class="text-primary font-semibold underline-offset-2 hover:underline" href={downloadUrl}>
            {m.einladung_app_download()}
          </a>
        {/if}
      </p>
    {:else if zustand === 'abgemeldet'}
      <p class="text-muted-foreground text-xs">{m.einladung_anmelden_hinweis()}</p>
    {/if}
  {/if}
</div>
```

- [ ] **Step 3: Lader schreiben**

`web/src/lib/einladung/laden.ts` (ersetzt den Prototyp vollständig):

```ts
// Lädt und löst ein, was die Einladungskarte zeigt — gemeinsam für die Seite
// /invite/<code> und den Dialog in der App.
//
// Cloud-Einladungen gehen AUSDRÜCKLICH an die Cloud, nie an den aktiven
// Server: ist gerade ein Self-Host aktiv, kennt der den Cloud-Code nicht und
// meldete fälschlich „ungültig“.
import { ApiError } from '$lib/api/client';
import { chatApi } from '$lib/api/chat';
import { getInvitePreviewOn, SelfHostContactConfirmRequired } from '$lib/api/add-server-flow';
import type { InvitePreview } from '$lib/api/types';
import { serversStore } from '$lib/api/servers.svelte';
import { guilds } from '$lib/stores/guilds.svelte';
import { serverGuilds } from '$lib/stores/serverGuilds.svelte';
import { guildIconSrc } from '$lib/guildIcon';
import { joinGuildByInvite } from '$lib/guilds/joinByInvite';
import { m } from '$lib/paraglide/messages.js';
import type { EinladungCommunity, EinladungZustand } from './EinladungKarte.svelte';
import type { Einladung } from './einladungsLink';
import { einladungFehler, type EinladungFehler } from './fehlertext';

export interface GeladeneEinladung {
  zustand: EinladungZustand;
  community: EinladungCommunity | null;
  guildId: string | null;
  fehler: EinladungFehler | null;
}

const LEER = { community: null, guildId: null, fehler: null } as const;

export function fehlerAus(e: unknown): EinladungFehler {
  if (e instanceof ApiError) {
    const body = e.body as { detail?: unknown } | null;
    return einladungFehler(e.status, body?.detail);
  }
  return 'netz';
}

export function fehlerMeldung(f: EinladungFehler, host: string | null): string {
  switch (f) {
    case 'ungueltig':
      return m.einladung_ungueltig_titel();
    case 'email':
      return m.einladung_email_titel();
    case 'ausgeschlossen':
      return m.einladung_fehler_ausgeschlossen();
    case 'gesperrt':
      return m.einladung_fehler_gesperrt();
    case 'voll':
      return m.einladung_fehler_voll();
    case 'bremse':
      return m.einladung_fehler_bremse();
    case 'abgelehnt':
      return m.einladung_fehler_abgelehnt();
    case 'netz':
      return host ? m.einladung_fehler_server() : m.einladung_fehler_netz();
  }
}

function alsCommunity(p: InvitePreview, origin: string): EinladungCommunity {
  return {
    name: p.guild.name,
    iconUrl: guildIconSrc(p.guild.icon_url, origin),
    mitglieder: p.member_count
  };
}

function cloudVorschau(code: string): Promise<InvitePreview> {
  const cloudId = serversStore.cloudId();
  return cloudId ? getInvitePreviewOn(code, { serverId: cloudId }) : chatApi.getInvitePreview(code);
}

/** Für angemeldete, bestätigte Nutzer. */
export async function ladeEinladung(e: Einladung): Promise<GeladeneEinladung> {
  if (e.host) {
    // Self-Host: Vorschau nur, wenn wir dort schon eine Sitzung haben. Einen
    // UNBEKANNTEN Server fragen wir vor der Zustimmung nicht — er sähe sonst
    // die IP-Adresse, bevor der Nutzer zugestimmt hat (Spec, Sicherheit 2).
    const srv = serversStore.findByHostname(e.host);
    if (!srv) return { zustand: 'einladung', ...LEER };
    try {
      const p = await getInvitePreviewOn(e.code, { serverId: srv.id });
      await serverGuilds.ensureLoaded(srv.id);
      const mitglied = serverGuilds.get(srv.id).some((g) => g.id === p.guild.id);
      return {
        zustand: mitglied ? 'mitglied' : 'einladung',
        community: alsCommunity(p, srv.hostname),
        guildId: p.guild.id,
        fehler: null
      };
    } catch (err) {
      // Nur ein 404 ist endgültig; sonst bleibt der Beitritt versuchbar.
      if (fehlerAus(err) === 'ungueltig') return { zustand: 'ungueltig', ...LEER };
      return { zustand: 'einladung', ...LEER };
    }
  }

  try {
    const p = await cloudVorschau(e.code);
    await guilds.hydrate().catch(() => {});
    return {
      zustand: guilds.byId[p.guild.id] ? 'mitglied' : 'einladung',
      community: alsCommunity(p, window.location.origin),
      guildId: p.guild.id,
      fehler: null
    };
  } catch (err) {
    const f = fehlerAus(err);
    if (f === 'ungueltig') return { zustand: 'ungueltig', ...LEER };
    if (f === 'email') return { zustand: 'email', ...LEER };
    return { zustand: 'fehler', community: null, guildId: null, fehler: f };
  }
}

/** Für Abgemeldete. Ohne anonyme Vorschau (Etappe 2) gibt es keinen Namen. */
export async function ladeEinladungAbgemeldet(_e: Einladung): Promise<GeladeneEinladung> {
  return { zustand: 'abgemeldet', ...LEER };
}

export type BeitrittsErgebnis =
  | { art: 'ok' }
  | { art: 'rueckfrage' }
  | { art: 'fehler'; fehler: EinladungFehler };

/** Eingabe für joinGuildByInvite — dieselbe Form, die InviteEmbed baut. */
function beitrittsEingabe(e: Einladung): string {
  return e.host ? `https://app/invite/${e.code}?host=${encodeURIComponent(e.host)}` : e.code;
}

/** Tritt bei. Bei 'ok' hat joinGuildByInvite schon in die Community navigiert. */
export async function einladungAnnehmen(
  e: Einladung,
  bestaetigt: boolean
): Promise<BeitrittsErgebnis> {
  try {
    await joinGuildByInvite(beitrittsEingabe(e), bestaetigt);
    return { art: 'ok' };
  } catch (err) {
    if (err instanceof SelfHostContactConfirmRequired) return { art: 'rueckfrage' };
    return { art: 'fehler', fehler: fehlerAus(err) };
  }
}
```

- [ ] **Step 4: Typprüfung**

Run: `cd web && pnpm check 2>&1 | tail -3`
Expected: `0 ERRORS 0 WARNINGS`.

- [ ] **Step 5: Commit**

```bash
git add web/messages/de.json web/messages/en.json web/src/lib/einladung/EinladungKarte.svelte web/src/lib/einladung/laden.ts
git commit -m "feat(web): Einladungskarte und Lader mit eigenen Fehlertexten

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Die Seite `/invite/<code>`

**Files:**
- Create: `web/src/lib/components/AuthBuehne.svelte`
- Modify: `web/src/routes/login/+page.svelte:210-225` (die beiden Hintergrund-`div`s)
- Create (ersetzt den Prototyp): `web/src/routes/invite/[code]/+page.svelte`

**Interfaces:**
- Consumes: Task 1 (`einladungAusUrl`, `Einladung`), Task 2 (`browserSpeicher`, `einladungMerken`, `gemerkteEinladungVerwerfen`), Task 4 (Karte, `ladeEinladung`, `ladeEinladungAbgemeldet`, `einladungAnnehmen`, `fehlerMeldung`).
- Produces: Route `/invite/[code]`; `AuthBuehne.svelte` ohne Props.

- [ ] **Step 1: Bühne herauslösen**

`web/src/lib/components/AuthBuehne.svelte`:

```svelte
<!--
  Hintergrund der Anmelde- und der Einladungsseite: durchgehender Verlauf plus
  atmende Glow-Blobs über die GANZE Fläche (sonst wirkt nur eine Hälfte
  glühend). Nur nicht-handy — am Handy bleibt der Standard-Seitengrund. Der
  Elternknoten braucht `relative` und `overflow-hidden`.
-->
<div
  class="pointer-events-none absolute inset-0 -z-10 hidden nicht-handy:block"
  style="background: linear-gradient(150deg, #0e1f3a, #0a1525 60%, #08130c);"
></div>
<div
  class="pointer-events-none absolute inset-0 -z-10 hidden motion-safe:animate-blob-breathe nicht-handy:block"
  style="background:
    radial-gradient(520px 380px at 22% 20%, rgba(59,130,246,.22), transparent 60%),
    radial-gradient(560px 400px at 82% 88%, rgba(16,185,129,.16), transparent 60%);"
></div>
```

In `web/src/routes/login/+page.svelte` die beiden Hintergrund-`div`s samt ihren zwei Kommentaren (direkt unter `<div class="relative flex min-h-dvh overflow-hidden">`) durch `<AuthBuehne />` ersetzen und im Skript `import AuthBuehne from '$lib/components/AuthBuehne.svelte';` ergänzen. Verhalten unverändert.

- [ ] **Step 2: Seite schreiben**

`web/src/routes/invite/[code]/+page.svelte`:

```svelte
<!--
  /invite/<code>[?host=<fqdn>] — Einstieg über einen verschickten Einladungslink.

  Bis 2026-06-08 gab es diese Route, dann fiel sie beim Umbau auf Freundes-
  Einladungen weg (be72dedf), während „Link teilen“ (inviteLink.ts) diese
  Adresse seit 2026-07-13 wieder erzeugt — jeder Klick endete auf der
  Fehlerseite. Spec: docs/superpowers/specs/2026-10-10-einladungsseite-design.md

  Steht AUSSERHALB von /app (wie /c/<handle>): wer abgemeldet ist, soll die
  Einladung sehen, statt von der Anmelde-Wache weggeschickt zu werden. Der
  Rückweg nach Anmelden/Registrieren/Bestätigen läuft über die gemerkte
  Einladung (lib/einladung/gemerkt.ts), nicht über die Adresse.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
  import AuthBuehne from '$lib/components/AuthBuehne.svelte';
  import SelfHostContactConfirmDialog from '$lib/components/server/SelfHostContactConfirmDialog.svelte';
  import EinladungKarte, {
    type EinladungCommunity,
    type EinladungZustand
  } from '$lib/einladung/EinladungKarte.svelte';
  import { einladungAusUrl, type Einladung } from '$lib/einladung/einladungsLink';
  import {
    browserSpeicher,
    einladungMerken,
    gemerkteEinladungVerwerfen
  } from '$lib/einladung/gemerkt';
  import {
    einladungAnnehmen,
    fehlerMeldung,
    ladeEinladung,
    ladeEinladungAbgemeldet
  } from '$lib/einladung/laden';
  import { m } from '$lib/paraglide/messages.js';

  const einladung = $derived(einladungAusUrl(page.url.href, CLOUD_HOSTNAME));

  let zustand = $state<EinladungZustand>('laden');
  let community = $state<EinladungCommunity | null>(null);
  let guildId = $state<string | null>(null);
  let hinweis = $state<string | null>(null);
  let busy = $state(false);
  let rueckfrage = $state(false);
  // Gegen überholte Antworten, wenn die Adresse wechselt (/invite/A → /invite/B).
  let lauf = 0;

  async function laden(e: Einladung | null) {
    const meiner = ++lauf;
    zustand = 'laden';
    community = null;
    guildId = null;
    hinweis = null;
    // Auth wird nur im /app-Layout hydriert; diese Route liegt außerhalb.
    await auth.hydrate().catch(() => {});
    if (meiner !== lauf) return;
    if (!e) {
      zustand = 'ungueltig';
      return;
    }
    // Unbestätigte Konten sperrt der chat-gateway komplett (403) — gar nicht erst fragen.
    if (auth.user?.email_verification_pending) {
      zustand = 'email';
      return;
    }
    const r = auth.user ? await ladeEinladung(e) : await ladeEinladungAbgemeldet(e);
    if (meiner !== lauf) return;
    zustand = r.zustand;
    community = r.community;
    guildId = r.guildId;
    hinweis = r.zustand === 'fehler' && r.fehler ? fehlerMeldung(r.fehler, e.host) : null;
  }

  $effect(() => {
    const e = einladung;
    untrack(() => void laden(e));
  });

  function merkenUndWeiter(ziel: string) {
    if (einladung) einladungMerken(browserSpeicher(), einladung, Date.now());
    void goto(ziel);
  }

  async function beitreten(bestaetigt = false) {
    if (busy || !einladung) return;
    busy = true;
    hinweis = null;
    const r = await einladungAnnehmen(einladung, bestaetigt);
    busy = false;
    if (r.art === 'ok') gemerkteEinladungVerwerfen(browserSpeicher());
    else if (r.art === 'rueckfrage') rueckfrage = true;
    else hinweis = fehlerMeldung(r.fehler, einladung.host);
  }
</script>

<svelte:head>
  <title>
    {community ? m.einladung_seitentitel_name({ name: community.name }) : m.einladung_seitentitel()}
  </title>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="relative flex min-h-dvh items-center justify-center overflow-hidden p-4">
  <AuthBuehne />
  <EinladungKarte
    {zustand}
    {community}
    host={einladung?.host ?? null}
    {hinweis}
    {busy}
    onBeitreten={() => beitreten()}
    onOeffnen={() => guildId && goto(`/app/guilds/${guildId}/channels/_`)}
    onAnmelden={() => merkenUndWeiter('/login')}
    onRegistrieren={() => merkenUndWeiter('/register')}
    onEmail={() => merkenUndWeiter('/verify-email-required')}
    onErneut={() => laden(einladung)}
    onZuPulse={() => goto('/app')}
  />
</div>

<SelfHostContactConfirmDialog
  open={rueckfrage}
  hostname={einladung?.host ?? ''}
  onConfirm={() => {
    rueckfrage = false;
    void beitreten(true);
  }}
  onCancel={() => (rueckfrage = false)}
/>
```

- [ ] **Step 3: Prüfen**

Run: `cd web && pnpm check 2>&1 | tail -1`
Expected: `0 ERRORS 0 WARNINGS`.

Im laufenden Dev-Stack von Hand: `http://127.0.0.1:5173/invite/<gültiger Code>` abgemeldet → Karte „abgemeldet“; `/invite/ZZZZ9999` → „gilt nicht mehr“; `/login` sieht unverändert aus.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/components/AuthBuehne.svelte web/src/routes/login/+page.svelte "web/src/routes/invite/[code]/+page.svelte"
git commit -m "feat(web): Einladungsseite /invite/<code> — der verschickte Link führt wieder irgendwohin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Dialog in der App, Rückweg, Abmelden

**Files:**
- Create (ersetzt den Prototyp): `web/src/lib/einladung/EinladungDialog.svelte`
- Modify: `web/src/routes/app/+layout.svelte` (Import + `<EinladungDialog />` nach `<AnrufOverlay />`)
- Modify: `web/src/lib/stores/auth.svelte.ts` (`signOut`)

**Interfaces:**
- Consumes: Task 1 (`einladungAusParametern`, `ohneEinladung`), Task 2 (`gemerkteEinladung`, `gemerkteEinladungVerwerfen`, `browserSpeicher`), Task 4.
- Produces: Dialog öffnet sich bei `?einladung=<code>[&einladung_host=<fqdn>]` an jeder `/app`-Adresse **oder** bei einer gemerkten Einladung, sobald `auth.user` gesetzt und bestätigt ist. `data-testid="einladung-dialog"`.

- [ ] **Step 1: Dialog schreiben**

`web/src/lib/einladung/EinladungDialog.svelte`:

```svelte
<!--
  Einladung INNERHALB der App, über der aktuellen Ansicht. Zwei Quellen:
  - die Adresse (`?einladung=<code>[&einladung_host=<fqdn>]`) — so öffnen
    Chat-Links (linkKlick.ts) und der Deep-Link (deepLink.ts) den Dialog;
  - die gemerkte Einladung (gemerkt.ts) — der Rückweg von /invite über
    Anmelden, Registrieren und E-Mail-Bestätigung. Erst gelesen, wenn der
    Nutzer angemeldet UND bestätigt ist; vorher sperrt der Server ohnehin.
  Schließen verwirft die gemerkte Einladung; das ist die Entscheidung „nein“.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { auth } from '$lib/stores/auth.svelte';
  import { CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
  import SelfHostContactConfirmDialog from '$lib/components/server/SelfHostContactConfirmDialog.svelte';
  import EinladungKarte, {
    type EinladungCommunity,
    type EinladungZustand
  } from './EinladungKarte.svelte';
  import { einladungAusParametern, ohneEinladung, type Einladung } from './einladungsLink';
  import { browserSpeicher, gemerkteEinladung, gemerkteEinladungVerwerfen } from './gemerkt';
  import { einladungAnnehmen, fehlerMeldung, ladeEinladung } from './laden';
  import { m } from '$lib/paraglide/messages.js';

  const ausUrl = $derived(einladungAusParametern(page.url.searchParams, CLOUD_HOSTNAME));
  let ausSpeicher = $state<Einladung | null>(null);

  $effect(() => {
    if (auth.user && !auth.user.email_verification_pending) {
      ausSpeicher = gemerkteEinladung(browserSpeicher(), Date.now());
    }
  });

  const offen = $derived(ausUrl !== null || ausSpeicher !== null);
  const aktiv = $derived<Einladung | null>(ausUrl === 'kaputt' ? null : (ausUrl ?? ausSpeicher));

  let zustand = $state<EinladungZustand>('laden');
  let community = $state<EinladungCommunity | null>(null);
  let guildId = $state<string | null>(null);
  let hinweis = $state<string | null>(null);
  let busy = $state(false);
  let rueckfrage = $state(false);
  let lauf = 0;

  async function laden(e: Einladung | null) {
    const meiner = ++lauf;
    zustand = 'laden';
    community = null;
    hinweis = null;
    if (!e) {
      zustand = 'ungueltig';
      return;
    }
    const r = await ladeEinladung(e);
    if (meiner !== lauf) return;
    zustand = r.zustand;
    community = r.community;
    guildId = r.guildId;
    hinweis = r.zustand === 'fehler' && r.fehler ? fehlerMeldung(r.fehler, e.host) : null;
  }

  $effect(() => {
    const e = aktiv;
    if (!offen) return;
    untrack(() => void laden(e));
  });

  function erledigt() {
    gemerkteEinladungVerwerfen(browserSpeicher());
    ausSpeicher = null;
  }

  function schliessen() {
    erledigt();
    if (ausUrl !== null) {
      void goto(ohneEinladung(page.url.pathname + page.url.search), {
        replaceState: true,
        noScroll: true,
        keepFocus: true
      });
    }
  }

  async function beitreten(bestaetigt = false) {
    if (busy || !aktiv) return;
    busy = true;
    hinweis = null;
    const ziel = aktiv;
    const r = await einladungAnnehmen(ziel, bestaetigt);
    busy = false;
    if (r.art === 'ok') erledigt();
    else if (r.art === 'rueckfrage') rueckfrage = true;
    else hinweis = fehlerMeldung(r.fehler, ziel.host);
  }

  function oeffnen() {
    if (!guildId) return;
    erledigt();
    void goto(`/app/guilds/${guildId}/channels/_`);
  }
</script>

<Dialog.Root open={offen} onOpenChange={(v) => { if (!v) schliessen(); }}>
  <Dialog.Content class="nicht-handy:max-w-sm" data-testid="einladung-dialog">
    <Dialog.Title class="sr-only">{m.einladung_dialog_titel()}</Dialog.Title>
    <div class="pt-2">
      <EinladungKarte
        {zustand}
        {community}
        host={aktiv?.host ?? null}
        {hinweis}
        {busy}
        rahmen="dialog"
        onBeitreten={() => beitreten()}
        onOeffnen={oeffnen}
        onErneut={() => laden(aktiv)}
        onZuPulse={schliessen}
      />
    </div>
  </Dialog.Content>
</Dialog.Root>

<SelfHostContactConfirmDialog
  open={rueckfrage}
  hostname={aktiv?.host ?? ''}
  onConfirm={() => {
    rueckfrage = false;
    void beitreten(true);
  }}
  onCancel={() => (rueckfrage = false)}
/>
```

- [ ] **Step 2: Abmelden verwirft die gemerkte Einladung**

In `web/src/lib/stores/auth.svelte.ts`:
- Import oben ergänzen: `import { browserSpeicher, gemerkteEinladungVerwerfen } from '$lib/einladung/gemerkt';`
- In `signOut()` direkt nach `clearVoiceResume();` einfügen:

```ts
    // Gemerkte Einladung (lib/einladung/gemerkt.ts) — auf einem gemeinsam
    // genutzten Rechner soll der nächste Nutzer nicht die Einladung des
    // vorigen vorgesetzt bekommen.
    gemerkteEinladungVerwerfen(browserSpeicher());
```

- [ ] **Step 3: Im App-Layout einhängen**

In `web/src/routes/app/+layout.svelte` direkt nach `import SelfHostDisclaimer from '$lib/components/server/SelfHostDisclaimer.svelte';` ergänzen:

```ts
  import EinladungDialog from '$lib/einladung/EinladungDialog.svelte';
```

und direkt unter `<AnrufOverlay />`:

```svelte
  <EinladungDialog />
```

Run: `grep -c "EinladungDialog" web/src/routes/app/+layout.svelte`
Expected: `2`.

- [ ] **Step 4: Prüfen**

Run: `cd web && pnpm check 2>&1 | tail -1 && pnpm test:unit 2>&1 | grep -E "^ℹ (tests|fail)"`
Expected: `0 ERRORS 0 WARNINGS`; `fail 0`.

Von Hand im Dev-Stack: als angemeldeter Nutzer `/app?einladung=<gültiger Code>` → Dialog; Schließen → Parameter weg. Abgemeldet `/invite/<Code>` → „Anmelden“ → anmelden → in `/app` öffnet sich der Dialog.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/einladung/EinladungDialog.svelte web/src/routes/app/+layout.svelte web/src/lib/stores/auth.svelte.ts
git commit -m "feat(web): Einladungsdialog in der App und Rückweg über die gemerkte Einladung

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Cloud-Route, Host-Prüfung, ein Parser für die Chat-Karte

**Files:**
- Modify: `web/src/lib/guilds/joinByInvite.ts` (Invite-Pfad ab `const { code, host } = parsed;`, Cloud-Ende `const result = await chatApi.acceptInvite(code);`, `joinByPublicHandle`)
- Modify: `web/src/lib/components/InviteEmbed.svelte` (`onMount`)
- Modify: `web/src/lib/components/MessageItem.svelte:114-126`

**Interfaces:**
- Consumes: `zielHost`, `ersteEinladungImText` (Task 1).
- Produces: `joinGuildByInvite` wirft `Error(m.einladung_host_ungueltig())` bei ungültigem Host; Cloud-Beitritte laufen über `serversStore.cloudId()`.

- [ ] **Step 1: joinByInvite — Invite-Pfad**

Import ergänzen: `import { zielHost } from '$lib/einladung/einladungsLink';`

Ersetzen:

```ts
  const { code, host } = parsed;
  if (!code) throw new Error(m.einladung_beitritt_eingabe());

  if (host) {
    // Self-Host: HTTPS-Hostname normalisieren
    const trimmed = host.trim().toLowerCase().replace(/\/$/, '');
    const hostname = trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`;
```

durch:

```ts
  const { code } = parsed;
  if (!code) throw new Error(m.einladung_beitritt_eingabe());
  // Zielserver streng prüfen (einladungsLink.ts): `?host=<cloud>` ist eine
  // Cloud-Einladung; ein Host mit `@`, `\`, Port oder IP wird abgewiesen —
  // daran lesen Browser und Cloud (Python) eine Adresse verschieden.
  const host = zielHost(parsed.host, CLOUD_HOSTNAME);
  if (host === undefined) throw new Error(m.einladung_host_ungueltig());

  if (host) {
    const hostname = `https://${host}`;
```

- [ ] **Step 2: joinByInvite — Cloud-Ende**

Ersetzen:

```ts
  const result = await chatApi.acceptInvite(code);
  joinedInvites.markJoined(code, result.guild.id);
```

durch:

```ts
  // Cloud-Einladung AUSDRÜCKLICH an die Cloud: ist gerade ein Self-Host
  // aktiv, kennt der den Code nicht und antwortete 404 „ungültig“.
  const cloudId = serversStore.cloudId();
  const result = cloudId
    ? await acceptInvite(code, { serverId: cloudId })
    : await chatApi.acceptInvite(code);
  if (cloudId) activeServer.set(cloudId);
  joinedInvites.markJoined(code, result.guild.id);
```

- [ ] **Step 3: joinByPublicHandle — gleiche Prüfung, gleiche Cloud-Route**

Am Anfang von `joinByPublicHandle` ersetzen:

```ts
  if (!host) {
    // Cloud-Community
    const result = await chatApi.joinPublicCommunity(handle);
```

durch:

```ts
  const ziel = zielHost(host, CLOUD_HOSTNAME);
  if (ziel === undefined) throw new Error(m.einladung_host_ungueltig());
  if (!ziel) {
    // Cloud-Community — ausdrücklich an die Cloud, wie im Invite-Pfad.
    const cloudId = serversStore.cloudId();
    const result = await chatApi.joinPublicCommunity(handle, cloudId ? { serverId: cloudId } : {});
    if (cloudId) activeServer.set(cloudId);
```

und weiter unten in derselben Funktion ersetzen:

```ts
  const trimmed = host.trim().toLowerCase().replace(/\/$/, '');
  const hostname = trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`;
```

durch:

```ts
  const hostname = `https://${ziel}`;
```

- [ ] **Step 4: InviteEmbed — Cloud-Vorschau an die Cloud**

In `web/src/lib/components/InviteEmbed.svelte` im `onMount` ersetzen:

```ts
      preview = await chatApi.getInvitePreview(code);
```

durch:

```ts
      // Host-loser Link = Cloud-Einladung → ausdrücklich die Cloud fragen,
      // nicht den aktiven Server (sonst „ungültig“ in einem Self-Host-Kanal).
      const cloudId = serversStore.cloudId();
      preview = cloudId
        ? await getInvitePreviewOn(code, { serverId: cloudId })
        : await chatApi.getInvitePreview(code);
```

(`serversStore` und `getInvitePreviewOn` sind dort schon importiert.)

- [ ] **Step 5: MessageItem — ein Parser**

In `web/src/lib/components/MessageItem.svelte` Imports ergänzen:

```ts
  import { ersteEinladungImText } from '$lib/einladung/einladungsLink';
  import { CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
```

und den Block vom Kommentar `// Invite-Embed-Detection: …` bis einschließlich `const isInviteOnly = $derived(…);` ersetzen durch:

```ts
  // Einladungs-Karte: erste gültige Einladung im Text (einladungsLink.ts —
  // derselbe Leser wie Beitrittsfeld, Seite und Dialog; `host=` an jeder
  // Stelle, Satzzeichen am Linkende werden abgeschnitten).
  const inviteTreffer = $derived(ersteEinladungImText(message.content, CLOUD_HOSTNAME));
  const inviteCode = $derived(inviteTreffer?.einladung.code ?? null);
  const inviteHost = $derived(inviteTreffer?.einladung.host ?? null);
  // Rohtext ausblenden, wenn die Nachricht NUR aus dem Link besteht.
  const isInviteOnly = $derived(
    !!inviteTreffer && message.content.trim() === inviteTreffer.roh
  );
```

- [ ] **Step 6: Prüfen**

Run: `cd web && pnpm check 2>&1 | tail -1 && pnpm test:unit 2>&1 | grep -E "^ℹ (tests|fail)"`
Expected: `0 ERRORS 0 WARNINGS`; `fail 0`.

Run (bestehende Einladungs-E2E, lokaler Stack): `cd web && PULSE_INSTANCE_MODE=cloud pnpm exec playwright test tests/e2e/invite-link-join.spec.ts tests/e2e/overnight-invites.spec.ts tests/e2e/invite.spec.ts`
Expected: alle grün.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/guilds/joinByInvite.ts web/src/lib/components/InviteEmbed.svelte web/src/lib/components/MessageItem.svelte
git commit -m "fix(web): Cloud-Einladungen immer an die Cloud, Server-Adresse streng geprüft

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Klick auf einen Einladungslink im Chat öffnet den Dialog

**Files:**
- Create: `web/src/lib/einladung/linkKlick.ts`
- Modify: `web/src/lib/components/MessageItem.svelte` (Inhalts-`div` mit `data-testid="message-content"`)

**Interfaces:**
- Consumes: `einladungAusUrl`, `klickAbfangen`, `mitEinladung` (Task 1); Dialog (Task 6) liest `?einladung=`.
- Produces: `einladungsKlicksAbfangen(el: HTMLElement): () => void`

- [ ] **Step 1: Klick-Fänger schreiben**

`web/src/lib/einladung/linkKlick.ts`:

```ts
// Ein schlichter Linksklick auf einen Einladungslink in einer Nachricht
// öffnet den Einladungsdialog an der aktuellen Adresse, statt eines neuen
// Tabs — und in der Desktop-App statt eines zweiten, nackten Fensters:
// messageRender.ts setzt `target="_blank"`, und main.ts lässt Fenster gleichen
// Ursprungs ohne Preload aufgehen. Strg/Cmd/Mittelklick bleiben unberührt
// (klickAbfangen).
import { goto } from '$app/navigation';
import { CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
import { einladungAusUrl, klickAbfangen, mitEinladung } from './einladungsLink';

export function einladungsKlicksAbfangen(el: HTMLElement): () => void {
  const beiKlick = (ev: MouseEvent) => {
    if (!klickAbfangen(ev)) return;
    const a = (ev.target as Element | null)?.closest?.('a[href]');
    if (!(a instanceof HTMLAnchorElement) || !el.contains(a)) return;
    const e = einladungAusUrl(a.href, CLOUD_HOSTNAME);
    if (!e) return;
    ev.preventDefault();
    void goto(mitEinladung(window.location.pathname + window.location.search, e), {
      noScroll: true,
      keepFocus: true
    });
  };
  el.addEventListener('click', beiKlick);
  return () => el.removeEventListener('click', beiKlick);
}
```

- [ ] **Step 2: In MessageItem anhängen**

In `web/src/lib/components/MessageItem.svelte`:
- Import: `import { einladungsKlicksAbfangen } from '$lib/einladung/linkKlick';`
- Im Skript ergänzen:

```ts
  let inhalt = $state<HTMLElement | null>(null);
  $effect(() => (inhalt ? einladungsKlicksAbfangen(inhalt) : undefined));
```

- Am `div` mit `data-testid="message-content"` `bind:this={inhalt}` ergänzen.

- [ ] **Step 3: Prüfen**

Run: `cd web && pnpm check 2>&1 | tail -1`
Expected: `0 ERRORS 0 WARNINGS`. (Der Listener hängt per `$effect`, nicht als `onclick` am `div` — so gibt es keine a11y-Warnung.)

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/einladung/linkKlick.ts web/src/lib/components/MessageItem.svelte
git commit -m "feat(web): Einladungslink im Chat öffnet den Dialog statt eines neuen Fensters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Deep-Link aus dem Browser öffnet den Dialog oder wird gemerkt

**Files:**
- Create: `web/src/lib/einladung/deepLink.ts`
- Modify: `web/src/routes/+layout.svelte` (Zeilen 31–33 Importe, 64–97 Zustand und `runDeepLinkJoin`/`onConfirmInviteContact`/`onCancelInviteContact`, 165–182 Verdrahtung, 263–268 `SelfHostContactConfirmDialog`)
- Modify: `web/src/lib/platform/pulse.d.ts` (Kommentar zu `PulseInvitePayload`)

**Interfaces:**
- Consumes: `istGueltigerCode`, `zielHost`, `mitEinladung` (Task 1); `einladungMerken`, `browserSpeicher` (Task 2).
- Produces: `einladungAusDeepLink(data: { hostname: string; code: string }): void`. `hostname: ''` bedeutet Cloud (ab Etappe 3 schickt die App das so; heutige Apps schicken immer einen FQDN).

- [ ] **Step 1: Handler schreiben**

`web/src/lib/einladung/deepLink.ts`:

```ts
// Deep-Link `pulse://invite?code=…[&host=…]` aus dem Browser in die
// Desktop-App. Die App prüft den Link in main (deeplink.ts) und reicht
// {hostname, code} herüber. Vorher trat der Renderer sofort bei und schrieb
// einen Fehlschlag nur in die Konsole — war die App nicht angemeldet, passierte
// für den Nutzer schlicht nichts.
//
// Jetzt: angemeldet und in /app → Dialog an der aktuellen Adresse. Sonst
// merken; der Dialog im App-Layout greift die Einladung nach dem Login auf.
import { goto } from '$app/navigation';
import { auth } from '$lib/stores/auth.svelte';
import { CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
import { istGueltigerCode, mitEinladung, zielHost } from './einladungsLink';
import { browserSpeicher, einladungMerken } from './gemerkt';

export function einladungAusDeepLink(data: { hostname: string; code: string }): void {
  // '' = Cloud (Etappe 3); der Cloud-Hostname selbst ebenfalls (zielHost).
  const host = zielHost(data.hostname || null, CLOUD_HOSTNAME);
  if (host === undefined || !istGueltigerCode(data.code)) return;
  const e = { code: data.code, host };
  const bereit = !!auth.user && !auth.user.email_verification_pending;
  if (bereit && window.location.pathname.startsWith('/app')) {
    void goto(mitEinladung(window.location.pathname + window.location.search, e), {
      noScroll: true,
      keepFocus: true
    });
    return;
  }
  einladungMerken(browserSpeicher(), e, Date.now());
  if (bereit) void goto('/app');
}
```

- [ ] **Step 2: Root-Layout umstellen**

In `web/src/routes/+layout.svelte`:
- Die drei Importe `joinGuildByInvite`, `SelfHostContactConfirmRequired`, `SelfHostContactConfirmDialog` entfernen und `import { einladungAusDeepLink } from '$lib/einladung/deepLink';` ergänzen.
- Den Block vom Kommentar `// Erstkontakt-Bestätigung für Electron-Deeplink-Invites …` bis einschließlich der Funktion `onCancelInviteContact` ersatzlos entfernen (die Erstkontakt-Rückfrage stellt jetzt der Dialog).
- Die Verdrahtung ersetzen — vom Kommentar `// Wire the Electron invite deep-link bridge (Phase 5.3).` bis zur schließenden Klammer des `if (isElectron()) { … }` — durch:

```ts
    // Einladungs-Deep-Link der Desktop-App (pulse://invite, geprüft in
    // desktop/electron/deeplink.ts): Dialog öffnen oder merken
    // (lib/einladung/deepLink.ts). Pull-Weg für Links, die vor diesem onMount
    // ankamen (finding 156).
    let disposeInvite: (() => void) | undefined;
    if (isElectron()) {
      disposeInvite = window.pulse?.invite?.onLink(einladungAusDeepLink);
      void window.pulse?.invite?.getPending().then((data) => {
        if (data) einladungAusDeepLink(data);
      });
    }
```

- Das Markup `<SelfHostContactConfirmDialog open={inviteConfirmOpen} … />` am Ende entfernen.

- [ ] **Step 3: Typ-Kommentar**

In `web/src/lib/platform/pulse.d.ts` beim Typ `PulseInvitePayload` (bzw. dessen `hostname`-Feld) den Kommentar ergänzen: `/** FQDN des Self-Hosts; '' = Cloud-Einladung (ab Desktop 0.1.98). */`. Erst `grep -n "PulseInvitePayload" web/src/lib/platform/pulse.d.ts` — dort steht die Definition.

- [ ] **Step 4: Prüfen**

Run: `cd web && pnpm check 2>&1 | tail -1 && grep -c "runDeepLinkJoin\|inviteConfirmOpen" src/routes/+layout.svelte`
Expected: `0 ERRORS 0 WARNINGS`; `0`.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/einladung/deepLink.ts web/src/routes/+layout.svelte web/src/lib/platform/pulse.d.ts
git commit -m "feat(web): Einladungs-Deep-Link öffnet den Dialog oder wartet auf die Anmeldung

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Link-Vorschau in Messengern

**Files:**
- Modify: `web/src/app.html` (im `<head>`, nach den `theme-color`-Zeilen)

- [ ] **Step 1: Angaben eintragen**

```html
    <!-- Link-Vorschau in Messengern (WhatsApp, Signal, Mail). Deren Abrufer
         führen kein JavaScript aus — was hier nicht steht, sehen sie nicht.
         Allgemein für alle Seiten; der Community-Name in der Vorschau einer
         Einladung bräuchte serverseitig eingesetzte Angaben (Spec, später). -->
    <meta name="description" content="Chat, Sprachkanäle und Bildschirmübertragung in hoher Qualität – im Browser und als App." />
    <meta property="og:site_name" content="Pulse" />
    <meta property="og:title" content="Pulse" />
    <meta property="og:description" content="Chat, Sprachkanäle und Bildschirmübertragung in hoher Qualität – im Browser und als App." />
    <meta property="og:image" content="https://howispulse.com/pulse-icon-512.png" />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary" />
```

- [ ] **Step 2: Prüfen**

Run: `cd web && pnpm build 2>&1 | tail -2 && grep -c 'og:title' build/index.html`
Expected: Build erfolgreich; `1`.

- [ ] **Step 3: Commit**

```bash
git add web/src/app.html
git commit -m "feat(web): Link-Vorschau in Messengern zeigt Pulse

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: E2E — der Link wird wirklich aufgerufen

**Files:**
- Create: `web/tests/e2e/einladungsseite.spec.ts`

**Interfaces:**
- Consumes: Test-IDs aus Task 4 und 6; `invite-open-btn`, `invite-share-create`, `invite-share-link`, `message-input`, `message-content`, `route-error`, `reg-*`, `guild-create-menu-*`, `guild-create`, `create-guild-name`, `create-guild-submit` (bestehend).

- [ ] **Step 1: Test schreiben**

`web/tests/e2e/einladungsseite.spec.ts`:

```ts
/**
 * Die Einladungsseite (Spec 2026-10-10). Anders als invite-link-join.spec.ts,
 * das den Link nur ins Beitrittsfeld kopiert, RUFT dieser Test den Link auf —
 * genau die Lücke, durch die die fehlende Route vier Monate unbemerkt blieb.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { E2E_BASE_URL } from './_ports';

const ts = Date.now();
const ALICE = {
  username: `ein_alice_${ts}`,
  email: `ein_alice_${ts}@dcc-test.example.com`,
  password: 'ein-secret-pass'
};
const BOB = {
  username: `ein_bob_${ts}`,
  email: `ein_bob_${ts}@dcc-test.example.com`,
  password: 'ein-secret-pass'
};
const RUNDE = 'Einladungsrunde';
const ZWEITE = 'Zweite Runde';

async function registrieren(page: Page, u: typeof ALICE) {
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

async function communityAnlegen(page: Page, name: string): Promise<string> {
  await page.locator('[data-testid^="guild-create-menu-"]').first().click();
  await page.getByTestId('guild-create').click();
  await page.getByTestId('create-guild-name').fill(name);
  await page.getByTestId('create-guild-submit').click();
  await page.waitForURL(/\/app\/guilds\/(\d+)\/channels\/\d+/);
  return page.url();
}

async function linkErzeugen(page: Page): Promise<string> {
  await page.getByTestId('invite-open-btn').click();
  await page.getByTestId('invite-share-create').click();
  const el = page.getByTestId('invite-share-link');
  await expect(el).toBeVisible({ timeout: 10_000 });
  const link = (await el.textContent())!.trim();
  await page.keyboard.press('Escape');
  return link;
}

const karte = (page: Page, zustand: string) =>
  page.locator(`[data-testid=einladung-karte][data-zustand=${zustand}]`);

test.describe.serial('Einladungsseite', () => {
  let aliceCtx: BrowserContext;
  let alice: Page;
  let bobCtx: BrowserContext;
  let bob: Page;
  let rundeUrl = '';
  let link1 = '';
  let link2 = '';

  test.beforeAll(async ({ browser }) => {
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    alice = await aliceCtx.newPage();
    bob = await bobCtx.newPage();
  });

  test.afterAll(async () => {
    await aliceCtx.close();
    await bobCtx.close();
  });

  test('Alice legt zwei Communitys an und erzeugt je einen Link', async () => {
    await alice.goto('/register');
    await registrieren(alice, ALICE);
    rundeUrl = await communityAnlegen(alice, RUNDE);
    link1 = await linkErzeugen(alice);
    await communityAnlegen(alice, ZWEITE);
    link2 = await linkErzeugen(alice);
    expect(link1).toContain('/invite/');
  });

  test('Abgemeldet: der Link zeigt die Einladung, keine Fehlerseite', async () => {
    await bob.goto(link1);
    await expect(karte(bob, 'abgemeldet')).toBeVisible({ timeout: 15_000 });
    await expect(bob.getByTestId('route-error')).toHaveCount(0);
  });

  test('Konto erstellen führt nach der Registrierung zur Einladung zurück', async () => {
    await bob.getByTestId('einladung-registrieren').click();
    await bob.waitForURL(/\/register/);
    await registrieren(bob, BOB);
    const dialog = bob.getByTestId('einladung-dialog');
    await expect(karte(bob, 'einladung')).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByTestId('einladung-name')).toHaveText(RUNDE);
    await dialog.getByTestId('einladung-beitreten').click();
    const guildId = rundeUrl.match(/\/app\/guilds\/(\d+)/)![1];
    await bob.waitForURL(new RegExp(`/app/guilds/${guildId}/channels/`), { timeout: 15_000 });
    await expect(bob.getByTestId('einladung-dialog')).toHaveCount(0);
  });

  test('Schon Mitglied: Community öffnen', async () => {
    await bob.goto(link1);
    await expect(karte(bob, 'mitglied')).toBeVisible({ timeout: 15_000 });
    await bob.getByTestId('einladung-oeffnen').click();
    await bob.waitForURL(/\/app\/guilds\/\d+\/channels\//);
  });

  test('Unbekannter Code: gilt nicht mehr', async () => {
    await bob.goto(`${E2E_BASE_URL}/invite/ZZZZ9999`);
    await expect(karte(bob, 'ungueltig')).toBeVisible({ timeout: 15_000 });
  });

  test('Klick auf einen Einladungslink im Chat öffnet den Dialog, keinen neuen Tab', async () => {
    await alice.goto(rundeUrl);
    await alice.getByTestId('message-input').click();
    await alice.getByTestId('message-input').fill(`Schau mal: ${link2}`);
    await alice.getByTestId('message-input').press('Enter');

    await bob.goto(rundeUrl);
    const anker = bob.locator(`[data-testid=message-content] a[href="${link2}"]`);
    await expect(anker).toBeVisible({ timeout: 15_000 });
    await anker.click();
    await expect(bob).toHaveURL(/einladung=/);
    await expect(bob.getByTestId('einladung-dialog').getByTestId('einladung-name')).toHaveText(ZWEITE, {
      timeout: 15_000
    });
    expect(bobCtx.pages()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Laufen lassen**

Run: `cd web && PULSE_INSTANCE_MODE=cloud pnpm exec playwright test tests/e2e/einladungsseite.spec.ts`
Expected: 6 passed. Schlägt „Konto erstellen …“ fehl, weil ein anderer Dialog nach der Registrierung über dem Einladungsdialog liegt, ist das ein echter Befund (zwei Dialoge gleichzeitig) — nicht den Test lockern, sondern den Einladungsdialog warten lassen, bis der andere geschlossen ist.

- [ ] **Step 3: Commit**

```bash
git add web/tests/e2e/einladungsseite.spec.ts
git commit -m "test(e2e): Einladungslink wird wirklich aufgerufen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Etappe 1 abschließen und landen

**Files:**
- Modify: `web/static/changelog.json`
- Modify: `CLAUDE.md` (kurzer Abschnitt „Einladungslinks“ unter „Architektur — die nicht-offensichtlichen Stücke“)

- [ ] **Step 1: Simplifier**

`code-simplifier`-Agent über alle in Etappe 1 geänderten Dateien (`git diff --name-only origin/main...HEAD -- web`). Danach `pnpm check`, `pnpm test:unit` und Task 11 erneut grün.

- [ ] **Step 2: CLAUDE.md**

Abschnitt ergänzen (vorher `grep -n "invite" CLAUDE.md`, um keine widersprechende Aussage stehen zu lassen):

```markdown
**Einladungslinks (seit 2026-10, Spec `docs/superpowers/specs/2026-10-10-einladungsseite-design.md`)** — `/invite/<code>[?host=<fqdn>]` ist eine eigene Seite AUSSERHALB von `/app`; in der App öffnet derselbe Inhalt als Dialog über `?einladung=<code>[&einladung_host=<fqdn>]` an der aktuellen Adresse.
- **Ein Parser für alle Leser:** `web/src/lib/einladung/einladungsLink.ts` (importfrei). Wer irgendwo einen Einladungslink liest, nimmt den — vorher hatten Chat-Karte und Beitrittsfeld eigene, widersprüchliche Ausdrücke.
- **Rückweg = gemerkte Einladung** (`gemerkt.ts`, `localStorage`, 24 h), nicht `?redirect=`: Registrierung und E-Mail-Bestätigung führen beide nach `/app`, die Adresse ginge unterwegs verloren.
- **Cloud-Einladungen ausdrücklich an die Cloud** (`serversStore.cloudId()`), nie an den aktiven Server — ein aktiver Self-Host kennt den Code nicht.
- **Kein Kontakt zu einem unbekannten Self-Host vor der Erstkontakt-Zustimmung**, auch nicht für die Vorschau.
```

- [ ] **Step 3: Gate**

Run: `bash scripts/gate.sh`
Expected: `✓ Test-Gate grün.`

- [ ] **Step 4: Stempel und Changelog**

Run: `bash .claude/hooks/simplify-stamp.sh`

Dem Eigentümer zwei bis drei Formulierungen für den Changelog-Eintrag vorschlagen (Inhalt: verschickte Einladungslinks funktionieren wieder; Anmelden und Registrieren führen zur Einladung zurück; Links im Chat öffnen ein Fenster in der App), Stil wählen lassen, dann oben in `entries` eintragen (`id` = Datum, ggf. `.N`).

- [ ] **Step 5: Commit**

```bash
git add web/static/changelog.json CLAUDE.md
git commit -m "docs: Einladungslinks — Changelog und CLAUDE.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Landen (nur mit Freigabe)**

Eigentümer fragen. Bei Ja: `bash scripts/ship.sh`. Kein Desktop-Versionssprung nötig (nur `web/`).

---

# Etappe 2 — Server: Name für Abgemeldete

### Task 13: Anonyme Vorschau-Route

**Files:**
- Create: `services/chat-gateway/src/dcc_chat_gateway/routes/invite_public.py`
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/__init__.py` (Import + `router.include_router(invite_public.router)` direkt nach `router.include_router(invites.router)`)
- Test: `services/chat-gateway/tests/test_invite_public.py`

**Interfaces:**
- Consumes: `_is_active`, `_member_count`, `_INVITE_INVALID` aus `routes/invites.py`; `gaeste.bremse`, `gaeste.code_hash`; `client_ip`; `is_guild_suspended`.
- Produces: `GET /invites/{code}/public-preview` → `{"guild": {"name": str, "icon_url": str | None}, "member_count": int}`; 404 für jedes „nein“; 429 ab 31 Abrufen pro IP bzw. 61 pro Code in 60 s.

- [ ] **Step 1: Write the failing test**

`services/chat-gateway/tests/test_invite_public.py`:

```python
"""Anonyme Einladungs-Vorschau (GET /invites/{code}/public-preview).

Der erste Weg, auf dem ein Abgemeldeter etwas über eine Community erfährt.
Geprüft wird deshalb vor allem, was die Route NICHT verrät: keine Kennungen,
und jedes „nein“ sieht gleich aus — sonst ließe sich der Code-Raum abtasten.
"""

from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update

from dcc_chat_gateway.models import Guild, GuildInvite
from dcc_chat_gateway.routes import invite_public


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _nutzer(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"user{uid}"), uid


async def _community_mit_link(client, _auth_signer, **link) -> tuple[str, dict, str]:
    token, _ = _nutzer(_auth_signer)
    g = (await client.post("/guilds", json={"name": "Designrunde"}, headers=_auth(token))).json()
    r = await client.post(f"/guilds/{g['id']}/invites", json=link, headers=_auth(token))
    assert r.status_code == 201, r.text
    return token, g, r.json()["code"]


@pytest.fixture(autouse=True)
async def _bremse_leeren(app):
    async for key in app.state.redis.scan_iter("einladung:rate:*"):
        await app.state.redis.delete(key)
    yield


@pytest.mark.asyncio
async def test_liefert_name_bild_mitglieder_ohne_anmeldung(client, _auth_signer):
    _, _, code = await _community_mit_link(client, _auth_signer)
    r = await client.get(f"/invites/{code}/public-preview")
    assert r.status_code == 200, r.text
    # Genau diese Felder — keine guild.id, kein channel_id (der Besitzer zählt als Mitglied).
    assert r.json() == {"guild": {"name": "Designrunde", "icon_url": None}, "member_count": 1}


@pytest.mark.asyncio
async def test_jedes_nein_sieht_gleich_aus(client, _auth_signer, session_factory):
    antworten = []

    antworten.append(await client.get("/invites/unbekannt1/public-preview"))

    owner, _, code = await _community_mit_link(client, _auth_signer)
    await client.delete(f"/invites/{code}", headers=_auth(owner))
    antworten.append(await client.get(f"/invites/{code}/public-preview"))

    _, _, code = await _community_mit_link(client, _auth_signer)
    async with session_factory() as s:
        await s.execute(
            update(GuildInvite)
            .where(GuildInvite.code == code)
            .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        await s.commit()
    antworten.append(await client.get(f"/invites/{code}/public-preview"))

    _, _, code = await _community_mit_link(client, _auth_signer, max_uses=1)
    gast, _ = _nutzer(_auth_signer)
    assert (await client.post(f"/invites/{code}/accept", headers=_auth(gast))).status_code == 200
    antworten.append(await client.get(f"/invites/{code}/public-preview"))

    _, g, code = await _community_mit_link(client, _auth_signer)
    async with session_factory() as s:
        await s.execute(
            update(Guild).where(Guild.id == int(g["id"])).values(suspended_at=datetime.now(UTC))
        )
        await s.commit()
    antworten.append(await client.get(f"/invites/{code}/public-preview"))

    assert [a.status_code for a in antworten] == [404] * 5
    assert len({a.text for a in antworten}) == 1, [a.text for a in antworten]


@pytest.mark.asyncio
async def test_bremse_pro_ip(client):
    for i in range(30):
        assert (await client.get(f"/invites/unbek{i:04d}/public-preview")).status_code == 404
    assert (await client.get("/invites/unbek9999/public-preview")).status_code == 429


@pytest.mark.asyncio
async def test_bremse_pro_code(client, monkeypatch):
    ips = iter(f"10.0.{i // 250}.{i % 250}" for i in range(1000))
    monkeypatch.setattr(invite_public, "client_ip", lambda _req: next(ips))
    for _ in range(60):
        assert (await client.get("/invites/gleich01/public-preview")).status_code == 404
    assert (await client.get("/invites/gleich01/public-preview")).status_code == 429
```

- [ ] **Step 2: Run test to verify it fails**

Run (aus dem Repo-Root): `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_invite_public.py`
Expected: FAIL — `ImportError: cannot import name 'invite_public'`.

- [ ] **Step 3: Write minimal implementation**

`services/chat-gateway/src/dcc_chat_gateway/routes/invite_public.py`:

```python
"""Anonyme Einladungs-Vorschau: ``GET /invites/{code}/public-preview``.

Für die Einladungsseite (``web/src/routes/invite/[code]``): wer abgemeldet
einen Link öffnet, soll vor dem Anmelden sehen, wohin er führt. Eigene Route
statt optionaler Anmeldung an ``GET /invites/{code}`` — dieselbe Regel wie
bei den Gast-Links: nirgends „Nutzer ODER anonym“ an einer Abhängigkeit.

Bewusst knapp: Name, Bild, Mitgliederzahl — keine ``guild.id``, kein
``channel_id``. Jedes „nein“ (unbekannt, zurückgezogen, abgelaufen,
aufgebraucht, gesperrte Community) ist dieselbe 404, und die Bremse zählt in
Redis pro IP UND pro Code (``ratelimit.py`` zählt pro Nutzer-ID im Prozess und
wäre für Anonyme wirkungslos). Spec 2026-10-10, Abschnitt „Server“.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Path, Request, status
from pydantic import BaseModel

from dcc_chat_gateway import gaeste
from dcc_chat_gateway.client_ip import client_ip
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import Guild, GuildInvite
from dcc_chat_gateway.routes._deps import is_guild_suspended
from dcc_chat_gateway.routes.invites import _INVITE_INVALID, _is_active, _member_count

router = APIRouter()

# Wie die Gast-Routen (gaeste.bremse_pruefen): 30 Codes pro IP und Minute
# reichen jedem Menschen; 60 Abrufe pro Code bremsen ein Skript auf einen Link.
_IP_LIMIT = 30
_CODE_LIMIT = 60
_FENSTER_S = 60


class PublicInviteGuildOut(BaseModel):
    name: str
    icon_url: str | None


class PublicInvitePreviewOut(BaseModel):
    guild: PublicInviteGuildOut
    member_count: int


async def _bremsen(redis, request: Request, code: str) -> None:
    ip = client_ip(request)
    if ip and not await gaeste.bremse(redis, f"einladung:rate:ip:{ip}", _IP_LIMIT, _FENSTER_S):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="zu viele Anfragen")
    code_h = gaeste.code_hash(code)
    if not await gaeste.bremse(redis, f"einladung:rate:code:{code_h}", _CODE_LIMIT, _FENSTER_S):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="zu viele Anfragen")


@router.get("/invites/{code}/public-preview", response_model=PublicInvitePreviewOut)
async def public_invite_preview(
    session: SessionDep,
    request: Request,
    code: str = Path(min_length=1, max_length=64),
) -> PublicInvitePreviewOut:
    await _bremsen(getattr(request.app.state, "redis", None), request, code)
    invite = await session.get(GuildInvite, code)
    if invite is None or not _is_active(invite, datetime.now(tz=UTC)):
        raise HTTPException(404, detail=_INVITE_INVALID)
    guild = await session.get(Guild, invite.guild_id)
    if guild is None or await is_guild_suspended(session, guild.id):
        raise HTTPException(404, detail=_INVITE_INVALID)
    return PublicInvitePreviewOut(
        guild=PublicInviteGuildOut(name=guild.name, icon_url=guild.icon_url),
        member_count=await _member_count(session, guild.id),
    )
```

In `routes/__init__.py`: `invite_public` in die alphabetische Import-Liste neben `invites` aufnehmen und direkt nach `router.include_router(invites.router)` die Zeile `router.include_router(invite_public.router)` einfügen.

- [ ] **Step 4: Run test to verify it passes**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_invite_public.py services/chat-gateway/tests/test_invites.py`
Expected: alle grün.

- [ ] **Step 5: Commit**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/routes/invite_public.py services/chat-gateway/src/dcc_chat_gateway/routes/__init__.py services/chat-gateway/tests/test_invite_public.py
git commit -m "feat(chat-gateway): anonyme Einladungs-Vorschau mit Bremse

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Seite zeigt Abgemeldeten den Namen, Etappe 2 landen

**Files:**
- Modify: `web/src/lib/api/chat.ts` (neben `getPublicCommunityPreview`), `web/src/lib/einladung/laden.ts` (`ladeEinladungAbgemeldet`), `web/tests/e2e/einladungsseite.spec.ts`

**Interfaces:**
- Produces: `chatApi.getPublicInvitePreview(code: string, route?: { serverId?: string }): Promise<PublicInvitePreview>`, `type PublicInvitePreview = { guild: { name: string; icon_url: string | null }; member_count: number }`.

- [ ] **Step 1: E2E zuerst verschärfen (failing)**

In `einladungsseite.spec.ts`, Test „Abgemeldet: …“, nach der Karten-Erwartung ergänzen:

```ts
    await expect(bob.getByTestId('einladung-name')).toHaveText(RUNDE);
```

Run: `cd web && PULSE_INSTANCE_MODE=cloud pnpm exec playwright test tests/e2e/einladungsseite.spec.ts -g "Abgemeldet"`
Expected: FAIL — Name ist „Eine Community wartet auf dich“.

- [ ] **Step 2: API-Funktion**

In `web/src/lib/api/chat.ts` bei den Typen `PublicCommunityPreview` ergänzen:

```ts
export type PublicInvitePreview = {
  guild: { name: string; icon_url: string | null };
  member_count: number;
};
```

und in `chatApi` direkt nach `getPublicCommunityPreview`:

```ts
  /** Anonyme Einladungs-Vorschau (Name, Bild, Mitgliederzahl) — für die
   *  Einladungsseite ohne Anmeldung. 404 für jedes „nein“, 429 bei Bremse. */
  getPublicInvitePreview(
    code: string,
    route: { serverId?: string } = {},
  ): Promise<PublicInvitePreview> {
    return request<PublicInvitePreview>(
      `/invites/${encodeURIComponent(code)}/public-preview`,
      {},
      route,
    );
  },
```

- [ ] **Step 3: Lader**

In `web/src/lib/einladung/laden.ts` `ladeEinladungAbgemeldet` ersetzen durch:

```ts
/** Für Abgemeldete. Name nur für Cloud-Einladungen: einen Self-Host fragen
 *  wir vor der Erstkontakt-Zustimmung nie (Spec, Sicherheit 2). */
export async function ladeEinladungAbgemeldet(e: Einladung): Promise<GeladeneEinladung> {
  if (e.host) return { zustand: 'abgemeldet', ...LEER };
  try {
    const cloudId = serversStore.cloudId();
    const p = await chatApi.getPublicInvitePreview(e.code, cloudId ? { serverId: cloudId } : {});
    return {
      zustand: 'abgemeldet',
      community: {
        name: p.guild.name,
        iconUrl: guildIconSrc(p.guild.icon_url, window.location.origin),
        mitglieder: p.member_count
      },
      guildId: null,
      fehler: null
    };
  } catch (err) {
    // Ungültig ist endgültig; Bremse oder Netz dürfen das Anmelden nicht blockieren.
    if (fehlerAus(err) === 'ungueltig') return { zustand: 'ungueltig', ...LEER };
    return { zustand: 'abgemeldet', ...LEER };
  }
}
```

- [ ] **Step 4: Prüfen**

Run: `cd web && pnpm check 2>&1 | tail -1 && PULSE_INSTANCE_MODE=cloud pnpm exec playwright test tests/e2e/einladungsseite.spec.ts`
Expected: `0 ERRORS 0 WARNINGS`; 6 passed.

- [ ] **Step 5: Commit, Gate, Changelog, Landen**

```bash
git add web/src/lib/api/chat.ts web/src/lib/einladung/laden.ts web/tests/e2e/einladungsseite.spec.ts
git commit -m "feat(web): Einladungsseite zeigt auch ohne Anmeldung, wohin der Link führt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Dann: Simplifier über die Etappe-2-Dateien → `bash scripts/gate.sh` → `bash .claude/hooks/simplify-stamp.sh` → Changelog (fällt Etappe 2 auf denselben Tag wie Etappe 1 und ist Etappe 1 noch nicht ausgeliefert, in **denselben** Eintrag; sonst neuer Eintrag, Stil wählen lassen) → Freigabe → `bash scripts/ship.sh`.

---

# Etappe 3 — Desktop-App

### Task 15: `pulse://invite` ohne Host = Cloud

**Files:**
- Modify: `desktop/electron/deeplink.ts`
- Create: `desktop/test/deeplink.test.ts`
- Modify: `desktop/package.json` (`test:unit`-Dateiliste)
- Modify: `desktop/electron/preload.ts` (Kommentar über `invite:`)

**Interfaces:**
- Produces: `parseInviteDeepLink(url: string): { hostname: string; code: string } | null` (`hostname: ''` = Cloud). `handleDeepLink`/`seedPendingFromArgv` nutzen sie.

- [ ] **Step 1: Testzahl vorher notieren**

Run: `cd desktop && pnpm test:unit 2>&1 | grep -E "^ℹ tests"`
Expected: eine Zahl N notieren.

- [ ] **Step 2: Write the failing test**

`desktop/test/deeplink.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidFqdn, parseInviteDeepLink } from '../electron/deeplink.ts';

test('Self-Host-Einladung wie bisher', () => {
  assert.deepEqual(parseInviteDeepLink('pulse://invite?host=pulse.example.de&code=abc12345'), {
    hostname: 'pulse.example.de',
    code: 'abc12345'
  });
});

test('Cloud-Einladung: ohne Host', () => {
  assert.deepEqual(parseInviteDeepLink('pulse://invite?code=abc12345'), {
    hostname: '',
    code: 'abc12345'
  });
});

test('abgewiesen: falscher Host, falscher Code, fremdes Ziel', () => {
  for (const url of [
    'pulse://invite?host=192.168.1.1&code=abc12345',
    'pulse://invite?host=evil.example%5C%40victim.example&code=abc12345',
    'pulse://invite?code=abc',
    'pulse://invite?code=abc12345%20x',
    'pulse://anderes?code=abc12345',
    'https://howispulse.com/invite/abc12345',
    'kein link'
  ]) {
    assert.equal(parseInviteDeepLink(url), null, url);
  }
});

test('isValidFqdn bleibt streng', () => {
  assert.equal(isValidFqdn('pulse.example.de'), true);
  assert.equal(isValidFqdn('0x7f.0.0.1'), false);
});
```

In `desktop/package.json` im `test:unit`-Skript `test/deeplink.test.ts` an die Dateiliste anhängen.

Run: `cd desktop && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test test/deeplink.test.ts`
Expected: FAIL — `parseInviteDeepLink` ist kein Export.

- [ ] **Step 3: Implementierung**

In `desktop/electron/deeplink.ts`:
- Kopfkommentar Zeile 2 ändern in: `// Validates and dispatches \`pulse://invite?code=<code>[&host=<fqdn>]\` URLs (no host = Cloud).`
- Nach `extractPulseUrl` einfügen:

```ts
/**
 * Prüft `pulse://invite?code=<code>[&host=<fqdn>]`. Ohne `host` ist es eine
 * Cloud-Einladung (`hostname: ''`) — bis 0.1.97 war `host` Pflicht, und jede
 * Cloud-Einladung aus dem Browser wurde hier still verworfen. Mit `host` gilt
 * weiter `isValidFqdn`. null = verwerfen.
 */
export function parseInviteDeepLink(url: string): { hostname: string; code: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'pulse:' || parsed.hostname !== 'invite') return null;
  const host = parsed.searchParams.get('host') ?? '';
  const code = parsed.searchParams.get('code') ?? '';
  if (host !== '' && !isValidFqdn(host)) return null;
  if (!INVITE_CODE_RE.test(code)) return null;
  return { hostname: host, code };
}
```

- `seedPendingFromArgv` ersetzen durch:

```ts
(function seedPendingFromArgv(): void {
  const url = extractPulseUrl(process.argv);
  if (url) pendingInvitePayload = parseInviteDeepLink(url);
})();
```

- In `handleDeepLink` alles vom `let parsed: URL;` bis einschließlich der Prüfung `if (!INVITE_CODE_RE.test(code)) { … }` und der Zeile `const payload = { hostname: host, code };` ersetzen durch:

```ts
  const payload = parseInviteDeepLink(url);
  if (!payload) {
    // Bewusst ohne URL im Log: sie trägt den Einladungscode.
    console.warn('[deep-link] ungültiger Einladungslink, ignoriert');
    return;
  }
```

- In `desktop/electron/preload.ts` im Kommentar über `invite:` ergänzen: `hostname '' = Cloud-Einladung.`

- [ ] **Step 4: Run tests**

Run: `cd desktop && pnpm test:unit 2>&1 | grep -E "^ℹ (tests|fail)" && pnpm run build:electron 2>&1 | tail -1`
Expected: `tests` = N + 4, `fail 0`; Build ohne Fehler.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/deeplink.ts desktop/electron/preload.ts desktop/test/deeplink.test.ts desktop/package.json
git commit -m "feat(desktop): Einladungs-Deep-Link nimmt Cloud-Einladungen an

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: `pulse://` unter Linux und macOS anmelden, Version anheben

**Files:**
- Modify: `packaging/com.howispulse.Pulse.desktop`
- Modify: `desktop/electron-builder.yml`
- Modify: `desktop/package.json` (`version`)

- [ ] **Step 1: Linux (Flatpak)**

In `packaging/com.howispulse.Pulse.desktop`:
- `Exec=pulse` → `Exec=pulse %u` (der Launcher `packaging/launcher.sh` reicht `"$@"` an Electron durch; `extractPulseUrl` findet die URL in `argv`).
- Zeile ergänzen: `MimeType=x-scheme-handler/pulse;`

- [ ] **Step 2: macOS (und Windows-Installer)**

In `desktop/electron-builder.yml` auf oberster Ebene (nach `productName: Pulse`) ergänzen:

```yaml
# pulse://invite?code=…[&host=…] — der Sprung aus der Einladungsseite im
# Browser. macOS braucht das Schema im Info.plist (CFBundleURLTypes), sonst
# bleibt `setAsDefaultProtocolClient` wirkungslos; der NSIS-Installer trägt es
# zusätzlich in die Registry ein (zur Laufzeit tut es main.ts ohnehin).
protocols:
  - name: Pulse
    schemes:
      - pulse
```

- [ ] **Step 3: Version anheben**

Run: `git fetch -q origin && git show origin/main:desktop/package.json | grep '"version"'`
Dann in `desktop/package.json` `version` auf die **nächste** Version nach der auf `origin/main` setzen (Stand dieses Plans: `0.1.97` → `0.1.98`). Den Kommentar in `web/src/lib/platform/pulse.d.ts` aus Task 9 auf diese Version abgleichen.

- [ ] **Step 4: Prüfen**

Run: `cd desktop && pnpm run build:electron 2>&1 | tail -1 && pnpm test:unit 2>&1 | grep -E "^ℹ fail"`
Expected: Build ohne Fehler; `fail 0`.

Von Hand (nach dem CI-Bau der Pakete, Eigentümer oder auf den jeweiligen Rechnern):
- Windows: `pulse://invite?code=<Cloud-Code>` in die Adresszeile eines Browsers → Pulse geht auf, Dialog mit der Community. Dasselbe mit `&host=<Self-Host>`.
- Linux-Flatpak: `xdg-open 'pulse://invite?code=<Code>'` → dito; vorher `flatpak update` auf die neue Version.
- macOS: `open 'pulse://invite?code=<Code>'` → dito.
- App nicht angemeldet: Link öffnen → Login → nach dem Login erscheint der Dialog.

- [ ] **Step 5: Commit und Landen (nur mit Freigabe)**

```bash
git add packaging/com.howispulse.Pulse.desktop desktop/electron-builder.yml desktop/package.json web/src/lib/platform/pulse.d.ts
git commit -m "feat(desktop): pulse:// unter Linux und macOS anmelden — 0.1.98

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Gate → Simplifier/Stempel → Freigabe → `bash scripts/ship.sh`. Danach warten, bis `win-build.yml`, `mac-build.yml` und `flatpak.yml` grün sind und die Pakete veröffentlicht sind, **bevor** Task 17 landet.

---

### Task 17: Knopf „In der Desktop-App öffnen“

**Files:**
- Modify: `web/src/routes/invite/[code]/+page.svelte`
- Modify: `web/tests/e2e/einladungsseite.spec.ts`

**Interfaces:**
- Consumes: Karten-Props `appKnopf`, `appGeoeffnet`, `downloadUrl`, `onApp` (Task 4); `WINDOWS_INSTALLER_URL`, `MAC_DMG_URL`, `LINUX_FLATPAKREF_URL` aus `$lib/downloads/appDownloads`.

- [ ] **Step 1: E2E zuerst (failing)**

In `einladungsseite.spec.ts` nach „Unbekannter Code …“ ergänzen:

```ts
  test('Desktop-App-Knopf: die Seite bleibt stehen, der Hinweis erscheint', async () => {
    await bob.goto(link1);
    await expect(karte(bob, 'mitglied')).toBeVisible({ timeout: 15_000 });
    await bob.getByTestId('einladung-app').click();
    await expect(bob.getByText('Pulse wird geöffnet', { exact: false })).toBeVisible();
    await expect(bob).toHaveURL(/\/invite\//);
  });
```

Run: `cd web && PULSE_INSTANCE_MODE=cloud pnpm exec playwright test tests/e2e/einladungsseite.spec.ts -g "Desktop-App"`
Expected: FAIL — `einladung-app` nicht vorhanden.

- [ ] **Step 2: Seite verdrahten**

In `web/src/routes/invite/[code]/+page.svelte` im Skript ergänzen:

```ts
  import { isElectron, isLinux, isMac, isMobile, isWindows } from '$lib/platform/runtime';
  import {
    LINUX_FLATPAKREF_URL,
    MAC_DMG_URL,
    WINDOWS_INSTALLER_URL
  } from '$lib/downloads/appDownloads';

  // Nur im Browser am Rechner — nie in der App selbst, nie am Handy.
  const amRechnerImBrowser = !isElectron() && !isMobile();
  const appKnopf = $derived(
    amRechnerImBrowser && (zustand === 'einladung' || zustand === 'abgemeldet' || zustand === 'mitglied')
  );
  const downloadUrl = isWindows()
    ? WINDOWS_INSTALLER_URL
    : isMac()
      ? MAC_DMG_URL
      : isLinux()
        ? LINUX_FLATPAKREF_URL
        : null;
  let appGeoeffnet = $state(false);

  /** Startversuch über ein verstecktes iframe statt `location.href`: ohne
   *  installierte App ersetzt ein Browser die Seite sonst ggf. durch eine
   *  Fehlerseite, und der Hinweis „hier im Browser beitreten“ wäre weg. */
  function inDerApp() {
    if (!einladung) return;
    const params = new URLSearchParams({ code: einladung.code });
    if (einladung.host) params.set('host', einladung.host);
    const rahmen = document.createElement('iframe');
    rahmen.style.display = 'none';
    rahmen.src = `pulse://invite?${params.toString()}`;
    document.body.appendChild(rahmen);
    setTimeout(() => rahmen.remove(), 2000);
    appGeoeffnet = true;
  }
```

und an `<EinladungKarte …>` ergänzen: `{appKnopf} {appGeoeffnet} {downloadUrl} onApp={inDerApp}`.

- [ ] **Step 3: Prüfen**

Run: `cd web && pnpm check 2>&1 | tail -1 && PULSE_INSTANCE_MODE=cloud pnpm exec playwright test tests/e2e/einladungsseite.spec.ts`
Expected: `0 ERRORS 0 WARNINGS`; 7 passed.

Von Hand: Chrome, Edge und Firefox, jeweils mit und ohne installierte App — mit App geht Pulse auf und zeigt den Dialog; ohne App bleibt die Seite stehen und zeigt den Hinweis mit Download-Link. Weicht ein Browser ab, ist das ein Befund für den Eigentümer, kein Grund, den Knopf zu entfernen.

- [ ] **Step 4: Commit, Gate, Changelog, Landen**

```bash
git add "web/src/routes/invite/[code]/+page.svelte" web/tests/e2e/einladungsseite.spec.ts
git commit -m "feat(web): Einladung aus dem Browser in der Desktop-App öffnen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Simplifier/Stempel → Gate → Changelog (Stil wählen lassen) → Freigabe → `bash scripts/ship.sh`.

---

# Etappe 4 — `/c/<handle>` angleichen

### Task 18: Öffentliche Community-Adresse mit derselben Karte und demselben Rückweg

**Files:**
- Modify: `web/src/lib/einladung/einladungsLink.ts`, `web/test/einladung-link.test.ts`
- Modify: `web/src/lib/einladung/gemerkt.ts`, `web/test/einladung-gemerkt.test.ts`
- Modify: `web/src/lib/einladung/laden.ts`, `web/src/lib/einladung/EinladungDialog.svelte`
- Modify (ersetzt): `web/src/routes/c/[handle]/+page.svelte`

**Interfaces:**
- Produces:
  - `interface Adresse { handle: string; host: string | null }`, `type Ziel = Einladung | Adresse`, `istAdresse(z: Ziel): z is Adresse`, `istGueltigerHandle(h: string): boolean`
  - `einladungMerken(s, z: Ziel, jetzt)`, `gemerkteEinladung(s, jetzt): Ziel | null` (alte Einträge ohne `handle` bleiben Einladungen)
  - `ladeEinladung(z: Ziel)`, `ladeEinladungAbgemeldet(z: Ziel)`, `einladungAnnehmen(z: Ziel, bestaetigt)`
  - Dialog: `aktiv: Ziel | null`

- [ ] **Step 1: Failing tests**

An `web/test/einladung-link.test.ts` anhängen (Import um `istGueltigerHandle, istAdresse` erweitern):

```ts
test('Handle-Form wie parseJoinInput', () => {
  assert.equal(istGueltigerHandle('designrunde'), true);
  assert.equal(istGueltigerHandle('a'), true);
  assert.equal(istGueltigerHandle('-x'), false);
  assert.equal(istGueltigerHandle('Gross'), false);
  assert.equal(istGueltigerHandle('a'.repeat(33)), false);
});

test('istAdresse trennt Adresse und Einladung', () => {
  assert.equal(istAdresse({ handle: 'x', host: null }), true);
  assert.equal(istAdresse({ code: 'abc12345', host: null }), false);
});
```

An `web/test/einladung-gemerkt.test.ts` anhängen:

```ts
test('Adressen werden gemerkt; alte Einträge ohne Handle bleiben Einladungen', () => {
  const s = speicher();
  einladungMerken(s, { handle: 'designrunde', host: null }, T0);
  assert.deepEqual(gemerkteEinladung(s, T0), { handle: 'designrunde', host: null });
  s.daten.set(SPEICHER_SCHLUESSEL, JSON.stringify({ code: 'abc12345', host: null, gemerktAm: T0 }));
  assert.deepEqual(gemerkteEinladung(s, T0), { code: 'abc12345', host: null });
  s.daten.set(SPEICHER_SCHLUESSEL, JSON.stringify({ handle: 'Böse!', host: null, gemerktAm: T0 }));
  assert.equal(gemerkteEinladung(s, T0), null);
});
```

Run: `cd web && pnpm test:unit 2>&1 | grep -E "^ℹ fail"`
Expected: `fail` > 0.

- [ ] **Step 2: einladungsLink.ts erweitern**

Nach der `Einladung`-Schnittstelle ergänzen:

```ts
/** Öffentliche Community-Adresse `/c/<handle>[?host=<fqdn>]`. */
export interface Adresse {
  handle: string;
  host: string | null;
}

/** Was die Karte zeigen kann: eine Einladung (Code) oder eine Adresse (Handle). */
export type Ziel = Einladung | Adresse;

export function istAdresse(z: Ziel): z is Adresse {
  return 'handle' in z;
}

/** Handle-Form wie `parseJoinInput` (lib/guilds/joinByInvite.ts). */
const HANDLE_RE = /^(?:[a-z0-9][a-z0-9-]{0,30}[a-z0-9]|[a-z0-9])$/;

export function istGueltigerHandle(h: string): boolean {
  return HANDLE_RE.test(h);
}
```

- [ ] **Step 3: gemerkt.ts erweitern**

- Import: `import { istGueltigerCode, istGueltigerHandle, istGueltigerHost, type Ziel } from './einladungsLink.ts';`
- `einladungMerken(s: Speicher | null, z: Ziel, jetzt: number)` — schreibt `JSON.stringify({ ...z, gemerktAm: jetzt })`.
- `gemerkteEinladung(…): Ziel | null`.
- `lesen` ersetzen durch:

```ts
function lesen(roh: string, jetzt: number): Ziel | null {
  let d: unknown;
  try {
    d = JSON.parse(roh);
  } catch {
    return null;
  }
  if (typeof d !== 'object' || d === null) return null;
  const { code, handle, host, gemerktAm } = d as Record<string, unknown>;
  if (host !== null && (typeof host !== 'string' || !istGueltigerHost(host))) return null;
  if (typeof gemerktAm !== 'number') return null;
  const alter = jetzt - gemerktAm;
  if (!(alter >= 0 && alter < HALTBARKEIT_MS)) return null;
  // Einträge aus Etappe 1 tragen nur `code` — sie bleiben Einladungen.
  if (typeof handle === 'string') return istGueltigerHandle(handle) ? { handle, host } : null;
  if (typeof code === 'string' && istGueltigerCode(code)) return { code, host };
  return null;
}
```

- [ ] **Step 4: laden.ts erweitern**

Imports anpassen: `import { istAdresse, type Adresse, type Ziel } from './einladungsLink';` (ersetzt `import type { Einladung } …`) und `import type { PublicCommunityPreview } from '$lib/api/chat';`.

Neue Hilfsfunktionen (nach `cloudVorschau`):

```ts
function adressVorschau(p: PublicCommunityPreview): EinladungCommunity {
  return {
    name: p.guild.name,
    iconUrl: guildIconSrc(p.guild.icon_url, window.location.origin),
    mitglieder: p.member_count
  };
}

/** Öffentliche Adresse `/c/<handle>`: die Vorschau ist auf der Cloud ohne
 *  Anmeldung abrufbar. Self-Host-Adressen fragen wir vor der Zustimmung
 *  nicht (Spec, Sicherheit 2). */
async function ladeAdresse(a: Adresse, angemeldet: boolean): Promise<GeladeneEinladung> {
  const ohneVorschau = angemeldet ? 'einladung' : 'abgemeldet';
  if (a.host) return { zustand: ohneVorschau, ...LEER };
  try {
    const cloudId = serversStore.cloudId();
    const p = await chatApi.getPublicCommunityPreview(a.handle, cloudId ? { serverId: cloudId } : {});
    if (angemeldet) await guilds.hydrate().catch(() => {});
    const mitglied = angemeldet && !!guilds.byId[p.guild.id];
    return {
      zustand: !angemeldet ? 'abgemeldet' : mitglied ? 'mitglied' : 'einladung',
      community: adressVorschau(p),
      guildId: p.guild.id,
      fehler: null
    };
  } catch (err) {
    const f = fehlerAus(err);
    if (f === 'ungueltig') return { zustand: 'ungueltig', ...LEER };
    if (!angemeldet) return { zustand: 'abgemeldet', ...LEER };
    return { zustand: 'fehler', community: null, guildId: null, fehler: f };
  }
}
```

Die öffentlichen Funktionen nehmen ab jetzt `Ziel`; der Parametername `e` bleibt, damit der übrige Rumpf unverändert stehen kann — nach dem Wächter ist `e` für TypeScript wieder eine `Einladung`:

```ts
export async function ladeEinladung(e: Ziel): Promise<GeladeneEinladung> {
  if (istAdresse(e)) return ladeAdresse(e, true);
  // … übriger Rumpf aus Task 4 unverändert …
```

```ts
export async function ladeEinladungAbgemeldet(e: Ziel): Promise<GeladeneEinladung> {
  if (istAdresse(e)) return ladeAdresse(e, false);
  // … übriger Rumpf aus Task 14 unverändert …
```

`beitrittsEingabe` ersetzen:

```ts
function beitrittsEingabe(e: Ziel): string {
  if (istAdresse(e)) return e.host ? `https://${e.host}/c/${e.handle}` : `c/${e.handle}`;
  return e.host ? `https://app/invite/${e.code}?host=${encodeURIComponent(e.host)}` : e.code;
}
```

Und die Signatur von `einladungAnnehmen` auf `(e: Ziel, bestaetigt: boolean)` umstellen (Rumpf unverändert).

- [ ] **Step 5: Dialog und Deep-Link auf `Ziel` umstellen**

In `web/src/lib/einladung/EinladungDialog.svelte` den Import `type Einladung` durch `type Ziel` ersetzen und die drei Typangaben anpassen:

```ts
  let ausSpeicher = $state<Ziel | null>(null);
  const aktiv = $derived<Ziel | null>(ausUrl === 'kaputt' ? null : (ausUrl ?? ausSpeicher));
  async function laden(e: Ziel | null) {
```

`deepLink.ts` bleibt unverändert (Deep-Links tragen nur Codes; `{ code, host }` ist ein gültiges `Ziel`).

- [ ] **Step 6: `/c/` auf die Karte umstellen**

`web/src/routes/c/[handle]/+page.svelte` vollständig ersetzen durch:

```svelte
<!--
  /c/<handle>[?host=<fqdn>] — öffentliche Community-Adresse.

  Dieselbe Karte und derselbe Rückweg wie /invite/<code> (Spec 2026-10-10,
  Etappe 4). Bis dahin trat diese Seite nach dem Login automatisch bei
  (/login?pendingAddress=…); jetzt merkt sie die Adresse
  (lib/einladung/gemerkt.ts), und der Dialog im App-Layout fragt nach dem
  Login — Beitreten ist immer ein eigener Klick.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
  import AuthBuehne from '$lib/components/AuthBuehne.svelte';
  import SelfHostContactConfirmDialog from '$lib/components/server/SelfHostContactConfirmDialog.svelte';
  import EinladungKarte, {
    type EinladungCommunity,
    type EinladungZustand
  } from '$lib/einladung/EinladungKarte.svelte';
  import { istGueltigerHandle, zielHost, type Ziel } from '$lib/einladung/einladungsLink';
  import {
    browserSpeicher,
    einladungMerken,
    gemerkteEinladungVerwerfen
  } from '$lib/einladung/gemerkt';
  import {
    einladungAnnehmen,
    fehlerMeldung,
    ladeEinladung,
    ladeEinladungAbgemeldet
  } from '$lib/einladung/laden';

  const ziel = $derived.by((): Ziel | null => {
    const handle = (page.params.handle ?? '').toLowerCase();
    const host = zielHost(page.url.searchParams.get('host'), CLOUD_HOSTNAME);
    return istGueltigerHandle(handle) && host !== undefined ? { handle, host } : null;
  });

  let zustand = $state<EinladungZustand>('laden');
  let community = $state<EinladungCommunity | null>(null);
  let guildId = $state<string | null>(null);
  let hinweis = $state<string | null>(null);
  let busy = $state(false);
  let rueckfrage = $state(false);
  let lauf = 0;

  async function laden(z: Ziel | null) {
    const meiner = ++lauf;
    zustand = 'laden';
    community = null;
    guildId = null;
    hinweis = null;
    await auth.hydrate().catch(() => {});
    if (meiner !== lauf) return;
    if (!z) {
      zustand = 'ungueltig';
      return;
    }
    if (auth.user?.email_verification_pending) {
      zustand = 'email';
      return;
    }
    const r = auth.user ? await ladeEinladung(z) : await ladeEinladungAbgemeldet(z);
    if (meiner !== lauf) return;
    zustand = r.zustand;
    community = r.community;
    guildId = r.guildId;
    hinweis = r.zustand === 'fehler' && r.fehler ? fehlerMeldung(r.fehler, z.host) : null;
  }

  $effect(() => {
    const z = ziel;
    untrack(() => void laden(z));
  });

  function merkenUndWeiter(pfad: string) {
    if (ziel) einladungMerken(browserSpeicher(), ziel, Date.now());
    void goto(pfad);
  }

  async function beitreten(bestaetigt = false) {
    if (busy || !ziel) return;
    busy = true;
    hinweis = null;
    const r = await einladungAnnehmen(ziel, bestaetigt);
    busy = false;
    if (r.art === 'ok') gemerkteEinladungVerwerfen(browserSpeicher());
    else if (r.art === 'rueckfrage') rueckfrage = true;
    else hinweis = fehlerMeldung(r.fehler, ziel.host);
  }
</script>

<svelte:head>
  <title>{community?.name ?? 'Pulse'}</title>
</svelte:head>

<div class="relative flex min-h-dvh items-center justify-center overflow-hidden p-4">
  <AuthBuehne />
  <EinladungKarte
    {zustand}
    {community}
    host={ziel?.host ?? null}
    {hinweis}
    {busy}
    onBeitreten={() => beitreten()}
    onOeffnen={() => guildId && goto(`/app/guilds/${guildId}/channels/_`)}
    onAnmelden={() => merkenUndWeiter('/login')}
    onRegistrieren={() => merkenUndWeiter('/register')}
    onEmail={() => merkenUndWeiter('/verify-email-required')}
    onErneut={() => laden(ziel)}
    onZuPulse={() => goto('/app')}
  />
</div>

<SelfHostContactConfirmDialog
  open={rueckfrage}
  hostname={ziel?.host ?? ''}
  onConfirm={() => {
    rueckfrage = false;
    void beitreten(true);
  }}
  onCancel={() => (rueckfrage = false)}
/>
```

Die Behandlung von `pendingAddress` in `web/src/routes/login/+page.svelte` bleibt stehen, damit ein Login, der vor dem Deploy begonnen wurde, nicht ins Leere läuft; nach zwei Wochen in einem eigenen Schritt entfernen.

Die alten Test-IDs (`public-community-card`, `-name`, `-join`) entfallen mit der alten Seite. Einziger Nutzer: `web/tests/e2e/overnight-discovery-plugins.spec.ts`, Test „/c/<handle>: Karte zeigt den Community-Namen …“ (der Beitretende ist dort angemeldet). Dort ersetzen:

```ts
    await expect(joiner.getByTestId('public-community-card')).toBeVisible({ timeout: 15_000 });
    await expect(joiner.getByTestId('public-community-name')).toHaveText(GUILD_NAME);
    await joiner.getByTestId('public-community-join').click();
```

durch:

```ts
    await expect(
      joiner.locator('[data-testid=einladung-karte][data-zustand=einladung]')
    ).toBeVisible({ timeout: 15_000 });
    await expect(joiner.getByTestId('einladung-name')).toHaveText(GUILD_NAME);
    await joiner.getByTestId('einladung-beitreten').click();
```

Vorher `grep -rn "public-community-" web/tests/e2e web/src` — es darf danach keinen Treffer mehr geben.

- [ ] **Step 7: Prüfen**

Run: `cd web && pnpm check 2>&1 | tail -1 && pnpm test:unit 2>&1 | grep -E "^ℹ fail" && PULSE_INSTANCE_MODE=cloud pnpm exec playwright test tests/e2e/einladungsseite.spec.ts tests/e2e/overnight-discovery-plugins.spec.ts`
Expected: `0 ERRORS 0 WARNINGS`; `fail 0`; alle grün.

Von Hand: eine öffentliche Community (`/c/<handle>`) abgemeldet öffnen → Karte mit Name → „Anmelden“ → nach dem Login Dialog → „Beitreten“.

- [ ] **Step 8: Commit, Gate, Changelog, Landen**

```bash
git add web/src/lib/einladung web/test/einladung-link.test.ts web/test/einladung-gemerkt.test.ts "web/src/routes/c/[handle]/+page.svelte" web/tests/e2e/overnight-discovery-plugins.spec.ts
git commit -m "feat(web): öffentliche Community-Adresse mit derselben Einladungskarte

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Simplifier/Stempel → Gate → Changelog → Freigabe → `bash scripts/ship.sh`.
