/**
 * Was gilt am Ende — und WOHER es kommt.
 *
 * **Das Problem.** Zwei Ebenen bestimmen, was jemand darf: die Rollen der
 * Community als Grundlage und die Abweichungen je Kanal darüber. Die Ansicht
 * zeigte bisher nur die Abweichungen; man setzte Häkchen und wusste hinterher
 * nicht, was gilt. Das Endergebnis allein reicht aber auch nicht: „nein" ohne
 * Grund schickt den Bearbeiter auf die Suche. Also wird beides geliefert.
 *
 * **Das Ergebnis wird NICHT neu gerechnet.** `gilt` kommt aus
 * `resolveChannelPermissions` — demselben Resolver, den der Client überall
 * benutzt und der die Reihenfolge des Servers spiegelt. Ein zweiter Nachbau der
 * Formel wäre eine Kopie, die irgendwann abweicht. Neu ist hier nur die
 * **Herkunft**: dieselbe Reihenfolge wird ein zweites Mal durchlaufen, diesmal
 * je Bit einzeln, und gemerkt wird die zuletzt entscheidende Stufe. Sollte der
 * Durchlauf je vom Resolver abweichen, ist die Anzeige falsch beschriftet —
 * nicht die Rechte falsch gesetzt.
 *
 * **Warum die Rollen benannt sein müssen.** „ja · aus Moderation" ist die
 * Antwort, die jemand sucht; „ja" allein nicht. Der Resolver führt keine Namen,
 * deshalb die `Benannte*`-Typen (siehe `schnappschuesse.ts`).
 *
 * **Fremde Instanz-Admins sind unsichtbar.** Ob ein anderes Mitglied
 * Instanz-Administrator ist, steht nur in dessen eigener Sitzung. Solche Nutzer
 * lösen serverseitig auf `GRANT_ALL_SAFE` auf, dürfen also immer. Deshalb kennt
 * dieses Modul kein `isGlobalAdmin` — jede Anzeige darauf ist eine
 * **Untergrenze** und sagt „mindestens", genau wie `remote/berechtigte.ts`.
 */

import {
  Perm,
  has,
  resolveChannelPermissions,
  vergleichRollen,
  type OverwriteSnapshot,
  type Permission,
  type RoleSnapshot
} from './bitfield';

export type BenannteRolle = RoleSnapshot & { name: string };
export type BenanntesOverwrite = OverwriteSnapshot & { name: string };

/** Die Stufe, die das Ergebnis eines Rechts zuletzt bestimmt hat. */
export type Herkunft =
  | { art: 'besitzer' }
  | { art: 'administrator'; rolle: string }
  | { art: 'rolle'; rolle: string }
  | { art: 'keine_rolle' }
  /** `ueber` = Name der fremden Überschreibung, `null` = die des Ziels selbst. */
  | { art: 'hier_erlaubt'; ueber: string | null }
  | { art: 'hier_verboten'; ueber: string | null }
  | { art: 'sichtsperre' }
  | { art: 'kein_mitglied' };

export type Rechtsstand = { gilt: boolean; herkunft: Herkunft };

/**
 * Ein aufzulösendes Ziel — eine Person oder eine simulierte Rolle.
 *
 * Für eine ROLLE wird ein Mitglied nachgestellt, das genau `@everyone` und
 * diese Rolle trägt: das ist die Wahrheit für den Normalfall und lässt sich mit
 * demselben Resolver rechnen. `userId` bleibt dann leer, damit keine
 * Mitglieds-Überschreibung greift.
 */
export type Aufloesungsziel = {
  userId: string;
  isMember: boolean;
  isOwner: boolean;
  rollen: BenannteRolle[];
  overwrites: BenanntesOverwrite[];
  /**
   * `<art>:<id>` des gerade betrachteten Ziels. Entscheidet eine ANDERE
   * Überschreibung, nennt die Herkunft sie beim Namen („hier verboten über
   * @everyone") — sonst stünde da „hier verboten", und der Bearbeiter suchte
   * den Schalter in einer Zeile, in der er gar nicht sitzt.
   */
  eigenerSchluessel?: string;
};

/** @everyone zuerst, dann Rollen nach Position — die Reihenfolge des Servers. */
function sortiert(rollen: readonly BenannteRolle[]): BenannteRolle[] {
  return [...rollen].sort(vergleichRollen);
}

/** Die Überschreibungen, die dieses Ziel treffen — in Anwendungsreihenfolge. */
function stufen(ziel: Aufloesungsziel, rollen: BenannteRolle[]): BenanntesOverwrite[] {
  const nachSchluessel = new Map(
    ziel.overwrites.map((ow) => [`${ow.target_type}:${ow.target_id}`, ow])
  );
  const reihe: BenanntesOverwrite[] = [];
  for (const r of rollen) {
    const ow = nachSchluessel.get(`0:${r.id}`);
    if (ow) reihe.push(ow);
  }
  const eigene = ziel.userId ? nachSchluessel.get(`1:${ziel.userId}`) : undefined;
  if (eigene) reihe.push(eigene);
  return reihe;
}

/**
 * Ergebnis + Herkunft für eine Liste von Rechten, in einem Durchlauf.
 *
 * Die Rechte kommen als Liste herein, weil die Ansicht ohnehin genau die
 * kanalskopierten Bits zeigt — für alle 52 zu rechnen wäre Arbeit für nichts.
 */
export function rechtsstaende(
  ziel: Aufloesungsziel,
  rechte: readonly Permission[]
): Map<Permission, Rechtsstand> {
  const rollen = sortiert(ziel.rollen);
  const endwert = resolveChannelPermissions({
    // Siehe Modulkopf: fremde Instanz-Admin-Flags kennt kein Client.
    isGlobalAdmin: false,
    isOwner: ziel.isOwner,
    isMember: ziel.isMember,
    userId: ziel.userId,
    roles: rollen,
    overwrites: ziel.overwrites
  });
  const sieht = has(endwert, Perm.VIEW_CHANNEL);
  const abweichungen = stufen(ziel, rollen);
  const adminRolle = rollen.find((r) => has(r.permissions, Perm.ADMINISTRATOR));

  const ergebnis = new Map<Permission, Rechtsstand>();
  for (const perm of rechte) {
    ergebnis.set(perm, {
      gilt: has(endwert, perm),
      herkunft: herkunft(ziel, perm, rollen, abweichungen, adminRolle, sieht)
    });
  }
  return ergebnis;
}

function herkunft(
  ziel: Aufloesungsziel,
  perm: Permission,
  rollen: readonly BenannteRolle[],
  abweichungen: readonly BenanntesOverwrite[],
  adminRolle: BenannteRolle | undefined,
  sieht: boolean
): Herkunft {
  if (!ziel.isMember) return { art: 'kein_mitglied' };
  if (ziel.isOwner) return { art: 'besitzer' };
  // ADMINISTRATOR kürzt im Resolver den ganzen Kanal-Teil ab (GRANT_ALL_SAFE
  // wird sofort zurückgegeben) — eine Abweichung im Kanal greift dann NICHT.
  // Das muss die Anzeige genauso sagen, sonst setzt jemand ein Verbot und
  // wundert sich, dass es wirkungslos bleibt.
  if (adminRolle) return { art: 'administrator', rolle: adminRolle.name };

  // Grundlage: die höchste Rolle, die das Bit trägt. Gerechnet wird ohnehin
  // die Vereinigung aller Rollen — genannt wird die oberste, weil das die
  // Rolle ist, an der man es abschaltet.
  let stand: Herkunft = { art: 'keine_rolle' };
  for (const r of rollen) {
    if (has(r.permissions, perm)) stand = { art: 'rolle', rolle: r.name };
  }

  for (const ow of abweichungen) {
    const eigene = `${ow.target_type}:${ow.target_id}` === ziel.eigenerSchluessel;
    const ueber = eigene ? null : ow.name;
    // Formel des Resolvers: (wert | allow) & ~deny — innerhalb DERSELBEN
    // Überschreibung gewinnt deny also über allow, wenn beide dasselbe Bit
    // tragen. Reihenfolge hier deshalb umgekehrt zur Formel-Schreibweise.
    if (has(ow.deny, perm)) stand = { art: 'hier_verboten', ueber };
    else if (has(ow.allow, perm)) stand = { art: 'hier_erlaubt', ueber };
  }

  // Die revoke-all-Invariante des Servers: ohne „Kanal ansehen" fällt alles
  // Übrige weg, egal was darüber steht. Bisher ahnte das niemand.
  if (perm !== Perm.VIEW_CHANNEL && !sieht) return { art: 'sichtsperre' };
  return stand;
}
