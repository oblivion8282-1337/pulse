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
 * anhaenge?: AnhangAngabe[], geloescht?: true, reaktion?: ReaktionsAngabe}`.
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

/**
 * Reaktions-Umschlag (Uebergabe P1.5): `ziel` ist die KANONISCHE ID der
 * Nachricht, auf die reagiert wird (`kanonischeAntwortId.ts` — dieselbe
 * Uebersetzung wie bei `replyToId`, aus demselben Grund: die lokale ID ist
 * je Geraet verschieden). `entfernen` nimmt die eigene Reaktion zurueck.
 * Der Absender steht nicht in der Nutzlast — er ist der Sitzungs-Partner
 * (`absenderErmitteln.ts`), und nur der darf seine Reaktion entfernen
 * (`reaktionen.ts`).
 */
export type ReaktionsAngabe = { ziel: string; emoji: string; entfernen?: true };

/** Bearbeitungs-Frame (P1.5 Teil 2): referenziert die Nachricht mit der
 *  kanonischen/localen ID und trägt den NEUEN Inhalt. Der Absender steht
 *  wie bei Reaktionen außerhalb — der Sitzungs-Partner ist der Autor. */
export type BearbeitungsAngabe = { ziel: string; inhalt: string };

/** Anruf-Schlüssel-Frame (E2EE-Anrufe, 2026-09-09): `schluessel` ist der EINE
 *  LiveKit-E2EE-Schlüssel des Anrufs — 32 Zufallsbytes des Initiators, base64
 *  —, `anrufId` die Server-ID des Anrufs, unter der der Empfaenger ihn im
 *  Anruf-Store (`anruf.svelte.ts`) wiederfindet. Reist über denselben
 *  verschlüsselten Sendeweg wie die anderen Frames: DM per Olm
 *  (`senden.ts::sendeAnrufSchluessel`), Gruppe per Megolm
 *  (`gruppe/frameSenden.ts::sendeGruppenAnrufSchluessel`). */
export type AnrufSchluesselAngabe = { anrufId: string; schluessel: string };

export type NachrichtNutzlast = {
  text: string;
  /** Kanonische Nachrichten-ID des Autors — `null` nur bei einer Legacy-
   *  Nutzlast ohne dieses Feld. */
  id: string | null;
  replyToId: string | null;
  /** Lösch-Frame (2026-09-02): `true` = die Nachricht mit dieser ID wurde
   *  vom Autor gelöscht — Empfaenger entfernen sie lokal (Grabstein). */
  geloescht?: true;
  /** Reaktions-Umschlag (s. `ReaktionsAngabe`) — wie `geloescht` ein Frame
   *  ohne Text, der sich auf eine ANDERE Nachricht bezieht. */
  reaktion?: ReaktionsAngabe;
  /** Bearbeitungs-Umschlag (P1.5 Teil 2) — wie `reaktion` ein Frame ohne
   *  eigenen Text, dessen `inhalt` den Text der Ziel-Nachricht ERSETZT. */
  bearbeitung?: BearbeitungsAngabe;
  /** Anruf-Schlüssel-Frame (E2EE-Anrufe) — wie `reaktion` ein Frame ohne
   *  eigenen Text; er gehört zu einem LAUFENDEN Anruf, nicht zu einer
   *  Nachricht (`AnrufSchluesselAngabe`). */
  anrufSchluessel?: AnrufSchluesselAngabe;
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
/** Lösch-Frame: leere Nutzlast, die nur die kanonische ID der gelöschten
 *  Nachricht trägt. Läuft über denselben verschlüsselten Sendeweg wie eine
 *  gewöhnliche Nachricht — der Server bleibt blindes Postfach. */
export function baueLoeschNutzlast(nachrichtId: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ v: FASSUNG, text: '', id: nachrichtId, geloescht: true })
  );
}

/** Reaktions-Umschlag: Frame ohne Text und ohne eigene ID — er IST keine
 *  Nachricht, sondern bezieht sich auf eine (`ReaktionsAngabe.ziel`, kanonisch).
 *  Derselbe verschluesselte Sendeweg wie der Loesch-Frame. */
export function baueReaktionsNutzlast(
  zielNachrichtId: string,
  emoji: string,
  entfernen: boolean
): Uint8Array {
  const reaktion: ReaktionsAngabe = { ziel: zielNachrichtId, emoji };
  if (entfernen) reaktion.entfernen = true;
  return new TextEncoder().encode(JSON.stringify({ v: FASSUNG, text: '', reaktion }));
}

/** Fail-closed wie `leseAnhang`: ein Frame ohne Ziel oder Emoji ist keine
 *  Reaktion — und faellt dann als leere Textnachricht NICHT in die Anzeige,
 *  weil `zustellungOeffnen` nur ein gelesenes `reaktion` als Frame behandelt;
 *  der Rest liest sich als gewoehnliche (leere) Nutzlast. */
function leseReaktion(wert: unknown): ReaktionsAngabe | null {
  if (wert === null || typeof wert !== 'object') return null;
  const r = wert as Record<string, unknown>;
  if (typeof r.ziel !== 'string' || r.ziel === '' || typeof r.emoji !== 'string' || r.emoji === '') {
    return null;
  }
  return { ziel: r.ziel, emoji: r.emoji, ...(r.entfernen === true ? { entfernen: true as const } : {}) };
}

/** Fail-closed wie `leseReaktion`: ein Frame ohne Ziel oder Inhalt ist keine
 *  Bearbeitung — und faellt dann als leere Textnachricht NICHT in die Anzeige,
 *  weil `zustellungOeffnen` nur ein gelesenes `bearbeitung` als Frame behandelt;
 *  der Rest liest sich als gewoehnliche (leere) Nutzlast. */
function leseBearbeitung(wert: unknown): BearbeitungsAngabe | null {
  if (wert === null || typeof wert !== 'object') return null;
  const b = wert as Record<string, unknown>;
  if (typeof b.ziel !== 'string' || b.ziel === '' || typeof b.inhalt !== 'string' || b.inhalt === '') {
    return null;
  }
  return { ziel: b.ziel, inhalt: b.inhalt };
}

/** Bearbeitungs-Umschlag: Frame ohne Text und ohne eigene ID — er IST keine
 *  Nachricht, sondern ersetzt den Text der Ziel-Nachricht. Derselbe
 *  verschluesselte Sendeweg wie Loesch- und Reaktions-Frame. */
export function baueBearbeitungsNutzlast(zielNachrichtId: string, inhalt: string): Uint8Array {
  const bearbeitung: BearbeitungsAngabe = { ziel: zielNachrichtId, inhalt };
  return new TextEncoder().encode(JSON.stringify({ v: FASSUNG, text: '', bearbeitung }));
}

/** Anruf-Schlüssel-Umschlag: Frame ohne Text — er gehört zu einem Anruf,
 *  nicht zu einer Nachricht. Derselbe verschluesselte Sendeweg wie Loesch-,
 *  Reaktions- und Bearbeitungs-Frame (DM: Olm, Gruppe: Megolm). */
export function baueAnrufSchluesselNutzlast(anrufId: string, schluessel: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ v: FASSUNG, text: '', anrufSchluessel: { anrufId, schluessel } })
  );
}

/** Fail-closed wie `leseReaktion`: ein Frame ohne anrufId oder Schlüssel ist
 *  keiner — der Rest liest sich dann als gewöhnliche leere Nutzlast. Ob der
 *  Schlüssel WIRKLICH 32 Bytes sind, prueft erst der Anruf-Store beim Merken
 *  (dort liegt atob, hier nicht — importfrei). */
function leseAnrufSchluessel(wert: unknown): AnrufSchluesselAngabe | null {
  if (wert === null || typeof wert !== 'object') return null;
  const a = wert as Record<string, unknown>;
  if (
    typeof a.anrufId !== 'string' ||
    a.anrufId === '' ||
    typeof a.schluessel !== 'string' ||
    a.schluessel === ''
  ) {
    return null;
  }
  return { anrufId: a.anrufId, schluessel: a.schluessel };
}

/**
 * Ein erkannter Aktions-Frame samt allem, was der Abholzyklus zum Anwenden
 * braucht — strukturell identisch zu den drei Frame-Zweigen von
 * `zustellungOeffnen.ts::ZustellungOffenErgebnis` (dort steht der Vertrag des
 * Zyklus, hier die Erkennung; absichtlich zwei Typen, damit diese Datei
 * importfrei bleibt).
 *
 * Die Erkennung ist GEMEINSAM fuer beide Empfangswege — den Olm-Weg der DMs
 * und den Megolm-Weg der Gruppen (`gruppe/empfangen.ts`): eine
 * Aktions-Nutzlast bedeutet ueberall dasselbe, und zwei Kopien der
 * Fallunterscheidung liefen auseinander. `autorId` steht nicht IN der
 * Nutzlast — er ist beim Olm-Weg der Sitzungs-Partner, beim Megolm-Weg der
 * Zustellungs-Absender, und wird hier nur durchgereicht.
 */
export type RahmenErgebnis =
  | { art: 'loeschung'; id: string; channelId: string; nachrichtId: string }
  | {
      art: 'reaktion';
      id: string;
      channelId: string;
      autorId: string;
      ziel: string;
      emoji: string;
      entfernen: boolean;
    }
  | { art: 'bearbeitung'; id: string; channelId: string; ziel: string; inhalt: string }
  | {
      art: 'anrufSchluessel';
      id: string;
      channelId: string;
      autorId: string;
      anrufId: string;
      schluessel: string;
    };

/** Liest aus einer geoeffneten Nutzlast einen Aktions-Frame — `null`, wenn es
 *  eine gewoehnliche Nachricht ist (der Aufrufer baut dann selbst die
 *  Anzeige-Form). Ein Loesch-Frame ohne ID ist keiner und faellt durch,
 *  fail-closed wie die Leser oben. */
export function rahmenAusNutzlast(
  gelesen: NachrichtNutzlast,
  id: string,
  channelId: string,
  autorId: string
): RahmenErgebnis | null {
  if (gelesen.geloescht && gelesen.id !== null) {
    return { art: 'loeschung', id, channelId, nachrichtId: gelesen.id };
  }
  if (gelesen.reaktion) {
    return {
      art: 'reaktion',
      id,
      channelId,
      autorId,
      ziel: gelesen.reaktion.ziel,
      emoji: gelesen.reaktion.emoji,
      entfernen: gelesen.reaktion.entfernen === true
    };
  }
  if (gelesen.bearbeitung) {
    return {
      art: 'bearbeitung',
      id,
      channelId,
      ziel: gelesen.bearbeitung.ziel,
      inhalt: gelesen.bearbeitung.inhalt
    };
  }
  if (gelesen.anrufSchluessel) {
    return {
      art: 'anrufSchluessel',
      id,
      channelId,
      autorId,
      anrufId: gelesen.anrufSchluessel.anrufId,
      schluessel: gelesen.anrufSchluessel.schluessel
    };
  }
  return null;
}

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
      const reaktion = leseReaktion(o.reaktion);
      const bearbeitung = leseBearbeitung(o.bearbeitung);
      const anrufSchluessel = leseAnrufSchluessel(o.anrufSchluessel);
      return {
        text: o.text as string,
        id: typeof o.id === 'string' ? o.id : null,
        replyToId: typeof o.replyToId === 'string' ? o.replyToId : null,
        anhaenge,
        ...(o.geloescht === true ? { geloescht: true as const } : {}),
        ...(reaktion ? { reaktion } : {}),
        ...(bearbeitung ? { bearbeitung } : {}),
        ...(anrufSchluessel ? { anrufSchluessel } : {})
      };
    }
  } catch {
    // Kein JSON, oder nicht Fassung 1 -> Legacy-Klartext, s. Modulkopf.
  }
  return { text: roh, id: null, replyToId: null, anhaenge: [] };
}
