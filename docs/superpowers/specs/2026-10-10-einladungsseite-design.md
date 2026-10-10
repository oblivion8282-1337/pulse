# Einladungsseite: Einladungslinks im Browser und in der Desktop-App

Stand 2026-10-10. **Entwurf, mit dem Eigentümer abgestimmt.** Ein Prototyp der
Seite, der Karte und des Dialogs liegt auf `feat/einladungsseite`
(`web/src/lib/einladung/`, `web/src/routes/invite/[code]/`); Screenshots aller
Zustände: https://claude.ai/artifact/7p5nvoq6VbVLtX8CKgiHbz.

## Wozu

„Link teilen“ im Leute-einladen-Dialog und die Community-Einstellungen
erzeugen `https://howispulse.com/invite/<code>`, bei Self-Host-Communitys mit
`?host=<fqdn>` (`web/src/lib/guilds/inviteLink.ts`). **Diese Adresse öffnet
heute nirgends etwas:** die Route `/invite/[code]` fiel am 2026-06-08 mit dem
Umbau auf Freundes-Einladungen weg (`be72dedf`), `inviteLink.ts` kam am
2026-07-13 zurück (`d23b96d8`), die Route nicht. Jeder Klick endet auf „Diese
Seite gibt es nicht“, eingeloggt wie ausgeloggt, Cloud wie Self-Host.
Beitreten geht nur, wenn man den Link von Hand ins Feld „Beitreten“ kopiert.
Die E2E-Tests (`invite-link-join.spec.ts`, `overnight-invites.spec.ts`) prüfen
nur die Form des Links und fügen ihn in dieses Feld ein — sie rufen ihn nie auf.

Ziel: Wer einen Einladungslink öffnet, sieht, wohin er führt, und ist mit
einem Klick drin — im Browser, in der Desktop-App und am Handy, angemeldet
oder nicht, mit oder ohne Konto.

## Entscheidungen

1. **Zwei Rahmen, eine Karte.** Wer den Link außerhalb von Pulse öffnet,
   bekommt eine eigene Seite (`/invite/<code>`). Wer schon in der App ist,
   bekommt einen Dialog über der aktuellen Ansicht. Beide zeigen dieselbe
   Komponente `EinladungKarte`.
2. **Abgemeldete sehen den Namen der Community** (mit Bild und
   Mitgliederzahl). Dafür bekommt der chat-gateway eine anonyme Vorschau mit
   Bremse (siehe „Server“). Gilt nur für Cloud-Communitys, siehe Sicherheit 2.
3. **Gemerkte Einladung statt Rückweg über die Adresse.** Die Seite merkt
   sich die Einladung im Browser; sobald man in diesem Browser in Pulse
   ankommt, öffnet sich der Dialog — egal ob über Anmelden, Registrieren oder
   E-Mail-Bestätigung. Ein Mechanismus statt drei Sonderfällen.
4. **Beitreten ist immer ein eigener Klick.** Der Knopf auf der Seite heißt
   „Anmelden“, nicht „Anmelden und beitreten“. Nach der Anmeldung zeigt der
   Dialog noch einmal, wem man beitritt; bei Self-Hosts kommt dort die
   Erstkontakt-Rückfrage.
5. **„In der Desktop-App öffnen“** steht auf der Seite im Browser am
   Rechner, nie in der App selbst und nie am Handy. Das Betriebssystem gibt
   `https`-Links immer an den Browser; der Knopf ist der einzige Weg in die
   App (wie bei Discord).

## Abläufe

**Browser, angemeldet:** Seite mit Karte → „Beitreten“ → `joinGuildByInvite`
→ in der Community. Schon Mitglied → „Community öffnen“.

**Browser, abgemeldet:** Seite mit Name/Bild/Mitgliederzahl, Knöpfe
„Anmelden“, „Konto erstellen“, „In der Desktop-App öffnen“. Ein Klick auf
Anmelden oder Konto erstellen merkt die Einladung und führt zur jeweiligen
Seite. Nach dem Login landet man in `/app`, das App-Layout findet die gemerkte
Einladung und öffnet den Dialog.

**Browser, angemeldet, E-Mail unbestätigt:** Der chat-gateway sperrt dann
alles mit 403 `email verification required` (`dcc_shared/token_verify.py`),
auch die Vorschau. Die Seite erkennt genau diesen Fall, zeigt „Bestätige
zuerst deine E-Mail-Adresse“, merkt die Einladung und führt zu
`/verify-email-required`. Nach der Bestätigung → `/app` → Dialog.

**Neues Konto:** `/register` → `/app` → (Cloud mit SMTP) Sperrseite
„E-Mail bestätigen“ → Bestätigungslink → `/app` → Dialog. Unterwegs hängt
nichts an der Adresse; die gemerkte Einladung trägt den Zusammenhang.

**Desktop-App, Link im Pulse-Chat angeklickt:** Heute öffnet ein
Einladungslink mit `target="_blank"` (`messageRender.ts`) und gleichem
Origin über `setWindowOpenHandler` (`desktop/electron/main.ts`) ein zweites,
nacktes Fenster ohne Preload. Künftig fängt die Nachrichtenanzeige Klicks auf
Einladungslinks ab und öffnet den Dialog (`?einladung=<code>[&host=…]` an der
aktuellen Adresse). Gilt im Browser genauso (statt neuem Tab).

**Desktop-App, Sprung aus dem Browser:** `pulse://invite?code=<code>[&host=<fqdn>]`.
Angemeldet → Dialog an der aktuellen Adresse. Nicht angemeldet → Einladung
merken → nach dem Login Dialog. Heute läuft der Beitritt sofort und scheitert
still (`runDeepLinkJoin` in `routes/+layout.svelte` schreibt nur in die
Konsole).

**Self-Host-Community:** Gleiche Karte mit der Server-Adresse als Marke.
Unbekannter Server → kein Name (Sicherheit 2), Server-Symbol statt Bild,
Titel „Community auf eigenem Server“. Bekannter Server mit Sitzung → Name und
Mitgliederzahl vom Server selbst. Beim Beitritt die bestehende
Erstkontakt-Rückfrage (`SelfHostContactConfirmDialog`).

**Handy:** Dieselbe Seite ohne Desktop-App-Knopf. Ob Einladungslinks in der
Android-App statt im Browser aufgehen, hängt an der App-Verknüpfung
(`/.well-known/assetlinks.json` liefert 200) und wird am Gerät geprüft.

## Bausteine

| Baustein | Ort | Aufgabe |
|---|---|---|
| `EinladungKarte.svelte` | `web/src/lib/einladung/` | rein darstellend; Zustände `laden`, `einladung`, `abgemeldet`, `email`, `mitglied`, `ungueltig`, `fehler`; Rahmen `karte`/`dialog` |
| `laden.ts` | `web/src/lib/einladung/` | Vorschau holen, Zustand bestimmen; Cloud **ausdrücklich** über `serversStore.cloudId()`, nie über den aktiven Server |
| `gemerkt.ts` | `web/src/lib/einladung/` | gemerkte Einladung lesen/schreiben/verwerfen; **importfrei** (Node-Unit-Tests, s. CLAUDE.md-Falle) |
| `fehlertext.ts` | `web/src/lib/einladung/` | HTTP-Status + `detail` → Paraglide-Schlüssel; importfrei |
| `EinladungDialog.svelte` | `web/src/lib/einladung/` | Dialog, öffnet bei `?einladung=` |
| Seite | `web/src/routes/invite/[code]/+page.svelte` | außerhalb von `/app`, Bühne wie `/login` |
| App-Layout | `web/src/routes/app/+layout.svelte` | Dialog einhängen; gemerkte Einladung nach Auth- und E-Mail-Prüfung in `?einladung=` umsetzen |
| Deep-Link | `web/src/routes/+layout.svelte` | statt `runDeepLinkJoin`: Dialog öffnen bzw. merken |
| Chat-Links | `messageRender.ts` / `MessageItem.svelte` | Klick auf Einladungslink → Dialog |
| Einladungs-Parser | eine importfreie Funktion | ersetzt `INVITE_RE` in `MessageItem.svelte:118` und die Host-Suche in `parseJoinInput`; findet `host=` an jeder Stelle der Query |
| Host-Prüfung | eine importfreie Funktion | Maßstab wie `isValidFqdn` (`desktop/electron/deeplink.ts`); lehnt IPs, Ports, `@`, `\` ab |

Alle sichtbaren Texte über Paraglide (de/en). Der Prototyp hat sie noch fest
auf Deutsch.

## Gemerkte Einladung

- `localStorage`, ein Eintrag: `{ code, host, gemerktAm }`. Lesen und
  Schreiben in `try/catch`; fehlt der Speicher, fällt nur der Komfort weg.
- **Geschrieben** beim Klick auf Anmelden, Konto erstellen oder E-Mail
  bestätigen — nicht schon beim bloßen Ansehen — und vom Deep-Link-Handler,
  wenn die App nicht angemeldet ist.
- **Gelesen** im App-Layout, sobald der Nutzer angemeldet und bestätigt ist.
  Treffer → `?einladung=…` an die aktuelle Adresse, Eintrag bleibt bis zur
  Entscheidung.
- **Verworfen** nach erfolgreichem Beitritt, beim Schließen des Dialogs,
  beim Abmelden (gemeinsam genutzter Rechner) und nach 24 Stunden.
- Geprüft wie ein frischer Link: Code-Form und Host-Prüfung, bevor irgendwas
  damit passiert.

## Server: anonyme Vorschau

Neue Route im chat-gateway, **eigene Route statt optionaler Anmeldung an der
bestehenden** (dieselbe Regel wie bei den Gast-Links: nirgends „Nutzer ODER
anonym“ an einer Abhängigkeit): `GET /invites/{code}/public-preview` →
`{ guild: { name, icon_url }, member_count }`.

- Kein `guild.id`-Feld, kein `channel_id` — Abgemeldete brauchen nur, was die
  Karte zeigt. Der Bildpfad in `icon_url` (`/api/chat/guild-icons/<id>.webp`)
  trägt die Guild-ID, das Bild ist dort ohnehin öffentlich abrufbar — die
  Antwort verrät nichts, was nicht schon öffentlich ist.
- Unbekannt, abgelaufen, zurückgezogen, aufgebraucht **und gesperrte
  Community** antworten gleich: 404.
- **Bremse über Redis, doppelt** (pro IP und pro Code), nach dem Muster von
  `gaeste.bremse_pruefen` — `ratelimit.py` zählt pro Nutzer-ID und im
  Prozess und ist für Anonyme wirkungslos.
- Nur die Cloud braucht die Route: an Self-Hosts fragt die Seite ohne
  Sitzung nie (Sicherheit 2). Sie kommt trotzdem mit dem gemeinsamen Code auf
  Self-Hosts mit und schadet dort nicht.

## Desktop

- `deeplink.ts`: `host` wird optional. Fehlt er, ist es eine
  Cloud-Einladung; steht dort der Cloud-Hostname, ebenfalls. Ist er
  gesetzt, bleibt `isValidFqdn` Pflicht.
- **Anmeldung beim System** für `pulse://`: Windows erledigt das heute zur
  Laufzeit (`setAsDefaultProtocolClient`). **Linux/Flatpak** braucht
  `MimeType=x-scheme-handler/pulse;` in `packaging/com.howispulse.Pulse.desktop`,
  **macOS** einen `protocols`-Eintrag in `desktop/electron-builder.yml`. Beides
  fehlt heute (aus dem Code gelesen, nicht ausprobiert).
- `desktop/electron/**` und das Paket ändern sich → **Version anheben**
  (CLAUDE.md, Windows-Release), sonst erreichen die Änderungen
  Bestandsclients nicht.
- Der Knopf „In der Desktop-App öffnen“ erscheint erst mit dieser Etappe.
  Davor würde er Cloud-Einladungen an eine App schicken, die sie ablehnt.
- Der Startversuch darf die Seite nicht verlassen (verstecktes `iframe` statt
  `location.href`), sonst ersetzt ein Browser ohne registrierte App die Seite
  durch eine Fehlerseite und der Hinweis „hier im Browser beitreten“ ist weg.
  Vermutet für Firefox, **in Chrome, Edge und Firefox prüfen**.
- Der Hinweis nach dem Klick bekommt einen Link „Pulse herunterladen“
  (`AppDownloadLinks`/`lib/downloads/appDownloads.ts`).

## Fehlerfälle und Texte

Nur ein 404 bedeutet „Diese Einladung gilt nicht mehr“. Alles andere hat
einen eigenen Satz:

| Situation | Erkennbar an | Text (sinngemäß) |
|---|---|---|
| unbekannt/abgelaufen/aufgebraucht | 404 | Diese Einladung gilt nicht mehr. Frag nach einem neuen Link. |
| E-Mail unbestätigt | 403 `email verification required` | Bestätige zuerst deine E-Mail-Adresse. |
| ausgeschlossen | 403 `you are banned from this server` | Du kannst dieser Community nicht beitreten. |
| Community gesperrt | 403 `community is suspended` | Diese Community ist zurzeit gesperrt. |
| Community voll | 403 `community … limit reached` | Diese Community hat keinen Platz mehr. |
| Bremse | 429 | Zu viele Versuche. Warte einen Moment. |
| Netz/Server | Netzwerkfehler, 5xx | Konnte nicht geladen werden + „Erneut versuchen“ |
| Self-Host nicht erreichbar | Fehler beim Ticket-/Sitzungsweg | Der Server ist gerade nicht erreichbar. |

Die Zuordnung liegt in `fehlertext.ts` und wird an `detail` und Status
getestet — die `detail`-Texte des Servers sind die Schnittstelle.

## Sicherheit

1. **Host-Prüfung überall gleich streng.** Heute prüft nur der Electron-
   Deep-Link streng; im Chat und im Beitrittsfeld geht `?host=` fast ungeprüft
   durch (`normalizeHostname`). Weil Python (`urlsplit`, Cloud) und der Browser
   (`new URL`) einen gebauten Host wie `evil.example\@victim.example`
   verschieden lesen, könnte das 60-s-Ticket einer echten Instanz bei einem
   fremden Server landen. Abgefedert durch die Erstkontakt-Rückfrage und die
   Registrierungspflicht der Zielinstanz, aber die Ursache ist die lasche
   Prüfung. Die abweichende Lesart ist nachgemessen (Python `urlsplit` →
   `victim.example`, `new URL` → `evil.example`), ein Angriff nicht.
2. **Kein Kontakt zu einem unbekannten Self-Host vor der Zustimmung.** Auch
   nicht für die Vorschau: der Server sähe die IP-Adresse, bevor der Nutzer
   zugestimmt hat — genau das verhindert die Erstkontakt-Rückfrage
   (`joinByInvite.ts`). Deshalb bei unbekannten Self-Hosts nie ein Name.
3. **Gleiche 404** für alle ungültigen Codes in der anonymen Vorschau, plus
   Bremse — sonst lässt sich der Code-Raum abtasten.
4. Codes stehen in der Adresse. `Referrer-Policy: strict-origin-when-cross-origin`
   (`infra/prod/security-headers.inc`) gibt an Dritte nur den Origin weiter.

## Mitgezogene Fehler im bestehenden Einladungsweg (Prüfung 2026-10-10)

- **Cloud-Einladungen immer an die Cloud.** `joinGuildByInvite` löst einen
  Code ohne Host über den aktiven Server ein, `InviteEmbed` lädt die Vorschau
  ebenso. Ist ein Self-Host aktiv, meldet beides „ungültig“. Fix: Cloud-Route
  ausdrücklich, und vor dem Navigieren `activeServer` auf die Cloud setzen.
- **`host=` an jeder Stelle der Query** (gemeinsamer Parser, s. Bausteine).
- **`?host=<cloud-hostname>`** wird als Cloud-Einladung behandelt, nicht als
  Self-Host.

## Link-Vorschau in Messengern

`web/src/app.html` hat heute keine Vorschau-Angaben; WhatsApp und Co. zeigen
nur den nackten Link. **In diesem Vorhaben:** allgemeine Open-Graph-Angaben
(Titel „Pulse“, Beschreibung, Bild) für alle Seiten. **Später:** der Name der
Community in der Vorschau — das braucht serverseitig eingesetzte Meta-Angaben
für `/invite/…`, weil die Vorschau-Abrufer kein JavaScript ausführen.

## Etappen

Jede Etappe ist einzeln auslieferbar.

1. **Web.** Seite, Karte, Dialog, gemerkte Einladung, Rückweg über Anmelden,
   Registrieren und E-Mail-Bestätigung, Fehlertexte, Chat-Links öffnen den
   Dialog, Deep-Link-Handler im Renderer, Cloud-Route-Fix, Parser und
   Host-Prüfung, allgemeine Open-Graph-Angaben. Ohne Desktop-App-Knopf, ohne
   Namen für Abgemeldete (neutrale Karte). Geht per Cron live.
2. **Server.** Anonyme Vorschau mit Bremse; die Seite zeigt Abgemeldeten
   danach den Namen.
3. **Desktop.** `deeplink.ts`, `pulse://` unter Linux und macOS anmelden,
   Version anheben, Desktop-App-Knopf mit Download-Hinweis einschalten.
4. **`/c/<handle>` angleichen.** Die öffentliche Community-Adresse bekommt
   dieselbe Karte und dieselbe gemerkte Einladung statt des automatischen
   Beitritts über `pendingAddress`. Die gemerkte Einladung kennt dafür neben
   dem Code auch eine Adresse.

## Tests

- **Unit (Node-Läufer, `web/test/*.test.ts`):** `gemerkt.ts` (Verfall, kaputte
  Einträge, fehlender Speicher), Einladungs-Parser (Host an jeder Stelle,
  Cloud-Host, Fremd-Origin), Host-Prüfung (die Fälle aus `deeplink.ts` plus
  `@`, `\`, Port), `fehlertext.ts`. Desktop: `deeplink`-Tests um „ohne Host“
  erweitern — **in die Dateiliste von `desktop`s `test:unit` eintragen** und
  die Testzahl vergleichen.
- **Backend:** anonyme Vorschau — gültig, alle 404-Fälle gleich, gesperrte
  Community, Bremse pro IP und pro Code, keine Anmeldung nötig, keine
  `guild.id`-Feld in der Antwort, `icon_url` unverändert durchgereicht.
- **E2E (Playwright), der Link wird wirklich aufgerufen:** abgemeldet öffnen
  → Karte → Anmelden → Dialog → Beitreten → in der Community; angemeldet
  öffnen → Beitreten; schon Mitglied; ungültiger Code; Klick auf einen
  Einladungslink im Chat öffnet den Dialog statt eines neuen Tabs.
- **Von Hand:** `pulse://` unter Windows, Linux (Flatpak) und macOS;
  Desktop-App-Knopf in Chrome, Edge und Firefox mit und ohne installierte
  App; Android-App-Verknüpfung am Gerät; E-Mail-Bestätigungsweg in der Cloud
  (das Tor hängt an SMTP, und `_globalSetup.ts` setzt die SMTP-Einstellungen
  für die E2E-Läufe zurück — dort ist es aus).

## Bewusst nicht drin

- **Registrierung nur auf Einladung** (`registration_mode = invite_only`):
  eine Community-Einladung zählt dort nicht als Registrierungs-Einladung, und
  „Konto erstellen“ liefe ins Leere. Die Cloud ist offen; zurückgestellt, bis
  sich das ändert.
- Name der Community in Messenger-Vorschauen (s. oben, später).
- Wer einlädt („Anna lädt dich ein“): die Vorschau kennt den Ersteller nicht,
  und die Seite ist auch ohne ihn klar.
