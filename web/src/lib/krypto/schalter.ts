/**
 * Der Schalter fuer Ende-zu-Ende-verschluesselte Direktnachrichten.
 *
 * **AN seit dem 2026-09-01** (Entscheidung des Eigentuemers). Die Bedingung,
 * unter der er aus war, ist eingeloest: zwei echte Geraete gehen den Weg
 * nachweislich, gegen den Remote-Dev-Stack und mit der Gegenprobe in
 * Postgres, dass in `chat.messages` kein Klartext steht
 * (`tests/e2e/e2e-dm.spec.ts`, `e2e-dm-hetzner.spec.ts`).
 *
 * **Warum das eine Einbahnstrasse ist.** Eine verschluesselte Nachricht, die
 * der Empfaenger nicht oeffnen kann, ist UNWIEDERBRINGLICH verloren — der
 * Server haelt keine Kopie. Wieder-Ausschalten heilt nichts, was in der
 * Zwischenzeit verschickt wurde; es aendert nur den Weg neuer Nachrichten.
 * Wer ihn zurueckdreht, loest damit also kein Problem, sondern verdeckt es.
 *
 * Importfrei, damit Nodes Testlaeufer Module pruefen kann, die diesen Wert
 * nur lesen (s. CLAUDE.md „Die Falle").
 */
export const E2E_DMS_ENABLED = true;

/**
 * Der Schalter fuer private Gruppenchats — **AN seit dem 2026-09-01**,
 * gemeinsam mit den DMs umgelegt.
 *
 * **Der Riegel dahinter bleibt und ist hier der wichtigere.** Dieser Schalter
 * verhindert nur den ersten Serveraufruf; ob es Gruppen GIBT, entscheidet die
 * Server-Einstellung `private_groups_enabled` (Vorgabe `False`). Ist sie aus,
 * antwortet der Server weiter mit 403 `private_groups_disabled` — dieser
 * Schalter allein schaltet also nichts frei, er hoert nur auf, die Frage
 * vorher abzufangen.
 *
 * **Warum ein eigener, und warum keiner der beiden vorhandenen passt.**
 * Nachgesehen, nicht angenommen:
 *
 * * `E2E_DMS_ENABLED` (oben) gilt fuer DIREKTNACHRICHTEN. Ihn hier
 *   mitzubenutzen, hiesse zwei Funktionen an einen Schalter zu haengen, die
 *   getrennt reifen — CLAUDE.md fuehrt beide ausdruecklich als zwei.
 * * `private_groups_enabled` ist eine SERVER-Einstellung
 *   (`services/chat-gateway/.../config.py`, Vorgabe `False`) und dem
 *   Klienten heute nicht sichtbar: weder `GET /capabilities` noch der
 *   `ready`-Rahmen melden sie. Der Klient erfuehre ihren Zustand nur am 403
 *   `private_groups_disabled` — also erst, NACHDEM er gefragt hat. Ein
 *   Schalter, der einen Serveraufruf voraussetzt, kann keinen Serveraufruf
 *   verhindern.
 *
 * Deshalb dieser dritte. Er ist der Riegel VOR dem ersten Serveraufruf; der
 * Server-Schalter bleibt der Riegel dahinter (`403`, und
 * `private_gruppen_zugriff.py` versteckt bei ausgeschaltetem Schalter auch
 * Bestandsgruppen vor dem Postfach). Beide muessen an sein, damit etwas
 * passiert — und solange dieser hier aus ist, unternimmt der Klient
 * nichts: kein `GET /gruppen`, kein Schluesselabruf, kein Sitzungsaufbau.
 *
 * **Anders als bei DMs gibt es hier keinen Klartext-Rueckfall.** Private
 * Gruppen sind von Geburt an verschluesselt (Spec §9) — es gibt keinen
 * Altbestand, auf den man zurueckfallen koennte. „Aus" heisst deshalb: es
 * gibt keine Gruppen, nicht „Gruppen laufen unverschluesselt".
 */
export const PRIVATE_GRUPPEN_ENABLED = true;

/**
 * Der Schalter fuer Geraete-Kopplung und Verlaufsumzug (Etappe F) —
 * **AN seit dem 2026-09-01**.
 *
 * **Warum ein dritter und nicht `E2E_DMS_ENABLED`.** Nachgesehen, nicht
 * angenommen: der Umzug schiebt den LOKALEN VERLAUF (`lib/verlauf/**`), und
 * den gibt es seit Etappe C1 unabhaengig von der Verschluesselung — er
 * fuellt sich auch heute, mit lesbaren Daten. Kopplung und Umzug
 * funktionieren also, ohne dass eine einzige DM verschluesselt waere. Sie an
 * `E2E_DMS_ENABLED` zu haengen, hiesse zwei Funktionen zu koppeln, die
 * getrennt reif werden — genau das, was der Kommentar an
 * `PRIVATE_GRUPPEN_ENABLED` oben schon einmal begruendet.
 *
 * **Was das Umlegen scharf stellt.** Der Kopplungscode ist, solange er gilt,
 * ein Schluessel zum vollstaendigen lokalen Verlauf (die ausfuehrliche
 * Abwaegung steht im Kopf von `services/chat-gateway/.../routes/kopplung.py`).
 * Die Bedingung, unter der er aus war, ist eingeloest: der Zwei-Geraete-Weg
 * ist nachgewiesen (`tests/e2e/e2e-kopplung.spec.ts`, mit der Gegenprobe,
 * dass der Server den Verlauf nie im Klartext sieht).
 */
export const GERAETE_KOPPLUNG_ENABLED = true;
