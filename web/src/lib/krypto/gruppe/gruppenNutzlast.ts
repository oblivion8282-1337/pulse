/**
 * Die zwei Wire-Formen, die eine verschluesselte Gruppe braucht — importfrei,
 * damit Nodes eingebauter Testlaeufer sie ohne Bundler prueft (s. CLAUDE.md
 * „Die Falle").
 *
 * **1. Der Verteilschluessel** faehrt im Klartext EINER 1:1-Olm-Zustellung
 * mit, also genau dort, wo sonst der Text einer Direktnachricht steht. Er
 * geht an jedes Geraet jedes Mitglieds einzeln — das ist der Preis, den
 * Megolm einmal je Sitzung zahlt, statt einmal je Nachricht.
 *
 * **Die Reihenfolge beim Lesen ist eine Sicherheitsfrage, keine
 * Geschmacksfrage.** `nachrichtNutzlast.ts::leseNachrichtNutzlast` faellt auf
 * einen Legacy-Zweig zurueck, sobald der Klartext kein Fassung-1-Objekt MIT
 * `text` ist — und zeigt dann den ROHEN Klartext als Nachrichtentext an. Ein
 * Verteilschluessel-Objekt hat kein `text`, faellt also genau in diesen
 * Zweig: wer erst `leseNachrichtNutzlast` fragt, stellt einem Nutzer den
 * Gruppenschluessel als Chat-Nachricht ins Fenster und legt ihn im lokalen
 * Verlauf ab. **Deshalb fragt der Empfangsweg IMMER zuerst
 * `leseVerteilNutzlast`** — die Funktion ist streng (sie verlangt die Marke
 * `typ` und alle drei Felder) und gibt `null` zurueck, sobald es keiner ist.
 *
 * **2. Die Gruppennachricht** ist der Megolm-Geheimtext. Er reist als eigene
 * Umschlagsart im Postfach (`ART_GRUPPENNACHRICHT`), als EINE Nutzlast mit
 * vielen Empfaengern — das ist der ganze Sinn der Trennung von Nutzlast und
 * Zustellung im Postfach-Modell (`models/postfach.py`). Der Server
 * unterscheidet die Arten nie, er reicht die Zahl nur durch
 * (`PostfachNutzlastIn.art: int`, ohne Wertebereich).
 *
 * **Warum der Geheimtext noch eine Huelle bekommt:** der Empfaenger muss
 * wissen, WELCHE seiner eingehenden Sitzungen gemeint ist. Ein
 * Megolm-Geheimtext traegt die Sitzungskennung zwar in sich, aber der
 * Krypto-Kern reicht sie nicht ueber die WASM-Grenze (`crate::Gruppenempfang`
 * hat keinen Zugriffsweg dafuer, s. `krypto/pulse-krypto/src/gruppe.rs`).
 * Die Alternative — jede vorhandene Sitzung der Reihe nach ausprobieren —
 * waere zwar gefahrlos, wuerde aber mit jeder Verteilrunde langsamer und
 * verwaehrt jede Moeglichkeit, alte Sitzungen je aufzuraeumen. Die Huelle
 * kostet rund 60 Byte je Nachricht.
 *
 * `btoa`/`atob` sind hier zulaessig, obwohl sie nur mit Latin-1 umgehen
 * koennen: der Rumpf der Huelle besteht ausschliesslich aus Hex-Kennungen
 * und Base64 aus dem Krypto-Kern, also aus ASCII. Nutzertext steckt INNEN,
 * im Megolm-Geheimtext, und kommt hier nie vor. Beide Funktionen sind seit
 * Node 16 auch dort global — die Datei bleibt damit importfrei.
 *
 * **Seit 2026-09-01 traegt der Verteilschluessel optional zwei weitere
 * Felder** (Design `docs/superpowers/specs/2026-08-31-ablage-kanaele-
 * design.md` §3.1): den **Ablage-Hauptschluessel** und die
 * **Freigabe-Adresse** eines Ablage-Kanals. Beide reisen im selben
 * Olm-Umschlag wie die Gruppensitzung — ein zweiter Verteilweg haette
 * denselben Inhalt zweimal durch den Krypto-Kern geschickt, ohne
 * zusaetzliche Sicherheit zu gewinnen.
 *
 * **Bewusst KEIN Fassungssprung.** `FASSUNG` bleibt `1`: die beiden neuen
 * Felder sind optional und werden nur gesetzt, wenn BEIDE vorhanden sind.
 * Ein aelterer Klient, der `leseVerteilNutzlast` noch ohne sie kennt, liest
 * dieselben drei Pflichtfelder wie bisher und ignoriert den Rest des
 * JSON-Objekts stillschweigend — er „erstickt" nicht an einem erweiterten
 * Umschlag, er sieht ihn einfach nicht. Ein neuerer Klient, der eine
 * Nutzlast OHNE die beiden Felder bekommt (private Gruppe, kein
 * Ablage-Kanal), liest `undefined` — auch das ist der Normalfall, kein
 * Fehler. Ein Fassungssprung waere hier die falsche Antwort: er haette
 * JEDEN aelteren Klienten an JEDER Nutzlast dieses Typs scheitern lassen,
 * nicht nur an den wenigen, die tatsaechlich einen Ablage-Kanal betreffen.
 */

const FASSUNG = 1;

/** Marke im Klartext einer Olm-Zustellung, die einen Gruppenschluessel
 *  transportiert. Ein anderer Wert (oder ein fehlendes Feld) heisst: keiner. */
const TYP_VERTEILSCHLUESSEL = 'gruppenschluessel';

/**
 * Die Umschlagsart einer Megolm-Gruppennachricht im Postfach.
 *
 * 0 und 1 sind vergeben (Olm-Sitzungsaufbau / laufende Olm-Nachricht, s.
 * `Umschlagart` im Krypto-Kern und `models/postfach.py`). 2 ist neu und
 * gehoert NICHT dem Krypto-Kern — sie beschreibt, was in `daten` steht, und
 * unterscheidet damit an genau einer Stelle, ob eine Zustellung ueber eine
 * Olm- oder ueber eine Megolm-Sitzung zu oeffnen ist.
 */
export const ART_GRUPPENNACHRICHT = 2;

export type Verteilnutzlast = {
  /** Kanal-ID der Gruppe. Faehrt mit, obwohl die Zustellung ihren Kanal
   *  ohnehin nennt: der Verteilschluessel wird ueber die 1:1-Sitzung des
   *  DM-Kanals verschickt, wenn es einen gibt — Kanal der Zustellung und
   *  Kanal der Gruppe sind dann verschieden. Wer sich auf die Zustellung
   *  verliesse, ordnete den Schluessel der falschen Gruppe zu. */
  kanal: string;
  sitzung: string;
  /** Base64, aus `Gruppensitzung::verteilschluessel()`. NIE loggen. */
  schluessel: string;
  /** NUR bei Ablage-Kanaelen (Design §3.1): der Ablage-Hauptschluessel des
   *  Kanalordners, Base64. Immer zusammen mit `freigabeAdresse` gesetzt oder
   *  gar nicht — die Haelfte eines Paars ist unbrauchbar. NIE loggen. */
  ablageHauptschluessel?: string;
  /** NUR bei Ablage-Kanaelen: die Freigabe-Adresse des Kanalordners (Design
   *  §4.1) — kein Geheimnis im Sinne von Zugangsdaten (ein Faehigkeits-
   *  Verweis), aber trotzdem nur an Mitglieder verteilt, s. dort. */
  freigabeAdresse?: string;
};

export type Gruppenhuelle = {
  sitzung: string;
  /** Base64 des Megolm-Geheimtexts. */
  nachricht: string;
};

/** Nur bei Ablage-Kanaelen mitgegeben, s. `Verteilnutzlast`-Kopfkommentar. */
export interface AblageVerteilzugabe {
  /** Base64. */
  hauptschluessel: string;
  freigabeAdresse: string;
}

/** Baut die Klartext-Bytes, die anschliessend eine 1:1-Olm-Sitzung
 *  verschluesselt. `ablage` ist nur bei Ablage-Kanaelen gesetzt (Design
 *  §3.1) — ohne sie entsteht dieselbe Nutzlast wie bisher, byteidentisch. */
export function baueVerteilNutzlast(
  kanal: string,
  sitzung: string,
  schluessel: string,
  ablage?: AblageVerteilzugabe
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      v: FASSUNG,
      typ: TYP_VERTEILSCHLUESSEL,
      kanal,
      sitzung,
      schluessel,
      ...(ablage
        ? { ablageHauptschluessel: ablage.hauptschluessel, freigabeAdresse: ablage.freigabeAdresse }
        : {})
    })
  );
}

/**
 * Liest einen entschluesselten Olm-Klartext als Verteilschluessel — `null`,
 * wenn es keiner ist. Streng: fehlt ein Feld oder stimmt die Marke nicht,
 * ist es keiner. Fail-closed, weil der Aufrufer den Rueckgabewert `null` als
 * „das ist eine gewoehnliche Nachricht" deutet und ein halb gelesener
 * Schluessel eine unbrauchbare Sitzung ergaebe.
 */
export function leseVerteilNutzlast(bytes: Uint8Array): Verteilnutzlast | null {
  let geparst: unknown;
  try {
    geparst = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (geparst === null || typeof geparst !== 'object') return null;
  const o = geparst as Record<string, unknown>;
  if (o.v !== FASSUNG || o.typ !== TYP_VERTEILSCHLUESSEL) return null;
  if (
    typeof o.kanal !== 'string' ||
    typeof o.sitzung !== 'string' ||
    typeof o.schluessel !== 'string'
  ) {
    return null;
  }
  const ergebnis: Verteilnutzlast = { kanal: o.kanal, sitzung: o.sitzung, schluessel: o.schluessel };
  // Nur setzen, wenn BEIDE da sind — s. Modulkopf. Damit bleibt eine
  // gewoehnliche Nutzlast (kein Ablage-Kanal) exakt das Objekt aus den drei
  // Pflichtfeldern, keine zusaetzlichen `undefined`-Schluessel.
  if (typeof o.ablageHauptschluessel === 'string' && typeof o.freigabeAdresse === 'string') {
    ergebnis.ablageHauptschluessel = o.ablageHauptschluessel;
    ergebnis.freigabeAdresse = o.freigabeAdresse;
  }
  return ergebnis;
}

/** Baut den `daten`-Wert einer Postfach-Nutzlast der Art
 *  `ART_GRUPPENNACHRICHT` — Base64, wie jede andere Nutzlast auch. */
export function baueGruppenhuelle(sitzung: string, nachricht: string): string {
  return btoa(JSON.stringify({ v: FASSUNG, sitzung, nachricht }));
}

/** Liest den `daten`-Wert einer Zustellung der Art `ART_GRUPPENNACHRICHT`.
 *  `null`, wenn er unlesbar ist — der Aufrufer laesst die Zustellung dann
 *  liegen, statt sie zu quittieren (dieselbe Regel wie bei einem unlesbaren
 *  Olm-Umschlag, s. `krypto/empfangen.ts`-Modulkopf). */
export function leseGruppenhuelle(daten: string): Gruppenhuelle | null {
  let geparst: unknown;
  try {
    geparst = JSON.parse(atob(daten));
  } catch {
    return null;
  }
  if (geparst === null || typeof geparst !== 'object') return null;
  const o = geparst as Record<string, unknown>;
  if (o.v !== FASSUNG) return null;
  if (typeof o.sitzung !== 'string' || typeof o.nachricht !== 'string') return null;
  return { sitzung: o.sitzung, nachricht: o.nachricht };
}

/**
 * Eine Sitzungskennung — 32 Hex-Zeichen aus `crypto.getRandomValues`.
 *
 * Sie ist KEIN Geheimnis (sie steht in jeder Gruppennachricht im Klartext
 * der Huelle) und muss nur innerhalb eines Kanals eindeutig sein. Zufall
 * statt Zaehler, weil zwei Geraete desselben Kontos unabhaengig voneinander
 * Sitzungen anlegen und ein Zaehler dann kollidierte.
 */
export function neueSitzungId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
