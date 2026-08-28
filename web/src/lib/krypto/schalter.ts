/**
 * Der Schalter fuer Ende-zu-Ende-verschluesselte Direktnachrichten — Vorgabe
 * AUS, am Vorbild von `cloud_dm_attachments_enabled`
 * (`services/chat-gateway/src/dcc_chat_gateway/config.py`).
 *
 * Anders als jenes Flag ist dieses eine reine KLIENT-Konstante, keine
 * Server-Capability: Etappe D2 baut nur die Mechanik (Task 1 bis 3), sie
 * wird noch nicht end-zu-Ende mit zwei echten Geraeten geprueft — das ist
 * Handarbeit des Eigentuemers (Task 4 / Umlegen). Solange der Schalter aus
 * ist, laeuft jede Direktnachricht den heutigen Klartext-Weg.
 *
 * Der Grund fuer den Schalter ist hier zwingender als bei privaten Gruppen:
 * eine verschluesselte Nachricht, die der Empfaenger nicht oeffnen kann, ist
 * UNWIEDERBRINGLICH verloren — der Server haelt keine Kopie.
 *
 * Importfrei, damit Nodes Testlaeufer Module pruefen kann, die diesen Wert
 * nur lesen (s. CLAUDE.md „Die Falle").
 */
export const E2E_DMS_ENABLED = false;

/**
 * Der Schalter fuer private Gruppenchats — ebenfalls Vorgabe AUS.
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
export const PRIVATE_GRUPPEN_ENABLED = false;
