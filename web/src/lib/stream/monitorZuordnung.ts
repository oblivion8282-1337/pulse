/**
 * Welcher Bildschirm zu welchem Stream-Platz gehört — die reine Rechnung.
 *
 * **Warum getrennt von `captureSource.ts`:** damit sie prüfbar ist. Der
 * Web-Testläufer (`pnpm test:unit`, Nodes eingebauter) kann eine Datei nur
 * ausführen, wenn sie keinen erweiterungslosen Laufzeit-Import mitschleppt —
 * den löst der Bundler auf, Node nicht. `captureSource.ts` hängt an
 * `$lib/platform/runtime` und am Einstellungs-Zustand und ist damit
 * unerreichbar; dieses Modul importiert **nichts**. Gleiches Muster wie
 * `quellenummer.ts` und `remote/zeigerbildPruefung.ts`, aus demselben Grund.
 *
 * Die Zuordnung war bis zum 2026-08-26 ungetestet — und genau hier saß der
 * Fehler, den ein Nutzer als „Pulse bringt die Bildschirme durcheinander"
 * gemeldet hat.
 *
 * **Was hier NICHT gelöst wird:** dass eine Bildschirm-Nummer überhaupt als
 * Identität taugt. Sie ist die Position in der Aufzählung des Betriebssystems
 * (`ops/list_monitors.rs`) — fällt ein Bildschirm heraus, rücken alle
 * dahinterliegenden eine Stelle vor, und dieselbe gespeicherte Nummer zeigt
 * danach auf ein anderes Gerät. Dagegen hilft nur eine Kennung, die vom Gerät
 * selbst kommt; das ist ein eigenes Vorhaben. Hier wird nur verhindert, dass
 * eine gespeicherte Wahl dabei **verloren geht**.
 */

/** Was die Zuordnung von einem Bildschirm wissen muss. */
export interface Schirm {
  index: number;
  primary?: boolean;
}

/** Vorsatz einer Bildschirm-Quelle; muss zu `settingsCatalog.ts` passen. */
const MONITOR_VORSATZ = 'Monitor: ';

/**
 * Die Bildschirme in der Reihenfolge, in der sie an die Plätze verteilt werden:
 * Hauptbildschirm zuerst, danach die übrigen so, wie der Sidecar sie meldet.
 */
export function reihenfolge(schirme: readonly Schirm[]): Schirm[] {
  const haupt = schirme.find((s) => s.primary) ?? schirme[0];
  if (!haupt) return [];
  return [haupt, ...schirme.filter((s) => s !== haupt)];
}

/**
 * Die Vorgabe für einen Platz, für den noch nichts gewählt wurde: der N-te
 * Bildschirm der Reihe. Wer zwei Schirme hat, bekommt so ohne Zutun je einen
 * Stream pro Schirm.
 *
 * Gehen die Bildschirme aus, fängt die Reihe von vorn an — mehr Streams als
 * Schirme sind erlaubt, und reihum verteilt es sich wenigstens gleichmäßig,
 * statt alle überzähligen auf denselben zu legen. Ohne gemeldeten Bildschirm
 * bleibt es beim Portal-Wert.
 */
export function vorgabeFuerPlatz(platz: number, schirme: readonly Schirm[]): string {
  const reihe = reihenfolge(schirme);
  if (reihe.length === 0) return 'portal';
  return `${MONITOR_VORSATZ}${reihe[platz % reihe.length].index}`;
}

/** Die Bildschirm-Nummer aus einer Quelle, oder `undefined`. */
export function nummerAus(quelle: string): number | undefined {
  const treffer = /^Monitor: (\d+)$/.exec(quelle);
  return treffer ? Number(treffer[1]) : undefined;
}

/**
 * Trägt die gespeicherte Wahl noch? Nur dann darf sie ersetzt werden.
 *
 * **Eine fehlende Nummer heisst NICHT „ersetzen".** Bis zum 2026-08-26 wurde
 * die gespeicherte Wahl weggeschrieben, sobald ihre Nummer gerade nicht in der
 * Liste stand — und die Liste ist genau dann unvollständig, wenn ein Bildschirm
 * kurz weg ist: beim Aufwachen aus der Sperre, während ein Kabel wackelt, oder
 * bevor der Sidecar geantwortet hat. Kam der Bildschirm zurück, war die Wahl
 * längst überschrieben und der Nutzer sass dauerhaft auf dem falschen.
 *
 * Deshalb wird eine gemerkte Bildschirm-Wahl **nie** verworfen. Sie kostet im
 * schlimmsten Fall einen Eintrag für ein Kabel, das nie wiederkommt — und
 * dieser Eintrag tut nichts, weil {@link quelleFuerStart} beim Start ohnehin
 * auf einen vorhandenen Bildschirm ausweicht.
 *
 * Fenster sind der andere Fall: ein geschlossenes Fenster kommt nicht wieder
 * (die Kennung wird neu vergeben), eine Fenster-Wahl darf also verfallen.
 */
export function wahlBleibt(quelle: string): boolean {
  return quelle === 'portal' || nummerAus(quelle) !== undefined;
}

/**
 * Womit dieser Platz JETZT aufnimmt — für Anzeige und Start.
 *
 * Die gespeicherte Wahl gewinnt, solange ihr Ziel vorhanden ist. Ist es das
 * gerade nicht, wird ausgewichen, **ohne die Wahl zu ändern**: der Rückfall
 * gilt für diesen einen Start, nicht für immer.
 *
 * `ausweichend` sagt dem Aufrufer, dass hier nicht das Gewählte läuft — die
 * Oberfläche kann das anzeigen, statt den Nutzer glauben zu lassen, er sähe
 * seinen Bildschirm. Ohne dieses Feld wäre der Rückfall stumm, und genau das
 * war die Beschwerde: es sah aus, als habe Pulse die Bildschirme vertauscht.
 */
export function quelleFuerStart(
  gewaehlt: string,
  platz: number,
  schirme: readonly Schirm[],
  fensterIds: readonly number[],
): { quelle: string; ausweichend: boolean } {
  const fenster = /^window:(\d+)$/.exec(gewaehlt);
  if (fenster && fensterIds.includes(Number(fenster[1]))) {
    return { quelle: gewaehlt, ausweichend: false };
  }
  const nummer = nummerAus(gewaehlt);
  if (nummer !== undefined && schirme.some((s) => s.index === nummer)) {
    return { quelle: gewaehlt, ausweichend: false };
  }
  if (gewaehlt === 'portal') return { quelle: gewaehlt, ausweichend: false };
  // Ohne Bildschirmliste laesst sich nichts feststellen — sie ist beim Oeffnen
  // des Dialogs noch leer, bis der Sidecar geantwortet hat, und unter Linux
  // bleibt sie es. „Es fehlt etwas" waere dann keine Feststellung, sondern
  // Unwissen, und eine Warnung aus Unwissen ist Rauschen. Der Start bekommt
  // trotzdem einen Wert; ``vorgabeFuerPlatz`` liefert hier den Portal-Wert.
  if (schirme.length === 0) {
    return { quelle: vorgabeFuerPlatz(platz, schirme), ausweichend: false };
  }
  return { quelle: vorgabeFuerPlatz(platz, schirme), ausweichend: true };
}
