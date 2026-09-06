/**
 * Hochscroll-Nachladen (`MessageList::loadOlder`) — ausgelagert, damit die
 * Komponente unter der Größen-Policy bleibt. Reine Verdrahtung (lokal ↔
 * Server), keine eigene Rechnung — deshalb hier, nicht importfrei.
 *
 * C2: erst lokal, und nur wenn dort nichts mehr liegt, den Server fragen.
 * Für Guild-Kanäle liefert `verlaufLesen` immer `[]` (nur DMs und private
 * Gruppen landen lokal, s. `verlauf/index.ts::istLokalerKanal`) — dort greift
 * also unverändert der Server-Zweig, wie vor C2.
 *
 * "Lokal hat etwas geliefert" ist dabei NICHT gleichbedeutend mit "das ist
 * die richtige naechste Seite" (Bughunt Fund 2): ein Gap-Fill-Overflow
 * (`ws/gapFill.ts`) legt nur die neueste Serverseite lokal ab, der alte
 * Bestand VOR der Luecke bleibt unangetastet liegen — ein Cursor, der genau
 * in diese Luecke faellt, findet also lokal Zeilen, nur eben die FALSCHEN
 * (den alten Bestand, faelschlich als naechste zusammenhaengende Seite
 * gedeutet). `betrifftLuecke` faengt genau diesen Fall ab, s. `luecke.ts`.
 *
 * Bughunt Fund 3: eine lokal ausgelieferte Seite wurde NIE mit dem Server
 * abgeglichen — ein Edit oder eine Loeschung, die auf einem anderen Geraet
 * (oder waehrend dieses Geraet offline war) passierte, blieb fuer aeltere
 * Seiten fuer immer unsichtbar (`ws/gapFill.ts::reconcile` deckt nur die
 * juengsten 100 ab). `reconciliereAeltereSeite` holt darum, sobald eine
 * lokale Seite ausgeliefert wurde, im HINTERGRUND (nicht blockierend, nicht
 * abgewartet) einmal dieselbe Spanne vom Server nach und gleicht ab. Das ist
 * bewusst PRAGMATISCH: es garantiert nicht, dass jeder Aufruf einen
 * Server-Roundtrip abwartet oder dass ein bereits gerendertes DOM-Element
 * augenblicklich reagiert, falls der Live-Store die Nachricht gerade nicht
 * (mehr) haelt — es garantiert nur, dass Inhalt/Bearbeitungszeit und
 * Grabsteine spaetestens beim naechsten Blick auf diese Seite (naechster
 * Mount, naechstes Scrollen dorthin) stimmen, weil sie in IndexedDB
 * geschrieben werden. Ein Netzwerkfehler wird verschluckt (best effort,
 * s. `catch` unten) — der naechste Aufruf versucht es erneut.
 *
 * Bughunt 2026-08-28 (FIX 3): waehrend diese Anfrage unterwegs ist, kann ein
 * `message_delete` fuer genau diese Seite eintreffen und lokal einen
 * Grabstein setzen. Der Server liefert geloeschte Nachrichten grundsaetzlich
 * NICHT aus (s. `serverZuPosten` in `index.ts`) — seine Antwort kennt die
 * Loeschung also nicht, und `verlaufSpeichern` ist ein blindes Upsert
 * (`verlaufPutSaetze`, s. `db.ts`), das einen frischen Grabstein wieder auf
 * "nicht geloescht" zuruecksetzen wuerde. Deshalb wird unmittelbar VOR dem
 * Schreiben noch einmal frisch nachgesehen, welche Grabsteine JETZT lokal
 * stehen, und genau diese IDs aus der Serverantwort herausgenommen — das
 * schliesst das Zeitfenster nicht rechnerisch (keine Transaktion ueber beide
 * Schritte), verkleinert es aber auf die Zeit zwischen dieser Lesung und dem
 * `put` selbst, ohne einen weiteren `await` dazwischen.
 */
import {
	hatServerVerlauf,
	verlaufLesen,
	verlaufSpeichern,
	verlaufNachrichtGeloescht
} from './index';
import { betrifftLuecke, lueckeNachServerantwortAktualisieren } from './luecke';
import { ermittleGeloeschteIds } from './abgleich';
import { ohneFrischeGrabsteine } from './ohneFrischeGrabsteine';
import { messages } from '$lib/stores/messages.svelte';
import { directMessages } from '$lib/stores/directMessages.svelte';
import { chatApi } from '$lib/api/chat';
import type { Message } from '$lib/api/types';

export type AeltereSeite = {
  nachrichten: Message[];
  /** `true`, wenn die Seite vom Server kam — nur dann sagt "kürzer als
   *  angefragt" wirklich "Historie-Ende", und nur dann lohnt das erneute
   *  Ablegen im lokalen Verlauf (lokal gelesene Sätze liegen dort schon). */
  vomServer: boolean;
  /** B6: die Sicherung hat in DIESEM Lauf eine Archiv-Seite (> 0) in den
   *  lokalen Verlauf nachgeladen — deren Zeilen waren für diesen Cursor
   *  aber (noch) nicht älter. Eine kurze/leere Server-Antwort ist dann
   *  KEIN Historie-Ende: der Lesestand steht weiter vorne, der nächste
   *  Hochscroll-Aufruf liest die Archiv-Seite lokal aus. Wahl der
   *  Umsetzung: Flag nach oben reichen (statt der Seite), weil nur
   *  MessageList am `hasMore` hängt. */
  sicherungLieferte?: boolean;
};

export async function ladeAeltereSeite(
  channelId: string,
  oldest: string,
  seitenGroesse: number,
  route: { serverId?: string } | undefined
): Promise<AeltereSeite> {
  // B6-Flag: gilt für den ganzen restlichen Lauf (auch den Server-Zweig).
  let sicherungLieferte = false;
	if (!betrifftLuecke(channelId, oldest)) {
		const lokal = (await verlaufLesen(channelId, { vor: oldest, anzahl: seitenGroesse })).filter(
			(n) => n.deleted_at === null
		);
		if (lokal.length > 0) {
			// Abgleich nur, wo es etwas abzugleichen gibt (s. `hatServerVerlauf`).
			if (hatServerVerlauf(channelId)) {
				void reconciliereAeltereSeite(channelId, oldest, seitenGroesse, lokal, route);
			}
			return { nachrichten: lokal, vomServer: false };
		}
	}

	// Der lokale Bestand ist an dieser Stelle zu Ende (oder eine aktive
	// Lücke verbietet ihm zu vertrauen) — BEVOR der Server gefragt wird,
	// hol die nächste ältere Seite aus dem Sicherungs-Archiv in den
	// lokalen Verlauf. B9: AUSSERHALB der Lücken-Klammer — der Archiv-Zweig
	// hängt früher darin und wurde bei aktiver WS-Lücke übersprungen; bei
	// leerer Server-Antwort blieb dann `hasMore = false` für die Session,
	// obwohl der Archiv-Ordner noch ältere Seiten trägt. Das ist
	// dedup-sicher: der je-Kanal-Lesestand der Sicherung ist vom Cursor
	// unabhängig, gelieferte Zeilen landen per Upsert im lokalen Verlauf,
	// und die untere Nachlese hier gibt nur Zeilen STRIKT älter als
	// `oldest` weiter. Nur für die Kanalarten, die die Sicherung überhaupt
	// spiegelt (DMs, private Gruppen, Ablage-Kanäle — derselbe Filter wie
	// `istLokalerKanal`); der Lesestand wird je Kanal geführt, der nächste
	// Hochscroll-Aufruf bekommt also nur strikt Älteres. Kam etwas an,
	// gilt die Seite als lokal gelesen — derselbe Rückgabeweg wie oben.
	// `sicherungKanalSeiteLaden` wirft nie (s. andock.ts), der
	// Server-Zweig läuft sonst unverändert weiter. Dynamischer Import wie
	// in `verlauf/index.ts`: die Sicherung (inkl. hash-wasm) gehört nicht
	// in den Chat-Grundstack.
	if (!hatServerVerlauf(channelId) || channelId in directMessages.byId) {
		const { sicherungKanalSeiteLaden } = await import('$lib/sicherung/andock');
		const archivSeite = await sicherungKanalSeiteLaden(channelId, seitenGroesse);
		if (archivSeite > 0) {
			const nachgeladen = (
				await verlaufLesen(channelId, { vor: oldest, anzahl: seitenGroesse })
			).filter((n) => n.deleted_at === null);
			if (nachgeladen.length > 0)
				return { nachrichten: nachgeladen, vomServer: false, sicherungLieferte: true };
			// B6: Archiv-Seite > 0, aber alles ≥ `oldest` (schon sichtbar) —
			// der Server-Zweig läuft unten weiter; sein (möglicherweise
			// leerer) Rest darf aber nicht als Historie-Ende gelten, denn
			// der Archiv-Lesestand ist einen Schritt weitergerückt.
			sicherungLieferte = true;
		}
	}

  // Eine private Gruppe hat keinen Server-Verlauf — der lokale Bestand ist
  // die einzige Kopie. Ist er erschoepft, ist die Seite zu Ende; ein Aufruf
  // gaebe hier eine Abweisung, die als Ladefehler aussaehe.
  if (!hatServerVerlauf(channelId)) return { nachrichten: [], vomServer: false };

  const vomServer = await chatApi.listMessages(
    channelId,
    { before: oldest, limit: seitenGroesse },
    route
  );
  void verlaufSpeichern(channelId, vomServer);
  // `listMessages` liefert neueste zuerst (s. `ws/gapFill.ts`), der letzte
  // Eintrag ist also die aelteste Nachricht dieser Seite.
  lueckeNachServerantwortAktualisieren(
    channelId,
    vomServer[vomServer.length - 1]?.id,
    vomServer.length < seitenGroesse
  );
  return { nachrichten: vomServer, vomServer: true, sicherungLieferte };
}

/** Siehe Modulkopf ("Bughunt Fund 3"). */
async function reconciliereAeltereSeite(
  channelId: string,
  oldest: string,
  seitenGroesse: number,
  lokal: { id: string }[],
  route: { serverId?: string } | undefined
): Promise<void> {
  try {
    const vomServer = await chatApi.listMessages(
      channelId,
      { before: oldest, limit: seitenGroesse },
      route
    );
    // Inhalt/Bearbeitungszeit: put ist ein Upsert (s. `db.ts`), ueberschreibt
    // also einen veralteten lokalen Satz mit der Serverfassung — AUSSER einen
    // Grabstein, der in der Zwischenzeit entstanden ist (s. Modulkopf FIX 3).
    const jetztLokal = await verlaufLesen(channelId, { vor: oldest, anzahl: seitenGroesse });
    const frischGeloeschteIds = jetztLokal
      .filter((n) => n.deleted_at !== null)
      .map((n) => n.id);
    void verlaufSpeichern(channelId, ohneFrischeGrabsteine(vomServer, frischGeloeschteIds));
    messages.reconcile(channelId, vomServer);
    for (const id of ermittleGeloeschteIds(lokal, vomServer)) {
      verlaufNachrichtGeloescht(channelId, id);
      messages.remove(channelId, id);
    }
  } catch {
    // Best-effort — s. Modulkopf. Naechster Aufruf versucht es erneut.
  }
}
