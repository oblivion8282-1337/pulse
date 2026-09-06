import { vergleicheSnowflakeArtigeId } from '../utils/snowflakeZeit.ts';

/**
 * Reine Rechnung fuer C5 (lokale DM-Suche) — importfrei, damit Nodes
 * Testlaeufer sie direkt prueft (kein erweiterungsloser Laufzeit-Import,
 * kein `$state()` auf Modulebene, s. CLAUDE.md „Die Falle"). Importiert
 * bewusst NUR `../utils/snowflakeZeit.ts` (selbst importfrei, per
 * erweiterungspflichtigem Relativpfad eingebunden — dasselbe Muster wie
 * `zusammenfuegen.ts`).
 *
 * Ersatz-Baustein fuer `GET /dm-channels-search`
 * (`services/chat-gateway/src/dcc_chat_gateway/routes/dms.py`), aber NUR fuer
 * den Teil, der ueber den bereits lokal abgelegten Verlauf laeuft
 * (`verlauf/db.ts`). Verschluesselte Nachrichten haben dort NIE eine Zeile
 * in der servereigenen `messages`-Tabelle (der Umschlag geht ueber
 * `/postfach`, s. `krypto/senden.ts`) — die serverseitige `ilike`-Suche kann
 * sie also grundsaetzlich nicht finden. Diese Datei durchsucht stattdessen,
 * was dieses Geraet bereits entschluesselt (oder als Klartext live gesehen)
 * und lokal abgelegt hat.
 *
 * Case-insensitive Teilstring-Suche, bewusst OHNE die Diakritika-/Leet-
 * Normalisierung aus `utils/suche.ts::suchnorm` (Personen-/Kanalnamen-Suche):
 * die Server-Gegenseite (`_like_maskieren` + `ilike`) kennt diese Normalisierung
 * ebenfalls nicht, ein einfacher `toLowerCase().includes(...)` bildet ihr
 * Verhalten treu nach — sonst faende die lokale Haelfte Treffer, die die
 * Server-Haelfte fuer denselben Begriff nicht liefert, und das Ergebnis wirkte
 * uneinheitlich zwischen alten (Server-)Nachrichten und neuen (lokalen).
 */

/** Ausschnitt eines `Satz` (`schema.ts`), den diese Rechnung braucht — ohne
 *  dessen Typ zu importieren (importfrei-Pflicht). */
export type DurchsuchbarerSatz = {
  kanalId: string;
  nachrichtId: string;
  autorId: string;
  inhalt: string;
  erstelltAm: string;
  geloescht: boolean;
};

/** Ein lokaler Suchtreffer — strukturell ein Ausschnitt von
 *  `$lib/api/chat::DMMessageSearchHit` OHNE `other_user_id` (das kennt nur
 *  der DM-Kanal-Store, den dieses importfreie Modul nicht sehen darf; der
 *  Aufrufer in `sucheLokal.ts` ergaenzt es). */
export type LokalerTreffer = {
  message_id: string;
  dm_channel_id: string;
  author_id: string;
  content: string;
  created_at: string;
};

/** Dieselbe Obergrenze wie `dms.py::_SUCHE_LIMIT` (Server) — bewusst
 *  dupliziert, kein Import moeglich (importfrei-Pflicht, s. Modulkopf), und
 *  ohnehin zwei verschiedene Sprachen/Prozesse. Eine Suchleiste will
 *  Treffer, keine Chronologie — dieselbe Begruendung wie beim Server-Limit. */
export const LOKALE_SUCHE_LIMIT = 20;

/**
 * Findet Treffer im lokal abgelegten Verlauf. Grabsteine bleiben aussen vor
 * (wie beim Server: `Message.deleted_at.is_(None)`-Filter). Sortiert
 * NEUESTE ZUERST — ueber die eingebettete Nachrichten-ID, nicht ueber
 * `erstelltAm`: lokal erzeugte Kennungen (`krypto/senden.ts::lokaleNachrichtId`)
 * und echte Server-Snowflakes sind zwei verschiedene ID-Schemata, und nur
 * `vergleicheSnowflakeArtigeId` traegt beide korrekt (s. dortigen Modulkopf).
 */
export function lokaleTreffer(
  saetze: DurchsuchbarerSatz[],
  suchbegriff: string
): LokalerTreffer[] {
  const begriff = suchbegriff.trim().toLowerCase();
  if (begriff.length < 2) return [];
  const gefunden = saetze.filter(
    (s) => !s.geloescht && s.inhalt.toLowerCase().includes(begriff)
  );
  gefunden.sort((a, b) => vergleicheSnowflakeArtigeId(b.nachrichtId, a.nachrichtId));
  return gefunden.slice(0, LOKALE_SUCHE_LIMIT).map((s) => ({
    message_id: s.nachrichtId,
    dm_channel_id: s.kanalId,
    author_id: s.autorId,
    content: s.inhalt,
    created_at: s.erstelltAm
  }));
}
