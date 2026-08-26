/**
 * Die Schnittstelle von `TileShell.svelte`.
 *
 * **Warum als eigene Datei:** der Typ ist mit seinen Erklärungen rund achtzig
 * Zeilen und damit fast ein Drittel der Komponente — er ist Dokumentation der
 * Schnittstelle, keine Logik, und drückte `TileShell` über die Grössen-Grenze
 * für Svelte-Komponenten (PLAN.md §12.1). Hier stört er niemanden und ist
 * zugleich die Stelle, an der die vier Kachel-Arten nachlesen, was sie
 * mitgeben dürfen.
 */
import type { Snippet } from 'svelte';
import type { TileKind } from '../openedTiles.svelte';

export interface TileShellProps {
  kind: TileKind;
  /** data-testid des äußeren Containers (kind-spezifisch, kein Schema). */
  containerTestid: string;
  /** Prefix für alle inneren Testids: `${prefix}-mute`, `-fullscreen`, … */
  testidPrefix: string;
  /** Optionales data-identity am Container (Screenshare/Webcam-LiveKit-ID). */
  identity?: string;
  name: string;
  nameTestid?: string;
  /** <video>-Element für den iOS-Fullscreen-Fallback. iframe → null. */
  video?: HTMLVideoElement | null;
  /** HUD im Vollbild erzwungen sichtbar (Verbinde-/Fehler-Overlay). */
  forceHud?: boolean;
  /** Gesetzt → Lautstärke-Regler wird gerendert (HQ + Screenshare). */
  volume?: number;
  /** Obergrenze des Reglers. Vorgabe = Verstärkung bis 200 %; Quellen ohne
   * Verstärkungsgriff (Watch-Party-Kachel) geben 100 vor. */
  volumeMax?: number;
  /** Lautstärke-Änderung. `Event` kommt vom Regler im Dock; `number` von
   *  den mobilischen 5er-Schritt-Knöpfen. */
  onVolumeChange?: (e: Event | number) => void;
  onToggleMute?: () => void;
  audioBlocked?: boolean;
  onEnableAudio?: () => void;
  chatOpen?: boolean;
  onToggleChat?: () => void;
  /** Watch Party: gleicher Seitenpanel-Slot wie der Chat, aber für die
   *  Warteschlange. Chat + Queue schliessen sich gegenseitig aus (der Aufrufer
   *  regelt das), es liegt also immer nur eins rechts. */
  queueOpen?: boolean;
  onToggleQueue?: () => void;
  onDetach?: () => void;
  /** Beschriftung des Abkoppel-Knopfs (s. TileDock). */
  detachLabel?: string;
  /** Steuerleiste ganz weglassen. Der HQ-Stream setzt das, sobald sein Bild
   *  im eigenen Player-Fenster laeuft: dessen Leiste ist dann die einzige
   *  Bedienung, zwei uebereinander waeren nur verwirrend. */
  hideDock?: boolean;
  onHide?: () => void;
  media: Snippet;
  overlay?: Snippet;
  stats?: Snippet;
  nameExtra?: Snippet;
  controlsExtra?: Snippet;
  chatPanel?: Snippet;
  chatOverlay?: Snippet;
  queuePanel?: Snippet;
}
