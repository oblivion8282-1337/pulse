# Prüfauftrag: die zusammengelegten Bausteine auf Windows und Linux

**Stand 2026-08-22. Zweig `feat/mac-bild-ton-trennung` (enthält alles). Nicht gelandet.**

**Dieses Dokument ersetzt die drei vom 2026-08-20** (`uebergabe-etappe-1-2.md`, `-3-4.md`). Die sind überholt — seither sind eine fünfte Kiste und die Pacer-Zusammenlegung dazugekommen. Arbeite nur nach diesem hier.

Geschrieben auf dem Mac. **Der Windows- und der Linux-Sidecar bauen dort nicht, Flatpak schon gar nicht.** Alles, was ihre Seite betrifft, ist durch Lesen geprüft und nie übersetzt worden. Genau das holt ihr nach.

## Was passiert ist, in drei Sätzen

Fünf Dateien lagen mehrfach im Repo — teils wortgleich, teils mit stillen Abweichungen. Sie liegen jetzt je einmal in einer gemeinsamen Kiste, und die alten Dateien sind Weiterleitungen von wenigen Zeilen. **Keine einzige Aufrufstelle wurde angefasst**: `crate::redact::…`, `crate::whip::av1::…` und so weiter bedeuten weiterhin dasselbe.

Bilanz für eure beiden Sidecars: **4.639 Zeilen weniger, 242 mehr.**

## Die fünf Kisten

| Kiste | Zeilen | wer sie nutzt |
|---|---|---|
| `pulse-redact` | 229 | alle drei Sidecars + `win-hq-labor` |
| `pulse-zeitbasis` | 188 | alle drei Sidecars |
| `pulse-whip` | 1.569 | alle drei Sidecars (`av1`, `sdp`, `h264`, `pacer`) |
| `pulse-bildmarke` | 422 | Windows- und Linux-Sidecar + Player |
| `pulse-zeigerbild` | 501 | Windows-Sidecar + Player |

**Was bewusst NICHT zusammengelegt wurde:** `whip/mod.rs` — plattformeigen, Windows trägt dort eine Bandbreiten-Schätzung, die die anderen nicht haben.

> **Nachtrag 2026-08-22 abends: der Taktgeber ist jetzt doch dabei.** Hier stand, der Windows-Pacer bleibe unangetastet, weil ungemessen sei, welcher Zuschnitt besser ist. Aufgelöst hat das nicht eine Messung, sondern die Einsicht, dass die Frage kleiner ist als sie aussah: Die beiden unterschieden sich nur bei **kleinen** Bildern (2,5 gegen 6,7 ms) — also dort, wo ein Schwall am wenigsten schadet; bei grossen Bildern waren sie ohnehin fast gleich. Kleiner ungewisser Gewinn gegen sicheren Gewinn an Wartbarkeit. Dazu kam der Befund, dass der Windows-Zuschnitt gar kein Zugeständnis an die Plattform war, sondern unabhängig aus denselben Lehren entstanden — es wurde also nichts aufgegeben. **Für Linux und macOS ändert sich dadurch nichts**, ihr Taktgeber ist derselbe wie zuvor. Begründung und Zahlen im Kopf von `streaming/pulse-whip/src/pacer.rs`.

## Das Einzige, was sein Verhalten ändert: die Maskierung

Die Maskierung von Stream-Schlüsseln verhielt sich auf den drei Plattformen **verschieden**, und jede Fassung hatte eine eigene Lücke:

| | alle Vorkommen | Groß/klein egal | Abschlusszeichen |
|---|---|---|---|
| Windows | ja | **nein** | gründlich |
| Linux | ja | ja | **nur `&` und Leerzeichen** |
| macOS | **nur das erste** | **nein** | **nur `&` und Leerzeichen** |

Es gab also Adressen, bei denen ein Schlüssel auf einer Plattform maskiert wurde und auf einer anderen **im Klartext im Protokoll landete** — und Electron schreibt jede Ausgabezeile dauerhaft auf die Platte. Die gemeinsame Fassung setzt die Stärken zusammen und fängt **strikt mehr als jede der drei**. Für Windows konkret: `?Token=…` mit großem T wurde bisher **nicht** maskiert.

Alles andere ist ein reiner Umzug ohne Verhaltensänderung.

---

## LINUX

### 1. Baut der Sidecar?

```bash
git fetch && git checkout feat/mac-bild-ton-trennung
cd streaming/linux-hq-sidecar && cargo test
```

**`Cargo.lock` mitcommitten.** Die Datei ist getrackt und kennt keine der Kisten; der erste Bau trägt sie ein.

### 2. Der Flatpak — der wichtigste Punkt, und nur hier prüfbar

Der Flatpak baut mit `cargo --offline` und hängt Module per `type: dir` ein — das kopiert **ausschließlich die genannten Verzeichnisse**. Fehlt eine Kiste, zeigt ihre Pfad-Abhängigkeit ins Leere, und ohne Netz gibt es kein Nachladen: Der Bau bricht, **nur dort, und erst in CI**.

Zwei Module sind umgebaut (`packaging/com.howispulse.Pulse.yml`):

- **`pulse-linux-hq-sidecar`** — fünf `dir`-Quellen (Sidecar plus vier Kisten), `cd` im Baubefehl, ein Verzeichnis im `install`-Pfad.
- **`pulse-player`** — dasselbe, **und hier war es heikler**: Die gepatchte webrtc-Kopie samt ihrer drei Patches musste von `vendor/webrtc-rs` auf `pulse-player/vendor/webrtc-rs` mitziehen.

```bash
flatpak-builder --repo=/tmp/pulse-pruef --force-clean build/flatpak packaging/com.howispulse.Pulse.yml
```

**Nicht `packaging/build.fish`** — das endet auf `--user --install` und ersetzt die installierte App.

Danach müssen **beide** Binärdateien liegen:
- `build/flatpak/files/bin/pulse-linux-hq-sidecar`
- `build/flatpak/files/bin/pulse-player`

Die Pfade sind auf dem Mac von Hand nachgerechnet und mit einem `cp -r`-Nachbau gegengeprüft, aber **nie ausgeführt worden**. Bricht es, schick die Fehlermeldung im Wortlaut.

**Was du NICHT tun musst:** die `*-cargo-sources.json` neu erzeugen. `pulse-whip` bringt zwar `webrtc`, `anyhow` und `tokio` mit — alle drei stehen bereits im Sidecar und sind in der Sources-Datei nachgewiesen.

### 3. Ein echter Stream

Streamen und beim Zuschauer prüfen: **Kommt ein Bild, und zwar in AV1?** Ein Umzug, der die SDP-Aushandlung beschädigt, fällt nur hier auf.

Danach das Sidecar-Protokoll auf Stream-Schlüssel absuchen — die Push-Adresse taucht mehrfach auf (Start-Antwort, argv, Fehlerketten). **Jede Stelle prüfen.**

Und eine Zeile, die neu ist und dazugehört:
```
[whip] Bildmarke ausgehandelt als extmap N
```

---

## WINDOWS

Windows trägt am meisten: **alle fünf Kisten** treffen hier zusammen.

### 1. Baut der Sidecar?

```powershell
git fetch; git checkout feat/mac-bild-ton-trennung
cd streaming\win-hq-sidecar; cargo test
```

**`Cargo.lock` mitcommitten.**

### 2. Das Labor — zwei eigene Fallen

```powershell
cd streaming\win-hq-labor; cargo check
```

Es zieht den Sidecar als Bibliothek und ist damit der Erste, der bei Sichtbarkeits-Fehlern umfällt — davon gab es sieben (Symbole, die aus der Kiste heraus sichtbar sein müssen). Ausserdem ruft es `redact::secrets`; unter Windows hiess die Funktion so, unter Linux und macOS `redact_url`. Damit das Labor unangetastet bleibt, bietet die Weiterleitung **beide** Namen an.

**`streaming/win-hq-labor/Cargo.lock` ist ein zweites, eigenes Lock** — ebenfalls getrackt, ebenfalls mitcommitten. Leicht zu übersehen.

### 3. Ein echter Stream, und zwar mit Fernsteuerung

Drei Dinge, die nur hier auffallen:

1. **AV1-Stream** zum Zuschauer — kommt ein Bild? Und steht `[whip] Bildmarke ausgehandelt als extmap N` im Protokoll?
2. **Zeigerformen über die Fernsteuerung** — fahr über ein Textfeld (I-Balken), einen Fensterrand (Grössenpfeil) und über etwas mit **selbstgemaltem** Zeiger, den Windows nicht kennt (Resolve, Premiere, Blender). Der Steuernde muss alle sehen. Das ist der Weg durch `zeigerbild.rs`, das jetzt gemeinsam mit dem Player liegt.
3. **Protokoll auf Stream-Schlüssel absuchen.** Hier besonders interessant, weil es die Verhaltensänderung ist, die Windows betrifft: Eine Adresse mit grossgeschriebenem Parameternamen (`?Token=…`) muss jetzt maskiert werden. Vorher wurde sie es nicht.

---

## Was zurückzumelden ist

Von beiden Maschinen:

1. **Testausgabe im Wortlaut** (die Ergebniszeile genügt).
2. **`Cargo.lock` mitcommittet?** (Windows: **beide** — Sidecar und Labor.)
3. **Kam beim Zuschauer ein AV1-Bild?**
4. **Stand die Bildmarken-Zeile im Protokoll?**
5. **Das Ergebnis der Protokoll-Prüfung** — nicht „sah gut aus", sondern: wo hast du nachgesehen, und stand irgendwo ein Schlüssel?

Linux zusätzlich: **baut der Flatpak, und liegen BEIDE Binärdateien?**
Windows zusätzlich: **baut das Labor?** Und: **sieht der Steuernde die Zeigerformen, auch die selbstgemalten?**

Bricht etwas: Fehlermeldung im Wortlaut, nicht zusammengefasst. Der wahrscheinlichste Fehler ist eine Pfadangabe im Flatpak-Manifest — dafür braucht es den genauen Text.

## Was auf dem Mac bereits belegt ist

Damit klar ist, was schon geprüft wurde und was nicht:

- Fünf Kisten, 72 Tests grün. Testnetz 4 Suiten. mac-Sidecar 23. **Player 388.**
- Ein echter Stream über die Produktionsleitung: **6.705 Pakete, null Verlust**, 60 Bilder/s, gemeldeter Vollbild-Abstand 60,0 s.
- Bild und Ton lippensynchron (das war das Hauptrisiko der Trennung in zwei Aufnahmen).
- `pnpm check` ohne Befund, `pnpm build` durch, 115 Web- und 181 Desktop-Unit-Tests grün.

**Nicht geprüft:** alles, was Windows und Linux betrifft, und der Flatpak-Bau. Genau dafür gibt es dieses Dokument.

---

# RÜCKMELDUNG WINDOWS — 2026-08-22

Maschine: Windows 11, AMD, zwei Schirme (1920×1080@180, 3840×2160@120), rustc 1.97.1.

## Was am Bau geprüft ist

| | Ergebnis |
|---|---|
| `win-hq-sidecar` `cargo test` | **180 grün, 0 rot**, 2 übersprungen (fragen echte Hardware ab) |
| `win-hq-labor` `cargo check` | **sauber**, 30 s — keiner der sieben Sichtbarkeits-Fehler ist zurück, `redact::secrets` löst über die Weiterleitung auf |
| Beide `Cargo.lock` | eingetragen und committet, je 32 Zeilen, **ausschliesslich** die fünf Kisten — keine fremde Version hat sich verschoben |
| Rauchtest am Binary | `health` und `list_monitors` antworten; AMD erkannt, HDR/10 Bit/AV1 verfügbar, `remote_input: true`, beide Schirme gefunden |
| Die fünf Kisten einzeln | redact 12, zeitbasis 6, whip 30 (+1 übersprungen), bildmarke 11, zeigerbild 12 — alle grün |
| Testnetz `zwillinge` | 10 grün (nach dem Fix unten) |

Die Verhaltensänderung an der Maskierung ist abgedeckt: `grossgeschriebener_parametername_wird_auch_gefasst` hält genau den Windows-Fall fest (`?Token=`).

## Zwei Befunde — beide im Testwerk, keiner im Umbau

**1. Der Flatpak-Wächter schlug auf keiner Windows-Maschine an** (behoben, `fix(zwillinge)`). Der Test vom 2026-08-22 meldete `Modul 'pulse-linux-hq-sidecar' steht nicht im Manifest` für einen Eintrag, der dort steht. Ursache: Git wandelt die Zeilenenden beim Auschecken auf Windows um (`core.autocrlf`, Vorgabe des dortigen Installers); der Test suchte byteweise nach `- name: <x>\n`. Er lief damit auf genau einer der drei Maschinen — auf dem Bauserver grün, auf jeder Windows-Maschine blind. Jetzt zeilenweise, plus ein Test auf einem gestellten Manifest in beiden Schreibweisen. Gegenprobe gefahren.

Das ist die **zweite** Zeilenenden-Falle im Repo; die erste steht im `CLAUDE.md` bei `bootstrap-windows-capture.sh`. Beide Male grün auf Linux, hart kaputt auf Windows.

**2. Der Verteilungs-Test in `pulse-whip` flatterte** (behoben, `test(pulse-whip)`). Drei Läufe: 28,0 ms rot, grün, 16,1 ms rot — bei einem Soll von 12,5 und 3 ms Toleranz. Nicht über mehr Toleranz gelöst: die müsste bei rund 20 ms liegen und wäre grösser als das Soll selbst, der alte Fehler (Ist 20,8) läge dann darin. Stattdessen unter Windows übersprungen, mit sichtbarem Grund.

**Die Ursache war zunächst falsch zugeordnet** und ist beim Zusammenlegen des Taktgebers aufgefallen: Es liegt nicht am Betriebssystem, sondern an der **Testbinärdatei**. Der ausgelieferte Sidecar hebt die Zeitgeber-Auflösung prozessweit auf 1 ms (`timeBeginPeriod(1)` in `main.rs`), der Testlauf tut das nicht — dort liegen die Wartezeiten auf dem 15,6-ms-Raster. Über die echte Leitung gemessen hält derselbe Zuschnitt sein Soll auf 0,44 ms genau. Scharf zu stellen wäre er mit demselben Aufruf im Test; das verlangt die `windows`-Kiste als Dev-Abhängigkeit einer bislang abhängigkeitsarmen Crate und ist deshalb nicht nebenbei entschieden.

## Am laufenden Stream geprüft

Mehrere Streams über den gemeinsamen Dev-Stack, Sidecar aus `target/release` des Zweigs (nicht der installierte), AMD 780M:

- [x] **AV1-Bild beim Zuschauer** — `av1_amf` offen, `Ausgabe: angemeldeter Sendeweg (nicht der Muxer)`, also der eigene WHIP-Weg aus der gemeinsamen Kiste. Bild kam an, vom Nutzer bestätigt.
- [x] **`[whip] Bildmarke ausgehandelt als extmap 1`** — bei jedem Start im Protokoll.
- [x] **Rückkanal** — „Vollbild angefordert" samt Auslieferung binnen Millisekunden, mehrfach.
- [x] **Protokoll auf Stream-Schlüssel** — an allen drei Stellen nachgesehen (eingehender Startbefehl, `argv`, `push_url`), über den ganzen Lauf **kein Schlüssel im Klartext**; ebensowenig in den 5589 Zeilen davor.
- [ ] **Zeigerformen über die Fernsteuerung** (Textfeld, Fensterrand, selbstgemalter Zeiger aus Resolve/Premiere/Blender) — **beim Abschluss der Sitzung nicht ausdrücklich einzeln bestätigt.** Wer als Nächster an einer Windows-Maschine sitzt, fährt das nach; es ist der Weg durch `pulse-zeigerbild`, und der ist sonst nirgends im Betrieb geprüft.

**Zur Reichweite der Schlüssel-Prüfung:** Auf der Platte landet nichts, aber die Maskierung, die dort greift, ist die **Electron-seitige** (`desktop/electron/sidecar-log.ts`) — es gibt zwei Schichten. Die Rust-seitige, also die mit der Verhaltensänderung, feuert nur auf Fehlerpfaden; alle Läufe waren fehlerfrei. Sie ist durch zwölf Einzeltests abgedeckt, nicht durch einen Stream. Nebenbei: Die Electron-Schicht kennt `token=` und `pass=`, aber **nicht `streamid=`** — heute folgenlos, weil nur WHIP benutzt wird.

## Ein dritter Befund, ebenfalls behoben

`pulse-bildmarke` fehlte in den **Pfad-Filtern aller drei Bau-Abläufe** (`win-build.yml`, `mac-build.yml`, `flatpak.yml` nannten nur die vier älteren Kisten) und in der Version-Bump-Aufzählung im `CLAUDE.md`. Folge: Eine Änderung allein an dieser Kiste hätte weder Installer noch DMG noch Flatpak neu gebaut, das Ausgelieferte wäre still auf dem alten Stand geblieben.

Das ist die unangenehmere Hälfte derselben Falle, die der Wächter fürs Flatpak-Manifest abfängt: **dort bricht der Bau, hier bricht gar nichts.** Kein Knall, keine rote CI — der Bau läuft einfach nicht.

Eingetragen, und daneben ein zweiter Wächter (`streaming/zwillinge/tests/bau_ausloeser.rs`), der je Ablauf nachrechnet, welche Kisten die Programme brauchen, die er baut. Rekursiv, und geprüft wird nur die Richtung, die weh tut — ein Eintrag zu viel kostet einen unnötigen Bau, einer zu wenig liefert alten Code aus. Gegenprobe gefahren. Die Abhängigkeits-Rechnung liegt jetzt einmal in `zwillinge::kisten_von` und wird von beiden Wächtern benutzt.

**Für Linux heisst das:** `packaging/com.howispulse.Pulse.yml` ist unverändert — der Flatpak-Teil des Auftrags oben steht genau so weiter offen.

---

# WAS LINUX NOCH ZU TUN HAT

Der LINUX-Abschnitt oben gilt unverändert. Seit er geschrieben wurde, ist auf der Windows-Maschine allerdings etwas dazugekommen, das Linux mitbetrifft:

**Der Taktgeber ist jetzt bei allen dreien derselbe** (s. Nachtrag oben). Für Linux ändert sich am Verhalten **nichts** — es fährt schon seit dem 2026-08-22 vormittags den gemeinsamen, und dessen Rechnung ist unangetastet. Geändert haben sich nur der Modulkopf, ein Test-Attribut und die Doku. Trotzdem gehört der Linux-Bau danach einmal durchgelassen, weil `pulse-whip` angefasst wurde.

Damit sind es für Linux drei Dinge:

1. **`cd streaming/linux-hq-sidecar && cargo test`** — und `Cargo.lock` mitcommitten (kennt die Kisten noch nicht).
2. **Der Flatpak-Bau** — der wichtigste Punkt, und nur dort prüfbar. Danach müssen BEIDE Binärdateien liegen. Der Wächter `streaming/zwillinge/tests/flatpak_kisten.rs` rechnet die Manifest-Einträge zwar nach, aber er ersetzt den Bau nicht: Er prüft, ob jede Kiste GENANNT ist, nicht ob der Bau durchläuft.
3. **Ein echter Stream** mit AV1-Bild beim Zuschauer, der Bildmarken-Zeile im Protokoll und der Schlüssel-Prüfung.

**Was Linux NICHT nachholen muss:** die beiden Test-Befunde von Windows (Zeilenenden, flatternder Verteilungs-Test). Beide waren Windows-eigen und sind behoben; auf Linux waren sie ohnehin grün.
