# Eindeutige Zuordnung Strom → Bildschirm — Umsetzungsplan (Teil 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Bildschirm-Nummer reist mit dem Stream bis zum Zuschauer, damit „welches Fenster zeigt welchen Monitor" gewusst statt geraten wird.

**Architecture:** Die sendende Seite kennt die Nummer (`"Monitor: 3"`), wirft sie heute aber zugunsten des Anzeigenamens weg. Sie reist künftig als zweites optionales Feld denselben Weg wie `label` — Token-Anfrage → chat-gateway → media-svc → auth-hook → `stream:active` → Poller → Kanalzustand → Zuschauer. Der Namensvergleich bleibt als Rückfall für ältere Klienten; kein Stichtag.

**Tech Stack:** TypeScript (`web/`), Python (chat-gateway, media-svc, mediamtx-auth-hook), Nodes eingebauter Testläufer, pytest

**Spec:** `docs/superpowers/specs/2026-08-24-mehrere-host-bildschirme-design.md` (Teil 3)

## Global Constraints

- **Keine Migration, kein Stichtag.** Das Feld ist überall optional und fehlt bei älteren Klienten; dann gilt der Namensvergleich wie bisher.
- **Zwei Dateien beschreiben dieselben Redis-Schlüssel und müssen synchron bleiben:** `services/media-svc/src/dcc_media_svc/streamkeys.py` und `services/mediamtx-auth-hook/src/dcc_mediamtx_auth_hook/shared.py`. Der auth-hook hat bewusst keine `dcc-shared`-Abhängigkeit.
- Quelldateien ≤ 350 Zeilen Richtwert, hart 500 (Tests ausgenommen). `settingsCatalog.ts` steht bei 312, `label.ts` bei 157, `schirme.svelte.ts` bei 416.
- Deutsch in neuen Kommentaren, Stil der Umgebung, **keine Emojis**.
- **Version-Bump und Changelog gehören NICHT in diesen Plan** — Teil 3 wird zusammen mit den Teilen 2, 4 und 5 ausgeliefert, und dafür gibt es am Ende einen gemeinsamen Eintrag.
- Backend-Tests: `REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud uv run --all-packages pytest -q`. Den Volllauf **nicht** neben einen schweren Build legen.
- Web-Unit-Tests: `cd web && pnpm test:unit`.
- Arbeitszweig: der bestehende `feat/ziehen-ueber-die-fenstergrenze`.

---

## File Structure

| Datei | Verantwortung |
|---|---|
| `web/src/lib/stream/settingsCatalog.ts` | **Neu darin:** `monitorNummer()` — aus der Aufnahmequelle die Bildschirm-Nummer lesen. Die Datei ist **importfrei** und hält `MONITOR_CAPTURE_PREFIX` bereits; damit gibt es keine zweite Wahrheit und der Test läuft unter Nodes Läufer. |
| `web/src/lib/stream/label.ts` | `resolveStreamLabel` gibt die Nummer mit zurück, statt sie zu verwerfen. |
| `web/src/lib/stream/starten.ts` | reicht sie an die Token-Anfrage weiter. |
| `web/src/lib/api/chat.ts` | `getStreamToken` nimmt sie entgegen und schreibt sie in den Rumpf. |
| `services/chat-gateway/.../routes/streaming.py` | nimmt sie entgegen, reicht sie an media-svc weiter. |
| `services/media-svc/.../routes.py` | nimmt sie entgegen, schreibt sie in den Token-Record. |
| `services/mediamtx-auth-hook/.../routes.py` | kopiert sie beim Publish-Auth aus dem Token-Record nach `stream:active`. |
| `services/media-svc/.../streamkeys.py` + `.../auth_hook/shared.py` | Schlüssel-Beschreibung nachziehen (beide, synchron). |
| `services/media-svc/.../poller.py` | liest sie aus `stream:active` und hängt sie an den Kanalzustand. |
| `web/src/lib/stores/streamPresence.svelte.ts` | liest sie in den `StreamDescriptor`. |
| `web/src/lib/devices/schirme.svelte.ts` | vergleicht **zuerst die Nummer**, Name als Rückfall; meldet Mehrdeutigkeit. |
| `web/test/quellenummer.test.ts` | **Neu.** Tests für `monitorNummer` und die Zuordnung. |

---

## Task 1: Die Nummer lesen, statt sie wegzuwerfen

**Files:**
- Modify: `web/src/lib/stream/settingsCatalog.ts` (neue Funktion `monitorNummer`)
- Modify: `web/src/lib/stream/label.ts:28-69` (`StreamLabel` + `resolveStreamLabel`)
- Test: `web/test/quellenummer.test.ts` (neu)

**Interfaces:**
- Consumes: `MONITOR_CAPTURE_PREFIX` (`settingsCatalog.ts:288`, Wert `'Monitor: '`)
- Produces:
  - `export function monitorNummer(captureSource: string | undefined | null): number | undefined`
  - `StreamLabel` bekommt das optionale Feld `monitorIndex?: number`

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

Datei `web/test/quellenummer.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { monitorNummer } from '../src/lib/stream/settingsCatalog.ts';

test('eine Monitor-Quelle liefert ihre Nummer', () => {
  assert.equal(monitorNummer('Monitor: 3'), 3);
  assert.equal(monitorNummer('Monitor: 1'), 1);
});

test('Rand und Grossschreibung stoeren nicht, ein fehlender Vorsatz schon', () => {
  assert.equal(monitorNummer('  Monitor: 2  '), 2);
  assert.equal(monitorNummer('monitor: 2'), undefined, 'Vorsatz ist gross geschrieben');
});

test('was kein Monitor ist, hat keine Nummer', () => {
  assert.equal(monitorNummer('window:12345'), undefined);
  assert.equal(monitorNummer('portal'), undefined);
  assert.equal(monitorNummer(''), undefined);
  assert.equal(monitorNummer(undefined), undefined);
  assert.equal(monitorNummer(null), undefined);
});

test('Unfug ergibt keine Nummer statt NaN', () => {
  assert.equal(monitorNummer('Monitor: abc'), undefined);
  assert.equal(monitorNummer('Monitor: '), undefined);
  assert.equal(monitorNummer('Monitor: 1.5'), undefined, 'nur ganze Zahlen');
  assert.equal(monitorNummer('Monitor: -1'), undefined, 'keine negativen');
});
```

- [ ] **Step 2: Laufen lassen und scheitern sehen**

```bash
cd web && pnpm test:unit
```

Erwartet: Fehler, `monitorNummer` gibt es nicht.

- [ ] **Step 3: `monitorNummer` ergänzen**

In `web/src/lib/stream/settingsCatalog.ts`, direkt unter `MONITOR_CAPTURE_PREFIX`:

```ts
/**
 * Aus einer Aufnahmequelle die Bildschirm-Nummer lesen.
 *
 * **Warum hier und nicht in `label.ts`:** Diese Datei ist importfrei und haelt
 * den Vorsatz bereits — damit gibt es genau eine Wahrheit, und Nodes
 * eingebauter Testlaeufer kann die Rechnung pruefen (`label.ts` importiert
 * `./settings.svelte` und ist fuer ihn unerreichbar, s. `CLAUDE.md`).
 *
 * `undefined` fuer alles, was kein Monitor ist — Fenster-Aufnahmen, der
 * Linux-Portal-Platzhalter, Unfug. Geraten wird nichts: eine erfundene Nummer
 * zeigte beim Zuschauer auf den falschen Bildschirm.
 */
export function monitorNummer(captureSource: string | undefined | null): number | undefined {
  const src = (captureSource ?? '').trim();
  if (!src.startsWith(MONITOR_CAPTURE_PREFIX)) return undefined;
  const roh = src.slice(MONITOR_CAPTURE_PREFIX.length).trim();
  if (roh === '') return undefined;
  const n = Number(roh);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}
```

- [ ] **Step 4: `resolveStreamLabel` gibt sie mit zurück**

In `web/src/lib/stream/label.ts`:

Den Import um `monitorNummer` erweitern (die Datei importiert bereits aus `./settings.svelte`; `monitorNummer` kommt aus `./settingsCatalog`):

```ts
import { monitorNummer } from './settingsCatalog';
```

`StreamLabel` erweitern (heute Zeilen 30-33):

```ts
export interface StreamLabel {
  label: string;
  icon: StreamIcon;
  /**
   * Welchen Bildschirm des Hosts dieser Strom zeigt — 1-basiert, passend zur
   * Aufnahmequelle `Monitor: <index>`.
   *
   * **Der Name allein reicht nicht.** Zwei baugleiche Monitore heissen gleich;
   * wer nur den Namen ueber den Draht schickt, macht die Zuordnung beim
   * Zuschauer unmoeglich (Fehler vom 2026-08-24). `undefined` bei
   * Fenster-Aufnahmen und beim Linux-Portal.
   */
  monitorIndex?: number;
}
```

Im Monitor-Zweig von `resolveStreamLabel` (heute Zeilen 51-57) die Nummer mitgeben:

```ts
  if (src.startsWith(MONITOR_CAPTURE_PREFIX)) {
    const idx = monitorNummer(src);
    const mon = idx === undefined ? undefined : catalogs.monitors.find((m) => m.index === idx);
    if (mon?.name) return { label: mon.name, icon: 'monitor', monitorIndex: idx };
    if (idx !== undefined) return { label: `Monitor ${idx}`, icon: 'monitor', monitorIndex: idx };
    return fallback;
  }
```

- [ ] **Step 5: Tests laufen lassen**

```bash
cd web && pnpm test:unit
```

Erwartet: alle grün, inklusive der vier neuen.

```bash
cd web && pnpm check
```

Erwartet: keine neuen Typfehler.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/stream/settingsCatalog.ts web/src/lib/stream/label.ts web/test/quellenummer.test.ts
git commit -m "feat(stream): die Bildschirm-Nummer nicht mehr wegwerfen

resolveStreamLabel kannte die Nummer aus der Aufnahmequelle und
behielt nur den Anzeigenamen. Zwei baugleiche Monitore heissen gleich —
damit war die Zuordnung beim Zuschauer nicht mehr moeglich.

Die Aufloesung sitzt in settingsCatalog.ts, weil die Datei importfrei
ist und den Vorsatz schon haelt: eine Wahrheit, und zum ersten Mal
ueberhaupt pruefbar (label.ts importiert settings.svelte und ist fuer
Nodes Testlaeufer unerreichbar).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Die Nummer über den Draht

Rein mechanisch: ein zweites optionales Feld überall dort, wo `label` schon reist. Nirgends Pflicht, nirgends eine Migration.

**Files:**
- Modify: `web/src/lib/stream/starten.ts:62-92`
- Modify: `web/src/lib/api/chat.ts:565-585`
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/streaming.py:64-72` und `:201-210`
- Modify: `services/media-svc/src/dcc_media_svc/routes.py:150-165` und `:305-315`
- Modify: `services/mediamtx-auth-hook/src/dcc_mediamtx_auth_hook/routes.py:155-190` und `:255-270`
- Modify: `services/media-svc/src/dcc_media_svc/streamkeys.py` (Schlüssel-Beschreibung + `normalise`)
- Modify: `services/mediamtx-auth-hook/src/dcc_mediamtx_auth_hook/shared.py:28-34` (dieselbe Beschreibung)
- Modify: `services/media-svc/src/dcc_media_svc/poller.py:55-70` und `:320-340`

**Interfaces:**
- Consumes: `resolveStreamLabel(...).monitorIndex` aus Task 1
- Produces: das Feld `monitor_index` (Schlangenschrift auf dem Draht, `monitorIndex` im TypeScript) in: Token-Anfrage-Rumpf, Token-Record, `stream:active`-Record, Kanalzustands-`streams`-Eintrag

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

Such die bestehende Testdatei für die Token-Route: `grep -rln "stream-token" services/chat-gateway/tests/ services/media-svc/tests/`. Häng in der Datei, die den Rumpf der Token-Anfrage prüft, einen Test an, der belegt: **wird `monitor_index` mitgeschickt, steht es im Rumpf an media-svc; fehlt es, steht es nicht drin.** Halte dich an den Stil der Nachbartests derselben Datei (Fixtures, Mock-Aufbau, Namensgebung).

Genauso in `services/media-svc/tests/`: ein Test, der belegt, dass `monitor_index` im **Token-Record** landet, wenn es in der Anfrage stand — und dass der Record ohne die Angabe **kein** `monitor_index` trägt (das Weglassen ist der bestehende Vertrag für `label`, s. `routes.py:308-311`).

- [ ] **Step 2: Laufen lassen und scheitern sehen**

```bash
REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud uv run --all-packages pytest -q -k "stream_token or media_svc"
```

Erwartet: die neuen Tests scheitern, alle anderen bestehen.

- [ ] **Step 3: Client-Seite**

`web/src/lib/api/chat.ts`, `getStreamToken`: ein weiteres optionales Argument **hinten** anhängen (die Reihenfolge der bestehenden darf sich nicht ändern, es gibt Aufrufer mit Positionsargumenten):

```ts
    remoteInput = false,
    /** Welchen Bildschirm des Hosts dieser Strom zeigt (1-basiert). Reist bis
     *  zum Zuschauer und macht dort die Zuordnung Strom -> Monitor eindeutig;
     *  der Name allein kann das bei baugleichen Geraeten nicht. */
    monitorIndex?: number
  ): Promise<StreamTokenResponse> {
```

und im Rumpf, nach demselben Muster wie `label` (nur mitschicken, wenn gesetzt):

```ts
        ...(remoteInput ? { remote_input: true } : {}),
        ...(monitorIndex === undefined ? {} : { monitor_index: monitorIndex })
```

`web/src/lib/stream/starten.ts`: die Auflösung liefert jetzt beides. Statt nur `.label` zu nehmen, das ganze Ergebnis merken und die Nummer als letztes Argument durchreichen. Der bestehende Kommentar über die Standplatz-Sonderbehandlung bleibt unverändert gültig — er begründet, aus **welcher** Quelle aufgelöst wird, und das ändert sich nicht.

- [ ] **Step 4: chat-gateway**

`routes/streaming.py`: neben `label` ein zweites optionales Feld im Anfrage-Modell:

```python
    # Welchen Bildschirm des Hosts dieser Strom zeigt (1-basiert). Wird wie
    # ``label`` nur weitergereicht; media-sve faedelt es ueber Token-Record →
    # auth-hook → ``stream:active`` → Poller bis zum Zuschauer. Dort macht es
    # die Zuordnung Strom → Monitor eindeutig, die der Name bei baugleichen
    # Geraeten nicht leisten kann.
    monitor_index: Annotated[int | None, Field(default=None, ge=0, le=_SLOT_MAX)] = None
```

Achtung: `_SLOT_MAX` ist die Obergrenze für Plätze, nicht für Monitore. Nimm eine eigene, grosszügige Schranke (etwa `le=99`) oder die vorhandene, wenn sie inhaltlich passt — **entscheide bewusst und schreib die Begründung als Kommentar dazu.**

Und beim Weiterreichen, direkt neben der `label`-Zeile (heute `:205-206`):

```python
    if payload.monitor_index is not None:
        token_body["monitor_index"] = payload.monitor_index
```

- [ ] **Step 5: media-svc**

`routes.py`: dasselbe optionale Feld ins Anfrage-Modell (neben `label`, heute `:159`), und beim Schreiben des Token-Records neben `record["label"]` (heute `:308-310`):

```python
    if payload.monitor_index is not None:
        record["monitor_index"] = payload.monitor_index
```

- [ ] **Step 6: auth-hook**

`routes.py`: die Funktion, die `stream:active` schreibt, nimmt heute `label` entgegen (`:159`) und schreibt es bei Bedarf (`:185-186`). Ergänze `monitor_index: int | None = None` in derselben Weise, und lies es an der Stelle, an der `label` aus dem Token-Record geholt wird (`:262-265`), mit derselben Sorgfalt (Typprüfung, `None` bei Unfug).

**Beide Schlüssel-Beschreibungen nachziehen** — `services/media-svc/.../streamkeys.py` und `services/mediamtx-auth-hook/.../shared.py:32`. Sie beschreiben dieselben Redis-Schlüssel und stehen bewusst doppelt (der auth-hook hat keine `dcc-shared`-Abhängigkeit); laufen sie auseinander, glaubt man der falschen.

- [ ] **Step 7: Poller**

`poller.py`: neben `label_of` (heute `:324-337`) dieselbe Auflösung für `monitor_index` aus demselben `mget` — **kein zweiter Redis-Durchgang**, der Record ist schon geladen. Und im Eintrag des Kanalzustands (heute `:55-67`) das Feld anhängen, wieder nur wenn vorhanden.

- [ ] **Step 8: Tests**

```bash
REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud uv run --all-packages pytest -q
cd web && pnpm check
```

Erwartet: alles grün. Der Volllauf braucht rund 9 Minuten auf ruhiger Maschine — **nicht** neben einen Build legen, sonst hängt ein WS-Test ins Zeitlimit.

- [ ] **Step 9: Commit**

```bash
git add web/src/lib/api/chat.ts web/src/lib/stream/starten.ts services/
git commit -m "feat(stream): die Bildschirm-Nummer reist bis zum Zuschauer

Zweites optionales Feld neben label, denselben Weg: Token-Anfrage →
chat-gateway → media-svc → Token-Record → auth-hook → stream:active →
Poller → Kanalzustand. Nirgends Pflicht, keine Migration, kein Stichtag.

Beide Schluessel-Beschreibungen nachgezogen (streamkeys.py und die
Kopie im auth-hook) — sie stehen bewusst doppelt und muessen synchron
bleiben.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Der Zuschauer vergleicht die Nummer

**Files:**
- Modify: `web/src/lib/stores/streamPresence.svelte.ts:19-52`
- Modify: `web/src/lib/devices/schirme.svelte.ts:62-150`
- Test: `web/test/quellenummer.test.ts` (erweitern)

**Interfaces:**
- Consumes: das Draht-Feld `monitor_index` aus Task 2
- Produces:
  - `StreamDescriptor` bekommt `monitor_index?: number`
  - `passt(strom, mon)` vergleicht zuerst die Nummer
  - **Neu:** eine Auskunft, ob die Zuordnung eindeutig ist — Teil 2 hängt daran

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

Die Zuordnung in `schirme.svelte.ts` ist nicht importfrei (die Datei zieht Stores). Zieh die **reine Vergleichsregel** deshalb in eine importfreie Funktion und prüfe die. Häng an `web/test/quellenummer.test.ts` an:

```ts
import { stromPasstZuMonitor } from '../src/lib/stream/settingsCatalog.ts';

test('die Nummer gewinnt gegen den Namen', () => {
  const mon = { index: 2, name: 'Dell U2723', primary: false };
  assert.equal(stromPasstZuMonitor({ monitor_index: 2, label: 'ganz anders' }, mon), true);
  assert.equal(stromPasstZuMonitor({ monitor_index: 3, label: 'Dell U2723' }, mon), false,
    'traegt der Strom eine Nummer, entscheidet NUR sie');
});

test('ohne Nummer bleibt der Namensvergleich — fuer aeltere Klienten', () => {
  const mon = { index: 2, name: 'Dell U2723', primary: false };
  assert.equal(stromPasstZuMonitor({ label: 'Dell U2723' }, mon), true);
  assert.equal(stromPasstZuMonitor({ label: '  dell u2723 ' }, mon), true, 'nachsichtig');
  assert.equal(stromPasstZuMonitor({ label: 'Monitor 2' }, mon), true);
  assert.equal(stromPasstZuMonitor({ label: 'BenQ 24' }, mon), false);
  assert.equal(stromPasstZuMonitor({}, mon), false, 'ohne alles passt nichts');
});

test('zwei baugleiche Monitore: mit Nummer eindeutig, ohne Nummer nicht', () => {
  const a = { index: 1, name: 'Dell U2723', primary: true };
  const b = { index: 2, name: 'Dell U2723', primary: false };
  // Mit Nummer trifft jeder Strom genau einen Schirm.
  assert.equal(stromPasstZuMonitor({ monitor_index: 1 }, a), true);
  assert.equal(stromPasstZuMonitor({ monitor_index: 1 }, b), false);
  // Ohne Nummer passt derselbe Strom auf BEIDE — genau die Mehrdeutigkeit,
  // wegen der die Nummer eingefuehrt wurde.
  assert.equal(stromPasstZuMonitor({ label: 'Dell U2723' }, a), true);
  assert.equal(stromPasstZuMonitor({ label: 'Dell U2723' }, b), true);
});
```

- [ ] **Step 2: Laufen lassen und scheitern sehen**

```bash
cd web && pnpm test:unit
```

Erwartet: `stromPasstZuMonitor` gibt es nicht.

- [ ] **Step 3: Die reine Regel nach `settingsCatalog.ts`**

```ts
/** Was die Zuordnung von einem Strom braucht. Absichtlich schmal — so laesst
 *  sie sich ohne Stores pruefen. */
export interface StromKennung {
  label?: string;
  monitor_index?: number;
}

/** Und was sie von einem Bildschirm braucht. */
export interface MonitorKennung {
  index: number;
  name: string;
}

/**
 * Zeigt dieser Strom diesen Bildschirm?
 *
 * **Die Nummer gewinnt.** Traegt der Strom eine, entscheidet allein sie — auch
 * wenn der Name danebenliegt (umbenannter Monitor, andere Sprache, fehlender
 * EDID-Name). Der Namensvergleich bleibt als Rueckfall fuer Klienten, die die
 * Nummer noch nicht mitschicken; er ist nachsichtig bei Rand und
 * Gross-/Kleinschreibung, weil ein Unterschied dort nicht auffaellt, sondern
 * still das Falsche tut.
 *
 * **Der Grund fuer die Nummer:** zwei baugleiche Monitore heissen gleich. Ohne
 * sie passt derselbe Strom auf beide, und die Zuordnung ist nicht zu treffen.
 */
export function stromPasstZuMonitor(strom: StromKennung, mon: MonitorKennung): boolean {
  if (typeof strom.monitor_index === 'number') return strom.monitor_index === mon.index;
  const a = strom.label?.trim().toLowerCase();
  if (!a) return false;
  return a === mon.name.trim().toLowerCase() || a === `monitor ${mon.index}`;
}
```

- [ ] **Step 4: `streamPresence` liest das Feld**

In `web/src/lib/stores/streamPresence.svelte.ts`: `StreamDescriptor` um `monitor_index?: number` erweitern, und in `normalizeStreams` (heute `:42-52`) nach demselben Muster wie `label` übernehmen — nur wenn es eine ganze Zahl ≥ 0 ist, sonst weglassen. Kommentar dazu, warum die Prüfung streng ist (eine verbogene Nummer zeigte auf den falschen Bildschirm).

- [ ] **Step 5: `schirme.svelte.ts` benutzt die Regel**

Die dortige `passt()`-Funktion (heute `:73-79`) durch einen Aufruf von `stromPasstZuMonitor` ersetzen. Der ausführliche Kommentar über dem alten `passt()` beschreibt jetzt teilweise etwas Falsches („verglichen wird der **Name**") — **berichtige ihn**, statt ihn stehen zu lassen.

Der Griff für den namenlosen Hauptbildschirm (`:126-143`) bleibt, wird aber **nachrangig**: er ist ein Notbehelf für Ströme ohne brauchbare Angabe. Trägt ein Strom eine Nummer, darf er nie über diesen Weg einem anderen Schirm zugeschlagen werden. Prüfe im Code, ob das schon so ist — die Suche nach dem „namenlosen" Strom (`:135-137`) muss Ströme **mit** Nummer ausschliessen.

- [ ] **Step 6: Auskunft über Eindeutigkeit**

Teil 2 braucht sie: dort darf „du bist hier" nur behauptet werden, wenn die Zuordnung eindeutig ist. Ergänze in `schirme.svelte.ts` eine exportierte Auskunft, etwa:

```ts
/** Ist die Zuordnung Strom → Bildschirm fuer dieses Geraet eindeutig?
 *
 *  Unklar wird sie, wenn ein Strom OHNE Nummer auf mehr als einen Bildschirm
 *  passen wuerde — zwei baugleiche Monitore beim Host und ein Klient, der die
 *  Nummer noch nicht mitschickt. Teil 2 behauptet dann kein „du bist hier":
 *  ein fehlender Hinweis faellt auf und ist harmlos, ein falscher faellt nicht
 *  auf. */
export function zuordnungEindeutig(device: Device): boolean
```

Implementier sie über dieselbe Liste, die `zuordnung()` schon benutzt — keine zweite Rechnung daneben, sonst laufen sie auseinander.

- [ ] **Step 7: Tests**

```bash
cd web && pnpm test:unit && pnpm check && pnpm build
```

Erwartet: alles grün.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/stores/streamPresence.svelte.ts web/src/lib/devices/schirme.svelte.ts web/src/lib/stream/settingsCatalog.ts web/test/quellenummer.test.ts
git commit -m "feat(stream): die Zuordnung Strom-Bildschirm vergleicht die Nummer

Traegt ein Strom eine Bildschirm-Nummer, entscheidet allein sie. Der
Namensvergleich bleibt Rueckfall fuer Klienten ohne Nummer — kein
Stichtag.

Die reine Vergleichsregel sitzt in settingsCatalog.ts, weil
schirme.svelte.ts Stores zieht und fuer Nodes Testlaeufer unerreichbar
ist. Dazu die Auskunft zuordnungEindeutig(), an der Teil 2 haengt: ohne
Eindeutigkeit wird spaeter kein \"du bist hier\" behauptet.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Selbstprüfung gegen den Entwurf

| Entwurf, Teil 3 | Task |
|---|---|
| Importfreie Auflösung der Nummer, erstmals prüfbar | 1 |
| `resolveStreamLabel` verwirft sie nicht mehr | 1 |
| `starten.ts` reicht sie weiter | 2 |
| chat-gateway nimmt sie als zweites optionales Feld | 2 |
| media-svc: Token-Record | 2 |
| auth-hook: `stream:active` | 2 |
| Beide Schlüssel-Beschreibungen synchron | 2 |
| Poller: Kanalzustand | 2 |
| `streamPresence` liest sie | 3 |
| Nummer zuerst, Name als Rückfall | 3 |
| Fail-visible: Auskunft über Eindeutigkeit für Teil 2 | 3 |
| Vertagt: stabile Kennung statt Nummer | — bewusst nicht in diesem Plan |
