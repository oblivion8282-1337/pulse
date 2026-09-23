/**
 * TOFU-Pinnung der Geraete-Identitaeten (Bughunt 2026-09-23).
 *
 * Die Buendel-Signatur (`buendelSignatur.ts`) beweist nur, dass ein Buendel
 * zu dem ed25519-Schluessel gehoert, der daneben steht — nicht, dass DIESER
 * Schluessel der des bekannten Geraets ist. Der Ersatz-Gegner liefert ein
 * vollstaendig eigenes, sauber selbst signiertes Buendel. Die einzige
 * Verteidigung dagegen ist der Vergleich mit dem einmal gesehenen Stand:
 * "Trust On First Use" — beim ersten verifizierten Kontakt wird die
 * Identitaet gepinnt, jede Abweichung danach ist laut (in `senden.ts` ein
 * Wurf, kein Rueckfall).
 *
 * Die Pinnung liegt in derselben IndexedDB wie der Account und die Sitzungen
 * (`pulse-identity`), unveraendert nebendrauf — sie ist OEFFENTLICHES
 * Material (die publizierten Schluessel selbst), kein Geheimnis, braucht
 * also keinen Pickle-Schutz.
 *
 * **Bekannte Grenze, bewusst eingeräumt:** setzt ein Nutzer sein Geraet
 * wirklich neu auf (neues Olm-Konto, `verlustPlan`), wirft der erste
 * Kontakt danach hier einen `GeraeteIdentitaetGeaendertFehler` — bis eine
 * Bestätigungs-UI existiert, ist der Weg für Gegenstellen so blockiert, wie
 * er es bei einem echten Identitätswechsel auch sein soll. Das Gerätemodell
 * selbst (Kopplung, Widerruf) bleibt unangetastet.
 */
import { openIdentityDb, idbGetIdentity, idbPutIdentity, idbDeleteIdentity } from '../identity/idb-shared';
import { signaturPruefen } from '../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import {
  buendelAnmeldung,
  BuendelSignaturFehler,
  BuendelUnsigniertFehler,
  GeraeteIdentitaetGeaendertFehler
} from './buendelSignatur';

export type GeraetePinn = { curve25519: string; ed25519: string };

function idbSchluessel(geraetePubkey: string): string {
  return `pulse.krypto-geraet-pinn.${geraetePubkey}`;
}

export async function geraetePinnLesen(geraetePubkey: string): Promise<GeraetePinn | null> {
  const db = await openIdentityDb();
  const wert = (await idbGetIdentity(db, idbSchluessel(geraetePubkey))) as GeraetePinn | undefined;
  db.close();
  return wert ?? null;
}

/** Merkt den Stand des ERSTEN verifizierten Kontakts — bestehende Pinnung
 *  wird nie still überschrieben (eine Abweichung ist Sache des Aufrufers,
 *  der sie als Fehler behandelt). */
export async function geraetePinnMerken(
  geraetePubkey: string,
  pinn: GeraetePinn
): Promise<void> {
  const db = await openIdentityDb();
  await idbPutIdentity(db, idbSchluessel(geraetePubkey), pinn);
  db.close();
}

/** Authentifiziert einen Claim-Eintrag VOR dem ersten Einsatz seiner
 *  Schluessel — Signatur pruefen, TOFU-Pinnung vergleichen, ersten Kontakt
 *  pinnen. Wirft bei allen drei Misserfolgen (`buendelSignatur.ts`), statt
 *  das Geraet still zu ueberspringen: ein stiller Skip liefert die Nachricht
 *  an weniger Geraete aus, ohne dass es jemand erfahrt.
 *
 *  Die EINE Stelle, die beide Sendewege (DM `senden.ts`, Gruppe
 *  `gruppe/gruppenEinliefern.ts`) aufrufen — der Megolm-Verteilschluessel
 *  geht ueber dieselben Olm-Sitzungen und ist deshalb der groesste Preis,
 *  den ein Schluesseltausch am Verzeichnis erzielen koennte. */
export async function geraetebuendelAuthentifizieren(geraet: {
  device_pubkey: string;
  curve25519: string;
  rueckfallschluessel: string | null;
  ed25519?: string | null;
  bundel_signatur?: string | null;
}): Promise<void> {
  if (!geraet.ed25519 || !geraet.bundel_signatur) {
    throw new BuendelUnsigniertFehler(geraet.device_pubkey);
  }
  if (!signaturPruefen(geraet.ed25519, buendelAnmeldung(geraet), geraet.bundel_signatur)) {
    throw new BuendelSignaturFehler(geraet.device_pubkey);
  }
  const pinn = await geraetePinnLesen(geraet.device_pubkey);
  if (pinn !== null) {
    if (pinn.ed25519 !== geraet.ed25519 || pinn.curve25519 !== geraet.curve25519) {
      throw new GeraeteIdentitaetGeaendertFehler(geraet.device_pubkey);
    }
    return;
  }
  // Erster verifizierter Kontakt — hier (nicht erst beim gebauten Sitzungs-
  // paket) pinnen: die Pinnung haelt OEFFENTLICHES Material fest, und ein
  // Geraet, dessen Vorrat gerade leer ist, hat seinen ersten Kontakt damit
  // trotzdem gehabt.
  await geraetePinnMerken(geraet.device_pubkey, {
    curve25519: geraet.curve25519,
    ed25519: geraet.ed25519
  });
}

/** Löscht die Pinnung eines Geräts — die Nutzer-Entscheidung „das ist
 *  wirklich mein neu aufgesetztes Gerät" (Bestätigungs-UI im Sendeweg,
 *  `dmSenden.ts`). Danach pinnt der nächste verifizierte Kontakt den neuen
 *  Stand ganz normal (TOFU von vorn); nichts weiter muss überführt werden.
 *  **Genau hier liegt die Macht der Entscheidung:** ab diesem Augenblick
 *  gilt, was der Server liefert, als neuer erster Kontakt — die Funktion
 *  darf deshalb nur hinter einer ausdrücklichen Nutzerbestätigung stehen. */
export async function geraetePinnVergessen(geraetePubkey: string): Promise<void> {
  const db = await openIdentityDb();
  await idbDeleteIdentity(db, idbSchluessel(geraetePubkey));
  db.close();
}
