/**
 * Ablage — Renderer zur Plattform-Brücke.
 *
 * Gebaut wie `sidecarInput.ts`: im Browser und in einer älteren Shell liefert
 * jede Funktion still ein Ergebnis, statt zu werfen. Der Unterschied zur
 * Eingabe ist die Bedeutung: eine verlorene Ablage-Nachricht kostet ein
 * Einfügen, keine Sitzung.
 *
 * **Zwei verschiedene Brücken, mit Absicht.** Hinaus geht jeder Wert über
 * `window.pulse.gsr.ablage(rolle, session, data, slot)` — der Hauptprozess
 * entscheidet dort, ob er ins Player-Fenster oder an den Host-Sidecar geht
 * (`desktop/electron/ablageWeiche.ts`). Die **Rolle reist mit, statt im
 * Hauptprozess geraten zu werden**: ein Host, der nebenbei den Strom eines
 * Dritten im nativen Player anschaut, trägt ebenfalls eine Sitzungsnummer —
 * daraus liesse sich fälschlich 'controller' folgern.
 *
 * **Herein kommen die beiden Rollen aus verschiedenen Quellen**, und das ist
 * kein Zufall: beim Steuernden hält der native Player die Ablage und meldet
 * über `player:event`, beim Host der Sidecar des Träger-Platzes über
 * `gsr:event`. Ein gemeinsames Abonnement beider Ströme wäre kürzer und
 * falsch — der Host hat womöglich ein Player-Fenster offen (er schaut den
 * Strom eines Dritten an), und dessen Ablage-Ereignisse gehören nicht in seine
 * Host-Sitzung.
 */

function ablageBruecke() {
  return typeof window !== 'undefined' ? window.pulse?.gsr : undefined;
}

function playerBruecke() {
  return typeof window !== 'undefined' ? window.pulse?.player : undefined;
}

/** Einen Ablage-Wert an die eigene Plattform geben (Player beim Steuernden,
 *  Sidecar beim Host — die Weiche steht im Hauptprozess, `rolle` bestimmt sie).
 *
 *  `session` ist die Player-Fensternummer des Steuernden (0 sonst), `slot` der
 *  Stream-Platz des Träger-Sidecars beim Host (0 sonst). **Zwei Felder statt
 *  eines gemeinsamen:** sie bedeuten Verschiedenes, und ein Feld, dessen
 *  Bedeutung von der Rolle abhängt, wird beim nächsten Lesen falsch verstanden.
 *
 *  `data` ist bereits eingehüllt (`ablageHuelle.ts`) — diese Funktion hüllt
 *  NICHT selbst ein: sie könnte einen Anstoss von einem Leitungsrahmen nicht
 *  unterscheiden, also läge die Entscheidung wieder bei der Form des Werts
 *  statt beim Aufrufer, der sie kennt. */
export async function ablageAnPlattform(
  rolle: 'host' | 'controller',
  session: number,
  data: unknown,
  slot = 0,
): Promise<boolean> {
  const b = ablageBruecke();
  if (typeof b?.ablage !== 'function') return false;
  try {
    const antwort = (await b.ablage(rolle, session, data, slot)) as { ok?: boolean } | undefined;
    return antwort?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Dem Sidecar eines Platzes sagen, dass seine Ablage-Sitzung vorbei ist — beim
 * **Trägerwechsel** (`ablageTraeger.ts::traegerWechsel`).
 *
 * **Eigener Weg statt `ablageAnPlattform`**, weil er einen Riegel braucht, den
 * nur der Hauptprozess setzen kann: `getSidecar()` startet lazy, ein Ruf an
 * einen Platz ohne laufenden Sidecar spawnte also einen Prozess, nur um ihm zu
 * sagen, dass er nichts zu tun hat. Der Riegel (`sidecarRunning`) ist zugleich
 * der ganze Plattform-Unterschied: auf Windows ist der alte Träger nach `stop`
 * weg, auf macOS lebt er weiter.
 *
 * Nur die Host-Rolle hat Träger; der Steuernde ruft das nie.
 */
export async function ablageEndeAnPlatz(slot: number): Promise<boolean> {
  const b = ablageBruecke();
  // Ältere Shell ohne diesen Kanal: still nichts tun, wie überall in dieser
  // Schicht. Es kostet auf Windows nichts (dort stirbt der Prozess ohnehin).
  if (typeof b?.ablageEnde !== 'function') return false;
  try {
    const antwort = (await b.ablageEnde(slot)) as { ok?: boolean } | undefined;
    return antwort?.ok === true;
  } catch {
    return false;
  }
}

/** Was die eigene Plattform hinausschicken will. Liefert den Abmelder, oder
 *  `null`, wenn es die Brücke nicht gibt.
 *
 *  Der zweite Rückruf-Parameter ist der Stream-Platz, von dem das Ereignis
 *  kommt (`null` beim Player, der keinen hat). Der Host braucht ihn, um
 *  Ereignisse eines Sidecars zu verwerfen, der **nicht Träger** ist — dass
 *  überhaupt nur einer wach ist, entscheidet er selbst über den Anstoss
 *  `beginn`; diese Prüfung ist das Netz darunter. */
export function aufAblageEreignisse(
  rolle: 'host' | 'controller',
  cb: (data: unknown, slot: number | null) => void,
): (() => void) | null {
  const b = rolle === 'host' ? ablageBruecke() : playerBruecke();
  if (typeof b?.onEvent !== 'function') return null;
  return b.onEvent((ev: unknown) => {
    const m = ev as { ev?: unknown; data?: unknown; slot?: unknown } | null;
    if (m?.ev !== 'ablage') return;
    if (m.data === undefined) return;
    cb(m.data, typeof m.slot === 'number' ? m.slot : null);
  });
}
