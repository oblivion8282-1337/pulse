# Räumliches Audio — Stufe 1 („Sitzordnung") Umsetzungsplan

**Goal:** Remote-Stimmen im Voice-Channel werden binaural (HRTF) auf einem Halbkreis *vor* dem Hörer positioniert, statt flach aus der Mitte zu kommen — rein clientseitig, abschaltbarer Toggle in den Voice-Settings. Keine Bewegung, kein Netzwerk-Sync (das ist Stufe 2).

**Architektur:** Pro Remote-Mic-Track wird ein `PannerNode` (panningModel `HRTF`) ans **Ende** der bestehenden `RemoteAudioElements`-Node-Kette gesetzt (`… → gain → [limiter] → [panner] → ctx.destination`). Der `AudioListener` des AudioContext sitzt im Ursprung mit Blick nach −z. Die Halbkreis-Positionen berechnet eine pure Funktion in `spatial.ts` und werden bei jedem Join/Leave neu verteilt. Der An/Aus-Toggle läuft end-to-end exakt wie der bestehende `limiterEnabled` (Schema → Setter → `livekit.svelte.ts` → `audioElements.ts` → UI).

**Tech-Stack:** Web Audio API (`PannerNode`, `AudioListener`) — nativ, **keine neue Dependency**. Svelte 5 Runes, Paraglide-i18n, bestehende `settings-registry`.

---

## Vorbild im Code (1:1 spiegeln)

Der `limiterEnabled`-Toggle ist der rote Faden — jede Schicht hat ihr Pendant:
- Schema: `web/src/lib/settings-registry/sections/audio.ts` — Typ (Z.21), Default (Z.48), Migration/Validierung (Z.98 `bool(a.limiterEnabled, d.limiterEnabled)`).
- Setter: `web/src/lib/stores/settings.svelte.ts:215` `setLimiterEnabled`.
- Engine-Verdrahtung: `web/src/lib/voice/livekit.svelte.ts:291` (beim Connect anwenden), `:766` (`setLimiterEnabled`-Methode → `#audioEls`).
- Audio-Knoten: `web/src/lib/voice/audioElements.ts` `setLimiterEnabled` + `#applyLimiterTail`.
- UI: `web/src/lib/components/settings/SettingsAudioVideo.svelte:25` (Handler), `:198` (Switch-Block).

**Wichtig — kein Vitest/Unit im Frontend** (CLAUDE.md): Verifikation pro Task = `cd web && pnpm check` (0 Errors) und am Ende `pnpm build` + manueller 2-Client-Kopfhörer-Test. Die pure Geometrie ist die einzige sinnvoll isoliert prüfbare Logik — sie wird über `pnpm check` typgeprüft und im manuellen Test validiert.

---

## Task 1: Geometrie-Helper `web/src/lib/voice/spatial.ts` (neu, pure)

**Files:** Create `web/src/lib/voice/spatial.ts`

- [ ] **Schritt 1: Modul schreiben**

```typescript
/**
 * Stufe-1-Spatial-Audio-Geometrie: verteilt die Teilnehmer eines Voice-
 * Channels auf einem Halbkreis VOR dem Hörer (Web-Audio-Konvention: −z = vorn,
 * +x = rechts, y = 0 = Ohrhöhe). Rein clientseitig + deterministisch — jeder
 * Client rechnet dasselbe, kein Netzwerk-Sync (das ist Stufe 2).
 *
 * Stabile Plätze: die userIds werden lexikografisch sortiert (Snowflake-ID-
 * Strings → stabile, sprech-unabhängige Reihenfolge), dann gleichmäßig über
 * die Winkelspanne verteilt. Ein einzelner Sprecher landet mittig (Winkel 0).
 */
export interface SpatialPosition {
  x: number;
  y: number;
  z: number;
}

/** Halbkreis-Radius in „Metern" (Web-Audio-Einheiten). Alle Sprecher gleich
 *  weit weg → Stufe 1 vermittelt nur Richtung, keine Distanz. */
export const SPATIAL_RADIUS = 1.5;
/** Halbe Winkelspanne in Grad: ±60° fühlt sich breit, aber natürlich an
 *  (±90° drängt Sprecher „neben die Ohren", was unnatürlich klingt). */
export const SPATIAL_HALF_SPAN_DEG = 60;

export function computeHalfCirclePositions(
  userIds: readonly string[]
): Map<string, SpatialPosition> {
  const out = new Map<string, SpatialPosition>();
  const ids = [...userIds].sort();
  const n = ids.length;
  const span = (SPATIAL_HALF_SPAN_DEG * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    // Einzelner Sprecher → Winkel 0 (mittig). Sonst von −span..+span verteilt.
    const t = n === 1 ? 0.5 : i / (n - 1);
    const angle = -span + t * (2 * span);
    out.set(ids[i], {
      x: Math.sin(angle) * SPATIAL_RADIUS,
      y: 0,
      z: -Math.cos(angle) * SPATIAL_RADIUS // −z = vor dem Hörer
    });
  }
  return out;
}
```

- [ ] **Schritt 2: `cd web && pnpm check`** → 0 Errors.

## Task 2: Settings-Schema `spatialAudio` (Audio-Section)

**Files:** Modify `web/src/lib/settings-registry/sections/audio.ts`

Spiegelt `limiterEnabled` an allen drei Stellen.

- [ ] **Schritt 1: Typ-Feld** (bei Z.21, neben `limiterEnabled: boolean;`):
```typescript
  /** Stufe-1-Spatial-Audio: Remote-Stimmen binaural auf einem Halbkreis. */
  spatialAudio: boolean;
```
- [ ] **Schritt 2: Default** (bei Z.48, neben `limiterEnabled: false`):
```typescript
  spatialAudio: false,
```
- [ ] **Schritt 3: Validierung/Migration** (bei Z.98, neben der `limiterEnabled`-Zeile):
```typescript
      spatialAudio: bool(a.spatialAudio, d.spatialAudio),
```
- [ ] **Schritt 4: `cd web && pnpm check`** → 0 Errors.

## Task 3: Setter in `settings.svelte.ts`

**Files:** Modify `web/src/lib/stores/settings.svelte.ts`

- [ ] **Schritt 1: Setter ergänzen** (direkt nach `setLimiterEnabled`, Z.217):
```typescript
  setSpatialAudio(v: boolean): void {
    this.#audio.set('spatialAudio', v);
  }
```
- [ ] **Schritt 2: `pnpm check`** → 0 Errors.

## Task 4: `audioElements.ts` — PannerNode + AudioListener

**Files:** Modify `web/src/lib/voice/audioElements.ts`

Kernarbeit. Der Panner sitzt am Tail (nach `gain`/`limiter`, vor `ctx.destination`). Da es jetzt **zwei** optionale Tail-Knoten gibt (limiter + panner), wird die bestehende `#applyLimiterTail`-Logik durch ein allgemeineres `#rewireTail` ersetzt, das die Kette `gain → [limiter] → [panner] → destination` konsistent neu verdrahtet (Limiter-Verhalten bleibt identisch — reine Erweiterung, kein Verhaltenswechsel).

- [ ] **Schritt 1: Felder + Panner ins Bundle.** In `AudioNodeBundle` ergänzen:
```typescript
  /** HRTF-Panner am Tail, nur present während Spatial-Audio aktiv ist. */
  panner: PannerNode | null;
```
In der Klasse:
```typescript
  #spatialEnabled = false;
  /** Letzte berechnete Plätze, damit ein neu attachter Track sofort sitzt. */
  #positions = new Map<string, import('./spatial').SpatialPosition>();
```
In `attach()` das Bundle-Literal um `panner: null` ergänzen; in `detach()` `try { node.panner?.disconnect(); } catch {}` ergänzen.

- [ ] **Schritt 2: AudioListener einmalig setzen.** In `#ensureContext()`, direkt nach `const ctx = new AudioContext();`:
```typescript
    // Hörer im Ursprung, Blick nach −z (Web-Audio-Konvention „vorn").
    const L = ctx.listener;
    if (L.forwardX) {
      L.positionX.value = 0; L.positionY.value = 0; L.positionZ.value = 0;
      L.forwardX.value = 0; L.forwardY.value = 0; L.forwardZ.value = -1;
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else {
      // Fallback für ältere Engines (deprecated, aber breit unterstützt).
      (L as unknown as { setOrientation(a:number,b:number,c:number,d:number,e:number,f:number):void })
        .setOrientation(0, 0, -1, 0, 1, 0);
    }
```

- [ ] **Schritt 3: `#makePanner`-Helper.**
```typescript
  #makePanner(ctx: AudioContext): PannerNode {
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = SPATIAL_RADIUS; // alle Sprecher auf dem Radius → keine Distanz-Dämpfung
    p.rolloffFactor = 1;
    p.positionX.value = 0; p.positionY.value = 0; p.positionZ.value = -SPATIAL_RADIUS;
    return p;
  }
```
Import oben ergänzen: `import { computeHalfCirclePositions, SPATIAL_RADIUS, type SpatialPosition } from './spatial';`

- [ ] **Schritt 4: `setSpatialEnabled` + `#rewireTail`.** `#applyLimiterTail` durch `#rewireTail` ersetzen, das die volle Tail-Kette aufbaut:
```typescript
  setSpatialEnabled(on: boolean): void {
    this.#spatialEnabled = on;
    const ctx = this.#ctx;
    if (!ctx) return;
    for (const node of this.#nodes.values()) this.#rewireTail(node, ctx);
    if (on) this.#recomputePositions();
  }

  /** Verdrahtet gain → [limiter] → [panner] → destination konsistent neu.
   *  Idempotent: trennt den ganzen Tail und baut ihn anhand der aktiven Flags
   *  wieder auf. Ersetzt das frühere #applyLimiterTail (Limiter-Verhalten
   *  unverändert). */
  #rewireTail(node: AudioNodeBundle, ctx: AudioContext): void {
    // Tail komplett lösen.
    try { node.gain.disconnect(); } catch { /* */ }
    if (node.limiter) { try { node.limiter.disconnect(); } catch { /* */ } }
    if (node.panner)  { try { node.panner.disconnect(); }  catch { /* */ } }
    // Limiter erzeugen/entsorgen je nach Flag.
    if (this.#limiterEnabled && !node.limiter) {
      const lim = ctx.createDynamicsCompressor();
      const l = RemoteAudioElements.LIMITER;
      lim.threshold.value = l.threshold; lim.knee.value = l.knee;
      lim.ratio.value = l.ratio; lim.attack.value = l.attack; lim.release.value = l.release;
      node.limiter = lim;
    } else if (!this.#limiterEnabled && node.limiter) {
      node.limiter = null;
    }
    // Panner erzeugen/entsorgen je nach Flag.
    if (this.#spatialEnabled && !node.panner) {
      node.panner = this.#makePanner(ctx);
    } else if (!this.#spatialEnabled && node.panner) {
      node.panner = null;
    }
    // Kette neu zusammenstecken.
    let tail: AudioNode = node.gain;
    if (node.limiter) { tail.connect(node.limiter); tail = node.limiter; }
    if (node.panner)  { tail.connect(node.panner);  tail = node.panner; }
    tail.connect(ctx.destination);
  }
```
**Wichtig:** alle bisherigen Aufrufe von `#applyLimiterTail(node, ctx)` (in `#syncNode` und `setLimiterEnabled`) auf `#rewireTail(node, ctx)` umstellen. `setLimiterEnabled` bleibt ansonsten unverändert.

- [ ] **Schritt 5: `#recomputePositions`** (Halbkreis auf alle aktiven Panner anwenden):
```typescript
  #recomputePositions(): void {
    if (!this.#spatialEnabled) return;
    // Eine Position pro userId; ein User kann mehrere SIDs haben (selten) —
    // alle SIDs des Users teilen denselben Platz.
    const userIds = [...this.#userSids.keys()];
    this.#positions = computeHalfCirclePositions(userIds);
    for (const node of this.#nodes.values()) {
      const pos = this.#positions.get(node.userId);
      if (pos && node.panner) {
        node.panner.positionX.value = pos.x;
        node.panner.positionY.value = pos.y;
        node.panner.positionZ.value = pos.z;
      }
    }
  }
```

- [ ] **Schritt 6: attach/detach lösen Recompute aus.** Am Ende von `attach()` (nach dem Index-Update) und am Ende von `detach()`:
```typescript
    if (this.#spatialEnabled) this.#recomputePositions();
```
In `attach()` außerdem nach `this.#syncNode(node)` sicherstellen, dass `#rewireTail` lief (es läuft via `#syncNode` → `#rewireTail`); der neue Panner bekommt seine Position dann im `#recomputePositions`.

- [ ] **Schritt 7: `pnpm check`** → 0 Errors.

## Task 5: `livekit.svelte.ts` verdrahten

**Files:** Modify `web/src/lib/voice/livekit.svelte.ts`

- [ ] **Schritt 1: Beim Connect anwenden.** Bei Z.291 (neben `this.#audioEls.setLimiterEnabled(...)`):
```typescript
    this.#audioEls.setSpatialEnabled(settings.audio.spatialAudio);
```
- [ ] **Schritt 2: Public-Methode.** Neben `setLimiterEnabled` (Z.766):
```typescript
  /** Toggle Spatial-Audio live. Persistenz passiert in
   *  settings.setSpatialAudio — beide aufrufen. */
  setSpatialEnabled(on: boolean): void {
    this.#audioEls.setSpatialEnabled(on);
  }
```
- [ ] **Schritt 3: `pnpm check`** → 0 Errors.

## Task 6: UI-Toggle in `SettingsAudioVideo.svelte`

**Files:** Modify `web/src/lib/components/settings/SettingsAudioVideo.svelte`

- [ ] **Schritt 1: Handler** (neben `onLimiterToggle`, Z.25):
```typescript
  function onSpatialToggle(e: Event) {
    const on = (e.currentTarget as HTMLInputElement).checked;
    settings.setSpatialAudio(on);
    voice.setSpatialEnabled(on);
  }
```
- [ ] **Schritt 2: Switch-Block** (nach dem Limiter-Block, ~Z.210) — mit Kopfhörer-Hinweis:
```svelte
  <!-- Räumliches Audio (Stufe 1) -->
  <div class="border-border border-t pt-4">
    <label class="flex cursor-pointer items-center justify-between gap-3" data-testid="settings-spatial">
      <span>
        <span class="text-text-bright text-sm font-medium">{m.settings_audio_video_spatial_label()}</span>
        <p class="text-text-muted text-xs">{m.settings_audio_video_spatial_description()}</p>
      </span>
      <input
        type="checkbox"
        class="peer sr-only"
        checked={settings.audio.spatialAudio}
        onchange={onSpatialToggle}
      />
      <!-- Switch-Styling exakt vom Limiter-Block übernehmen (gleiche peer-Klassen) -->
    </label>
  </div>
```
(Das genaue Switch-Markup 1:1 aus dem Limiter-Block Z.198–208 kopieren — nur `data-testid`, `checked`, `onchange` und die Labels tauschen.)

- [ ] **Schritt 3: `pnpm check`** → 0 Errors.

## Task 7: i18n-Messages (de + en)

**Files:** Modify die Paraglide-Message-Quellen (`web/messages/de.json` + `en.json` o.ä. — Ort über `grep -rl settings_audio_video_limiter_label web/messages` bestätigen)

- [ ] **Schritt 1: Drei Keys je Sprache** (analog `settings_audio_video_limiter_*`):
```
settings_audio_video_spatial_label        de: "Räumliches Audio"            en: "Spatial audio"
settings_audio_video_spatial_description   de: "Stimmen klingen aus verschiedenen Richtungen — nur mit Kopfhörern sinnvoll."   en: "Voices come from different directions — only works with headphones."
```
- [ ] **Schritt 2: `pnpm check`** (Paraglide kompiliert die Messages; fehlende Keys brechen den Typecheck).

## Task 8: Verifikation (manuell)

- [ ] **Schritt 1:** `cd web && pnpm check && pnpm build` → 0 Errors / 0 Warnings.
- [ ] **Schritt 2:** `pnpm exec playwright test` → bestehende E2E grün (keine Regression; Voice ist nicht E2E-abgedeckt).
- [ ] **Schritt 3 (manuell, 2 Clients + Kopfhörer):** Zwei Accounts in denselben Voice-Channel. „Räumliches Audio" an. Mit ≥2 anderen Sprechern muss man hören, dass einer eher von links, einer eher von rechts kommt; ein einzelner Sprecher bleibt mittig. Toggle aus → wieder flach/mittig. Join/Leave eines Dritten → Plätze verteilen sich neu, ohne Knacken.

---

## Offene Punkte / bewusst NICHT in Stufe 1

- **Keine Bewegung, keine Distanz, kein Sync** — alle Sprecher gleich weit auf dem Halbkreis. Das ist Stufe 2 (LiveKit-Daten-Kanal).
- **Höhe (oben/unten)** — kommt erst mit Stufe 2.
- **Mini-Draufsicht-Visualisierung** (Punkte im Halbkreis in `VoiceChannelView.svelte`) — optionales Sahnehäubchen, separat machbar, nicht MVP-kritisch.
- **CPU bei sehr großen Channels** — HRTF kostet pro Sprecher; bei ≤ ~20 unkritisch. Falls nötig später: nur die lautesten N binaural rendern.
- **Screen-Share-Audio** bleibt unräumlich (läuft über `ScreenShareTile`, nicht `RemoteAudioElements`) — bewusst, das ist kein „Sprecher im Raum".
