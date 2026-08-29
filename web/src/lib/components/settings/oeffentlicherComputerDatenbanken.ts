/**
 * Welche IndexedDB-Datenbanken der „öffentlicher Computer"-Knopf löscht —
 * importfrei, damit Nodes Testläufer die Liste direkt prüft (die Komponente
 * selbst ist ein `.svelte`-Skript, dort nicht erreichbar).
 *
 * Bughunt 2026-08-29 (Befund 2): die Liste stand seit der Entstehung dieses
 * Knopfs nur `pulse-identity`/`pulse-stream` und wurde nie nachgezogen, als
 * der lokale Verlauf (`verlauf/schema.ts::DB_NAME = 'pulse-verlauf'`) dazukam
 * — der Knopf verspricht, ALLE lokalen Daten zu löschen, ließ aber die
 * einzige Kopie verschlüsselter Nachrichten samt entschlüsselter Anhang-Bytes
 * (`verlauf/schema.ts::STORE_ANHAENGE`) stehen. `pulse_presence`
 * (`StatusPicker.svelte`/`service-worker.ts`, DND-Flag) trägt keine
 * Nachrichteninhalte, gehört aber ebenso zum vorigen Nutzer und fällt darum
 * genauso darunter.
 *
 * Der Name `'pulse-verlauf'` ist hier bewusst nicht importiert
 * (`verlauf/schema.ts::DB_NAME`), obwohl jene Datei selbst importfrei ist:
 * eine zusätzliche Abhängigkeit nur für einen konstanten String lohnt nicht,
 * und diese Liste ist ohnehin eine Behauptung, die bei jeder neuen
 * IndexedDB-Datenbank von Hand geprüft werden muss (`command grep -rn
 * "indexedDB.open\|deleteDatabase" web/src`, s. CLAUDE.md „vorher greppen").
 */
export const OEFFENTLICHER_COMPUTER_DATENBANKEN = [
  'pulse-identity',
  'pulse-stream',
  'pulse-verlauf',
  'pulse_presence'
] as const;
