/**
 * Ersatz-Dateiname für Anhänge ohne eigenen Namen.
 *
 * **Warum ein eigenes Modul:** Die Regel ist eine Sicherungs-Schiene (s.
 * unten) und gehört deshalb unter einen Test — und ein von Nodes Testläufer
 * geprüftes Modul darf keinen Import haben, den erst der Bundler auflöst
 * (`$lib/...`). `dateiTeilen.ts` braucht `devS3Url` und ist damit selbst
 * nicht prüfbar; die reine Rechnung steht darum hier. Muster: `lib/remote/
 * zeigerbildPruefung.ts` neben der Rune-Hülle.
 *
 * **Warum die Regel:** Mit `undefined`/`''` fällt das `download`-Attribut des
 * Ankers ganz weg — und ohne `download` NAVIGIERT der Klick in die
 * `blob:`-Adresse, statt zu speichern. Ein Anhang mit `text/html` liefe dann
 * als Skript im Ursprung der Anwendung. Zusammen mit
 * `krypto/sichererBlobTyp.ts` sind das die zwei Hälften derselben
 * Absicherung; eine allein genügt nicht.
 */

const ERSATZ_DATEINAME = 'anhang';

export function dateiNameOderErsatz(dateiname: string | null | undefined): string {
  return dateiname || ERSATZ_DATEINAME;
}
