/**
 * Die Deutung einer gescheiterten Serververbindung — reine Rechnung, ohne
 * Zustand und ohne Nachbarmodule.
 *
 * **Warum getrennt vom Prüfer selbst:** damit sie prüfbar ist. Der
 * Web-Testläufer (`pnpm test:unit`, Nodes eingebauter) führt eine Datei nur
 * aus, wenn sie keine erweiterungslosen Laufzeit-Importe mitschleppt — die
 * löst der Bundler auf, Node nicht. Dieses Modul importiert **nichts** und
 * bleibt es deshalb. Gleiches Muster wie `lib/remote/zeigerbildPruefung.ts`,
 * aus demselben Grund.
 *
 * **Warum es diese Deutung überhaupt gibt.** Ein Self-Host muss sieben Glieder
 * hintereinander bestehen, um ERREICHBAR zu sein — DNS, TCP/443, Zertifikat,
 * Routing durch einen fremden Proxy, CORS-Header, WebSocket-Upgrade,
 * UDP-Medienports. (Die Server-Diagnose kennt seit 2026-08-27 ein achtes
 * Glied, die Betreiber-Erkennung; die ist keine Erreichbarkeitsfrage und
 * hier deshalb nicht vertreten.) Bis 2026-08
 * fasste der Client alles davon zu einem einzigen „nicht erreichbar" zusammen
 * (`server-info.ts` fing DNS-, TLS-, CORS- und Zeitfehler in EINEM `catch`),
 * und der Betreiber stand ohne Anhaltspunkt da. Jede Zeile hier trennt einen
 * Fall ab, für den es eine ANDERE Handlung gibt — Befunde ohne eigene Handlung
 * gehören nicht in diese Liste, sie machen sie nur länger.
 */

// ---------------------------------------------------------------------------
// WS-Schliesscodes
// ---------------------------------------------------------------------------

/**
 * Die Schliesscodes, die diese Deutung auswertet.
 *
 * Kanonisch stehen sie in `services/chat-gateway/.../routes/ws.py` und
 * gespiegelt in `lib/api/constants.ts` (`WS_CLOSE`) — von dort können sie hier
 * nicht importiert werden (erweiterungsloser Laufzeit-Import, s. Kopf).
 * **Gegen das Auseinanderdriften hält `web/test/verbindungsbefund.test.ts`**
 * die Zahlen textlich gegen `constants.ts`; ein Kommentar allein hätte den
 * Abgleich niemandem abverlangt.
 */
const SCHLIESSCODE = {
  /** Token abgelehnt. Für einen Probe-Aufruf mit Wegwerf-Token der ERWÜNSCHTE
   *  Ausgang: der Gateway hat geantwortet, also steht die ganze Kette. */
  TOKEN_ABGELEHNT: 4001,
  SERVER_ZU_ALT: 4044,
  /** Der Gateway hat seine JWKS noch nicht — der Dienst nebenan (auth-svc,
   *  im selben Container) antwortet noch nicht darauf. */
  JWKS_KALT: 4046,
  /** Instanz von der Cloud gesperrt oder gelöscht. */
  INSTANZ_GESPERRT: 4070,
} as const;

// ---------------------------------------------------------------------------
// Befunde
// ---------------------------------------------------------------------------

/**
 * Was der Probe-Aufruf über die Verbindung sagt. Jeder Wert steht für eine
 * andere Handlung des Betreibers — deshalb sind es genau diese und nicht mehr.
 */
export type Verbindungsbefund =
  /** Die ganze Kette steht: DNS, TLS, Proxy-Upgrade, Gateway. */
  | 'offen'
  /** Der Proxy reicht WebSockets nicht durch (fehlende `Upgrade`-Header —
   *  die mit Abstand häufigste Falle hinter nginx / Nginx Proxy Manager). */
  | 'kein-upgrade'
  /** Der Upgrade kam durch, aber es antwortete kein Pulse-Gateway: der Proxy
   *  hat die Verbindung selbst beendet oder zeigt ins Leere. */
  | 'kein-gateway'
  /** Der Server läuft, aber seine JWKS sind kalt: der Dienst nebenan
   *  (auth-svc, im selben Container) hat noch nicht geantwortet. Nach
   *  aussen ist die Kette hier bereits vollständig bewiesen — DNS, TCP,
   *  TLS, Proxy, CORS und das WS-Upgrade sind alle durch. */
  | 'server-ohne-cloud'
  /** Die Instanz ist in der Cloud gesperrt oder gelöscht. */
  | 'server-gesperrt'
  /** Der Server ist zu alt für diesen Client. */
  | 'server-zu-alt'
  /** Nichts kam zurück, bevor die Zeit ablief. */
  | 'zeitueberschreitung';

/**
 * Deutet das Ergebnis eines WebSocket-Probe-Aufrufs.
 *
 * `geoeffnet` ist der eigentliche Träger der Aussage, nicht der Code: **ob der
 * Socket überhaupt aufging, entscheidet, ob der Upgrade den Proxy passiert
 * hat.** Erst danach trägt der Code eine Bedeutung.
 *
 * @param geoeffnet ob das `open`-Ereignis feuerte, bevor geschlossen wurde
 * @param code der Schliesscode; `null`, wenn die Zeit ablief
 */
export function deuteProbe(geoeffnet: boolean, code: number | null): Verbindungsbefund {
  if (code === null) return 'zeitueberschreitung';
  if (!geoeffnet) return 'kein-upgrade';

  switch (code) {
    // Der erwünschte Ausgang: der Gateway hat unser Wegwerf-Token abgelehnt.
    case SCHLIESSCODE.TOKEN_ABGELEHNT:
      return 'offen';
    case SCHLIESSCODE.JWKS_KALT:
      return 'server-ohne-cloud';
    case SCHLIESSCODE.INSTANZ_GESPERRT:
      return 'server-gesperrt';
    case SCHLIESSCODE.SERVER_ZU_ALT:
      return 'server-zu-alt';
    default:
      // Jeder Code aus dem 4000er-Band kommt vom Gateway selbst — auch einer,
      // den dieser Client noch nicht kennt. Dass er ANKAM, ist die Aussage:
      // die Kette steht. Ein neuerer Server darf hier nicht als Fehler gelten.
      if (code >= 4000 && code <= 4999) return 'offen';
      // 1006 (unsauber) / 1005 (kein Code) nach einem offenen Socket: der
      // Upgrade kam durch, aber nichts hat auf Pulse-Art geantwortet.
      return 'kein-gateway';
  }
}

/**
 * Ob dieser Befund das Hinzufügen des Servers verhindern soll.
 *
 * `server-gesperrt` und `server-zu-alt` sind **keine** Verbindungsfehler — sie
 * gehören dem Anmelde-/Versionsweg, der sie mit eigenen,
 * genaueren Texten behandelt. Hier würden sie nur doppelt gemeldet.
 */
export function haeltAuf(befund: Verbindungsbefund): boolean {
  return (
    befund === 'kein-upgrade' ||
    befund === 'kein-gateway' ||
    befund === 'server-ohne-cloud' ||
    befund === 'zeitueberschreitung'
  );
}

// ---------------------------------------------------------------------------
// Vorprüfung über HTTP
// ---------------------------------------------------------------------------

/**
 * Was die HTTP-Vorprüfung über einen gescheiterten Abruf sagt.
 *
 * Der Browser maskiert einen CORS-Block als denselben `TypeError: Failed to
 * fetch` wie ein totes Netz — aus dem Fehler allein ist das nicht zu trennen.
 * Trennbar ist es über eine **Gegenprobe mit `mode:'no-cors'`**: kommt dabei
 * eine (opaque) Antwort, dann steht der Server und nur die Header fehlen.
 *
 * @param opaqueAntwort ob die `no-cors`-Gegenprobe eine Antwort erhielt
 */
export function deuteAbrufFehler(opaqueAntwort: boolean): 'cors' | 'unreachable' {
  return opaqueAntwort ? 'cors' : 'unreachable';
}

// ---------------------------------------------------------------------------
// Die genaue Auskunft aus dem Desktop
// ---------------------------------------------------------------------------

/**
 * Was die Electron-Netzdiagnose herausgefunden hat, sofern sie etwas
 * herausgefunden hat. `null` heisst ausdrücklich **keine Aussage** — dann
 * bleibt es beim allgemeinen „nicht erreichbar", statt eine Ursache zu
 * erfinden, die niemand gemessen hat.
 */
export type Netbefund =
  /** Der Name löst nicht auf — meist steht der DNS-Eintrag noch nicht. */
  | 'name-unbekannt'
  /** Die Adresse gibt es, aber auf dem Port antwortet nichts. */
  | 'port-zu'
  /** Das Zertifikat gilt für einen anderen Namen. */
  | 'zert-name'
  | 'zert-abgelaufen'
  /** Selbstsigniert oder unvollständige Kette — kein Browser wird es nehmen. */
  | 'zert-ungueltig';

/** Ein Diagnoseschritt, so wie ihn `desktop/.../netdiag.ts` liefert. */
export type NetdiagSchritt = {
  schritt: string;
  ok: boolean;
  befund?: string;
};

/**
 * Zieht aus den Schritten den einen Befund, der die Ursache benennt.
 *
 * Die Diagnose bricht beim ersten harten Fehlschlag ab, gesucht ist also der
 * **letzte** Schritt — und der ist genau dann aussagekräftig, wenn er nicht
 * `ok` ist. Ein vollständig grüner Durchlauf ergibt `null`: dass die Kette bis
 * HTTP steht, der Browser aber trotzdem scheiterte, ist ein CORS-Fall und
 * gehört nicht hierher.
 */
export function deuteNetdiag(schritte: readonly NetdiagSchritt[] | null): Netbefund | null {
  if (!schritte || schritte.length === 0) return null;
  const letzter = schritte[schritte.length - 1];
  if (letzter.ok) return null;

  if (letzter.schritt === 'dns') return 'name-unbekannt';
  if (letzter.schritt === 'tcp') return 'port-zu';
  if (letzter.schritt === 'tls') {
    if (letzter.befund === 'falscher-name') return 'zert-name';
    if (letzter.befund === 'abgelaufen') return 'zert-abgelaufen';
    if (letzter.befund === 'selbstsigniert' || letzter.befund === 'kette-unvollstaendig') {
      return 'zert-ungueltig';
    }
    // 'laeuft-bald-ab' ist KEIN Grund, das Hinzufügen zu verhindern, und
    // 'unbekannter-fehler' ist keine Auskunft — beide fallen durch.
    return null;
  }
  return null;
}
