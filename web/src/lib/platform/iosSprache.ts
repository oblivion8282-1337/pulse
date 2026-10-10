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

import { registerPlugin } from '@capacitor/core';

import { isCapacitorIOS } from './runtime';
import type {
  NativerEigenerZustand,
  NativerTeilnehmer,
  NativerZustand,
  SprachePlugin
} from './iosSpracheTypen';

// Weitergereicht, damit die Aufrufer ihren Import nicht ändern müssen — die
// Typen sind Teil DIESER Schnittstelle, sie liegen nur woanders.
export type { NativerEigenerZustand, NativerTeilnehmer, NativerZustand };

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
  // `registerPlugin` liefert immer ein Objekt, auch für ein Plugin, das die
  // Hülle gar nicht hat — die Frage ist also nicht, ob es da ist, sondern ob
  // die Hülle es kennt.
  const cap = (window as Window & { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor;
  return cap?.Plugins?.SprachePlugin !== undefined;
}

/**
 * Was WebKit über seine EIGENE Audio-Session sagt — und das entscheidet auf
 * dem nativen Weg, ob die Hörmuschel wählbar ist.
 *
 * **Der Befund, 2026-10-10 am iPhone 16 Pro (iOS 26.6.2).** Die Hülle führt
 * den Sprachton, aber die Oberfläche spielt weiter ihre eigenen Töne — und der
 * erste kommt unmittelbar nach dem Beitritt (`voice.self_join` in
 * `voice/livekit.svelte.ts`). WebKit richtet dafür seine eigene Session ein,
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
 * wird beim Verlassen auf `auto` zurückgenommen: der Stream-Ton (WHEP) läuft
 * weiter in der WebView und braucht dort eine richtige Session, auch bei
 * gesperrtem Bildschirm.
 *
 * **Zweite Schreibstelle derselben Eigenschaft** ist `webAudioSession` in
 * `platform/iosTon.ts`; die ist abgeschaltet (`WEB_AUDIO_SESSION_AN`) und
 * gehört zum Web-Weg, den es auf iOS nicht mehr gibt. Wer sie wieder
 * einschaltet, prüft zuerst, dass sie diesen Wert nicht überschreibt.
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

export async function spracheBeitreten(
  wsUrl: string,
  token: string,
  kanalId: string,
  kanalName: string,
  startStumm: boolean,
  startTaub: boolean
): Promise<NativerZustand> {
  const p = plugin();
  if (!p) throw new Error('SprachePlugin fehlt');
  // **Vor dem Beitritt, nicht danach.** Der Ton, der die Session übernimmt,
  // kommt unmittelbar nach dem gelungenen Beitritt — eine Erklärung, die
  // erst danach abgegeben wird, kommt zu spät.
  webSessionTyp('ambient');
  return p.beitreten({ wsUrl, token, kanalId, kanalName, startStumm, startTaub });
}

export async function spracheVerlassen(): Promise<void> {
  await plugin()?.verlassen();
  webSessionTyp('auto');
}

export async function spracheMikrofon(an: boolean): Promise<NativerZustand | null> {
  return plugin()?.mikrofon({ an }) ?? null;
}

/**
 * Mithören aus.
 *
 * **Warum das überhaupt über die Brücke muss.** Der Web-Weg schaltet dafür die
 * `<audio>`-Elemente stumm, die die fremden Spuren abspielen
 * (`RemoteAudioElements`). Auf dem nativen Weg gibt es die nicht — den Ton
 * spielt der native Prozess. Bis zum 2026-10-10 lief `setDeafened` auf iOS
 * deshalb ins Leere: der Knopf kippte, das Zeichen wechselte, der Server
 * meldete allen anderen „taub" — und gehört wurde weiter alles. **Das ist
 * schlimmer als eine fehlende Funktion**, weil es nach aussen aussieht wie
 * eine vorhandene.
 */
export async function spracheTaub(an: boolean): Promise<NativerZustand | null> {
  return plugin()?.taub({ an }) ?? null;
}

export async function spracheKamera(an: boolean): Promise<NativerZustand | null> {
  return plugin()?.kamera({ an }) ?? null;
}

export async function spracheKameraSeite(front: boolean): Promise<NativerZustand | null> {
  return plugin()?.kameraSeite({ front }) ?? null;
}

/**
 * Die native Kanalansicht zeigen beziehungsweise wegnehmen.
 *
 * **Sie ist der einzige Weg zu einem Bild.** Kamera- und Bildschirmspuren
 * entstehen im nativen Prozess; die WebView kann sie nicht anzeigen. Deshalb
 * wird die Ansicht nativ gezeichnet und über die Oberfläche gelegt — die
 * Web-App bleibt darunter stehen (Entwurf §5).
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
}): () => void {
  const p = plugin();
  if (!p) return () => undefined;
  const griffe = [
    p.addListener('verbindung', h.verbindung),
    p.addListener('teilnehmer', (e) => h.teilnehmer(e.liste)),
    p.addListener('sprechen', (e) => h.sprechen(e.sprechen)),
    p.addListener('eigenerZustand', h.eigenerZustand),
    p.addListener('ansichtGeschlossen', h.ansichtGeschlossen)
  ];
  return () => {
    for (const g of griffe) void g.then((x) => x.remove()).catch(() => undefined);
  };
}
