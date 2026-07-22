/**
 * Fernsteuerung — Input-Capture (M3, Scheibe 4).
 *
 * Übersetzt DOM-Events des Viewer-`<video>` in Wire-Frames (Scheibe 1) und
 * schiebt sie über den Controller-DataChannel (Scheibe 3). Setzt die drei
 * Controller-Pflichten der Wire-Spec um:
 *
 *  - **Pointer-Lock ⇒ relativ, sonst absolut.** Ist die Maus aufs Video
 *    gelockt (Spiele), senden wir `MouseMoveRel` (Ballistik am Host erwünscht);
 *    sonst `MouseMoveAbs` mit **Letterbox-Mathematik** — der schwarze Rand des
 *    `object-fit:contain`-Videos wird rausgerechnet, Klicks darin nicht gesendet.
 *  - **Move-Coalescing.** Höchstens ein Move-Frame pro Animation-Frame; dazwischen
 *    wird die absolute Position überschrieben bzw. das relative Delta summiert.
 *  - **Flutkontrolle.** Läuft der Kanal-Puffer über `BUFFER_LIMIT`, werden nur
 *    **Moves** verworfen — Klicks, Tasten und Rad NIE.
 *
 * Tastatur wird nur erfasst, wenn der Viewer „eingefangen" ist (Pointer-Lock
 * oder Video fokussiert) — kein globales Keyboard-Hijack beim bloßen Zusehen.
 */

import { remoteController } from './controller.svelte';
import { remoteSession } from './session.svelte';
import {
  keyFrame,
  mapButton,
  mouseButton,
  mouseMoveAbs,
  mouseMoveRel,
  mouseWheel,
  scancodeFor,
  wheelToUnits,
} from './input';

/** Puffer-Schwelle: darüber werden Moves verworfen (Wire-Spec: 64 KiB). */
const BUFFER_LIMIT = 64 * 1024;

class RemoteInputCapture {
  /** Ist die Maus aufs Video gelockt? Die UI zeigt darauf ihren Hinweis. */
  pointerLocked = $state(false);

  #video: HTMLVideoElement | null = null;
  #cleanup: Array<() => void> = [];

  // Coalescing-Zustand bis zum nächsten Animation-Frame.
  #pendingAbs: { x: number; y: number } | null = null;
  #relDx = 0;
  #relDy = 0;
  #hasRel = false;
  #rafId = 0;

  /** An das Viewer-`<video>` hängen. Idempotent (löst eine alte Bindung). */
  attach(video: HTMLVideoElement): void {
    this.detach();
    this.#video = video;
    const add = (target: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn, opts);
      this.#cleanup.push(() => target.removeEventListener(type, fn, opts));
    };
    // Maus-Bewegung auf `document` — im Lock-Modus liefert nur das die Deltas.
    add(document, 'mousemove', this.#onMove as EventListener);
    add(document, 'mousedown', this.#onDown as EventListener);
    add(document, 'mouseup', this.#onUp as EventListener);
    // Rad/Kontextmenü non-passive, damit `preventDefault` greift.
    add(document, 'wheel', this.#onWheel as EventListener, { passive: false });
    add(video, 'contextmenu', this.#onContextMenu as EventListener);
    add(window, 'keydown', this.#onKeyDown as EventListener);
    add(window, 'keyup', this.#onKeyUp as EventListener);
    add(document, 'pointerlockchange', this.#onLockChange);
  }

  /** Maus aufs Video locken (Spielmodus) — von der UI aufgerufen. */
  requestPointerLock(): void {
    this.#video?.requestPointerLock?.();
  }

  /** Lock lösen (die UI oder Escape). */
  exitPointerLock(): void {
    if (this.pointerLocked) document.exitPointerLock();
  }

  detach(): void {
    for (const off of this.#cleanup) off();
    this.#cleanup = [];
    if (this.#rafId) cancelAnimationFrame(this.#rafId);
    this.#rafId = 0;
    this.#resetMove();
    if (this.pointerLocked) document.exitPointerLock();
    this.pointerLocked = false; // der pointerlockchange-Listener ist schon weg
    this.#video = null;
  }

  // ── intern ────────────────────────────────────────────────────────────────
  /** Session aktiv UND Input-Kanal offen? Sonst nichts senden. */
  #active(): boolean {
    return remoteSession.phase === 'active' && remoteController.inputOpen;
  }

  /** Darf ein Maus-Event an dieser Position gesendet werden? Im Lock-Modus
   *  immer; sonst nur, wenn der Zeiger übers Videobild geht (nicht Letterbox). */
  #shouldSend(e: MouseEvent): boolean {
    if (!this.#active()) return false;
    return this.pointerLocked || this.#toAbs(e) !== null;
  }

  /** Client-Koordinaten → 0..65535 aufs Videobild, oder `null` im Letterbox. */
  #toAbs(e: MouseEvent): { x: number; y: number } | null {
    const v = this.#video;
    if (!v || !v.videoWidth || !v.videoHeight) return null;
    const r = v.getBoundingClientRect();
    // `object-fit: contain` → Bild aspektwahrend in das Element eingepasst.
    const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const contentW = v.videoWidth * scale;
    const contentH = v.videoHeight * scale;
    if (contentW <= 0 || contentH <= 0) return null; // 0-Größe → sonst NaN-Koordinaten
    const offX = (r.width - contentW) / 2;
    const offY = (r.height - contentH) / 2;
    const u = (e.clientX - r.left - offX) / contentW;
    const w = (e.clientY - r.top - offY) / contentH;
    if (u < 0 || u > 1 || w < 0 || w > 1) return null; // Letterbox → nicht senden
    return { x: Math.round(u * 65535), y: Math.round(w * 65535) };
  }

  #onMove = (e: MouseEvent): void => {
    if (!this.#active()) return;
    if (this.pointerLocked) {
      this.#relDx += e.movementX;
      this.#relDy += e.movementY;
      this.#hasRel = true;
    } else {
      const abs = this.#toAbs(e);
      if (abs) this.#pendingAbs = abs;
      else return; // Zeiger im Letterbox/außerhalb — kein Move-Flush planen
    }
    this.#scheduleFlush();
  };

  #scheduleFlush(): void {
    if (this.#rafId) return;
    this.#rafId = requestAnimationFrame(() => {
      this.#rafId = 0;
      this.#flushMove();
    });
  }

  #flushMove(): void {
    // Flutkontrolle: bei vollem Puffer Moves fallen lassen (Buttons/Keys/Rad nie).
    if (remoteController.inputBufferedAmount() > BUFFER_LIMIT) {
      this.#resetMove();
      return;
    }
    if (this.#hasRel && (this.#relDx !== 0 || this.#relDy !== 0)) {
      remoteController.sendInput(mouseMoveRel(this.#relDx, this.#relDy));
    } else if (this.#pendingAbs) {
      remoteController.sendInput(mouseMoveAbs(this.#pendingAbs.x, this.#pendingAbs.y));
    }
    this.#resetMove();
  }

  #resetMove(): void {
    this.#pendingAbs = null;
    this.#relDx = this.#relDy = 0;
    this.#hasRel = false;
  }

  #onDown = (e: MouseEvent): void => this.#onButton(e, true);
  #onUp = (e: MouseEvent): void => this.#onButton(e, false);
  #onButton(e: MouseEvent, down: boolean): void {
    if (!this.#shouldSend(e)) return;
    const btn = mapButton(e.button);
    if (btn === undefined) return;
    e.preventDefault();
    // `preventDefault` unterdrückt den Default-Fokus des Klicks → das Video
    // müssen wir selbst fokussieren, sonst greift die Tastatur-Erfassung im
    // Absolut-Modus nie (sie gated auf `activeElement === Video`).
    if (down) this.#video?.focus();
    remoteController.sendInput(mouseButton(btn, down));
  }

  #onContextMenu = (e: MouseEvent): void => {
    if (this.#active()) e.preventDefault(); // Rechtsklick-Menü nicht aufpoppen
  };

  #onWheel = (e: WheelEvent): void => {
    if (!this.#shouldSend(e)) return;
    e.preventDefault();
    const dv = wheelToUnits(e.deltaY, e.deltaMode); // vertikal: Vorzeichen drehen
    const dh = wheelToUnits(e.deltaX, e.deltaMode, false); // horizontal: nicht drehen
    if (dv !== 0 || dh !== 0) remoteController.sendInput(mouseWheel(dv, dh));
  };

  /** Tastatur nur, wenn eingefangen (Lock) oder das Video fokussiert ist. */
  #engaged(): boolean {
    return this.#active() && (this.pointerLocked || document.activeElement === this.#video);
  }

  #onKeyDown = (e: KeyboardEvent): void => this.#onKey(e, true);
  #onKeyUp = (e: KeyboardEvent): void => this.#onKey(e, false);
  #onKey(e: KeyboardEvent, down: boolean): void {
    if (!this.#engaged()) return;
    const scan = scancodeFor(e.code);
    if (scan === undefined) return;
    e.preventDefault(); // Taste nicht zusätzlich den Browser auslösen lassen
    remoteController.sendInput(keyFrame(scan, down));
  }

  #onLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.#video;
  };
}

export const remoteInput = new RemoteInputCapture();
