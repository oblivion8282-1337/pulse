/** Geteilte Typen des Archivs (klein genug für eine eigene Datei — die
 *  Module importieren sich sonst gegenseitig zirkulär). */

export type ArchivPaar = { pubkey: Uint8Array; privkey: Uint8Array };
