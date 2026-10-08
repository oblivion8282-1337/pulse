/**
 * Aus einer von aussen hereingereichten Adresse das Ziel IN der App machen.
 *
 * **Warum das geprüft gehört und nicht inline passiert:** Was hier
 * hereinkommt, hat ein Fremder geschickt — eine Nachricht, eine Webseite, ein
 * QR-Code. Die Funktion ist damit eine Grenze, und eine Grenze, die
 * `goto(irgendwas)` füttert. Sie lässt deshalb nur durch, was sie positiv
 * erkennt (Erlaubnisliste), und gibt sonst `null` zurück — der Aufrufer öffnet
 * dann einfach gar nichts.
 *
 * Drei Riegel, jeder gegen einen echten Missbrauch:
 *  - **Nur unser Haus.** Eine fremde Herkunft fällt raus; sonst öffnete ein
 *    Link auf `boese.example/app/@me/1` die App an einer Stelle, die der
 *    Angreifer wählt.
 *  - **Nur `/app/…`.** Alles andere (Impressum, Landeseite, `/login`) gehört
 *    in den Browser und wurde auch nicht beansprucht.
 *  - **Kein Protokoll-Relativ, kein `//`.** `goto('//boese.example')` wäre
 *    eine Navigation nach draussen, die wie ein Pfad aussieht.
 *
 * Importfrei, damit Nodes Testläufer sie prüfen kann (s. CLAUDE.md).
 */

/** Die Herkunft, für die Universal Links beansprucht sind — dieselbe wie in
 *  `web/static/.well-known/apple-app-site-association`. */
const ERLAUBTE_HOSTS = ['howispulse.com', 'www.howispulse.com'];

export function zielPfad(adresse: string): string | null {
  let u: URL;
  try {
    u = new URL(adresse);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (!ERLAUBTE_HOSTS.includes(u.hostname.toLowerCase())) return null;
  // Genau `/app` oder darunter — `/appetit` darf nicht durchrutschen.
  if (u.pathname !== '/app' && !u.pathname.startsWith('/app/')) return null;
  const ziel = `${u.pathname}${u.search}${u.hash}`;
  // Doppelter Boden: ein Ziel, das mit `//` beginnt, ist für den Router eine
  // fremde Herkunft. Kann nach den Prüfungen oben nicht mehr auftreten —
  // steht hier, weil der Schaden gross und die Zeile billig ist.
  if (ziel.startsWith('//')) return null;
  return ziel;
}

/**
 * Dasselbe für einen PFAD ohne Herkunft — für Ziele, die aus der Hülle
 * zurückkommen (Schnellwahl am Icon, iOS-Punkt 44).
 *
 * **Warum das geprüft wird, obwohl der Pfad von uns selbst stammt.** Er hat
 * die App verlassen: er lag als `userInfo` in einem
 * `UIApplicationShortcutItem` und damit in einem Bereich, den das System
 * verwaltet und der einen Neustart überdauert. Was zurückkommt, ist deshalb
 * eine EINGABE, auch wenn wir sie selbst geschrieben haben — dieselbe Haltung
 * wie bei `zielPfad` gegenüber der Apple-Vorauswahl.
 *
 * Erlaubnisliste wie oben: genau `/app` oder darunter, kein `//`.
 */
export function zielPfadIntern(pfad: string): string | null {
  if (!pfad.startsWith('/')) return null;
  if (pfad.startsWith('//')) return null;
  // Genau `/app` oder darunter — `/appetit` darf nicht durchrutschen.
  if (pfad !== '/app' && !pfad.startsWith('/app/')) return null;
  return pfad;
}
