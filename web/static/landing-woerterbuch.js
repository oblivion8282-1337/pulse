/**
 * Woerterbuch und Uebersetzer der Landingpage — eigene Datei, damit
 * `landing.js` unter der Groessen-Policy bleibt (CLAUDE.md, ≤ 350 Zeilen).
 * Wird von `landing.js` als ES-Modul importiert; die CSP der Seite erlaubt
 * eigene Module (`script-src 'self'`).
 */

/**
 * DE → EN. Verbindlich uebernommen aus dem Design-Canvas (`getDict()` in
 * `artboard-logic.js`); die vier Umlaufbahn-Beschriftungen und der
 * Self-Hosting-Link kommen aus derselben Quelle (dort im Diagramm-Bauteil
 * statt im Woerterbuch). Zahlen bleiben unveraendert — Entscheidung des
 * Eigentuemers.
 */
export const WOERTERBUCH = {
  Funktionen: 'Features',
  Vergleich: 'Comparison',
  'Self-Hosting': 'Self-hosting',
  Plattformen: 'Platforms',
  'Im Browser öffnen': 'Open in browser',
  'App laden': 'Get the app',
  'Du verdienst was Besseres.': 'You deserve better.',
  'DIE NACKTEN ZAHLEN': 'THE HARD NUMBERS',
  'Wir fangen da an,': 'We start where',
  'wo die anderen aufhören.': 'the others leave off.',
  'Pulse, selbst gehostet': 'Pulse, self-hosted',
  Tonqualität: 'Audio quality',
  '64 kbit/s — mehr kostet extra': '64 kbps — anything more costs extra',
  '128 kbit/s': '128 kbps',
  'Bis 512 kbit/s': 'Up to 512 kbps',
  Auflösung: 'Resolution',
  '720p — mehr kostet extra': '720p — anything more costs extra',
  Unbegrenzt: 'Unlimited',
  Bildrate: 'Frame rate',
  '30 fps — mehr kostet extra': '30 fps — anything more costs extra',
  'Stark komprimiert': 'Heavily compressed',
  'Deutlich über der Konkurrenz': 'Well above the competition',
  'AV1 & H.264, direkt auf der GPU': 'AV1 & H.264, right on the GPU',
  'Volle Qualität kostet': 'Full quality costs',
  'Ein Abo': 'A subscription',
  FUNKTIONEN: 'FEATURES',
  'Alles drin. Nichts im Weg.': 'Everything you need. Nothing in the way.',
  'Kein Rauschen': 'No noise',
  'Cleanes Design, diszipliniert, nichts im Weg. So wie es sein sollte.':
    'A clean, disciplined design with nothing in the way. The way it should be.',
  'Communitys & Rollen': 'Communities & roles',
  'Text- und Sprachkanäle mit vollem Rollen- und Rechtesystem.':
    'Text and voice channels with a full roles and permissions system.',
  'Eine Stimme, die gut klingt': 'A voice that sounds good',
  'Klingt nach Raum, nicht nach Funkgerät — Push-to-Talk, optional 3D-Raumklang.':
    'Sounds like a room, not a walkie-talkie — push-to-talk, optional 3D audio.',
  'Watch-Partys': 'Watch parties',
  'Gemeinsam YouTube schauen — synchron, mit eigenem Chat.':
    'Watch YouTube together — in sync, with its own chat.',
  'Mehrere Bildschirme gleichzeitig': 'Multiple screens at once',
  'Ein Bildschirm reicht dir nicht? Dann teil zwei. Oder drei. Oder neunzig.':
    'One screen not enough? Then share two. Or three. Or ninety.',
  'TOTP und Passkeys — auf Wunsch komplett passwortloser Login.':
    'TOTP and passkeys — fully passwordless login if you like.',
  'Installieren ohne Store': 'No app store needed',
  'Windows, macOS, Linux — und im Browser, installierbar wie eine App.':
    'Windows, macOS, Linux — and in the browser, installable like an app.',
  Fernsteuerung: 'Remote control',
  'Zuschauer übernehmen auf Wunsch Maus und Tastatur — in Streaming-Qualität, auch für Rechner ohne Aufsicht.':
    'Viewers can take over mouse and keyboard on request — at streaming quality, even on unattended machines.',
  'HDR-Streaming': 'HDR streaming',
  'Bildschirm in HDR übertragen — AV1 mit 10 Bit, auf Windows mit NVIDIA und AMD.':
    'Share your screen in HDR — AV1 at 10 bit, on Windows with NVIDIA and AMD.',
  'Verschlüsselte Direktnachrichten': 'Encrypted direct messages',
  'Ende-zu-Ende verschlüsselt, auf allen deinen Geräten. Der Server sieht keinen Klartext.':
    'End-to-end encrypted, on all your devices. The server never sees plaintext.',
  'Besprechung ohne Konto': 'Meetings without an account',
  'Link teilen, Namen eintippen, drin. Gäste sitzen im Sprachkanal, ohne sich zu registrieren.':
    'Share a link, type a name, done. Guests join the voice channel without signing up.',
  'In Entwicklung': 'In development',
  'Ein Konto, viele Server.': 'One account, many servers.',
  'Deine Identität liegt zentral — deine Welten betreibst du selbst. Eigene Hardware, eigene Daten, eigene Regeln. Und deine Mitglieder bringen ihr Konto einfach mit.':
    'Your identity lives in one place — your worlds are yours to run. Your hardware, your data, your rules. And your members simply bring their account along.',
  'Selbst gehostet gibt es keine Grenzen — so weit deine Hardware reicht.':
    'Self-hosted, there are no limits — only your hardware sets them.',
  'Deine Instanz hängt an der Pulse Cloud — für Konto und Updates. Mehr nicht. Was auf deinem Server passiert, sieht niemand außer dir.':
    'Your instance connects to the Pulse Cloud — for your account and updates. Nothing more. Nobody sees what happens on your server but you.',
  'DEIN KONTO': 'YOUR ACCOUNT',
  'Selbst gehostete Instanzen sind anonym — die Cloud sieht nicht, was darauf läuft.':
    "Self-hosted instances are anonymous — the cloud can't see what runs on them.",
  PLATTFORMEN: 'PLATFORMS',
  'Läuft, wo du bist.': 'Runs wherever you are.',
  'Sende einen': 'Send a',
  'App laden — Windows · macOS · Linux': 'Get the app — Windows · macOS · Linux',
  Impressum: 'Legal notice',
  Datenschutz: 'Privacy',
  // Umlaufbahn-Diagramm (im Canvas Teil des Bauteils, nicht des Woerterbuchs)
  'SELBST GEHOSTET · ANONYM': 'SELF-HOSTED · ANONYMOUS',
  'Gaming-Gruppe': 'Gaming group',
  Freundeskreis: 'Friend circle',
  'Dein Heimserver': 'Your home server',
  'Vereins-Server': 'Club server',
  // Nur auf dieser Seite, im Canvas gab es den Link noch nicht
  'Befehl kopieren': 'Copy command',
  Kopiert: 'Copied',
  'Pulse für Linux': 'Pulse for Linux',
  'Installiere Pulse als Flatpak — der Befehl richtet zugleich die Update-Quelle ein.':
    'Install Pulse as a Flatpak — the command also sets up the update source.',
  Schließen: 'Close'
};

/** @type {WeakMap<Node, string>} */
const ausgangstexte = new WeakMap();

/**
 * Setzt alle Texte unter `root` auf `sprache`.
 *
 * Der deutsche Ausgangstext jedes Textknotens wird beim ersten Aufruf gemerkt.
 * Rueckwaerts uebersetzen (EN → DE) ueber ein umgedrehtes Woerterbuch waere
 * mehrdeutig — mehrere deutsche Saetze koennen dieselbe englische Fassung
 * haben, und unuebersetzte Texte stehen in beiden Sprachen gleich da.
 *
 * @param {Node | null} root
 * @param {Record<string, string>} dict
 * @param {'de'|'en'} sprache
 * @returns {number} Zahl der geaenderten Textknoten
 */
export function uebersetzen(root, dict, sprache) {
  if (!root || !root.ownerDocument) return 0;
  const lauf = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  /** @type {Node | null} */
  let knoten;
  let geaendert = 0;
  while ((knoten = lauf.nextNode())) {
    if (!ausgangstexte.has(knoten)) ausgangstexte.set(knoten, knoten.nodeValue || '');
    const original = ausgangstexte.get(knoten) || '';
    const kern = original.trim();
    if (!kern) continue;
    const ziel = sprache === 'en' && dict[kern] ? dict[kern] : kern;
    const neu = original.replace(kern, ziel);
    if (knoten.nodeValue !== neu) {
      knoten.nodeValue = neu;
      geaendert++;
    }
  }
  return geaendert;
}
