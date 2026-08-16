/**
 * Der Bearbeitungsstand einer Rolle — was im Formular steht, bevor
 * gespeichert wird.
 *
 * Bewusst KEIN `$effect`, das die ausgewaehlte Rolle laufend in die Felder
 * spiegelt: kaeme waehrend des Tippens ein `role_updated` ueber den
 * WebSocket herein (und sei es das eigene, gerade gespeicherte), setzte
 * ein solcher Effekt die Eingabe des Nutzers zurueck. Uebernommen wird
 * genau zweimal ausdruecklich: beim Wechsel der Auswahl und nach dem
 * Speichern.
 */

import type { Role } from '$lib/api/roles';
import { toBitfield } from '$lib/permissions/bitfield';

/** Grau — das ist die Farbe, in der ein Mitglied ohne Rollenfarbe steht.
 * Als Vorbelegung des Farbwaehlers heisst das: „so sieht es jetzt aus". */
const OHNE_FARBE = '#9ca3af';

export class Rollenentwurf {
  name = $state('');
  rechte = $state('0');
  farbe = $state(OHNE_FARBE);
  farbeAn = $state(false);
  hervorheben = $state(false);
  erwaehnbar = $state(false);

  /** Farbe als Zahl fuer die API — `null` heisst ausdruecklich „keine". */
  get farbwert(): number | null {
    return this.farbeAn ? parseInt(this.farbe.replace('#', ''), 16) : null;
  }

  uebernehmen(r: Role | undefined): void {
    if (!r) return;
    this.name = r.name;
    this.rechte = r.permissions;
    this.farbeAn = r.color != null;
    this.farbe = r.color != null ? '#' + r.color.toString(16).padStart(6, '0') : OHNE_FARBE;
    this.hervorheben = r.hoist;
    this.erwaehnbar = r.mentionable;
  }

  /** Wie viele Aenderungen stehen aus — fuer die Leiste unten.
   *
   * Rechte zaehlen einzeln (je umgelegtes Bit eine Aenderung), die
   * uebrigen Eigenschaften je eine. „3 Aenderungen" ist eine Zahl, an der
   * man merkt, ob man mehr angefasst hat als gedacht; ein blosses
   * „ungespeichert" ist das nicht. */
  aenderungen(r: Role | undefined): number {
    if (!r) return 0;
    let n = 0;
    if (this.name !== r.name) n++;
    if (this.farbwert !== r.color) n++;
    if (this.hervorheben !== r.hoist) n++;
    if (this.erwaehnbar !== r.mentionable) n++;
    let unterschied = toBitfield(this.rechte) ^ toBitfield(r.permissions);
    while (unterschied !== 0n) {
      unterschied &= unterschied - 1n;
      n++;
    }
    return n;
  }

  /** Nutzlast fuer PATCH. `@everyone` laesst den Namen weg — sie ist der
   * Boden, auf dem alle stehen, und traegt ihren Namen nicht als Eigenschaft
   * sondern als Bedeutung. */
  alsAenderung(r: Role) {
    return {
      name: r.is_everyone ? undefined : this.name,
      permissions: this.rechte,
      color: this.farbwert,
      hoist: this.hervorheben,
      mentionable: this.erwaehnbar
    };
  }
}
