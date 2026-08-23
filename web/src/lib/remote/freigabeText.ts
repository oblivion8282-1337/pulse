/**
 * Warum dieser Rechner nicht fernsteuerbar ist — in Worten, die zur richtigen
 * Systemeinstellung führen.
 *
 * **Importfrei und rein**, damit Nodes eingebauter Testläufer die Datei prüfen
 * kann (`pnpm test:unit`); wir haben kein Vitest. Muster wie
 * `lib/remote/zeigerbildPruefung.ts`.
 *
 * **Warum es diese Datei überhaupt gibt.** `stream.fernsteuerbar` sagt nur ja
 * oder nein. Auf macOS hängt die Fähigkeit an **zwei getrennten** Freigaben,
 * und die zweite fehlt fast immer, weil niemand sie erwartet — die
 * Bedienungshilfen sind bekannt, die Eingabeüberwachung nicht. Ohne diesen Text
 * sähe der Nutzer eine tote Funktion ohne Erklärung, und das ist derselbe
 * Fehler, den das Projekt an anderer Stelle schon teuer bezahlt hat:
 * unerfüllbar heißt Meldung, nicht Stille.
 */

/** Was dem Nutzer gezeigt wird. `null` heißt: es gibt nichts zu erklären. */
export interface Freigabehinweis {
  ueberschrift: string;
  erklaerung: string;
  /** Wohin der Nutzer gehen muss. Leer, wenn kein Pfad benennbar ist. */
  pfad: string;
}

const BEIDE_FREIGABEN =
  'Freigegeben wird Pulse selbst, nicht der Sidecar. Nach einem Update muss der ' +
  'Eintrag entfernt und neu gesetzt werden — nicht nur der Haken neu geklickt: ' +
  'die Freigabe hängt an der Signatur des Programms.';

/**
 * `grund` ist das Feld `health.gsr.remote_input_grund` des Sidecars.
 *
 * **Ein unbekannter Grund wird durchgereicht, nicht verschluckt.** Ein
 * „unbekannter Fehler" nähme dem Nutzer die einzige Spur, die er hat, und dem
 * Entwickler den Hinweis, dass hier ein Fall fehlt.
 */
export function freigabeHinweis(grund: string): Freigabehinweis | null {
  if (!grund) return null;

  if (grund === 'bedienungshilfen') {
    return {
      ueberschrift: 'Pulse darf keine Eingaben einspielen',
      erklaerung:
        'Ohne diese Freigabe kommt keine Maus- und Tastatureingabe des Steuernden an. ' +
        BEIDE_FREIGABEN,
      pfad: 'Systemeinstellungen > Datenschutz & Sicherheit > Bedienungshilfen',
    };
  }

  if (grund.startsWith('eingabeueberwachung')) {
    const stand = grund.slice('eingabeueberwachung'.length + 1);
    const nachtrag =
      stand === 'ungefragt'
        ? ' Der Eintrag erscheint erst, nachdem einmal eine Sitzung versucht wurde.'
        : '';
    return {
      ueberschrift: 'Pulse darf nicht mithören',
      erklaerung:
        'Einspielen ist erlaubt, Mithören nicht. Damit greift der Vorrang nicht: ' +
        'wenn Sie selbst an Maus oder Tastatur gehen, bekommt Pulse das nicht mit ' +
        'und gibt Ihnen den Rechner nicht zurück. Deshalb bleibt die Fernsteuerung aus.' +
        nachtrag +
        ' ' +
        BEIDE_FREIGABEN,
      pfad: 'Systemeinstellungen > Datenschutz & Sicherheit > Eingabeüberwachung',
    };
  }

  return {
    ueberschrift: 'Fernsteuerung nicht möglich',
    erklaerung: `Der Sidecar nennt als Grund: ${grund}`,
    pfad: '',
  };
}
