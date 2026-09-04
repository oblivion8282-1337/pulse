# Fernsteuerung — weitere Eingabegeräte (Controller, Blackmagic Speed Editor)

Stand 2026-09-05. Ergebnis eines Machbarkeits-Gesprächs, **nichts davon ist
gebaut**. Wer das Thema aufnimmt, liest zuerst `docs/fernsteuerung.md` und
`docs/plans/2026-08-12-input-wire-protokoll-v2.md`.

## Die Frage

Kann die Fernsteuerung ausser Maus und Tastatur auch andere Eingabegeräte
tragen — konkret einen Spiele-Controller und den Blackmagic Speed Editor für
DaVinci Resolve? Vorgabe des Eigentümers: **allgemeingültig für Windows- und
Mac-Hosts, und der Host-Nutzer soll keinen Treiber installieren müssen.**

## Wie die Fernsteuerung heute gebaut ist — drei Stationen

Jedes neue Gerät muss durch alle drei.

1. **Lesen.** Der native Player (`streaming/pulse-player/`) fängt Maus und
   Tastatur **in seinem Fenster** ab; Electron bündelt sie zu
   `remote_input`-Nachrichten (`desktop/electron/remoteInput.ts`), der Renderer
   setzt sie ab (`web/src/lib/remote/playerInput.ts`).
2. **Leitung.** Genau sechs Frame-Arten: Hello, MouseMoveAbs, MouseMoveRel,
   MouseButton, MouseWheel, Key (`pulse-fernsteuerung/src/rahmen.rs`). Feste
   Längen; **unbekannter Opcode beendet die Sitzung** (fail-closed, Absicht).
   Der Gateway parst Frames nicht, begrenzt nur ≤32 Frames / ≤1024 Byte je
   Nachricht. Das Hello ist eine Einbahnstrasse — der Host antwortet nicht,
   eine Fähigkeitsabsprache müsste ausserhalb des Frame-Kanals laufen.
3. **Abspielen.** Der Host feuert die Frames über die eingebaute
   Betriebssystem-Schnittstelle ab (`SendInput` / `CGEvent`) — „tu so, als
   hätte ein Mensch getippt". `pulse-fernsteuerung/src/plattform.rs::Injektor`
   kennt nur Maus und Tasten.

## Die Systemregel, an der „einfach anstecken" hängt

Ein normales Programm darf so tun, als **tippe** ein Mensch. Es darf **kein
Gerät erfinden**. „Hier steckt ein Speed Editor" darf auf Windows und macOS nur
der Betriebssystemkern behaupten, und wer dem Kern das beibringt, braucht einen
Treiber — auf Windows zusätzlich von Microsoft gegengezeichnet, auf macOS eine
DriverKit-Erweiterung, für die Apple erst eine Berechtigung erteilen muss und
die der Nutzer in den Systemeinstellungen eigenhändig freischaltet.

**Warum der Speed Editor lokal trotzdem ohne Treiber läuft:** Beim Anstecken
passiert etwas Physisches — das Gerät meldet sich am USB-Anschluss als
HID-Gerät, und dafür bringen Windows und macOS die Treiber mit. Dieser Treiber
reagiert aber nur auf Geräte **am Kabel**. Am fernen Rechner hängt am Anschluss
nichts; das „unsichtbare Kabel" ist es, das den Treiber braucht, nicht das
Gerät. Bild: eine Klingel funktioniert ohne Zutun am eigenen Haus — soll sie in
einem *anderen* Haus läuten, braucht das andere Haus eine Empfangsbox an
seiner Leitung.

**Linux ist die Ausnahme:** `/dev/uhid` erlaubt einem Programm, ein HID-Gerät
anzumelden, ohne dass etwas installiert wird. Für Linux-Hosts wäre der
treiberlose Weg real. Er hilft der Vorgabe (Windows + Mac) nicht.

## Was das für die beiden Geräte heisst

| | Windows-Host | Mac-Host |
|---|---|---|
| Übersetzung auf Tastendrücke (Weg A) | ja | ja |
| Controller als echtes Gerät | nur mit mitgeliefertem Fremdtreiber (ViGEmBus — vom Autor eingestellt, Nachfolger und Lizenz vor einer Entscheidung prüfen) | Apple-Berechtigung + Freischaltung durch den Nutzer |
| Speed Editor als echtes Gerät | Eigenbau-Kerntreiber (nichts Fertiges) | Eigenbau + Apple-Berechtigung |

**„Allgemeingültig" und „echtes Gerät drüben" schliessen sich aus.** Weg A ist
nicht die Notlösung, sondern die einzige, die der Vorgabe entspricht.

Zwei Dinge, die Weg A nicht kann und die man wissen muss:

* **Resolve liest den Speed Editor nicht als Tastatur.** Es spricht direkt mit
  dem USB-Gerät, mit Echtheitsprüfung (s. u.). Eine nachgebaute Tastatur am
  Host weckt die Speed-Editor-Funktionen in Resolve nicht — Weg A liefert
  stattdessen die Resolve-*Tastenkürzel*, die für fast alles auf der Cut-Page
  existieren. Das stufenlose Jog-/Shuttle-Rad hat kein Tastatur-Gegenstück;
  Ersatz sind Einzelbild-Schritte je Raste und die J/K/L-Stufen.
* **Spiele, die ausschliesslich XInput lesen**, bleiben aussen vor.

Ein Sicherheitspunkt für den Fall, dass doch einmal ein echter Controller-Weg
gebaut wird: die heutige Zusage „du kannst nur dorthin klicken, wo du
hinsehen darfst" (`ausfuehrung.rs`) hängt an Koordinaten. Controller-Frames
haben keine — die Zusage bekäme für diesen Weg eine andere Form, die man
bewusst festlegen muss.

## Was es draussen schon gibt (recherchiert 2026-09-05)

### „Echtes Gerät drüben" — gelöst, aber ausnahmslos mit Treiber

* Coloristen steuern ferne Resolve-Arbeitsplätze mit **Parsec** und nehmen
  Bedienpulte per **VirtualHere** (USB-Tunnel) mit:
  <https://mixinglight.com/color-grading-tutorials/parsec-virtualhere-remote-color-grading/>.
  VirtualHere installiert auf dem empfangenden Rechner einen Kerntreiber; auf
  dem Mac Freischaltung in den Sicherheitseinstellungen **plus Neustart**
  (<https://www.virtualhere.com/node/2723>,
  <https://www.virtualhere.com/client_configuration_faq>).
* Parsec bringt für Controller einen eigenen Kerntreiber mit (PVUD, dokumentiert
  unter <https://github.com/nomi-san/parsec-vusb/tree/main/>) und braucht dafür
  Systemrechte
  (<https://support.parsec.app/hc/en-us/articles/32381705301908-Setup-Gamepad>).
  Rückfall ist ViGEmBus.
* Im Blackmagic-Forum berichten Nutzer, dass der Speed Editor über Parsec
  **nicht** mitkommt — Parsec reicht nur Standardgeräte durch
  (<https://forum.blackmagicdesign.com/viewtopic.php?f=21&t=157501>).
* Kommerzielle „ohne Treiber"-Anbieter (FlexiHub, USB over Network) meinen die
  *Geräte*-Treiber; ihre Empfangsbox installieren sie trotzdem.
* Für macOS gibt es kein USB/IP; das freie `usb-lan` weicht deshalb genau auf
  Ereignis-Injektion aus — also auf Weg A
  (<https://github.com/peiqinzhao/usb-lan>).

### Bausteine für Weg A — die Begrüssung ist entschlüsselt

Der Speed Editor gibt seine Knöpfe erst nach einem Challenge-Response-Handschlag
her und verlangt ihn alle paar Minuten erneut. Sylvain Munaut hat ihn
entschlüsselt und unter **Apache 2.0** veröffentlicht — passt zur
Lizenzpolitik (keine GPL):
<https://github.com/smunaut/blackmagic-misc/blob/master/bmd.py>.

Darauf aufbauend:

* **Rust:** `bmd-speededitor` (<https://docs.rs/bmd-speededitor/>,
  <https://github.com/camikura/bmd-speededitor-rs>) — Sprache des Players.
  **Lizenz vor Gebrauch prüfen.**
* **Fertiges Programm, Windows + Mac:** Unbound Editor Device Customizer
  (<https://github.com/PuzzleEmptyM/blackmagic-speed-editor-customizer>) —
  liest per `hidapi`, erledigt und erneuert den Handschlag, übersetzt jeden
  Knopf in beliebige Tastendrücke. Lizenz nicht ausgewiesen; als Beleg, dass
  der Weg funktioniert, reicht es — als Abhängigkeit nicht.
* Weitere Belege: Go-Client
  <https://github.com/JamesBalazs/speed-editor-client>, C#-Wrapper
  <https://github.com/tractusevents/Tractus.Hid.DaVinciSpeedEditor>,
  Hardware-Nachbau <https://github.com/KipJM/blackmacro-lib>.

## Empfehlung

1. **Erst der Nullkosten-Versuch.** Unbound Customizer auf dem steuernden
   Rechner laufen lassen, Knöpfe auf Resolve-Kürzel legen, Pulse-Player-Fenster
   in den Vordergrund: die Tastendrücke landen im Player und gehen über die
   **bestehende** Fernsteuerung. Das beantwortet in einem Nachmittag, ob sich
   Weg A gut anfühlt — insbesondere, ob das Rad als Schrittgeber taugt. Offen:
   ob das Programm das Rad überhaupt in Tastendrücke wandelt.
2. **Fühlt es sich gut an:** Weg A in Pulse einbauen (Erfassung im Player über
   `hidapi` + Handschlag, Zuordnungstabellen, Einstellungen; Controller über
   die Gamepad-Schnittstelle gleich mit). Kein Host-Umbau, keine
   Protokolländerung. **Architektur-Vorhaben** — Entwurf vor dem Bau.
3. **Nicht anfangen:** Eigenbau-Kerntreiber für den Speed Editor. Andere Liga
   als alles, was Pulse enthält (Signierungskonto, Haftung, ein Absturz reisst
   den Rechner mit) — und er verletzte die Vorgabe „kein Treiber" ohnehin.
