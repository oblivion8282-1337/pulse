/**
 * Der Medien-Nachzug (Stufe B1, Plan
 * `docs/plans/2026-09-08-medien-nachziehen.md`): fuellt den geraeteweiten
 * Medien-Index (`STORE_MEDIEN`) seitenweise aus `GET /meine-anhaenge` —
 * newest-first, exklusiver `before`-Cursor — und hoert an der ERSTEN id auf,
 * die im Index schon liegt: Überlappung heißt, der Rest ist lokal bekannt
 * (der laufende Betrieb schreibt über `verlaufPutSaetze` ohnehin laufend
 * nach). Kein Vollsweep pro Start.
 *
 * **Importfrei, injizierter Abruf** (Muster `ablage/postfachQuelle.ts`):
 * Netz, IndexedDB und Konto kommen als Parameter herein, damit der
 * Node-Testläufer die Schleife ohne Krypto-WASM und ohne `fetch` prüft.
 * Produktiv verdrahtet das `MedienArchivSheet.svelte` mit
 * `api/meineAnhaenge.ts` und `verlauf/db.ts` — eine Zeile je Abhängigkeit.
 *
 * **Bytes werden nie geladen.** Der Endpunkt liefert Metadaten; an die
 * Bytes geht es erst auf Klick über die bestehenden Wege (`anhangBlob`
 * bzw. vorsignierte Adresse mit Kanalrechten).
 *
 * **Der Cursor ist exklusiv und streng fallend.** Der Server sortiert
 * `id DESC` mit `id < before`; ein Server, der dieselbe Seite noch einmal
 * liefert, würde eine Endlosschleife füttern — die Schleife bricht deshalb
 * ab, wenn die letzte id einer Seite nicht WIRKLICH unter dem Cursor liegt
 * (ein Verstoß gegen die Zusage, kein Datenverlust: das Blatt zeigt, was da
 * ist, der nächste Öffnungsversuch versucht es erneut).
 */

import type { MedienZeile } from './schema.ts';

/** Drahtform einer Zeile von `GET /meine-anhaenge` (Stufe A1) — die Felder,
 *  die der Klient braucht; `width`/`height`/Thumb-Maße sind Anzeige-Detail,
 *  der Index traegt sie bewusst nicht (`schema.ts::MedienZeile`). */
export type ServerAnhang = {
  id: string;
  channel_id: string;
  filename: string | null;
  mime: string | null;
  size: number;
  hat_thumb: boolean;
  erstellt_am: string;
  verschluesselt: boolean;
  laufwerk_verteilt: boolean;
};

/** Eine Seite vom Server: `(before, limit)` → newest-first-Liste. Produktiv
 *  `meineAnhaengeApi.auflisten`. */
export type MedienAbruf = (
  before: string | null,
  limit: number
) => Promise<ServerAnhang[]>;

/** Server-Zeile → Index-Zeile. `kontoId` ist zugleich der Autor: der
 *  Endpunkt liefert ausschließlich eigene Uploads
 *  (`uploader_id == current.id`). `schluessel` bleibt bewusst `null` — einen
 *  E2EE-Schlüssel sieht der Server nie; ihn ergänzen nur lokale Sätze. */
export function zeileAusServerAnhang(a: ServerAnhang, kontoId: string): MedienZeile {
  return {
    id: a.id,
    kontoId,
    kanalId: a.channel_id,
    autorId: kontoId,
    erstelltAm: a.erstellt_am,
    dateiname: a.filename,
    mime: a.mime,
    size: a.size,
    verschluesselt: a.verschluesselt === true,
    hatThumb: a.hat_thumb === true,
    schluessel: null,
    laufwerkVerteilt: a.laufwerk_verteilt === true
  };
}

export type NachzugBericht = {
  /** Zeilen, die in diesem Lauf neu in den Index wanderten. */
  nachgezogen: number;
  /** true: abgebrochen, weil eine gelieferte id bereits im Index lag. */
  ueberlappung: boolean;
  /** true: der Server hat weniger als `limit` geliefert — Anfang erreicht. */
  leergelaufen: boolean;
};

const STANDARD_LIMIT = 100;
/** Deckel nur gegen einen pathologischen Server (s. Cursor-Wache oben);
 *  1000 Seiten à 100 Zeilen sind ein index-wuerdiges Leben an Medien. */
const STANDARD_RUNDEN = 1000;

export async function medienNachziehen(
  abruf: MedienAbruf,
  abhaengigkeiten: {
    kontoId: string;
    /** Liegt diese Anhang-ID schon im Index dieses Kontos? Produktiv
     *  `verlauf/db.ts::medienIdVorhanden`. */
    liegtVor: (id: string) => Promise<boolean>;
    /** Upsert der Zeilen. Produktiv `verlauf/db.ts::medienSchreiben`. */
    schreiben: (zeilen: MedienZeile[]) => Promise<void>;
    limit?: number;
    runden?: number;
  }
): Promise<NachzugBericht> {
  const { kontoId, liegtVor, schreiben } = abhaengigkeiten;
  const limit = abhaengigkeiten.limit ?? STANDARD_LIMIT;
  const runden = abhaengigkeiten.runden ?? STANDARD_RUNDEN;

  let before: string | null = null;
  let nachgezogen = 0;

  for (let runde = 0; runde < runden; runde++) {
    const seite = await abruf(before, limit);
    if (seite.length === 0) {
      return { nachgezogen, ueberlappung: false, leergelaufen: true };
    }

    // Cursor-Wache ZUERST: `before` ist exklusiv, jede weitere Seite MUSS
    // streng darunter liegen — sonst pedalt der Server auf der Stelle (s.
    // Kopf), und nichts auf dieser Seite darf als neu geschrieben werden.
    const letzte = seite[seite.length - 1]!.id;
    if (before !== null && BigInt(letzte) >= BigInt(before)) {
      return { nachgezogen, ueberlappung: false, leergelaufen: false };
    }

    // Erste lokal bekannte id suchen — alles DAVOR (neuere) ist neu.
    let schnitt = -1;
    for (let i = 0; i < seite.length; i++) {
      if (await liegtVor(seite[i]!.id)) {
        schnitt = i;
        break;
      }
    }
    const neu = seite
      .slice(0, schnitt === -1 ? seite.length : schnitt)
      .map((a) => zeileAusServerAnhang(a, kontoId));
    await schreiben(neu);
    nachgezogen += neu.length;

    if (schnitt !== -1) {
      return { nachgezogen, ueberlappung: true, leergelaufen: false };
    }

    before = letzte;
    if (seite.length < limit) {
      return { nachgezogen, ueberlappung: false, leergelaufen: true };
    }
  }

  return { nachgezogen, ueberlappung: false, leergelaufen: false };
}
