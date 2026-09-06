/**
 * QR-Darstellung des Kopplungscodes (Etappe F, Ergaenzung).
 *
 * **Importfrei** im Sinn von CLAUDE.md „Die Falle": kein erweiterungsloser
 * Laufzeit-Import auf einen Nachbarn und kein `$state()` auf Modulebene. Der
 * Import von `uqr` bleibt zulaessig — Nodes Testlaeufer loest einen echten
 * Paketnamen ganz normal ueber `node_modules` auf; die Falle betrifft nur
 * relative Importe ohne Endung, die ein Bundler aufloest und Node nicht.
 *
 * **Warum ueberhaupt eine eigene SVG-Erzeugung statt `renderSVG` aus `uqr`.**
 * Die Bibliothek liefert nur die Punktmatrix (`encode(...).data`); das SVG
 * bauen wir selbst, damit die Bibliothek nie ans DOM muss und damit wir die
 * Textalternative (Titel/`aria-label`) selbst bestimmen.
 *
 * **Warum der Kopplungscode nie serverseitig zu einem Bild werden darf.**
 * Der Code ist zugleich die Ableitungsgrundlage fuer den Schluessel der
 * Verlaufsstuecke (s. `transport.ts`) — der Server haelt nur `SHA-256(Code)`
 * und darf den Klartext nie sehen. Ein QR-Bild aus einer serverseitigen
 * Bibliothek (im Projekt vorhanden: `qrcode[pil]` im auth-svc) muesste den
 * Code aber erst zum Server schicken, um ihn dort zu einem Bild zu machen —
 * genau das, was die Kopplung verhindern soll. Deshalb ausschliesslich
 * Klienten-seitige Erzeugung, auch wenn das eine zusaetzliche Abhaengigkeit
 * im Web-Bundle kostet.
 */
import { encode } from 'uqr';

/**
 * Quiet Zone in Modulen rings um die eigentliche Matrix. Der QR-Standard
 * (ISO/IEC 18004) verlangt mindestens 4 Module Rand fuer verlaessliches
 * Scannen — `uqr`s eigene Vorgabe (1) reicht dafuer nicht.
 */
const RAND_MODULE = 4;

/**
 * Erzeugt die Punktmatrix fuer einen Kopplungscode.
 *
 * Kodiert wird die KANONISCHE Form (ohne Gruppentrenner) — kuerzer als die
 * angezeigte Form mit Bindestrichen, und die Gegenseite normalisiert eine
 * gescannte Eingabe ohnehin ueber `codeNormalisieren` (der auch Trenner
 * abraeumt), sodass die Wahl hier keine zweite Konvention einfuehrt.
 *
 * `ecc: 'M'` (bis 15 % Datenverlust erholbar) ist der ueblich empfohlene
 * Mittelweg fuer gescannte Codes auf einem Bildschirm — genug Reserve gegen
 * einen ungenauen Ausschnitt, ohne die Matrix unnoetig zu vergroessern.
 */
export function qrMatrixFuerCode(code: string): boolean[][] {
  return encode(code, { ecc: 'M', border: RAND_MODULE }).data;
}

/** Schuetzt den Titel-Text vor den fuenf XML-Sonderzeichen. */
function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Baut ein eigenstaendiges SVG-Markup aus einer Punktmatrix.
 *
 * Jedes dunkle Modul wird ein `<rect>` im 1×1-Einheitenraster; `viewBox`
 * skaliert das Ganze verlustfrei auf jede Anzeigegroesse. Hintergrund ist
 * FEST weiss/schwarz (nicht themenabhaengig) — ein QR-Code muss unabhaengig
 * vom Dark Mode der Seite lesbaren Kontrast behalten, anders als der Rest
 * der Oberflaeche.
 *
 * `titel` landet als `<title>` (von Screenreadern vorgelesen) UND als
 * `aria-label` (Redundanz ist hier gewollt: manche Screenreader lesen bei
 * `role="img"` nur eines von beiden zuverlaessig).
 */
export function qrSvgAusMatrix(matrix: boolean[][], titel: string): string {
  const groesse = matrix.length;
  const beschriftung = xmlEscape(titel);
  let module = '';
  for (let y = 0; y < groesse; y++) {
    for (let x = 0; x < matrix[y].length; x++) {
      if (matrix[y][x]) module += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${groesse} ${groesse}" ` +
    `role="img" aria-label="${beschriftung}" shape-rendering="crispEdges">` +
    `<title>${beschriftung}</title>` +
    `<rect width="${groesse}" height="${groesse}" fill="#fff"/>` +
    `<g fill="#000">${module}</g>` +
    `</svg>`
  );
}

/** Kurzform: Code direkt zu fertigem SVG-Markup. */
export function qrSvgFuerCode(code: string, titel: string): string {
  return qrSvgAusMatrix(qrMatrixFuerCode(code), titel);
}
