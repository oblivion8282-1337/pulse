/**
 * Untertitel-Zustand einer Watch-Party-Kachel.
 *
 * Sitzt zwischen dem Player (via PartyController) und WatchCaptionsMenu und
 * hält die zwei Dinge, die das Menü anzeigen muss: die wählbaren Spuren und die
 * aktive. Ausgelagert aus WatchPartyTile, das seinen Größen-Cap sonst weiter
 * reisst.
 *
 * Drei nicht-offensichtliche Stücke, jedes aus einer Messung am echten
 * YouTube-Player (Details in youtubeCaptions.ts):
 *
 *  1. AUTOMATISCHE Untertitel stehen NICHT in der Spurliste — die kommt leer
 *     zurück, obwohl eine Spur läuft. Genau dann sitzt ein Zuschauer vor
 *     Untertiteln, die er nicht wegbekommt. Deshalb bauen wir aus der aktiven
 *     Sprache eine {@link CaptionsState.tracks synthetische Spur}, sonst hätte
 *     das Menü nichts anzuzeigen und die Kachel blendete es aus.
 *  2. Der Player verrät seinen Ist-Zustand nur EINMAL: nach dem ersten
 *     Schreiben meldet `getOption('track')` dauerhaft die alte Sprache, auch
 *     wenn die Untertitel sichtbar aus sind. Wir lesen also genau einmal und
 *     führen `active` danach selbst.
 *  3. Die einmal getroffene Wahl muss den Videowechsel überleben: die Kachel
 *     bleibt stehen, aber der Player wird neu gemountet ({#key playerKey}) und
 *     startet wieder mit YouTubes Vorgabe. Ohne Übertragung müsste der
 *     Zuschauer die Untertitel bei jedem Video der Warteschlange neu
 *     abschalten. Dafür ist {@link CaptionsState.#pref} da.
 */

import type { CaptionTrack } from '$lib/watch/sync';

/** Was CaptionsState vom Player braucht — der PartyController erfüllt das. */
export interface CaptionsPort {
  isAvailable(): boolean;
  getCaptionTracks(): CaptionTrack[];
  getActiveCaptionTrack(): string | null;
  setCaptionTrack(languageCode: string | null): void;
}

/** 'de' → 'Deutsch'. Für die synthetische Spur einer automatischen
 * Untertitelung: dort kennen wir nur den Sprachcode, kein Anzeigename. */
function languageLabel(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

export class CaptionsState {
  /** Wählbare Spuren; leer = die Kachel zeigt kein Untertitel-Control. */
  tracks = $state<CaptionTrack[]>([]);
  /** Sprachcode der aktiven Spur, null wenn aus. */
  active = $state<string | null>(null);
  /** Explizite Wahl des Zuschauers; undefined = noch keine getroffen, dann
   * gilt weiter YouTubes Vorgabe. Überlebt den Videowechsel. */
  #pref: string | null | undefined;
  /** Ist-Zustand des aktuellen Players schon gelesen? (Punkt 2 oben.) */
  #read = false;
  /** Ersatz-Eintrag für eine automatische Untertitelung, die in der Spurliste
   * fehlt (Punkt 1 oben). Bleibt stehen, wenn der Zuschauer abschaltet — sonst
   * verschwände mit der aktiven Spur auch der Knopf zum Wiedereinschalten. */
  #fallback: CaptionTrack | undefined;
  readonly #port: CaptionsPort;

  constructor(port: CaptionsPort) {
    this.#port = port;
  }

  /** Spuren neu einlesen — Aufrufer ist das `captions_changed`-Player-Event.
   * Überträgt dabei eine vorhandene Wahl auf das (womöglich neue) Video. */
  refresh(): void {
    // Vor dem Laden des Moduls heisst "keine Spuren" nur "noch nichts bekannt".
    // Würden wir hier schon lesen, stünde #read auf true und der echte
    // Startzustand ginge verloren.
    if (!this.#port.isAvailable()) return;

    const list = this.#port.getCaptionTracks();
    if (!this.#read) {
      this.#read = true;
      const current = this.#port.getActiveCaptionTrack();
      this.active = current;
      if (current && !list.some((t) => t.languageCode === current)) {
        this.#fallback = { languageCode: current, label: languageLabel(current) };
      }
    }
    const fallback = this.#fallback;
    this.tracks =
      fallback && !list.some((t) => t.languageCode === fallback.languageCode)
        ? [...list, fallback]
        : list;

    // Eine gemerkte Sprache nur übertragen, wenn dieses Video sie auch hat;
    // sonst bliebe es bei einem Wunsch, den der Player nicht erfüllen kann.
    // "Aus" (null) gilt dagegen immer.
    const pref = this.#pref;
    if (
      pref !== undefined &&
      this.tracks.length > 0 &&
      (pref === null || this.tracks.some((t) => t.languageCode === pref))
    ) {
      this.#port.setCaptionTrack(pref);
      this.active = pref;
    }
  }

  /** Auswahl durch den Zuschauer: anwenden und als Wunsch merken. */
  select(languageCode: string | null): void {
    this.#pref = languageCode;
    this.#port.setCaptionTrack(languageCode);
    this.active = languageCode;
  }

  /** Beim Videowechsel: der alte Player ist weg, seine Spuren und sein
   * Ist-Zustand gelten nicht mehr. Die gemerkte Wahl (#pref) bleibt bewusst
   * stehen. */
  reset(): void {
    this.tracks = [];
    this.active = null;
    this.#read = false;
    this.#fallback = undefined;
  }
}
