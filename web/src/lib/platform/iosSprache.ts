/**
 * Nativer Sprach-Raum auf iOS (Hülle: `SprachePlugin.swift`).
 *
 * **Warum es ihn gibt.** Den Sprachton spielt sonst WebKits eigener Prozess
 * ab, und dessen Audio-Session fordert den Lautsprecher und ist nicht
 * mischbar — die Hörmuschel ist aus dem Web heraus unerreichbar, und jedes
 * Drehen an der eigenen Session unterbricht nur WebKit. Beides am 2026-10-10
 * am Gerät gemessen; voller Befund und Zuschnitt im Entwurf
 * `docs/superpowers/specs/2026-10-10-ios-nativer-sprachweg-design.md`.
 *
 * **Die Anmeldung bleibt hier.** Das Token holt weiter der Klient und reicht
 * es hinüber; die Hülle kennt weder Konten noch Sitzungen.
 *
 * Alles andere (Browser, Electron, Android) sieht davon nichts — die Funktion
 * `nativerSprachwegDa()` ist dort `false`, und der bestehende Weg bleibt.
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

import { isCapacitorIOS } from './runtime';
import { tonNativerRaum } from './iosTon';
import type {
  NativerEigenerZustand,
  NativerTeilnehmer,
  NativerWunsch,
  NativerZustand,
  SprachePlugin
} from './iosSpracheTypen';

// Weitergereicht, damit die Aufrufer ihren Import nicht ändern müssen — die
// Typen sind Teil DIESER Schnittstelle, sie liegen nur woanders.
export type { NativerEigenerZustand, NativerTeilnehmer, NativerWunsch, NativerZustand };

/**
 * **Über `registerPlugin`, nicht über `window.Capacitor.Plugins` — und das ist
 * kein Geschmack, das hat die App zum Absturz gebracht.**
 *
 * Der erste Entwurf griff das rohe Objekt aus `Capacitor.Plugins`. Methoden
 * gehen darüber durch, Ereignis-Hörer NICHT: `addListener` lief dort über den
 * allgemeinen Brücken-Weg, der die Argumente der Reihe nach schickt statt als
 * benanntes Feld. Nativ kam der Ruf ohne `eventName` an, und Capacitors
 * `addEventListener` legt ihn als Schlüssel in ein `NSMutableDictionary` —
 * mit `nil` wirft das eine NSException, und die reisst den ganzen Prozess
 * mit. Am 2026-10-10 am Gerät: der Beitritt zum Sprachkanal beendete die App,
 * ohne eine einzige Zeile im Web-Log, weil es kein JS-Fehler war. Sichtbar
 * wurde es erst im Absturzbericht (`-[CAPPlugin addEventListener:listener:]`).
 *
 * Verräterisch war auch der Rückgabewert: `addListener` lieferte einen
 * String statt eines Promise. Wer diesen Weg wieder angeht, prüft das zuerst.
 *
 * Der Rest des Projekts macht es längst so (`schnellwahl.ts`, `appSperre`,
 * `iosWachhalten`, Anrufe).
 */
const nativ = registerPlugin<SprachePlugin>('SprachePlugin');

function plugin(): SprachePlugin | null {
  // **Der Guard ist Pflicht, nicht Vorsicht.** Ausserhalb der Hülle ist das
  // ein Web-Stub, und dessen `addListener` WIRFT („not implemented on web") —
  // im Browser riss das schon einmal den ganzen Start mit (Befund 2026-09-09
  // an `anruf.svelte.ts`).
  return isCapacitorIOS() ? nativ : null;
}

/**
 * **Notschalter. AN seit dem 2026-10-10** (Eigentümer-Entscheid: der native
 * Weg soll es werden, und zwar sauber).
 *
 * Er bleibt als Schalter stehen, weil die Web-App zentral ausgeliefert wird
 * und JEDES Telefon sofort erreicht: wer hier etwas kaputtmacht, nimmt allen
 * iOS-Nutzern die Sprache, bis ein neuer Bau draussen ist. Mit dem Schalter
 * ist der Rückweg eine Zeile.
 *
 * **Er hat an genau diesem Tag schon einmal Zeit gekostet:** auf `false`
 * gesetzt und dann vergessen, liefen vier Messläufe unbemerkt auf dem ALTEN
 * Weg — die Oberfläche sah richtig aus, nur die Zahlen gehörten zu etwas
 * anderem. Wer hier misst, prüft diesen Wert ZUERST.
 */
const NATIVER_SPRACHWEG_AN = true;

/**
 * Trägt diese App den nativen Weg?
 *
 * **Die Prüfung auf das Plugin ist nicht Zierde, sondern Pflicht.** Web und
 * Hülle werden getrennt ausgeliefert: die Oberfläche kommt bei jedem Start
 * frisch vom Server, die App nur über den Store. Ein Telefon mit älterem
 * Binary bekommt diese Datei also, ohne das Plugin zu haben — ohne diese
 * Weiche gäbe es dort gar keine Sprache mehr.
 */
export function nativerSprachwegDa(): boolean {
  if (!NATIVER_SPRACHWEG_AN) return false;
  if (!isCapacitorIOS()) return false;
  // **Gefragt wird die HÜLLE, nicht `Capacitor.Plugins`.** Hier stand bis zum
  // 2026-10-11 `Plugins.SprachePlugin !== undefined` — und das war immer
  // wahr: `registerPlugin` oben schreibt den Eintrag beim Import dieser Datei
  // selbst hinein, ob die Hülle das Plugin hat oder nicht. Auf jedem älteren
  // App-Bau lief der Beitritt damit in `UNIMPLEMENTED`, ohne Rückfall auf den
  // Web-Weg: keine Sprache, sobald dieser Web-Stand ausgeliefert ist
  // (Bughunt 2026-10-11, K1, in Node nachgebaut).
  //
  // `isPluginAvailable` liest die Kopfzeilen, die die Hülle beim Laden der
  // Seite einspielt (`Capacitor.PluginHeaders`) — und die kommen nur für
  // Plugins, die der Bau wirklich trägt. Das Verhalten beider Wege ist in
  // `test/ios-sprache-weiche.test.ts` gegen das echte `@capacitor/core`
  // festgehalten.
  return Capacitor.isPluginAvailable('SprachePlugin');
}

/**
 * Was WebKit über seine EIGENE Audio-Session sagt — und das entscheidet auf
 * dem nativen Weg, ob die Hörmuschel wählbar ist.
 * **Nur aus `raumBeginnt`/`raumEndet`** — dort kippt `tonNativerRaum` mit.
 *
 * **Der Befund, 2026-10-10 am iPhone 16 Pro (iOS 26.6.2).** Die Hülle führt
 * den Sprachton, aber die Oberfläche spielt weiter ihre eigenen Töne — und der
 * erste kommt unmittelbar nach dem Beitritt (`voice.self_join` in
 * `voice/nativerRaum.svelte.ts`). WebKit richtet dafür seine eigene Session ein,
 * und mit der Vorgabe `auto` ist die nicht mischbar: sie übernimmt die
 * Routen-Hoheit (im Gerätelog `cmsTakeControl … requires Volume_Routing`,
 * `routeSharingPolicy LongFormAudio`), und iOS **unterbricht** daraufhin
 * unsere Session. Ab da ist sie nicht mehr aktiv — und genau daran scheiterte
 * die Hörmuschel: das SDK wählt Lautsprecher oder Hörmuschel allein über
 * `setCategory`, und eine Kategorie bewegt an einer nicht aktiven Session
 * keine Route (sie meldet nicht einmal einen Routenwechsel).
 *
 * **Gemessen, derselbe Lauf, derselbe Ton, nur dieser Wert verschieden:**
 *
 * | `navigator.audioSession.type` | nach dem Ton |
 * |---|---|
 * | `auto` (bisher) | Audio-Maschine aus, Session ohne Eingang → Umschalten wirkungslos |
 * | `ambient` | Maschine läuft, Eingang bleibt → `Receiver` |
 *
 * `ambient` ist mischbar: WebKit legt seinen Ton dazu, statt die Session zu
 * übernehmen. Die Töne bleiben hörbar — nur eben als Beiwerk neben dem
 * Gespräch.
 *
 * **Der Preis, und er ist Absicht:** eine mischbare Session folgt dem
 * Klingel-Schalter. Wer im Sprachkanal sitzt und das Telefon auf stumm
 * stellt, hört die Oberflächen-Töne nicht mehr — was für „stumm" das
 * Richtige ist. Deshalb gilt der Wert nur SOLANGE der native Raum steht und
 * wird beim Verlassen auf `auto` zurückgenommen.
 *
 * **OFFEN, und vom Eigentümer zu entscheiden — nicht von dieser Datei:**
 * `ambient` gilt für die GANZE WebView, also auch für den Ton einer
 * HQ-Übertragung (WHEP), die man im Sprachkanal ansieht. Der folgt damit,
 * solange der native Raum steht, ebenfalls dem Klingel-Schalter und endet
 * beim Sperren des Bildschirms — und er ist dort nicht Beiwerk, sondern der
 * Inhalt (Bughunt 2026-10-11, K2). Die Alternative `auto` kostet die
 * Hörmuschel (Messung oben). Beides zugleich gibt die W3C-Schnittstelle nicht
 * her; eine Lösung bräuchte eine Unterscheidung, die es heute nicht gibt
 * (etwa den Stream-Ton ebenfalls nativ). Bis zur Entscheidung bleibt es bei
 * `ambient` — die Hörmuschel ist der Grund für den ganzen Umbau.
 *
 * **Zweite Schreibstelle derselben Eigenschaft** ist `webAudioSession` in
 * `platform/iosTon.ts`; die ist abgeschaltet (`WEB_AUDIO_SESSION_AN`) und
 * schweigt zusätzlich, solange der native Raum steht.
 */
function webSessionTyp(typ: 'ambient' | 'auto'): void {
  if (!isCapacitorIOS()) return;
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  // Vor iOS 17 gibt es die Schnittstelle nicht. Dann bleibt es beim alten
  // Verhalten — kein Grund, den Beitritt daran scheitern zu lassen.
  if (!nav.audioSession) return;
  try {
    nav.audioSession.type = typ;
  } catch {
    // Ein nicht angenommener Wert darf den Beitritt nicht aufhalten.
  }
}

/**
 * **Der native Raum steht — für WebKits Session UND für unsere eigene
 * Session-Steuerung, an EINER Stelle.**
 *
 * Zwei Dinge gelten genau so lange, wie die Hülle einen Raum hält: WebKits
 * Session ist `ambient` (s. `webSessionTyp`), und `iosTon` fasst die Session
 * nicht an, weil sie LiveKit gehört (`tonNativerRaum`, Bughunt K2). Bis zum
 * 2026-10-11 hing nur das Erste hier, und es kippte nicht in allen Fällen
 * zurück: ein gescheiterter Beitritt liess WebKit auf `ambient` stehen (M2),
 * ein Abbruch von aussen ebenso (M1).
 *
 * `raumGen` hält die Fälle auseinander, in denen ein überholter Beitritt
 * erst scheitert, wenn schon der nächste läuft — sein `raumEndet` darf den
 * neueren nicht abräumen.
 */
let raumGen = 0;

function raumBeginnt(): number {
  webSessionTyp('ambient');
  tonNativerRaum(true);
  return ++raumGen;
}

function raumEndet(gen?: number): void {
  if (gen !== undefined && gen !== raumGen) return;
  raumGen++;
  webSessionTyp('auto');
  tonNativerRaum(false);
}

export async function spracheBeitreten(
  wsUrl: string,
  token: string,
  kanalId: string,
  kanalName: string,
  startStumm: boolean,
  startTaub: boolean,
  hoeren?: { je: Record<string, number>; gesamt: number }
): Promise<NativerZustand> {
  const p = plugin();
  if (!p) throw new Error('SprachePlugin fehlt');
  // **Vor dem Beitritt, nicht danach.** Der Ton, der die Session übernimmt,
  // kommt unmittelbar nach dem gelungenen Beitritt — eine Erklärung, die
  // erst danach abgegeben wird, kommt zu spät.
  const gen = raumBeginnt();
  try {
    return await p.beitreten({
      wsUrl,
      token,
      kanalId,
      kanalName,
      startStumm,
      startTaub,
      lautstaerken: hoeren?.je,
      gesamt: hoeren?.gesamt
    });
  } catch (e) {
    raumEndet(gen);
    throw e;
  }
}

/**
 * `sitzung`: nur verlassen, wenn genau dieser Beitritt noch läuft (s.
 * `sitzung` in `SpracheRaum.swift`). Ohne sie trifft es, was gerade läuft.
 */
export async function spracheVerlassen(sitzung?: number): Promise<void> {
  try {
    await plugin()?.verlassen(sitzung === undefined ? {} : { sitzung });
  } finally {
    // Ein gezieltes Verlassen eines schon abgelösten Raums ändert am
    // laufenden nichts — dann bleibt auch WebKits Erklärung stehen.
    if (sitzung === undefined) raumEndet();
  }
}

/**
 * Nach einem Reload: die Hülle hält noch einen Raum, und die Seite übernimmt
 * ihn (`voice/nativerRaum.svelte.ts`). **WebKits Erklärung gilt je
 * Dokument** — die neue Seite hat sie nicht, also wird sie neu abgegeben.
 */
export function spracheRaumUebernommen(): void {
  raumBeginnt();
}

/** Der Raum ist von aussen weggebrochen; die Hülle hat ihn schon abgeräumt. */
export function spracheRaumWeg(): void {
  raumEndet();
}

export async function spracheMikrofon(an: boolean): Promise<NativerZustand | null> {
  return plugin()?.mikrofon({ an }) ?? null;
}

/**
 * Mithören aus. **Muss über die Brücke:** der Web-Weg schaltet dafür die
 * `<audio>`-Elemente der fremden Spuren stumm (`RemoteAudioElements`), und
 * die gibt es auf dem nativen Weg nicht — den Ton spielt der native Prozess.
 * Bis zum 2026-10-10 lief `setDeafened` auf iOS deshalb ins Leere: der Knopf
 * kippte, das Zeichen wechselte, der Server meldete allen anderen „taub" —
 * und gehört wurde weiter alles. **Das ist schlimmer als eine fehlende
 * Funktion**, weil es nach aussen aussieht wie eine vorhandene.
 */
export async function spracheTaub(an: boolean): Promise<NativerZustand | null> {
  return plugin()?.taub({ an }) ?? null;
}

/**
 * Lautstärke je Nutzer und gesamt — immer die ganze Tabelle (Begründung an
 * `lautstaerken` in `SprachePlugin.swift`). Eine ältere Hülle kennt den
 * Befehl nicht und lehnt ab; der Aufrufer schluckt das.
 */
export async function spracheLautstaerken(
  je: Record<string, number>,
  gesamt: number
): Promise<void> {
  await plugin()?.lautstaerken({ lautstaerken: je, gesamt });
}

export async function spracheKamera(an: boolean): Promise<NativerZustand | null> {
  return plugin()?.kamera({ an }) ?? null;
}

export async function spracheKameraSeite(front: boolean): Promise<NativerZustand | null> {
  return plugin()?.kameraSeite({ front }) ?? null;
}

/**
 * Die native Kanalansicht zeigen beziehungsweise wegnehmen — **der einzige
 * Weg zu einem Bild.** Kamera- und Bildschirmspuren entstehen im nativen
 * Prozess; die WebView kann sie nicht anzeigen. Deshalb wird die Ansicht
 * nativ gezeichnet und über die Oberfläche gelegt — die Web-App bleibt
 * darunter stehen (Entwurf §5).
 *
 * **Öffnen ist idempotent, Schliessen nimmt nur die ANSICHT**, nie den Raum:
 * ein Wischen nach unten darf nicht versehentlich auflegen.
 */
export async function spracheAnsichtOeffnen(): Promise<NativerZustand | null> {
  return plugin()?.ansichtOeffnen() ?? null;
}

export async function spracheAnsichtSchliessen(): Promise<NativerZustand | null> {
  return plugin()?.ansichtSchliessen() ?? null;
}

export async function spracheAusgabe(
  weg: 'lautsprecher' | 'hoermuschel'
): Promise<NativerZustand | null> {
  return plugin()?.ausgabe({ weg }) ?? null;
}

export async function spracheZustand(): Promise<NativerZustand | null> {
  return plugin()?.zustand() ?? null;
}

/** Alle Ereignisse der Hülle anmelden. Gibt den Abmelder zurück. */
export function spracheBeobachten(h: {
  verbindung: (e: { zustand: string; fehler?: string }) => void;
  teilnehmer: (liste: NativerTeilnehmer[]) => void;
  sprechen: (identitaeten: string[]) => void;
  eigenerZustand: (e: NativerEigenerZustand) => void;
  /** Der Nutzer hat die native Ansicht verlassen — **nicht** den Raum. */
  ansichtGeschlossen: () => void;
  /** Ein Knopf der nativen Ansicht, dessen Regeln hier liegen. */
  wunsch: (e: NativerWunsch) => void;
}): () => void {
  const p = plugin();
  if (!p) return () => undefined;
  const griffe = [
    p.addListener('verbindung', h.verbindung),
    p.addListener('teilnehmer', (e) => h.teilnehmer(e.liste)),
    p.addListener('sprechen', (e) => h.sprechen(e.sprechen)),
    p.addListener('eigenerZustand', h.eigenerZustand),
    p.addListener('ansichtGeschlossen', h.ansichtGeschlossen),
    p.addListener('wunsch', h.wunsch)
  ];
  return () => {
    for (const g of griffe) void g.then((x) => x.remove()).catch(() => undefined);
  };
}
