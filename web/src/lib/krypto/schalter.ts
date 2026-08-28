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
