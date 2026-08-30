/**
 * Nutzlast einer einzelnen Ende-zu-Ende-verschluesselten Direktnachricht —
 * das, was NACH dem Entschluesseln als Klartext-Bytes vorliegt.
 *
 * Das Wort traegt im Serverteil eine ANDERE Bedeutung: dort heisst
 * „Nutzlast" (`DmNutzlast`) der verschluesselte Umschlag samt seiner
 * Zustellzeilen, also genau die Huelle um das, was hier gebaut wird. Ein
 * drittes „Nutzlast" gab es bis zum 2026-08-30 in `krypto/nutzlast.ts` — die
 * Bytes, ueber die der Geraete-Nachweis unterschrieb; mit den Zertifikaten
 * ist die Datei entfallen (Spec §3b).
 *
 * FASSUNG 1: JSON `{v:1, text: string, id?: string, replyToId?: string,
 * anhaenge?: AnhangAngabe[]}`.
 *
 * **Die Fassungsnummer bleibt bei 1, obwohl `anhaenge` neu ist — das ist
 * Absicht, nicht Nachlaessigkeit.** `leseNachrichtNutzlast` prueft `v ===
 * FASSUNG`; ein Empfaenger mit der aelteren Fassung dieser Datei wuerde eine
 * `v:2`-Nutzlast deshalb NICHT als Fassung-1-Objekt erkennen, in den
 * Legacy-Zweig fallen und dem Nutzer das rohe JSON als Nachrichtentext
 * anzeigen. Der Text ginge damit praktisch verloren — genau das, was hier
 * nie passieren darf. Solange eine Aenderung nur FELDER HINZUFUEGT, die
 * beim Lesen optional sind, bleibt die Nummer stehen; erst eine Aenderung,
 * die ein bestehendes Feld anders BEDEUTET, braucht eine neue Nummer (und
 * dann einen Leser, der beide kennt).
 *
 * `id` ist die vom AUTOR gewaehlte, geraeteuebergreifende Nachrichten-ID
 * (`senden.ts::lokaleNachrichtId()`). Sie MUSS mitgeschickt werden, weil die
 * lokale `Message.id` auf dem Absender- und dem Empfaenger-Geraet
 * verschieden ist (Absender: selbst gewaehlt; Empfaenger: die
 * Postfach-Zustellungs-Kennung, s. `empfangen.ts`-Modulkopf) — ohne eine
 * geteilte Kennung koennte KEINE Gegenseite eine spaetere Antwort auf diese
 * Nachricht wiederfinden. `replyToId` traegt deshalb ebenfalls immer die
 * KANONISCHE Form (`kanonischeAntwortId.ts` uebersetzt dahin, bevor gesendet
 * wird), nie eine rein lokale ID.
 *
 * Beide Felder sind beim LESEN optional, damit eine Nutzlast, die sie nicht
 * kennt, trotzdem vollstaendig gelesen wird — ein zusaetzliches Feld haelt
 * niemanden vom ENTSCHLUESSELN ab (Olm entschluesselt beliebige Bytes,
 * unabhaengig von deren Struktur), die Fassung betrifft nur, wie die bereits
 * entschluesselten Bytes GELESEN werden. `leseNachrichtNutzlast` erkennt
 * zusaetzlich den Legacy-Fall: ein SENDER von vor dieser Aenderung hat den
 * Klartext ganz ohne Huelle verschickt (roher Text, kein JSON) — misslingt
 * das Parsen als Fassung-1-Objekt, gilt der komplette entschluesselte Text
 * als Nachrichtentext ohne Kennung und ohne Antwortbezug.
 *
 * Importfrei, damit Nodes eingebauter Testlaeufer die Datei ohne Bundler
 * prueft (s. CLAUDE.md „Die Falle").
 */

const FASSUNG = 1;

/**
 * Alles, was ein Empfaenger braucht, um EINEN verschluesselten Anhang zu
 * oeffnen und anzuzeigen — Etappe E.
 *
 * Der Server kennt zu einem verschluesselten Anhang bewusst weder Namen noch
 * Typ noch Maße (`routes/postfach_anhaenge.py`), also reist beides hier mit,
 * INNERHALB des verschluesselten Umschlags. `schluessel` ist der
 * Dateischluessel (Base64, s. `anhangKrypto.ts`); `vorschau` traegt den
 * ZWEITEN, eigenen Schluessel des Vorschaubildes — die Begruendung fuer zwei
 * Schluessel statt eines steht im Modulkopf von `anhangKrypto.ts`.
 *
 * `groesse`/`breite`/`hoehe` beschreiben den KLARTEXT (was der Nutzer sieht),
 * nicht den hochgeladenen Klumpen: die Maße reservieren beim Empfaenger den
 * Platz, bevor ein Byte da ist (`MessageAttachments.svelte::reserveBox`), und
 * die Groesse steht unter dem Herunterladen-Knopf.
 */
export type AnhangAngabe = {
  /** Kennung aus `POST /postfach/anhaenge/upload-url`. */
  id: string;
  name: string;
  typ: string;
  groesse: number;
  schluessel: string;
  breite: number | null;
  hoehe: number | null;
  vorschau: { schluessel: string; breite: number; hoehe: number } | null;
};

export type NachrichtNutzlast = {
  text: string;
  /** Kanonische Nachrichten-ID des Autors — `null` nur bei einer Legacy-
   *  Nutzlast ohne dieses Feld. */
  id: string | null;
  replyToId: string | null;
  /** Leer, wenn die Nutzlast keine Anhaenge trug ODER von einem Sender vor
   *  Etappe E stammt — beides sieht beim Lesen gleich aus und soll es auch. */
  anhaenge: AnhangAngabe[];
};

function istZahl(wert: unknown): wert is number {
  return typeof wert === 'number' && Number.isFinite(wert);
}

/** Prueft EINEN Eintrag aus `anhaenge` vollstaendig durch. Fail-closed: ein
 *  Eintrag, dem ein Pflichtfeld fehlt, wird verworfen statt halb angezeigt —
 *  eine Kachel ohne Schluessel liesse sich nie oeffnen, und der Nutzer saehe
 *  einen dauerhaften Ladefehler ohne Erklaerung. Der TEXT der Nachricht
 *  bleibt davon in jedem Fall unberuehrt. */
function leseAnhang(wert: unknown): AnhangAngabe | null {
  if (wert === null || typeof wert !== 'object') return null;
  const a = wert as Record<string, unknown>;
  if (
    typeof a.id !== 'string' ||
    typeof a.name !== 'string' ||
    typeof a.typ !== 'string' ||
    typeof a.schluessel !== 'string' ||
    !istZahl(a.groesse)
  ) {
    return null;
  }
  let vorschau: AnhangAngabe['vorschau'] = null;
  const v = a.vorschau;
  if (v !== null && typeof v === 'object') {
    const roh = v as Record<string, unknown>;
    if (typeof roh.schluessel === 'string' && istZahl(roh.breite) && istZahl(roh.hoehe)) {
      vorschau = { schluessel: roh.schluessel, breite: roh.breite, hoehe: roh.hoehe };
    }
  }
  return {
    id: a.id,
    name: a.name,
    typ: a.typ,
    groesse: a.groesse,
    schluessel: a.schluessel,
    breite: istZahl(a.breite) ? a.breite : null,
    hoehe: istZahl(a.hoehe) ? a.hoehe : null,
    vorschau
  };
}

/** Baut die Klartext-Bytes, die die Sitzung anschliessend verschluesselt.
 *  `nachrichtId` ist IMMER die kanonische Autor-ID dieser Nachricht (s.
 *  Modulkopf); `replyToId` (falls gesetzt) MUSS bereits die kanonische Form
 *  des Ziels sein (`kanonischeAntwortId.ts`), keine lokale ID. */
export function baueNachrichtNutzlast(
  text: string,
  nachrichtId: string,
  replyToId: string | null,
  anhaenge: AnhangAngabe[] = []
): Uint8Array {
  const objekt: Record<string, unknown> = { v: FASSUNG, text, id: nachrichtId };
  if (replyToId !== null) objekt.replyToId = replyToId;
  // Nur schreiben, wenn es etwas zu schreiben gibt — eine leere Liste
  // vergroesserte jede gewoehnliche Nachricht ohne Gegenwert.
  if (anhaenge.length > 0) objekt.anhaenge = anhaenge;
  return new TextEncoder().encode(JSON.stringify(objekt));
}

/** Liest die entschluesselten Klartext-Bytes einer Zustellung zurueck. */
export function leseNachrichtNutzlast(bytes: Uint8Array): NachrichtNutzlast {
  const roh = new TextDecoder().decode(bytes);
  try {
    const geparst: unknown = JSON.parse(roh);
    if (
      geparst !== null &&
      typeof geparst === 'object' &&
      (geparst as Record<string, unknown>).v === FASSUNG &&
      typeof (geparst as Record<string, unknown>).text === 'string'
    ) {
      const o = geparst as Record<string, unknown>;
      const anhaenge: AnhangAngabe[] = [];
      if (Array.isArray(o.anhaenge)) {
        for (const eintrag of o.anhaenge) {
          const gelesen = leseAnhang(eintrag);
          if (gelesen) anhaenge.push(gelesen);
        }
      }
      return {
        text: o.text as string,
        id: typeof o.id === 'string' ? o.id : null,
        replyToId: typeof o.replyToId === 'string' ? o.replyToId : null,
        anhaenge
      };
    }
  } catch {
    // Kein JSON, oder nicht Fassung 1 -> Legacy-Klartext, s. Modulkopf.
  }
  return { text: roh, id: null, replyToId: null, anhaenge: [] };
}
