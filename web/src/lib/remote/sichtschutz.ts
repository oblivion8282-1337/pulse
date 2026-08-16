/**
 * Der Riegel hinter dem Sichtschutz (`devices/components/DeviceSichtschutz.svelte`).
 *
 * Der Sichtschutz war beim Bughunt 2026-08-16 ein `fixed inset-0`-Div und sonst
 * nichts — und ein Div hält nur das auf, was unter ihm liegt. Drei Dinge lagen
 * nicht darunter:
 *
 * * **Toasts.** svelte-sonner rendert mit `z-index: 999999999`; jede DM-Meldung
 *   stand samt Absendernamen mitten auf dem Sichtschutz.
 * * **Dialoge.** `alert-dialog-content` ist `z-[60]` und wird ans `<body>`
 *   portaliert — bei Gleichstand gewinnt der spätere Knoten ohnehin.
 * * **Alles, was Fokus annimmt.** Der Steuernde konnte mit Tab durch die
 *   verdeckte App wandern und Felder auslesen, deren Inhalt der Browser beim
 *   Fokussieren scrollt.
 *
 * Zwei Werkzeuge dagegen, beide hier:
 *
 * 1. **`inert` auf allem ausser dem Sichtschutz.** Nicht auf einem festen
 *    Wurzelelement — portalierte Dialoge hängen direkt am `<body>` und wären
 *    daran vorbei. Stattdessen die Kette vom Sichtschutz bis zum `<body>` hoch
 *    und auf jeder Stufe die Geschwister sperren; ein neuer Knoten (der Dialog,
 *    der eine Sekunde später aufgeht) wird über je einen `MutationObserver` auf
 *    genau diesen Eltern nachgezogen.
 * 2. **Ein Merker, den die Melde-Wege abfragen**, bevor sie etwas anzeigen oder
 *    hinausschicken. `inert` versteckt nichts — ein Toast wäre weiter lesbar,
 *    und eine Betriebssystem-Meldung liegt ohnehin ausserhalb des Dokuments.
 *
 * **Warum der Merker hier steht und nicht im Sitzungs-Store:** ihn fragen die
 * WS-Handler ab (`ws/handlers/chat.ts`) und der Melde-Weg
 * (`notifications/inPage.ts`). Beide dürfen nicht den halben Fernsteuer-Baum
 * mitziehen — dieses Modul importiert deshalb bewusst gar nichts.
 */

/** Gesetzt vom Sichtschutz, solange er steht. */
let aktiv = false;

/**
 * Steht der Sichtschutz gerade?
 *
 * Wer hier `true` bekommt, zeigt **nichts** an und schickt **nichts** hinaus,
 * das Inhalte des Besitzers trägt — vor dem Schirm sitzt jemand anderes.
 */
export function sichtschutzAktiv(): boolean {
  return aktiv;
}

/** Nur vom Sichtschutz selbst zu rufen. */
export function sichtschutzMelden(wert: boolean): void {
  aktiv = wert;
}

/** Elemente mit diesem Attribut bleiben bedienbar. Trägt es genau eines: das
 *  Fernsteuer-Banner mit der Notbremse — der Besitzer muss jederzeit beenden
 *  können, was auf seinem Rechner läuft. */
const FREI = 'data-sichtschutz-frei';

/**
 * Alles ausser dem Sichtschutz stilllegen. Liefert die Umkehrung.
 *
 * Fremdes `inert` bleibt fremd: gesperrt wird nur, was vorher nicht schon
 * gesperrt war, und zurückgenommen nur, was wir selbst gesetzt haben. Sonst
 * risse das Ende einer Fernsteuerung einen Dialog auf, den bits-ui gerade
 * absichtlich stillgelegt hat.
 */
export function restlicheAppSperren(eigen: HTMLElement): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const gesperrt = new Set<HTMLElement>();
  const wachen: MutationObserver[] = [];

  const sperren = (el: Element, ausser: Element): void => {
    if (el === ausser || !(el instanceof HTMLElement)) return;
    if (el.hasAttribute(FREI) || el.inert || gesperrt.has(el)) return;
    el.inert = true;
    gesperrt.add(el);
  };

  const anwenden = (): void => {
    // Bis zum `<body>` hinauf — die letzte Stufe ist die wichtigste:
    // portalierte Dialoge und der Toaster hängen dort, nicht im SvelteKit-Baum.
    let knoten: HTMLElement | null = eigen;
    while (knoten && knoten !== document.body) {
      const eltern: HTMLElement | null = knoten.parentElement;
      if (!eltern) break;
      for (const kind of eltern.children) sperren(kind, knoten);
      knoten = eltern;
    }
  };

  // Je eine Wache auf den Eltern der Kette — `childList` ohne `subtree`.
  // Eine Wache über den ganzen Baum liefe bei jeder eintreffenden Nachricht
  // mit; hier sind es zwei bis drei Container, die sich fast nie ändern.
  let stufe: HTMLElement | null = eigen.parentElement;
  while (stufe) {
    const wache = new MutationObserver(anwenden);
    wache.observe(stufe, { childList: true });
    wachen.push(wache);
    if (stufe === document.body) break;
    stufe = stufe.parentElement;
  }

  anwenden();

  return () => {
    for (const wache of wachen) wache.disconnect();
    for (const el of gesperrt) el.inert = false;
    gesperrt.clear();
  };
}
