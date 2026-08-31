# Zwischenablage Stufe 1b-1 — der Weg vom Player bis zum Gateway

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Rahmen der geteilten Zwischenablage reisen über den bestehenden `remote_signal`-Weg zwischen zwei Renderern, und auf der Seite des **Steuernden** hält der Player die lokale Ablage nach dem Muster des verzögerten Renderns.

**Architecture:** Neue Signalart `"ablage"`. Der Renderer **parst den Rahmen nicht** — er reicht ihn durch und routet nur nach Sitzung und Rolle, dieselbe Linie wie „der Gateway parst Frames nicht". Das Format lebt damit an genau einer Stelle im Baum (`pulse-ablage`). Auf der Steuernden-Seite besitzt der Player die Ablage; unter Wayland ist das kein Kunstgriff, sondern wie das Protokoll gedacht ist — und der Player hält das nötige `wl_data_device` bereits.

**Tech Stack:** Python/FastAPI (chat-gateway), TypeScript (SvelteKit-Renderer, Electron-Hauptprozess und Vorlader), Rust (`pulse-player`, `wayland-client` 0.31), die Kiste `pulse-ablage` aus Plan 1a.

**Spec:** `docs/superpowers/specs/2026-08-31-fernsteuerung-zwischenablage-design.md`

## Global Constraints

- **Der Renderer parst den Ablage-Rahmen NICHT.** Er kennt `session_id`, Rolle und Träger-Platz; die Nutzlast reicht er unverändert durch. Wer hier eine zweite Formatprüfung einzieht, baut die Sprachgrenzen-Falle nach, an der das Zeigerbild schon einmal durch beide Testnetze gerutscht ist.
- **`_SIGNAL_KINDS` (`services/chat-gateway/src/dcc_chat_gateway/routes/ws_remote_handlers.py:122`) und `RemoteSignalKind` (`web/src/lib/ws/handlers/types.ts:32`) sind synchron zu halten.** Beide Listen tragen denselben Kommentar-Hinweis.
- **Gateway-Grenzen, gegen die gerechnet wird:** `_SIGNAL_MAX_DATA_BYTES = 8 * 1024`, gemessen als `len(json.dumps(data, separators=(",",":")))`; `_SIGNAL_MAX_MESSAGES_PER_S = 60`, Überschreitung wird **still** verworfen.
- **Selbstdrosselung ist Pflicht des Senders:** höchstens **30 Stücke/s**, damit Zeigerform und Vorrang auf demselben Zähler Platz behalten. Ein ungebremster Schwall verschwindet spurlos und sieht wie ein Netzfehler aus.
- **`web/src/lib/platform/pulse.d.ts` und `desktop/electron/preload.ts` sind synchron zu halten.**
- **`pnpm test:unit` (Nodes eingebauter Läufer, kein Vitest):** eine geprüfte Datei darf **keinen erweiterungslosen Laufzeit-Import** haben. Reine Rechnung gehört in ein importfreies Modul (Muster: `lib/remote/zeigerbildPruefung.ts`).
- **Größen-Policy:** Quelldateien ≤ 350 Zeilen (hart 500), Svelte-Komponenten ≤ 250. Tests und `lib/components/ui/` ausgenommen.
- **Kein Changelog-Eintrag** — das Merkmal hängt an `REMOTE_CONTROL` (Bit 37), das nicht in `DEFAULT_EVERYONE_PERMISSIONS` steht.
- **Deutsche Bezeichner** für neuen Code in `streaming/pulse-*` und `web/src/lib/remote/`; im Rust-Code ASCII-Schreibung (ae/oe/ue), in Markdown echte Umlaute. **Keine Emojis.**
- **Keine neuen Abhängigkeiten.**
- **Kein `git push`** ohne Freigabe.

## Was dieser Plan NICHT tut

Er baut **keine Host-Seite**. Der Windows-Sidecar (Ops, `HWND_MESSAGE`-Faden, Trägerwahl unter mehreren Plätzen, Versions-Bump, Pfad-Filter in den Workflows) ist Plan 1b-2; macOS ist Plan 1c. Nach diesem Plan kann der Steuernde seine Ablage anbieten und beanspruchen — es gibt nur noch keine Gegenstelle, die antwortet.

**Grund für den Schnitt:** der Windows-Sidecar baut auf der Entwicklungsmaschine nachweislich nicht (`scripts/bootstrap-windows-capture.sh` scheitert an gemischten Zeilenenden, und `cargo check --target x86_64-pc-windows-msvc` bricht danach an C-Abhängigkeiten ab). Alles in diesem Plan ist hier beweisbar; nichts davon muss auf Zuruf geglaubt werden.

## Ein Fund, der in 1b-2 gehört, aber hier schon notiert wird

**Der Windows-Sidecar ist per-Stream und beendet sich nach `stop`** (`streaming/win-hq-sidecar/src/dispatch.rs`: ein treiber-interner Threadpool-Timer bringt den Prozess sonst mit einer Access Violation um; Electron spawnt für den nächsten Stream einen frischen). Ein Ablage-Eigentümer in diesem Prozess stirbt also mit dem Stream. Das deckt sich zufällig mit der Sitzungsdauer — **aber die Trägerwahl muss neu greifen, wenn ausgerechnet der Träger-Stream endet, während ein anderer Platz weiterläuft.** Der Linux-Sidecar bleibt im Gegensatz dazu über Streams hinweg warm.

---

### Task 1: Gateway lässt `"ablage"` durch

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/ws_remote_handlers.py:122`
- Test: `services/chat-gateway/tests/test_remote_handlers.py`

**Interfaces:**
- Consumes: nichts
- Produces: die Signalart `"ablage"` passiert `handle_signal` wie `zeiger` und `vorrang` — peer-gebunden an die aktive Sitzung, 8 KiB je Nachricht, 60/s.

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

An `services/chat-gateway/tests/test_remote_handlers.py` anfügen. Das Muster für Aufbau und Hilfsfunktionen steht in derselben Datei bei den bestehenden `remote_signal`-Tests — übernimm es von dort statt es neu zu erfinden:

```python
async def test_signal_ablage_wird_weitergereicht(ws_app, remote_session):
    """Die Zwischenablage reitet auf demselben Weiterleiter wie Zeigerform und
    Vorrang: derselbe Empfaenger, dieselbe Bindung an die per Consent
    bestaetigte Sitzung, derselbe Deckel. Ohne diesen Eintrag verwirft der
    Gateway sie mit 4050, und zwar fuer BEIDE Richtungen."""
    host, controller, session_id = remote_session
    await controller.send_json(
        {
            "op": "remote_signal",
            "session_id": session_id,
            "kind": "ablage",
            "data": {"t": "neu", "gen": 1, "typ": "text"},
        }
    )
    frame = await host.receive_json()
    assert frame["op"] == "remote_signal"
    assert frame["kind"] == "ablage"
    assert frame["data"] == {"t": "neu", "gen": 1, "typ": "text"}


async def test_signal_ablage_ueber_dem_deckel_wird_abgelehnt(ws_app, remote_session):
    """Der Deckel gilt fuer die neue Art wie fuer jede andere — sonst waere sie
    ein Loch in einer Grenze, die fuer alle anderen gilt."""
    host, controller, session_id = remote_session
    await controller.send_json(
        {
            "op": "remote_signal",
            "session_id": session_id,
            "kind": "ablage",
            "data": {"t": "stueck", "id": 1, "i": 0, "n": 1, "d": "x" * 9000},
        }
    )
    antwort = await controller.receive_json()
    assert antwort["code"] == 4050
```

Passe Fixture-Namen und Aufbau an das an, was in der Datei bereits existiert — die Namen oben sind ein Vorschlag, nicht die Wahrheit über die Datei.

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_remote_handlers.py -q -k ablage`
Expected: FAIL — der erste Test bekommt `4050 session_id, kind and data required`, weil `"ablage"` nicht in der Prüfliste steht.

- [ ] **Step 3: Die Art eintragen**

In `ws_remote_handlers.py`, die Liste bei Zeile 122 und ihren Kommentar darüber:

```python
_SIGNAL_KINDS = ("offer", "answer", "ice", "vorrang", "zeiger", "zeiger_im_bild", "ablage")
```

Den bestehenden Erklärkommentar über der Liste um einen Absatz ergänzen:

```python
# ``ablage`` traegt die geteilte Zwischenablage (``streaming/pulse-ablage``).
# Sie reitet aus denselben Gruenden hier mit wie ``zeiger``: derselbe
# Empfaenger, dieselbe Bindung an die per Consent bestaetigte Sitzung,
# derselbe Deckel. **Der Gateway parst den Rahmen nicht** — beim Kopieren
# traegt er ohnehin keinen Inhalt, und beim Abruf ist der Inhalt genau das,
# was hier niemanden angeht. Er zaehlt nur mit und reicht durch.
```

- [ ] **Step 4: Tests laufen lassen, Grün bestätigen**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_remote_handlers.py -q`
Expected: PASS, alle Tests der Datei.

**Wenn WS-Tests lokal crashen:** `PULSE_INSTANCE_MODE=cloud` setzen — sonst greift der self-host-Guard im Lifespan.

- [ ] **Step 5: Commit**

```bash
git add services/chat-gateway
git commit -m "feat(gateway): Signalart ablage fuer die geteilte Zwischenablage

Reitet aus denselben Gruenden auf dem remote_signal-Weiterleiter mit wie
Zeigerform und Vorrang: derselbe Empfaenger, dieselbe Bindung an die per
Consent bestaetigte Sitzung, derselbe Deckel. Der Gateway parst den
Rahmen nicht — beim Kopieren traegt er keinen Inhalt, und beim Abruf ist
der Inhalt genau das, was ihn nichts angeht."
```

---

### Task 2: Renderer — Typ, Weiterleiter, Drossel

**Files:**
- Modify: `web/src/lib/ws/handlers/types.ts:32`
- Modify: `web/src/lib/ws/handlers/remote.ts:93`
- Create: `web/src/lib/remote/ablageDrossel.ts` (**importfrei**)
- Create: `web/src/lib/remote/ablage.ts`
- Create: `web/test/ablage-drossel.test.ts`

**Interfaces:**
- Consumes: `RemoteSignalKind` aus Task 1 dieser Ebene (Gateway) — die TS-Seite muss dieselbe Zeichenkette `'ablage'` führen.
- Produces:
  - `web/src/lib/remote/ablageDrossel.ts`: `export const STUECKE_PRO_SEKUNDE = 30`, `export class Drossel { constructor(proSekunde?: number); darf(jetztMs: number): boolean; }`
  - `web/src/lib/remote/ablage.ts`: `export const remoteAblage` mit `start(rolle: 'host' | 'controller', sendSignal: (kind: RemoteSignalKind, data: unknown) => boolean): void`, `stop(): void`, `_signal(data: unknown): void`, `hinaus(data: unknown): boolean`

- [ ] **Step 1: Den fehlschlagenden Test für die Drossel schreiben**

`web/test/ablage-drossel.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Drossel, STUECKE_PRO_SEKUNDE } from '../src/lib/remote/ablageDrossel.ts';

test('die Drossel bleibt unter dem Sekundendeckel des Gateways', () => {
  // Der Gateway verwirft ueber 60 Signale je Sekunde STILL. Auf demselben
  // Zaehler sitzen Zeigerform und Vorrang; deshalb nimmt die Ablage nur die
  // Haelfte. Ein Schwall verschwaende sonst spurlos und saehe wie ein
  // Netzfehler aus.
  assert.ok(STUECKE_PRO_SEKUNDE <= 30, `${STUECKE_PRO_SEKUNDE} laesst dem Rest keinen Platz`);
  const d = new Drossel();
  let durch = 0;
  for (let i = 0; i < 200; i++) if (d.darf(1000 + i)) durch++;
  assert.ok(durch <= STUECKE_PRO_SEKUNDE, `${durch} in einer Sekunde durchgelassen`);
});

test('nach der Sekunde geht es weiter', () => {
  const d = new Drossel();
  for (let i = 0; i < 200; i++) d.darf(1000 + i);
  assert.equal(d.darf(2500), true, 'ein neues Fenster muss wieder oeffnen');
});

test('die Drossel misst an der uebergebenen Zeit, nicht an der Uhr', () => {
  // Wichtig fuer die Pruefbarkeit UND fuer den Betrieb: Chromium drosselt
  // Zeitgeber in verdeckten Fenstern auf einen Lauf je Minute. Wer hier
  // `Date.now()` selbst riefe, haette im verdeckten Player-Fenster eine
  // Drossel, die nie oeffnet.
  const d = new Drossel(2);
  assert.equal(d.darf(0), true);
  assert.equal(d.darf(0), true);
  assert.equal(d.darf(0), false);
  assert.equal(d.darf(1000), true);
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd web && pnpm test:unit`
Expected: FAIL — `Cannot find module '../src/lib/remote/ablageDrossel.ts'`.

- [ ] **Step 3: Die Drossel schreiben**

`web/src/lib/remote/ablageDrossel.ts` — **keine Importe, auch keine Typ-Importe**, sonst fällt sie aus `pnpm test:unit`:

```ts
/**
 * Selbstdrosselung des Ablage-Senders.
 *
 * **Der Gateway verwirft über 60 Signale je Sekunde STILL** (kein Fehlercode,
 * keine Antwort — `ws_remote_handlers.py::handle_signal`). Auf demselben Zähler
 * sitzen Zeigerform und Vorrang, die je Sekunde auffrischen. Ein ungebremster
 * Schwall Ablage-Stücke verschwände deshalb spurlos und sähe von aussen wie ein
 * Netzfehler aus — dieselbe Pflicht, die die Wire-Spec dem Steuernden für
 * Eingaben schon normativ auferlegt.
 *
 * **Importfrei mit Absicht** — `pnpm test:unit` fährt Nodes eingebauten Läufer,
 * und der löst einen erweiterungslosen Laufzeit-Import nicht auf.
 */

/** Höchstens so viele Stücke je Sekunde. Die Hälfte des Gateway-Deckels: die
 *  andere Hälfte gehört Zeigerform, Vorrang und dem ICE-Schwall. */
export const STUECKE_PRO_SEKUNDE = 30;

/** Ein gleitendes Ein-Sekunden-Fenster. */
export class Drossel {
  #grenze: number;
  #fensterBeginnMs = -Infinity;
  #imFenster = 0;

  constructor(proSekunde: number = STUECKE_PRO_SEKUNDE) {
    this.#grenze = proSekunde;
  }

  /**
   * Darf jetzt ein Stück hinaus? `jetztMs` wird **übergeben**, nicht selbst
   * geholt: Chromium drosselt Zeitgeber in verdeckten Fenstern auf einen Lauf
   * je Minute, und eine Drossel, die ihre eigene Uhr liest, öffnete dort nie.
   */
  darf(jetztMs: number): boolean {
    if (jetztMs - this.#fensterBeginnMs >= 1000) {
      this.#fensterBeginnMs = jetztMs;
      this.#imFenster = 0;
    }
    if (this.#imFenster >= this.#grenze) return false;
    this.#imFenster++;
    return true;
  }
}
```

- [ ] **Step 4: Test laufen lassen, Grün bestätigen**

Run: `cd web && pnpm test:unit`
Expected: PASS, die drei neuen Tests laufen namentlich mit.

- [ ] **Step 5: Typ und Weiterleiter eintragen**

`web/src/lib/ws/handlers/types.ts:32` — die Art anhängen:

```ts
export type RemoteSignalKind =
  | 'offer'
  | 'answer'
  | 'ice'
  | 'vorrang'
  | 'zeiger'
  | 'zeiger_im_bild'
  | 'ablage';
```

`web/src/lib/ws/handlers/remote.ts` — beim bestehenden Verteiler (Zeile ~93) einen Zweig ergänzen, im selben Stil wie die Nachbarzeilen:

```ts
    else if (evt.kind === 'ablage') remoteAblage._signal(evt.data);
```

samt dem passenden Import oben.

- [ ] **Step 6: Den Weiterleiter schreiben**

`web/src/lib/remote/ablage.ts`:

```ts
/**
 * Fernsteuerung — geteilte Zwischenablage, Renderer-Hälfte.
 *
 * **Dieses Modul parst den Rahmen NICHT.** Es kennt Sitzung und Rolle und
 * reicht die Nutzlast unverändert durch: hinaus an den Gateway, herein an die
 * Plattform-Brücke. Dieselbe Linie wie „der Gateway parst Frames nicht" — und
 * derselbe Grund: das Format lebt an genau einer Stelle im Baum
 * (`streaming/pulse-ablage`). Eine zweite Prüfung hier wäre die Sprachgrenze,
 * an der das Zeigerbild schon einmal durch beide Testnetze gerutscht ist: die
 * Rust-Seite hielt die Kurzform fest, die TS-Seite verlangte die Langform,
 * beide grün, niemand sah hinüber.
 *
 * **Was hier sehr wohl passiert:** die Selbstdrosselung
 * (`ablageDrossel.ts`) — sie ist Pflicht des Senders, weil der Gateway
 * Überzähliges still verwirft.
 *
 * Rolle: **beide** Seiten tun dasselbe. Anders als bei `zeigerform.ts` (nur der
 * Host meldet) und `vorrang.ts` (nur der Host meldet) ist die Zwischenablage
 * symmetrisch — jede Seite kündigt an und jede Seite ruft ab.
 */

import type { RemoteSignalKind } from '$lib/ws/handlers/types';
import { Drossel } from './ablageDrossel';
import { ablageAnPlayer, aufAblageEreignisse } from './ablagePlatform';

type SignalSender = (kind: RemoteSignalKind, data: unknown) => boolean;

class RemoteAblage {
  #sendSignal: SignalSender | null = null;
  #abmelden: (() => void) | null = null;
  #drossel = new Drossel();

  start(_rolle: 'host' | 'controller', sendSignal: SignalSender): void {
    this.#sendSignal = sendSignal;
    // Die Plattform-Brücke meldet, was ihr Ende hinausschicken will. Im
    // Browser und in einer älteren Shell gibt es sie nicht — dann bleibt es
    // still, wie überall in dieser Schicht.
    this.#abmelden = aufAblageEreignisse((data) => this.hinaus(data));
  }

  stop(): void {
    this.#abmelden?.();
    this.#abmelden = null;
    this.#sendSignal = null;
    this.#drossel = new Drossel();
  }

  /** Ein `remote_signal` der Art 'ablage' vom Gegenüber. Ungeprüft weiter an
   *  die Plattform — sie hat den Parser. */
  _signal(data: unknown): void {
    if (data === null || data === undefined) return;
    void ablageAnPlayer(data);
  }

  /** Ein Rahmen der eigenen Seite hinaus. `false`, wenn er die Drossel nicht
   *  passiert hat oder keine Sitzung läuft — der Aufrufer wiederholt ihn
   *  dann selbst, statt ihn still zu verlieren. */
  hinaus(data: unknown): boolean {
    if (!this.#sendSignal) return false;
    if (!this.#drossel.darf(Date.now())) return false;
    return this.#sendSignal('ablage', data);
  }
}

export const remoteAblage = new RemoteAblage();
```

`web/src/lib/remote/ablagePlatform.ts` — die dünne Brücke, gebaut wie `sidecarInput.ts` (im Browser still, nicht werfend):

```ts
/**
 * Ablage — Renderer zur Plattform-Brücke.
 *
 * Gebaut wie `sidecarInput.ts`: im Browser und in einer älteren Shell liefert
 * jede Funktion still ein Ergebnis, statt zu werfen. Der Unterschied zur
 * Eingabe ist die Bedeutung: eine verlorene Ablage-Nachricht kostet ein
 * Einfügen, keine Sitzung.
 */

function bruecke() {
  return typeof window !== 'undefined' ? window.pulse?.gsr : undefined;
}

/** Einen Ablage-Rahmen an die eigene Plattform geben (Player beim Steuernden,
 *  Sidecar beim Host — die Weiche steht im Hauptprozess). */
export async function ablageAnPlayer(data: unknown): Promise<boolean> {
  const b = bruecke();
  if (typeof b?.ablage !== 'function') return false;
  try {
    const antwort = (await b.ablage(data)) as { ok?: boolean } | undefined;
    return antwort?.ok === true;
  } catch {
    return false;
  }
}

/** Was die eigene Plattform hinausschicken will. Liefert den Abmelder, oder
 *  `null`, wenn es die Brücke nicht gibt. */
export function aufAblageEreignisse(cb: (data: unknown) => void): (() => void) | null {
  // **`player.onEvent`, nicht `gsr.onEvent`** — nachgemessen am 2026-08-31:
  // `gsr.onEvent` hört auf `gsr:event` (die Capture-Sidecars), die Ereignisse
  // des Players kommen über `player:event`. Eine frühere Fassung dieses Plans
  // nannte hier `gsr` und wäre stillschweigend taub geblieben.
  const b = typeof window !== 'undefined' ? window.pulse?.player : undefined;
  if (typeof b?.onEvent !== 'function') return null;
  return b.onEvent((ev: unknown) => {
    const m = ev as { ev?: unknown; data?: unknown } | null;
    if (m?.ev !== 'ablage') return;
    if (m.data === undefined) return;
    cb(m.data);
  });
}
```

- [ ] **Step 7: Prüfen und übersetzen**

Run: `cd web && pnpm check && pnpm test:unit`
Expected: PASS. `pnpm check` meldet noch fehlende Felder an `window.pulse.gsr` — die kommen in Task 3; **läuft Task 3 nicht unmittelbar danach, ist dieser Zwischenstand nicht committbar**. Führe Task 2 und 3 deshalb hintereinander aus und committe einmal am Ende von Task 3.

- [ ] **Step 8: Kein Commit hier**

Task 2 und Task 3 teilen sich einen Commit — die Typdatei `pulse.d.ts` gehört zu Task 3, und ohne sie übersetzt Task 2 nicht.

---

### Task 3: Electron — Whitelist, Vorlader, Typen

**Files:**
- Modify: `desktop/electron/main.ts:922` (`ALLOWED_PLAYER_OPS`)
- Modify: `desktop/electron/preload.ts` (im `gsr`-Block)
- Modify: `web/src/lib/platform/pulse.d.ts`
- Create: `desktop/electron/ablageWeiche.ts`
- Create: `desktop/test/ablage-weiche.test.ts`

**Interfaces:**
- Consumes: `remoteAblage`/`ablagePlatform` aus Task 2 erwarten `window.pulse.gsr.ablage(data)` und ein `player:event` mit `{ ev: 'ablage', data }`.
- Produces:
  - `window.pulse.gsr.ablage(rolle: 'host' | 'controller', session: number, data: unknown): Promise<{ ok: boolean; error?: string }>`
  - `desktop/electron/ablageWeiche.ts`: `export function rolleLesen(roh: unknown): 'host' | 'controller' | null`
  - `desktop/electron/ablageWeiche.ts`: `export function zielFuerAblage(rolle: 'host' | 'controller'): 'player' | 'sidecar'`

- [ ] **Step 1: Den fehlschlagenden Test der Weiche schreiben**

`desktop/test/ablage-weiche.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zielFuerAblage } from '../electron/ablageWeiche.ts';

test('der Steuernde haelt seine Ablage im Player', () => {
  // Beim Steuernden laeuft KEIN Sidecar — nur das Player-Fenster. Waere die
  // Weiche hier falsch, ginge jeder Rahmen an einen Prozess, den es nicht
  // gibt, und die Ablage bliebe stumm.
  assert.equal(zielFuerAblage('controller'), 'player');
});

test('der Host haelt sie im Sidecar', () => {
  // Beim Host ist das Player-Fenster gar nicht offen; die Ablage gehoert dem
  // Prozess, der auch die Eingabe injiziert.
  assert.equal(zielFuerAblage('host'), 'sidecar');
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd desktop && pnpm test:unit`
Expected: FAIL — `Cannot find module '../electron/ablageWeiche.ts'`.

- [ ] **Step 3: Die Weiche schreiben**

`desktop/electron/ablageWeiche.ts`:

```ts
/**
 * Wohin ein Ablage-Rahmen im Hauptprozess geht.
 *
 * **Die Weiche steht hier und nicht im Renderer**, aus demselben Grund wie bei
 * `input_capture`: sie ist eine Zuordnung zwischen Prozessen, und die gehört
 * dem Hauptprozess. Der Renderer kennt die Rolle, nicht die Prozesse.
 *
 * Der Unterschied ist keine Feinheit: **beim Steuernden läuft überhaupt kein
 * Sidecar** — dort ist nur das Player-Fenster offen. Beim Host ist es
 * umgekehrt.
 *
 * Eigene Datei und importfrei, damit `pnpm test:unit` sie fahren kann.
 */

/** Welcher Prozess die lokale Zwischenablage dieser Rolle hält. */
export function zielFuerAblage(rolle: 'host' | 'controller'): 'player' | 'sidecar' {
  return rolle === 'controller' ? 'player' : 'sidecar';
}
```

- [ ] **Step 4: Test laufen lassen, Grün bestätigen**

Run: `cd desktop && pnpm test:unit`
Expected: PASS.

- [ ] **Step 5: Whitelist, Vorlader und Typen nachziehen**

`desktop/electron/main.ts` — `'ablage'` in `ALLOWED_PLAYER_OPS` aufnehmen, mit einer Begründung im bestehenden Kommentarblock darüber:

```ts
  // `ablage` darf ueber den generischen Kanal: der Hauptprozess reicht den
  // Rahmen unveraendert durch und deutet ihn nicht. Er traegt beim Kopieren
  // keinen Inhalt (nur eine Ankuendigung), und beim Abruf ist der Inhalt
  // genau das, was hier niemanden angeht — anders als `input_capture`, das
  // zugleich eine Zuordnung anlegt und deshalb im Hauptprozess bleibt.
  'ablage',
```

`desktop/electron/preload.ts` — im `gsr`-Block, neben `pointerShape`:

```ts
    /** Fernsteuerung: ein Rahmen der geteilten Zwischenablage
     *  (`$lib/remote/ablage.ts`). Der Vorlader deutet ihn nicht — das Format
     *  lebt in `streaming/pulse-ablage`, und eine zweite Fassung hier liefe
     *  auseinander. Beim Steuernden landet er im Player, beim Host im Sidecar;
     *  die Weiche steht im Hauptprozess (`ablageWeiche.ts`). */
    ablage: (rolle: 'host' | 'controller', session: number, data: unknown) =>
      ipcRenderer.invoke('gsr:ablage', rolle, session, data),
```

`web/src/lib/platform/pulse.d.ts` — dieselbe Signatur eintragen (**die beiden Dateien sind synchron zu halten**).

**Die Rolle wird ÜBERGEBEN, nicht erschlossen.** Eine Ableitung aus der
Sitzungsnummer (`session > 0 ⇒ Steuernder`) trifft nur, solange kein Host
nebenbei den Strom eines Dritten im nativen Player anschaut — dann trägt auch er
eine Nummer, und ein hereinkommender Rahmen landete im falschen, unbeteiligten
Fenster statt beim Sidecar. Der Renderer **kennt** seine Rolle aus
`remoteAblage.start(rolle, …)`; er gibt sie mit.

Dass sie vom Renderer kommt, ist hier zulässig — anders als bei `input_capture`,
das seine Zuordnung bewusst im Hauptprozess hält: jenes autorisiert eine
Eingabe-Injektion, das ist eine Sicherheitsentscheidung. Diese Weiche entscheidet
nur, **welcher der eigenen lokalen Prozesse** die Ablage hält; eine falsche Rolle
kostet ein fehlgeleitetes Einfügen, keine Befugnis. Ohne diesen Satz härtet die
Stelle irgendwann jemand „zur Sicherheit" wieder zu einer Rateregel zurück.

Im Hauptprozess einen `ipcMain.handle('gsr:ablage', …)` anlegen, der die Rolle
über `rolleLesen` prüft (alles Unbekannte → `{ ok: false }`, fail-closed), dann
über `zielFuerAblage` entscheidet und an `playerManager.call('ablage', { data })` bzw. an den Sidecar weiterreicht. Die Sidecar-Hälfte darf in diesem Plan ein `{ ok: false, error: 'kein Host-Sidecar in 1b-1' }` liefern — sie kommt in Plan 1b-2.

- [ ] **Step 6: Alles prüfen**

Run: `cd web && pnpm check && pnpm test:unit` und `cd desktop && pnpm run build:electron && pnpm test:unit`
Expected: beides grün, keine Typfehler.

- [ ] **Step 7: Commit (Task 2 und 3 gemeinsam)**

```bash
git add web/src/lib/remote web/src/lib/ws web/src/lib/platform web/test desktop/electron desktop/test
git commit -m "feat(ablage): Renderer-Weiterleiter, Drossel und Electron-Bruecke

Der Renderer parst den Ablage-Rahmen NICHT — er kennt Sitzung und Rolle
und reicht die Nutzlast durch. Dieselbe Linie wie beim Gateway, und
derselbe Grund: das Format lebt an genau einer Stelle im Baum. Eine
zweite Fassung hier waere die Sprachgrenze, an der das Zeigerbild schon
einmal durch beide Testnetze gerutscht ist.

Was hier sehr wohl passiert, ist die Selbstdrosselung: der Gateway
verwirft ueber 60 Signale je Sekunde STILL, und auf demselben Zaehler
sitzen Zeigerform und Vorrang. Die Drossel misst an einer uebergebenen
Zeit statt an der eigenen Uhr — Chromium drosselt Zeitgeber in
verdeckten Fenstern auf einen Lauf je Minute."
```

---

### Task 4: Player — Op, Ereignis und die Wayland-Umsetzung

**Files:**
- Modify: `streaming/pulse-player/Cargo.toml` (Pfad-Abhängigkeit `pulse-ablage`)
- Modify: `streaming/pulse-player/src/proto.rs` (zwei optionale Felder an `Request`)
- Modify: `streaming/pulse-player/src/app/mod.rs` (Op-Zweig)
- Create: `streaming/pulse-player/src/app/ablage.rs`
- Create: `streaming/pulse-player/src/fernsteuerung/wayland/ablage.rs`
- Modify: `streaming/pulse-player/src/fernsteuerung/wayland/mod.rs`

**Interfaces:**
- Consumes: `pulse_ablage::{format::Rahmen, sitzung::{Ankuendiger, Empfaenger, Fortschritt}, beobachter::Beobachter, eigentum::{Eigentum, Anspruch}}`
- Produces: Player-Op `ablage` mit `{ session, data }`; Player-Ereignis `{"ev":"ablage","session":<id>,"data":<rahmen>}` auf stdout.

- [ ] **Step 1: Abhängigkeit und Zusammenspiel prüfen**

Run: `command grep -rn "pulse-ablage" --include=Cargo.toml streaming/`
Expected: noch kein Treffer — dieser Plan macht `pulse-player` zum **ersten** Verbraucher.

`streaming/pulse-player/Cargo.toml` um die Pfad-Abhängigkeit ergänzen, neben `pulse-fernsteuerung`:

```toml
pulse-ablage = { path = "../pulse-ablage" }
```

**Danach laufen zwei Prüfsteine scharf, die vorher nichts zu prüfen hatten:**
`streaming/zwillinge/tests/bau_ausloeser.rs` und `flatpak_kisten.rs` leiten aus den `Cargo.toml` der Programme ab, welche Kisten in den Pfad-Filtern von `win-build.yml`/`mac-build.yml`/`flatpak.yml` und als `type: dir` im Flatpak-Manifest stehen müssen. Fahre sie:

Run: `cd streaming/zwillinge && cargo test -q`
Expected: **FAIL** — und das ist der Beweis, dass die Prüfsteine greifen. Trage `streaming/pulse-ablage/**` in die drei Workflow-Pfadfilter und `packaging/com.howispulse.Pulse.yml` ein, bis sie grün sind.

- [ ] **Step 2: Den fehlschlagenden Test für die Op-Verdrahtung schreiben**

In `streaming/pulse-player/src/app/ablage.rs`, Testmodul am Dateiende:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ein_rahmen_ohne_sitzung_wird_abgewiesen() {
        // Fail-closed wie im ganzen Fernsteuerungs-Weg: ein Rahmen ohne
        // zugeordnete Sitzung gehoert niemandem.
        assert!(rahmen_lesen(&serde_json::json!({"t": "neu", "gen": 1, "typ": "text"})).is_some());
        assert!(rahmen_lesen(&serde_json::json!({"t": "erfunden"})).is_none());
    }

    #[test]
    fn ein_hinausgehender_rahmen_traegt_die_sitzung() {
        let ev = ablage_ereignis(7, &Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text });
        let v = serde_json::to_value(&ev).expect("serialisierbar");
        assert_eq!(v["ev"], "ablage");
        assert_eq!(v["session"], 7);
        assert_eq!(v["data"]["t"], "neu");
        // Der Renderer routet nach Sitzung; ohne sie landete der Rahmen im
        // falschen Fenster, sobald zwei Sitzungen laufen.
        assert!(v["session"].is_number());
    }
}
```

- [ ] **Step 3: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd streaming/pulse-player && FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared LD_LIBRARY_PATH=$PWD/ffmpeg-dist/n8.1-lgpl-shared/lib cargo test --bins -q ablage`
Expected: FAIL — die Datei existiert noch nicht.

**Ohne `FFMPEG_DIR` zieht `ffmpeg-next` die zu neue System-FFmpeg und bricht an nicht abgedeckten Enum-Werten ab; ohne `LD_LIBRARY_PATH` übersetzt es, aber die Testbinaries finden `libavcodec.so.62` nicht und sterben mit Exit 127.** Beides sieht wie ein kaputter Test aus und ist keiner. Auf dem Mac liegt FFmpeg woanders (`PKG_CONFIG_PATH=$HOME/src/ffmpeg-openssl/lib/pkgconfig`).

- [ ] **Step 4: Die Player-Seite schreiben**

`streaming/pulse-player/src/app/ablage.rs` trägt:

- `pub(super) fn rahmen_lesen(v: &serde_json::Value) -> Option<Rahmen>` — dünne Hülle um `Rahmen::aus_json`, damit ein kaputter Rahmen still verworfen wird statt die Sitzung zu beenden (ein Ablage-Rahmen ist es nicht wert).
- `pub(super) fn ablage_ereignis(id: u64, r: &Rahmen) -> Event` — wie `eingabe_ereignis` in `app/eingabe.rs:428` gebaut, nur mit `"ablage"` und `data`.
- `pub(super) fn ablage(&mut self, req: &Request) -> Result<(), String>` an der `App` — Sitzung prüfen (`self.sessions.contains_key`), Rahmen lesen, an die Wayland-Seite geben.

`streaming/pulse-player/src/proto.rs`: zwei optionale Felder an `Request`, mit `#[serde(default)]` wie die Nachbarn:

```rust
    // --- ablage ---
    /// Ein Rahmen der geteilten Zwischenablage, unveraendert vom Renderer
    /// durchgereicht. Gedeutet wird er hier, nicht dort — das Format lebt in
    /// `pulse-ablage`.
    #[serde(default)]
    pub data: Option<serde_json::Value>,
```

`streaming/pulse-player/src/app/mod.rs`: einen `"ablage" => self.ablage(&req)`-Zweig im bestehenden Op-Dispatch, an derselben Stelle wie `remote_pointer`.

- [ ] **Step 5: Die Wayland-Umsetzung schreiben**

`streaming/pulse-player/src/fernsteuerung/wayland/ablage.rs` setzt `Beobachter` und `Eigentum` aus `pulse-ablage` auf `wl_data_device` um:

- **Beobachten:** das `selection`-Ereignis, das `mod.rs:186` heute ausdrücklich verwirft („`Selection`/`DataOffer` bleiben unausgewertet — die Zwischenablage ist nicht Sache dieses Moduls"). Der Kommentar dort ist entsprechend zu **ändern**, nicht zu ergänzen: er stimmt danach nicht mehr.
- **Faul liefern:** ein `wl_data_source`, das `text/plain;charset=utf-8` anbietet; auf `send(mime, fd)` wird der Text in den Dateideskriptor geschrieben. **Das ist der verzögerte Rendervorgang** — auf Wayland ist er kein Kunstgriff, sondern wie das Protokoll gedacht ist, und niemand blockiert dabei.
- **Der Anspruch wird eingereiht**, bis eine gültige Seriennummer vorliegt: `pulse_ablage::eigentum::Anspruch` trägt diese Rechnung bereits samt Tests. `set_selection` verlangt eine Nummer aus einem frischen Eingabeereignis, und ein Klient **ohne Fokus kann die Auswahl nicht setzen** — der Compositor verwirft es **still**. Genau der Fall tritt ein, wenn der Nutzer zu einem lokalen Programm wechselt und drüben kopiert wird.
- **`event_created_child` ist Pflicht** (bestehende Lehre in `mod.rs`), sonst Absturz beim ersten `data_offer` — und der kommt schon beim Programmstart über `Selection`.
- **`wayland_zug_abbau` nicht anfassen:** die Zwischenablage hat mit dem Ziehen nichts zu tun, und dieser Trichter räumt ausschliesslich Zug-Zustand.

- [ ] **Step 5b: Der Schalter im Fern-Menü**

Das Fern-Menü ist das **egui-Overlay des Players**
(`streaming/pulse-player/src/overlay/fernbedienung.rs`), nicht der Web-Renderer —
dort sitzt auch der Lautstärkeregler, der in `docs/fernsteuerung.md` eigens als
Falle erwähnt ist („ein set_option — Lautstärkeregler sitzt im Fern-Menü! — darf
die Absenkung nicht aufheben").

Ein Schalter **„Zwischenablage teilen"**, je Sitzung, **Vorgabe an**. Umgeschaltet
wirkt er sofort auf **dieser** Maschine und auf beides: ankündigen und ausliefern.

Aus für den Beobachter heisst: keine Ankündigung mehr hinaus. Aus für das
Eigentum heisst: einen laufenden Anspruch **freigeben** und den Vorbestand
zurückschreiben — nicht nur künftige Ansprüche unterlassen. Sonst bliebe die
Ablage des Nutzers leer, obwohl er das Teilen gerade abgeschaltet hat, und
ausgerechnet der Schalter, der Vertrauen herstellen soll, hinterliesse Schaden.

Ein Test hält fest, dass Ausschalten den Anspruch wirklich freigibt und nicht nur
den nächsten verhindert.

- [ ] **Step 6: Tests laufen lassen, Grün bestätigen**

Run: `cd streaming/pulse-player && FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared LD_LIBRARY_PATH=$PWD/ffmpeg-dist/n8.1-lgpl-shared/lib cargo test --bins -q`
Expected: PASS — die bestehenden Tests plus die neuen. **Binär-Crate: `--bins`, nicht `--lib`.**

Dieselbe Lastregel wie beim pytest-Volllauf: nicht neben schwere Bauten legen. Ein SIGSEGV in den GPU-nahen Tests ist Maschinenlast, keine Regression — erst allein nachfahren, dann urteilen.

- [ ] **Step 7: Commit**

```bash
git add streaming/pulse-player streaming/zwillinge .github/workflows packaging
git commit -m "feat(player): Ablage-Op und die Wayland-Umsetzung des verzoegerten Renderns

Der Player ist der erste Verbraucher von pulse-ablage. Auf Wayland ist
verzoegertes Rendern kein Kunstgriff, sondern wie das Protokoll gedacht
ist: ein wl_data_source liefert erst, wenn jemand einfuegt, und niemand
blockiert dabei.

Der Anspruch wird eingereiht, bis eine gueltige Seriennummer vorliegt —
ein Klient ohne Fokus kann die Auswahl nicht setzen, und der Compositor
verwirft es STILL. Genau der Fall tritt ein, wenn der Nutzer zu einem
lokalen Programm wechselt und drueben kopiert wird.

Mit der ersten Pfad-Abhaengigkeit laufen die zwillinge-Pruefsteine
scharf: pulse-ablage steht jetzt in den drei Workflow-Pfadfiltern und im
Flatpak-Manifest."
```

---

### Task 5: Verdrahtung in der Sitzung, Schalter und Zustimmungstext

**Files:**
- Modify: `web/src/lib/remote/session.svelte.ts` (start/stop neben `remoteZeigerform`)
- Modify: `web/src/lib/remote/components/RemoteConsentDialog.svelte`
- Modify: der Paraglide-Katalog (neue Zeilen für Dialogtext und Schalter)

**Interfaces:**
- Consumes: `remoteAblage.start/stop` aus Task 2.
- Produces: keine neuen für Folge-Tasks.

- [ ] **Step 1: In der Sitzung verdrahten**

In `session.svelte.ts`, direkt neben `remoteZeigerform.start(...)`:

```ts
    // Geteilte Zwischenablage (`ablage.ts`) — beim Kopieren geht nur eine
    // Ankündigung hinüber, der Inhalt erst beim tatsächlichen Einfügen.
    // Anders als Vorrang und Zeigerform ist sie SYMMETRISCH: beide Rollen
    // kündigen an und beide rufen ab, deshalb bekommt sie die Rolle zwar
    // mit, verzweigt aber nicht danach.
    remoteAblage.start(this.role, (kind, data) =>
      this.#senden((c) => c.sendRemoteSignal(sessionId, kind, data)),
    );
```

und im `#reset`-Pfad neben `remoteZeigerform.stop()`:

```ts
    remoteAblage.stop();
```

**Reihenfolge beachten:** der bestehende Kommentar dort erklärt, warum Vorrang vor P2P gestoppt wird. Die Ablage hängt an keiner der beiden — häng sie hinter `remoteZeigerform.stop()`.

- [ ] **Step 2: Den Zustimmungsdialog um eine Zeile ergänzen**

`RemoteConsentDialog.svelte`: eine Zeile in der Aufzählung dessen, was die Zustimmung umfasst — **eine Zustimmung, die nicht benennt, was sie deckt, ist keine.** Text (neuer Paraglide-Schlüssel, kein fest verdrahteter String):

> Die Zwischenablage wird geteilt: was du kopierst, kann der andere Rechner einfügen — und umgekehrt. Inhalte werden erst übertragen, wenn dort tatsächlich eingefügt wird.

Der zweite Satz gehört dazu; ohne ihn liest der erste sich als „alles fliesst sofort", und genau das ist die Bauart, die verworfen wurde.

- [ ] **Step 3: Nach einem Reclaim neu ankündigen**

Der Entwurf verlangt: nach erfolgreichem `remote_reclaim` schicken **beide**
Seiten ein frisches `neu`. Ohne das hält die Gegenseite ein Versprechen auf eine
Generation, die hier niemand mehr kennt — **jedes Einfügen antwortete danach
`veraltet`, und die Ablage wäre für den Rest der Sitzung still tot.**

Der Aufhänger existiert bereits: `web/src/lib/remote/wachten.ts` ruft
`beiWiederhergestellt`, und der Steuernde zieht dort schon sein Gehaltenes nach
(Hello + `nachziehBuendel()`). Häng die Ablage an denselben Rückruf — sie
braucht **kein** Hello, nur eine frische Ankündigung der eigenen Plattform.

Der Renderer weiss nicht, welche Generation gilt (er parst ja nicht). Also ein
**Anstoss nach unten**: `remoteAblage` bittet die eigene Plattform, ihren Stand
erneut anzukündigen. Nimm dafür `{"t":"neu_bitte"}` — ein Rahmen, den die Kiste
`pulse-ablage` **nicht kennt und nicht kennen muss**: er geht nie über die
Leitung, sondern nur vom Renderer an den eigenen Player. Ein Test im Player muss
festhalten, dass ein solcher Anstoss **nicht** weitergereicht wird.

- [ ] **Step 4: Beim Sitzungsende das Eigentum abgeben**

`remoteAblage.stop()` beendet nur den Renderer-Teil. Der Player muss zusätzlich
das Eigentum abgeben und den gemerkten Vorbestand zurückschreiben — sonst bleibt
die lokale Ablage des Nutzers leer, obwohl die Sitzung vorbei ist. Genau der
Schaden, gegen den der Vorbestand-Mechanismus gebaut wurde
(`Eigentum::freigeben`, Plan 1a).

`stop()` schickt dafür `{"t":"ende"}` an die eigene Plattform — ebenfalls nur
nach unten, nie über die Leitung.

**Der Schalter im Fern-Menü gehört NICHT in den Renderer.** Das Fern-Menü ist
das egui-Overlay des Players (`streaming/pulse-player/src/overlay/fernbedienung.rs`);
der Schalter steht deshalb in Task 4, Step 5b.

- [ ] **Step 5: Prüfen**

Run: `cd web && pnpm check && pnpm test:unit && pnpm build`
Expected: alles grün.

- [ ] **Step 6: Commit**

```bash
git add web/src
git commit -m "feat(ablage): in der Sitzung verdrahtet, Schalter und Zustimmungstext

Die Zustimmung benennt jetzt, was sie deckt — samt dem zweiten Satz, dass
Inhalte erst beim tatsaechlichen Einfuegen uebertragen werden. Ohne ihn
liest der erste sich als 'alles fliesst sofort', und das ist genau die
Bauart, die verworfen wurde.

Der Schalter im Fern-Menue schaltet auf DIESER Maschine beides ab,
ankuendigen und ausliefern — fuer den Moment, in dem man lokal ein
Passwort kopieren will, ohne dass auch nur die Ankuendigung hinausgeht."
```

---

## Was danach kommt

**Plan 1b-2 — der Windows-Host.** `ablage`-Ops im `win-hq-sidecar` (`dispatch.rs`, `ops/`), die Windows-Umsetzung beider Traits auf **eigenem Faden mit `HWND_MESSAGE`** (der Rückruf blockiert, und er darf weder auf der winit-Schleife noch auf dem Injektionsfaden noch auf dem Hook-Faden der Vorrang-Wache liegen — Windows hängt einen beschäftigten Hook-Faden stillschweigend ab), die **Trägerwahl** unter mehreren Sidecar-Prozessen im Renderer des Hosts, die Kopplung `takt()` → `Eigentum::liefern()` (offener Merkposten aus Plan 1a), und der **Windows-Versions-Bump** — `streaming/pulse-*` steht rekursiv in der Bump-Liste, ohne ihn erreicht die Änderung keinen Bestandsclient. **Auf der Entwicklungsmaschine nicht übersetzbar.**

**Plan 1c — macOS.** Host-Seite im `mac-hq-sidecar`, Steuernden-Seite im Player. Braucht vorher die Freigabe für `objc2` + `objc2-app-kit` im Player — er hat heute keine einzige macOS-Abhängigkeit.
