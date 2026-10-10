/**
 * Die reinen Entscheidungen des nativen Sprachwegs auf iOS — ohne Import,
 * damit Nodes Testläufer sie prüfen kann (CLAUDE.md, `pnpm test:unit`-Falle).
 * Verdrahtet werden sie in `nativerRaum.svelte.ts`.
 */

/** Ein Verbindungszustand der Hülle, als schlichtes Wort. */
export type HuellenVerbindung =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'disconnecting'
  | 'disconnected';

/**
 * Das Wort aus dem `verbindung`-Ereignis — **mit und ohne führenden Punkt.**
 *
 * Bis zum 2026-10-11 schickte die Hülle `"\(state)"`, und LiveKits
 * `description` setzt einen Punkt davor (`.connected`). Der Hörer verglich
 * mit `connected`: der Zweig griff nie, ein Wiederaufbau wurde nie angezeigt
 * (Bughunt 2026-10-11, G1). Die Hülle schickt seither das schlichte Wort
 * (`SpracheRaum.verbindungsName`) — aber Web und Hülle werden getrennt
 * ausgeliefert, und ältere Hüllen schicken den Punkt weiter. Deshalb liest
 * diese Seite beides.
 */
export function verbindungAusHuelle(roh: string): HuellenVerbindung | null {
  const wort = roh.startsWith('.') ? roh.slice(1) : roh;
  switch (wort) {
    case 'connected':
    case 'connecting':
    case 'reconnecting':
    case 'disconnecting':
    case 'disconnected':
      return wort;
    default:
      return null;
  }
}

/** Was nach einem Reload mit einem Raum geschieht, den die Hülle noch hält. */
export type Abgleich = 'nichts' | 'uebernehmen' | 'verlassen';

/**
 * Übernehmen oder verlassen? (Entwurf §5: „Ein Reload der Web-App darf den
 * Raum nicht reissen. Nativ lebt weiter; das Web fragt beim Start `zustand()`
 * und stellt sich darauf ein.")
 *
 * **Übernommen wird nur, was der Eintrag fürs Wiederaufnehmen bestätigt** —
 * derselbe Kanal, derselbe aktive Server. Der Eintrag ist der Beleg, dass
 * DIESE Sitzung den Raum betreten hat: er wird bei jedem Beitritt geschrieben
 * und beim Auflegen, Abmelden und Kontowechsel gelöscht (`resume.ts`). Fehlt
 * er, wurde er mit Absicht gelöscht; ein Raum ohne ihn gehört womöglich einem
 * anderen Konto — und ein Raum, den die Oberfläche nicht kennt, ist der
 * schlimmste denkbare Zustand: für alle anderen sitzt man im Kanal, unter
 * Umständen mit offenem Mikrofon, und es gibt keinen Knopf zum Gehen
 * (Bughunt 2026-10-11, E5). Deshalb: alles, was nicht bestätigt ist, wird
 * verlassen, nicht übernommen.
 */
export function abgleichEntscheiden(z: {
  huelle: { kanalId: string } | null;
  resume: { serverId: string; channelId: string } | null;
  aktiverServer: string;
}): Abgleich {
  if (!z.huelle || !z.huelle.kanalId) return 'nichts';
  if (!z.resume) return 'verlassen';
  if (z.resume.serverId !== z.aktiverServer) return 'verlassen';
  if (z.resume.channelId !== z.huelle.kanalId) return 'verlassen';
  return 'uebernehmen';
}

/**
 * Schaut der Nutzer gerade auf diesen Kanal? Genau dann — und nur dann —
 * legt sich die native Kanalansicht nach einem Beitritt darüber.
 *
 * **Die Frage stellt der Pfad, nicht der Anlass des Beitritts.** Ein Tipp auf
 * einen Sprachkanal navigiert im Web dorthin (Entwurf §5); ein
 * `voice_pull`, das Wiederaufnehmen nach einem Reload oder der automatische
 * Beitritt beim Start tun es nicht. Bis zum 2026-10-11 öffnete JEDER Beitritt
 * die Ansicht, und ein Moderator, der einen in seinen Kanal holte, legte ein
 * Vollbild über die offene Unterhaltung (Bughunt 2026-10-11, M3).
 *
 * Nur die Kanal-Route selbst zählt, mit Segmentgrenze — die
 * Rechte-Unterseite desselben Kanals nicht.
 */
export function routeZeigtKanal(pfad: string, kanalId: string): boolean {
  if (!kanalId) return false;
  const teile = pfad.split('/').filter(Boolean);
  return (
    teile.length === 5 &&
    teile[0] === 'app' &&
    teile[1] === 'guilds' &&
    teile[3] === 'channels' &&
    teile[4] === kanalId
  );
}
