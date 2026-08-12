# Zwei-Geräte-Test der Fernsteuerung — Aufbau (2026-08-12)

**Arbeitsanweisung für die Session auf dem Linux-Rechner** (AMD, Fedora,
`Michi-PC-3`). Geschrieben von der Windows-Session (NVIDIA, `MICHI-PC-2`), die
den Server aufgesetzt und ihre eigene Seite bereits vorbereitet hat.

Windows ist der **gesteuerte** Host, Linux der **steuernde**.

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

**Was bewusst FEHLT:** media-svc, mediamtx-auth-hook, MediaMTX, LiveKit, MinIO.
Es gibt also **kein HQ-Streaming und kein Bild**. Absicht: zuerst die eine Zahl
messen, die fehlt — die Laufzeit des Eingabewegs über das echte Internet. Die
Bildstrecke ist über denselben Server längst mit 59 ms gemessen.

**Der MediaMTX-Messstand ist dafür gestoppt.** Er lag auf derselben Adresse.
Rückholanleitung auf dem Server: `~/messstand-gestoppt-2026-08-12.txt`. Solange
er steht, laufen die Messwerkzeuge in `streaming/win-hq-labor/testbench/` nicht.

---

## 2. Das Hindernis — bitte zuerst lesen

**Der Anfrage-Knopf ist über die Oberfläche nicht erreichbar, solange kein Bild
läuft.** Er sitzt in der Kachel des nativen Player-Fensters
(`web/src/lib/player/components/NativeWindowPanel.svelte`), und die gibt es nur,
während man einem Streamer im Player zusieht. Ohne HQ-Streaming gibt es keinen
Player und damit keinen Knopf.

Der **Zustimmungs-Dialog** beim Host hängt dagegen global in
`routes/app/+layout.svelte` — der erscheint also sehr wohl.

Daraus folgen zwei Wege, und die Entscheidung gehört dem User:

**Weg A — Eingabeweg messen, ohne Bild.** Ein kleines Skript auf der
Linux-Seite öffnet die WebSocket zur Testinstanz, sendet `remote_request`, der
Mensch am Windows-Rechner klickt die Zustimmung, danach schickt das Skript
Eingabe-Frames. Auf der Windows-Seite fängt das Prüfziel
(`streaming/win-hq-labor/testbench/eingabe-pruefziel.ps1`) auf, was ankommt.
Damit ist die Laufzeit des Eingabewegs über das Internet gemessen. Kein Bild,
keine Oberfläche auf der steuernden Seite.

**Weg B — die Bildstufe nachziehen.** media-svc, mediamtx-auth-hook und
MediaMTX dazustellen. Dann läuft der Test durch die echte Oberfläche, mit Bild,
Knopf und allem. Deutlich mehr Aufbau, und MediaMTX müsste sich die Adresse mit
der Instanz teilen.

Empfehlung der Windows-Seite: **A zuerst.** Trägt der Eingabeweg nicht, ist B
hinfällig.

---

## 3. Linux-Seite starten

```bash
cd ~/…/pulse
git fetch && git checkout feat/windows-bruecke && git pull
pnpm install                      # falls noch nicht geschehen
cd desktop && pnpm run build:electron
```

Starten — **mit eigenem Datenverzeichnis**, sonst greift die
Einzelinstanz-Sperre und es kommt nur die vorhandene App nach vorn:

```bash
PULSE_URL=https://pulse.unicutmedia.com \
  npx electron . --user-data-dir=/tmp/pulse-test
```

`PULSE_URL` wirkt **nur in unverpackten Läufen** und akzeptiert nur `https://`
(`desktop/electron/main.ts`, Zeile ~199). Ein Codeeingriff ist nicht nötig.

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
* Der Sidecar wird mit `PULSE_LABOR_EINGABE_OHNE_STREAM=1` gefahren. Ohne
  laufenden Stream gibt es kein Quell-Rechteck; der Schalter nimmt dann einen
  Bildschirm. **Kein Produktweg**, nur damit sich ohne Bild überhaupt messen
  lässt.
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

**Für Weg A** (ohne Bild) ist die ehrliche Zahl: Absendezeit auf der
Linux-Seite gegen die Ankunft im Prüfziel-Protokoll, **beide Uhren getrennt
notiert**, und die Differenz nur als Größenordnung gelesen. Belastbarer ist die
halbe HTTPS-Umlaufzeit zum Server als Untergrenze (rund 40 ms je Richtung von
Windows aus).

**Für Weg B** (mit Bild) gibt es die saubere Messung: ein **geschlossener
Kreis**, komplett auf der Linux-Seite. Tastendruck raus, Windows spielt ihn ein,
die Eingabe verändert sichtbar das Windows-Bild, und dieses Bild läuft ohnehin
als Stream zurück. Start und Stopp liegen auf derselben Uhr. Das ist die Zahl,
die Schritt 4 der Neubewertung verlangt.

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
