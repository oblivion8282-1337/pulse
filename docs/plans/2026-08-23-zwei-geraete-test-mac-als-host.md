# Zwei-Geräte-Test der Fernsteuerung — der Mac als Host (2026-08-23)

**Der erste Lauf, bei dem wirklich jemand einen Mac fernsteuert.**
Schritt 3 der Abnahme von `docs/superpowers/plans/2026-08-23-fernsteuerung-macos-2-der-mac-als-host.md`.

> **Kurzfassung, falls du nur eines liest:**
> Auf dem **Mac**: `./scripts/fern-test-mac.sh`
> Auf dem **Linux-Rechner**: `./scripts/fern-test-linux.sh`
> Beide auf demselben Zweig, beide gegen `https://pulse.unicutmedia.com`.
> Der Linux-Rechner sieht dem Mac-Stream im nativen Player zu und fragt dort
> „Fernsteuerung anfragen"; der Mac stimmt zu.

---

## 1. Was anders ist als beim letzten Mal

Der Aufbau vom 2026-08-12 (`docs/plans/2026-08-12-zwei-geraete-test-aufbau.md`)
hatte **Windows als gesteuerten Host und Linux als Steuernden**. Diesmal ist die
gesteuerte Seite der **Mac**. Die steuernde Seite bleibt unverändert — deshalb
ist `scripts/fern-test-linux.sh` weiterverwendbar, ohne eine Zeile zu ändern.

Neu ist damit nur die Mac-Seite, und dort neu ist alles: der Sidecar spielt zum
ersten Mal Ereignisse ein, die von einem fremden Rechner kommen.

## 2. Was schon steht

**Der gemeinsame Dev-Stack** auf dem Hetzner (`https://pulse.unicutmedia.com`)
trägt den Test. Nachgeprüft am 2026-08-23: Oberfläche 200, `/api/auth/health`
200. Er ersetzt alles ausser Vite, Electron und den nativen Programmen — beide
Rechner sehen denselben Zustand, dasselbe Konto, dieselbe Community.
Voll-Doku: `infra/dev-remote/README.md`.

**Wichtig:** Backend-Code landet dort **nicht über Git**, sondern über
`pnpm dev:sync`. Für diesen Test spielt das keine Rolle — der Gateway-Teil der
Fernsteuerung liegt seit Etappe 1 auf `main` und ist dort längst live.

## 3. Der Mac — die gesteuerte Seite

```sh
git checkout feat/fernsteuerung-2-mac-als-host && git pull
./scripts/fern-test-mac.sh
```

Das Skript baut den Sidecar, **prüft beide Systemfreigaben** und startet dann
Vite und Electron. Nur prüfen, ohne zu starten: `--nur-pruefen`.

### Die zwei Freigaben — die Stelle, an der es lautlos schiefgeht

macOS trennt, was Windows zusammenfasst:

| | Systemeinstellung | Wofür |
|---|---|---|
| Einspielen | Datenschutz & Sicherheit → **Bedienungshilfen** | `CGEventPost` — die Fremdeingabe wirkt |
| Mithören | Datenschutz & Sicherheit → **Eingabeüberwachung** | die Wache sieht, dass der Host selbst an die Tastatur geht |

**Der gefährliche Zustand ist der asymmetrische: Einspielen ja, Mithören nein.**
Dann läuft die Fernsteuerung scheinbar einwandfrei — und der Vorrang des Hosts
greift nicht. Wer vor dem Mac sitzt, tippt gegen den fremden Rechner an und
bekommt seine Maschine nicht zurück. Man sieht diesem Zustand nichts an; er
wurde erst bei der Prüfung am 2026-08-23 gefunden, vorher galt die (falsche)
Annahme, ein Abgriff scheitere ohne Bedienungshilfen-Freigabe von selbst.
Er scheitert nicht — er bekommt nur nichts.

Deshalb fragt das Skript beide ab, über denselben `health`-Op, den auch die App
benutzt, und nennt die fehlende beim Namen.

**Zwei Fallen bei der Freigabe selbst:**

* **Freigegeben wird das startende Programm, nicht der Sidecar.** Ein
  Kindprozess erbt die Freigabe (gemessen, Messung 1 der Messakte). In der
  Liste steht also „Terminal" bzw. „Pulse", nie `pulse-mac-hq-sidecar`.
* **Nach einem Update muss der Eintrag entfernt und neu gesetzt werden**, nicht
  nur der Haken neu geklickt. Die Freigabe hängt an der Code-Signatur, und das
  Mac-DMG ist nur ad-hoc signiert — jede neue Binärdatei ist für macOS ein
  anderes Programm.

## 4. Der Linux-Rechner — die steuernde Seite

```sh
git fetch && git checkout feat/fernsteuerung-2-mac-als-host && git pull
./scripts/fern-test-linux.sh
```

Unverändert gegenüber dem 2026-08-12. Das Skript baut den **nativen Player** —
das ist der Teil, der regelmässig vergessen wird. Fehlt sein Binary, fällt die
App still auf das Browser-Videoelement zurück, und dort ist der Anfrage-Knopf
gar nicht eingehängt. Der Fehler sieht dann aus wie „die Funktion ist kaputt"
und ist eine fehlende Datei.

## 5. Das Recht — sonst sieht niemand etwas

`REMOTE_CONTROL` ist **Bit 37 und steht bewusst nicht in den Vorgaberechten**.
Genau das hält die Funktion bisher unsichtbar. Auf der Testinstanz muss das
Recht einmal zugeteilt werden (Community-Einstellungen → Rollen), sonst
erscheint der Anfrage-Knopf beim Steuernden nicht — und das sieht aus wie ein
Fehler in der Fernsteuerung.

## 6. Der Ablauf

1. Mac: anmelden, in einen **Sprachkanal**, HQ-Stream starten.
2. Linux: derselbe Kanal, dem Stream **im nativen Player-Fenster** zusehen.
3. Linux: „Fernsteuerung anfragen".
4. Mac: zustimmen. Der Zustimmungsdialog erscheint auf dem Mac.
5. Steuern.

## 7. Was zu belegen ist

| | Messlatte | Woher sie kommt |
|---|---|---|
| Treffgenauigkeit | 0 px auf 8 Zielen | Windows-Labor, 2026-08-12 |
| Tastatur | Scancodes identisch | ebenda |
| Vorrang des Hosts | Mac bewegt Maus → Fremdeingabe wird 5 s verworfen | `PULSE_FERN_VORRANG_MS` |
| Alles loslassen | Sitzungsende bei gehaltener Taste → nichts bleibt unten | die Kernzusage |
| Tastentabelle | Buchstaben, Ziffern, Umschalttasten, Pfeile, F-Tasten | 104 Einträge, bisher nur gegen den SDK-Header geprüft |

**Der letzte Punkt ist der eigentliche Zweck dieses Laufs.** Die Zuordnung
Windows-Scancode → `kVK_*` ist geprüft, aber noch nie hat eine dieser 104
Zuordnungen eine echte Taste ausgelöst. Ein Linux-Steuernder schickt dieselben
Scancodes wie ein Windows-Rechner, unabhängig von seiner Tastaturbelegung —
die Strecke ist also aussagekräftig.

## 8. Was KEIN Fehler ist

Damit nichts davon als Regression gemeldet wird:

* **Cmd+Tab und Mission Control gehen nicht.** Sie werden vom WindowServer
  behandelt, nicht von einem Programm, und lassen sich per `CGEventPost` nicht
  auslösen. Dokumentiert, nicht behebbar.
* **In Passwortfeldern ist die Tastatur tot, die Maus lebt.** Solange irgendein
  Programm `EnableSecureEventInput` hält (Passwortfelder, Anmeldeschirm, viele
  Passwortverwalter), kommt kein injiziertes Tastenereignis mehr an — ohne
  Meldung.
* **Bis zu 60 s bis zum ersten Bild sind möglich**, wenn der Rückkanal klemmt:
  der Vollbild-Abstand steht auf 60 s. Über WHIP fordert ein beitretender
  Zuschauer sein erstes Vollbild selbst an; bleibt das Bild lange schwarz, ist
  der Rückkanal die erste Verdächtige, nicht die Fernsteuerung.
* **F7/F8/F9 lösen keine Medienfunktion aus**, sondern kommen als F-Tasten an —
  gemessen am 2026-08-23, auch bei Werkseinstellung der Tastatur. Die
  Medienbedeutung entsteht im Treiber für die **physische** Taste.

## 9. Offen

* **Der Labor-Schalter `PULSE_LABOR_EINGABE_OHNE_STREAM`** (Windows-Gegenstück)
  fehlt auf dem Mac noch. Mit ihm liesse sich die Treffgenauigkeit **ohne
  zweiten Rechner** messen; ohne ihn braucht Punkt 7 den vollen Aufbau.
* **Ein Mac-Prüfziel** (Vollbild-Fenster, das empfangene Ereignisse
  protokolliert) ist in Arbeit.
