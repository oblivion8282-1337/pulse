# Zwei-Geräte-Test der Fernsteuerung — Aufbau (2026-08-12)

**Arbeitsanweisung für die Session auf dem Linux-Rechner** (AMD, Fedora,
`Michi-PC-3`). Geschrieben von der Windows-Session (NVIDIA, `MICHI-PC-2`), die
den Server aufgesetzt und ihre eigene Seite bereits vorbereitet hat.

Windows ist der **gesteuerte** Host, Linux der **steuernde**.

> **Kurzfassung, falls du nur eines liest:**
> ```bash
> git fetch origin && git checkout feat/windows-bruecke && git pull
> ./scripts/fern-test-linux.sh
> ```
> Danach auf `https://pulse.unicutmedia.com` registrieren, der Community
> beitreten, dem Windows-Stream **im nativen Player-Fenster** zusehen und dort
> „Fernsteuerung anfragen". Alles Weitere steht unten; §3 erklärt, warum der
> Player zwingend gebaut werden muss.

---

## 1. Was schon steht

**Eine Pulse-Testinstanz auf `https://pulse.unicutmedia.com`**, die unseren
Zweig `feat/windows-bruecke` fährt — also mit dem `remote_input`-Op, das es in
der Produktion nicht gibt.

| | |
|---|---|
| Server | Hetzner `77.42.71.166`, SSH-Kürzel `pulse-test` |
| Aufbau | `~/pulse-test/` (Compose: Postgres, Redis, auth-svc, chat-gateway, nginx) |
| Modus | `PULSE_INSTANCE_MODE=cloud` → Registrierung offen, kein Zertifikats-Login |
| Umlaufzeit von Windows | ICMP 57–62 ms, HTTPS 80 ms |

Belegt: Oberfläche 200, `/api/auth/health` grün, Registrierung 201, und ein
echter WebSocket-Handschlag über TLS endet mit `4001 unauthorized` — die
dokumentierte Antwort auf ein ungültiges Token. Die ganze Kette trägt.

**Die Bildstufe steht ebenfalls** (nachgezogen am 2026-08-12, Weg B): MediaMTX,
media-svc und mediamtx-auth-hook laufen. HQ-Streaming ist damit möglich, und der
Test läuft durch die **echte Oberfläche** — mit Bild, Anfrage-Knopf und
Zustimmungs-Dialog.

| Strecke | Stand |
|---|---|
| RTMPS-Einspeisung `pulse.unicutmedia.com:1936` | offen, von Windows aus erreichbar |
| WebRTC-ICE `:8189/udp` | offen |
| WHEP über `/whep/*` | nginx → MediaMTX → Auth-Hook, geprüft |

Belegt: eine WHEP-Anfrage ohne Token von außen endet mit **401**, und der
Auth-Hook protokolliert den Grund (`read_non_channel_path`). Die Kette
nginx → MediaMTX → Hook trägt also.

**Was weiterhin fehlt:** LiveKit (kein Voice) und MinIO (keine Anhänge). Für den
Fernsteuer-Test belanglos.

**Der MediaMTX-Messstand ist gestoppt.** Er lag auf derselben Adresse.
Rückholanleitung auf dem Server: `~/messstand-gestoppt-2026-08-12.txt`. Solange
die Testinstanz dort liegt, laufen die Messwerkzeuge in
`streaming/win-hq-labor/testbench/` nicht.

---

## 2. Ablauf des Tests

1. **Windows** registriert sich zuerst → wird Bootstrap-Admin, legt eine
   Community mit einem Sprachkanal an, vergibt `REMOTE_CONTROL` (Bit 37) an
   eine Rolle und lädt Linux ein.
2. **Windows startet einen HQ-Stream** in diesem Kanal.
3. **Linux** öffnet den Stream im **nativen Player** (nicht im Browser-Element)
   — nur dort sitzt der Anfrage-Knopf, und nur dort wird Eingabe erfasst
   (Zeigerfang, rohe Scancodes).
4. **Linux** klickt „Fernsteuerung anfragen".
5. **Windows** bekommt den Zustimmungs-Dialog und akzeptiert. Dieser Klick ist
   bewusst nicht automatisierbar.
6. Ab da bewegt Linux Maus und Tastatur des Windows-Rechners.

**Auf der Windows-Seite läuft dabei das Prüfziel**
(`streaming/win-hq-labor/testbench/eingabe-pruefziel.ps1`) über alle
Bildschirme und protokolliert jede ankommende Eingabe als JSONL — Zeitstempel,
Koordinate, Scancode, Erweitert-Kennung. Damit ist der Nachweis objektiv und
nicht „sieht gut aus".

---

## 3. Linux-Seite bauen und starten

**Ein Befehl macht alles:**

```bash
git fetch origin && git checkout feat/windows-bruecke && git pull
./scripts/fern-test-linux.sh
```

Das Skript baut den nativen Player, baut Electron und startet gegen die
Testinstanz. `--nur-bauen` lässt das Starten weg.

### Drei Dinge, die es tut — und warum jedes davon nötig ist

**1. Nativen Player bauen** (`streaming/pulse-player`, `cargo build --release`).
**Das ist Pflicht, kein Zubehör.** Die Erfassung von Maus und Tastatur passiert
IM Player-Fenster — Zeigerfang und rohe Scancodes kann ein `<video>` im Browser
nicht liefern —, und der Anfrage-Knopf hängt genau an dieser Kachel
(`NativeWindowPanel.svelte`). Fehlt das Binary, fällt die App **still** auf das
Browser-Videoelement zurück (`player.ts`: „rein additiv"), der Knopf erscheint
nie, und der Fehler sieht aus wie „die Funktion ist kaputt".

Scheitert der Bau, liegt es auf Linux fast immer an fehlenden
FFmpeg-Entwicklungspaketen; das Skript nennt die Paketnamen für Fedora und
Debian.

**2. Electron bauen** (`pnpm install && pnpm run build:electron`).

**3. Starten mit `PULSE_URL` und eigenem Datenverzeichnis:**

```bash
PULSE_URL=https://pulse.unicutmedia.com \
  npx electron . --user-data-dir=/tmp/pulse-test
```

`PULSE_URL` wirkt **nur in unverpackten Läufen** und akzeptiert nur `https://`
(`desktop/electron/main.ts`, Abschnitt `PROD_URL`). Ein Codeeingriff ist nicht
nötig. Das eigene Datenverzeichnis ist Pflicht, sonst greift die
Einzelinstanz-Sperre und es kommt bloß die vorhandene App nach vorn — nebenbei
bleiben so die echten Einstellungen unangetastet.

**Warum das ohne Änderung am Client funktioniert:** `isCloud` wird immer aus dem
Hostnamen abgeleitet und ist auf `howispulse.com` festgenagelt — aber die
WebSocket verbindet im Cloud-Fall gegen `window.location.host`, also gegen die
Adresse, von der die Seite geladen wurde (`ws/gateway-connection.ts`, Zeile 326).
Unsere Instanz liegt hinter derselben nginx-Konfiguration wie die Produktion,
der Pfad `/api/ws/ws` stimmt also.

---

## 4. Konten und Rechte

Auf der Testinstanz **registrieren** (die Oberfläche bietet es an; die Instanz
läuft im Cloud-Modus).

* **Der erste registrierte Nutzer wird Bootstrap-Admin** (`COUNT(*) == 1` in
  `auth.users`). Diesem Konto gehört die Instanz.
* `allow_guild_creation` ist per Vorgabe **aus** — nur der Admin legt
  Communities an und öffnet es unter `/admin/permissions`.
* **`REMOTE_CONTROL` ist Bit 37 und NICHT in den Vorgaberechten.** Der Admin
  muss es einer Rolle ausdrücklich geben, sonst kann niemand eine Fernsteuerung
  anfragen. Das ist die Vorabhürde; die Zustimmung je Sitzung kommt zusätzlich.

Sinnvolle Aufteilung: Windows registriert zuerst (wird Admin, legt die Community
an, lädt Linux ein und vergibt das Recht), Linux ist der Steuernde.

---

## 5. Was die Windows-Seite mitbringt

* Electron läuft dort bereits gegen die Testinstanz, mit eigenem
  Datenverzeichnis (`%LOCALAPPDATA%\PulseTest`) — die reguläre Pulse-App und
  ihre Stream-Einstellungen bleiben unangetastet.
* Der Sidecar läuft **ohne** Labor-Schalter — mit laufendem Stream gibt es ein
  echtes Quell-Rechteck, und genau dessen Auflösung soll ja mitgeprüft werden.
  (`PULSE_LABOR_EINGABE_OHNE_STREAM=1` gibt es weiterhin, aber nur für Messungen
  ohne Bild.)
* Das **Prüfziel** legt sich über alle Bildschirme, fängt jede injizierte
  Eingabe ab und protokolliert sie als JSONL — mit Zeitstempel, Koordinate,
  Scancode und Erweitert-Kennung.

Bereits ohne zweiten Rechner belegt (`streaming/testbench/profiles/fern-2026-08-12-*.json`):
Injektion trifft auf **0 px** über drei Bildschirme mit 100/125/150 Prozent
Skalierung und negativem Ursprung in beiden Achsen; Scancodes kommen
unverfälscht an; fail-closed greift; gedrückt gelassene Tasten werden beim
Sitzungsende freigegeben.

---

## 6. Die Latenz messen, ohne Uhren abzugleichen

Zwei Rechner haben nie dieselbe Uhr — ein Zeitstempel-Vergleich über die
Maschinen hinweg ist wertlos.

Weil die Bildstufe steht, gibt es die **saubere** Messung: ein **geschlossener
Kreis**, komplett auf der Linux-Seite. Tastendruck raus, Windows spielt ihn ein,
die Eingabe verändert sichtbar das Windows-Bild, und dieses Bild läuft ohnehin
als Stream zurück in den Player. Start und Stopp liegen damit auf **derselben**
Uhr. Das ist die Zahl, die Schritt 4 der Neubewertung verlangt.

Als Ziel eignet sich alles, was auf Eingabe sichtbar und schlagartig reagiert;
das Prüfziel zeichnet bei jeder Bewegung eine Marke an der Zeigerposition. Zum
Gegenrechnen: die HTTPS-Umlaufzeit Windows↔Server liegt bei 80 ms, ICMP bei
58 ms — die halbe Strecke je Richtung ist die Untergrenze für den Eingabeweg.

---

## 7. Was zurückzumelden ist

1. Ob die Linux-App die Testinstanz lädt (im Zugriffsprotokoll des Servers
   sichtbar: `docker logs pulsetest_web`).
2. Ob `remote_request` beim Windows-Rechner als Dialog ankommt.
3. Ob nach der Zustimmung Eingabe-Frames im Prüfziel-Protokoll landen — und mit
   welcher Abweichung.
4. Alles, was unterwegs nicht so war wie hier beschrieben.

---

## 8. Zusammenhang

* Neubewertung: `docs/plans/2026-08-11-fernsteuerung-neubewertung.md` (Zweig
  `docs/fernsteuerung-neubewertung`)
* Protokoll: `docs/plans/2026-08-12-input-wire-protokoll-v2.md`
* Messakten: `streaming/testbench/profiles/fern-2026-08-12-*.json`
* Die Brücke (SSH) ist **nicht** nötig: jede Seite beobachtet ihre eigene
  Maschine. `docs/plans/2026-08-11-windows-bruecke-einrichten.md` bleibt gültig,
  ist aber für diesen Test kein Vorbedingung.
