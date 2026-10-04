# Morgentest 2026-10-05 — Mobile-Merge + Anruf-Fixes + Archiv

> Nachtarbeit vom 04.10. auf Zweig `merge/mobile-2026-10` — **nichts nach
> main gemergt**, kein PR. Alles liegt committed + gepusht auf dem Zweig.
> Diese Anleitung ist für dich (Michael) geschrieben: Schritt für Schritt,
> ohne Vorkenntnisse. Was du brauchst: den Browser unter
> **http://localhost:5173**.

---

## 0. Vorbereitung (einmal)

Der Dev-Stack läuft seit der Nacht; läuft er beim Aufwachen noch, kannst du
direkt bei 1 beginnen. Falls die Seite nicht lädt:

```
cd ~/Dokumente/pulse
./scripts/dev-up.fish
```

(startet im Vordergrund und dauert ein paar Minuten — das Fenster einfach
stehen lassen, während du im Browser testest)

**Wichtig, einmalig:** dein bisheriger Browser-Login ist älter als das
Archiv-Feature. Bitte melde dich **einmal ab und wieder an** (Avatar oben
rechts → Abmelden), bevor du Tests zum Archiv machst. Bei der Anmeldung
wird der Archiv-Schlüssel deines Kontos angelegt.

---

## 1. Anrufe (die großen Fixes aus der Übergabe)

Zwei Konten, zwei Browserfenster (normales Fenster + **privates Fenster**,
dort mit dem zweiten Testkonto anmelden).

| # | Was tun | Was passieren muss |
|---|---------|--------------------|
| 1.1 | In einer DM auf den Anruf-Knopf, im anderen Fenster annehmen, etwas reden, dann auflegen | Anruf verbindet, Dauer läuft, beim Auflegen erscheint eine Systemzeile mit Dauer |
| 1.2 | **Annehmen-Knopf schnell zweimal antippen** | KEIN Echo/Dröhnung, es verbindet nur einmal |
| 1.3 | Gruppenanruf in einer privaten Gruppe: zwei Mitglieder treten bei, **eines legt auf** | Der andere bleibt verbunden — der Anruf endet NICHT für alle |
| 1.4 | Anruf laufen lassen und im anderen Fenster das **WLAN kurz aus/ein** schalten (oder Netzwerk-Profil wechseln) | Statt eines toten Overlay-Fensters erscheint „Anruf beendet — Verbindung verloren" und räumt auf |
| 1.5 | Sechs Anrufe hintereinander schnell starten | Der sechste wird abgewiesen (Rate-Limit, Schutz vor Klingel-Spam) |

*Dauer-Killer aus der Übergabe (Zweitgerät legt nach 45 s auf) — der
passiert nur mit zwei Geräten desselben Kontos (z. B. Handy + PC). Falls
du das Handy nebenbei hast: dort klingeln lassen, am PC annehmen, Handy
liegen lassen → nach 45 s darf der Anruf am PC WEITERLAUFEN.*

## 2. Chat-Scroll (dein offenes Problem + das Desktop-Blitzen)

| # | Was tun | Was passieren muss |
|---|---------|--------------------|
| 2.1 | Mehrere Kanäle nacheinander öffnen (Desktop-Browser) | KEIN Lade-Spinner blitzt mehr bei jedem Öffnen — der Verlauf steht einfach da |
| 2.2 | Einen langen Kanal öffnen und ans Ende schauen | Die letzte Nachricht sitzt sauber am Ende — keine „2 Nachrichtenhöhen Luft" mehr darunter (dein offenes Problem, very likely mitgefixt) |
| 2.3 | Sofort nach dem Öffnen nach unten scrollen | Nichts scrollt ins Leere; maximal 30 px Luft unter der letzten Nachricht |

## 3. Das neue Archiv („überall der exakte Verlauf")

Das Archiv speichert deine DM-Texte **verschlüsselt** 120 Tage beim Server.
Zweck: auf einem frischen Gerät (oder nach Neuinstallation) kommt der
Verlauf zurück — sofern er dort noch nie war.

| # | Was tun | Was passieren muss |
|---|---------|--------------------|
| 3.1 | In einer verschlüsselten DM ein paar Nachrichten schreiben (wie gewohnt) | nichts Besonderes sichtbar — der Server bekommt davon nur Chiffre |
| 3.2 | **Privates Fenster** öffnen (frisches Gerät simulieren), mit DEMSELBEN Konto anmelden (Bitte ab- und wieder anmelden, s. Vorbereitung — in diesem Fenster zählt der Login dort), die DM öffnen | Nach einem Moment erscheint der Verlauf — aus dem Archiv, obwohl dieses Fenster ihn nie lokal hatte |
| 3.3 | Passwort ändern (Einstellungen → Passwort), danach im privaten Fenster wieder öffnen | Archiv bleibt lesbar — der Passwortwechsel verliert nichts |
| 3.4 | (Optional, der harte Beweis) Passwort per „Passwort vergessen"-Mail zurücksetzen | Archiv bleibt danach ebenfalls lesbar — genau dafür ist der doppelte Schlüssel gebaut |

Was das Archiv (noch) NICHT tut, bewusst: keine Anhänge speichern (die
bleiben Durchlauferhitzer), keine Gruppen-Verläufe, kein Rückblick auf
Nachrichten, die VOR der Einrichtung gesendet wurden.

## 4. Wenn etwas hakt

- Seite lädt nicht: Stack oben starten (§0).
- „Nach dem Login kommt im privaten Fenster kein Verlauf": die Anmeldung
  in DEM Fenster muss NACH dem Senden der Nachrichten passiert sein — sonst
  once mehr ab- und anmelden.
- Alles andere: notieren (was getan, was gesehen) — ich schaue es mir an.

## Stand der Nacht (Kurzfassung)

- Übergabedokument §3 (7 Anruf-Befunde): **alle gefixt**, Server- und
  Klientenseite, mit Tests.
- §4 Desktop-Tuning: Lade-Spinner nur noch am Handy; Overscroll-E2E auf den
  neuen Mechanismus umgebaut (der alte prüfte ein entfernten Mechanismus und
  war dauerhaft rot).
- §5 Archiv: Server (2 Migrationen, Routen, Sweeper, Reset-Weg), Klient
  (Schlüssel, Senden, Lesen, Passwortwechsel), Probe-Tests grün.
- Nächster Schritt nach deinem Test: dein GO, dann PR (der Merge-Zweig
  enthält auch die Archiv-Commits; falls du das Archiv separat im PR haben
  willst, sag Bescheid — lässt sich abtrennen).
