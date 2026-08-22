# Übergabe: Etappen 1 und 2 auf dem Windows- und dem Linux-Rechner prüfen

> **ÜBERHOLT am 2026-08-22 — nicht mehr danach arbeiten.**
> Seither sind eine fünfte Kiste (`pulse-bildmarke`) und die Pacer-Zusammenlegung
> dazugekommen, und im Flatpak-Manifest fehlte ein Eintrag, der den Bau ohne Netz
> gebrochen hätte. Der gültige Prüfauftrag ist
> **`docs/plans/2026-08-22-uebergabe-gemeinsame-bausteine.md`**.
> Dieses Dokument bleibt als Protokoll des Zwischenstands stehen.

**Stand 2026-08-20. Zweig `feat/gemeinsame-bausteine`. Nicht gelandet — die Etappe wartet auf genau diese beiden Rückmeldungen.**

Geschrieben auf dem Mac. Der Windows- und der Linux-Sidecar bauen dort nicht (keine passende FFmpeg-Distribution, keine vendored Abhängigkeiten), und Flatpak schon gar nicht. Alles unten ist auf dem Mac **durch Lesen** geprüft und **nicht übersetzt worden**. Genau das holt ihr nach.

## Was geändert wurde, in einem Absatz

Zwei kleine Dateien lagen bisher **je dreimal** im Repo — einmal pro Sidecar. Sie liegen jetzt einmal in einer gemeinsamen Kiste, und die drei alten Dateien sind nur noch Weiterleitungen (`pub use …`). **Keine einzige Aufrufstelle wurde angefasst**: `crate::redact::redact_url(...)` und `crate::zeitbasis::…` bedeuten weiterhin dasselbe. Der Diff für eure beiden Sidecars ist entsprechend klein — 544 gelöschte, 80 neue Zeilen, verteilt auf vier Dateien plus je eine Zeile in `Cargo.toml`.

Neu: `streaming/pulse-redact` und `streaming/pulse-zeitbasis`. Beide ohne Abhängigkeiten, per Pfad eingebunden. **Kein Cargo-Workspace** — jedes Programm behält sein eigenes `Cargo.lock`, seine FFmpeg-Fassung und seine Toolchain.

## Das Einzige, was sich im Verhalten ändert: die Maskierung

Die Maskierung von Stream-Schlüsseln verhielt sich auf den drei Plattformen **verschieden**. Jede Fassung hatte eine Lücke, die die anderen nicht hatten:

| | alle Vorkommen | Groß/klein egal | Abschlusszeichen |
|---|---|---|---|
| Windows | ja | **nein** | gründlich (Leerraum, Klammern, Anführungszeichen, `,;<>\|\``) |
| Linux | ja | ja | **nur `&` und Leerzeichen** |
| macOS | **nein, nur das erste** | **nein** | **nur `&` und Leerzeichen** |

Im Klartext: Es gab Push-Adressen, bei denen ein Schlüssel auf einer Plattform maskiert wurde und auf einer anderen **im Klartext im Protokoll landete** — und Electron schreibt jede stdout-Zeile des Sidecars dauerhaft auf die Platte.

Die gemeinsame Fassung setzt die Stärken zusammen: Windows' Abschlusszeichen, Linux' Toleranz gegen Groß-/Kleinschreibung, „alle Vorkommen" von beiden. Sie fängt damit **strikt mehr als jede der drei alten**. Belegt: Die vollständigen Testkörper aller drei Altfassungen laufen gegen die neue Funktion durch. Für Windows heißt das konkret — `?Token=…` mit großem T wurde vorher **nicht** maskiert und wird es jetzt.

Es gibt eine **vierte** Fassung, `streaming/gsr-sidecar/redact.py` im Python-Sidecar (auf Linux das Auffangnetz). Sie fängt weniger als alle Rust-Fassungen und **bleibt bewusst stehen**: Der Python-Sidecar hat keine Rust-Abhängigkeiten und soll keine bekommen.

---

## Auf dem LINUX-Rechner

### 1. Baut es überhaupt?

```bash
git fetch && git checkout feat/gemeinsame-bausteine
cd streaming/linux-hq-sidecar && cargo test
```

`Cargo.lock` ist im Repo getrackt und kennt die beiden neuen Kisten **noch nicht** — der erste Bau trägt sie ein. **Committe die geänderte `Cargo.lock` mit** und meld, dass du es getan hast. (CI baut ohne `--locked`, es bricht dort also nicht; Flatpak ist der Fall, der es merkt.)

### 2. Der eigentliche Grund für diese Übergabe: der Flatpak

**Das ist der Punkt, an dem diese Etappe am ehesten scheitert, und er lässt sich nur hier prüfen.**

Der Flatpak baut mit `cargo --offline` und hängt den Sidecar per `type: dir` ein — das kopiert **ausschließlich das genannte Verzeichnis** in den Bauordner. Eine Pfad-Abhängigkeit auf `../pulse-redact` zeigte dort ins Leere, und ohne Netz gibt es kein Nachladen: Der Bau bräche. Windows und macOS bauen normal und merken davon nichts — der Fehler träfe **allein den Flatpak, und erst in CI nach dem Merge**.

Behoben in `packaging/com.howispulse.Pulse.yml` (Modul `pulse-linux-hq-sidecar`), aber **ungeprüft**: Die Geschwister-Lage aus dem Repo wird im Bauordner über `dest:` nachgebaut, damit `../pulse-redact` dort dasselbe bedeutet wie hier; der Baubefehl bekam ein `cd`, der `install`-Pfad ein Verzeichnis davor. `cargo/` bleibt an der Wurzel, wo `CARGO_HOME` (absoluter Pfad, unverändert) es erwartet.

```bash
flatpak-builder --repo=/tmp/pulse-pruef --force-clean build/flatpak packaging/com.howispulse.Pulse.yml
```

**Nicht `packaging/build.fish` nehmen** — das endet auf `--user --install` und ersetzt die installierte App.

Danach: Liegt `build/flatpak/files/bin/pulse-linux-hq-sidecar`? Wenn der Bau an einer der beiden neuen Kisten scheitert, schick die Fehlermeldung im Wortlaut — der `dest:`-Umbau ist die wahrscheinlichste Ursache, und die Pfadrechnung ist auf dem Mac nur nachgedacht, nicht ausgeführt.

**Was du NICHT tun musst:** `packaging/linux-hq-sidecar-cargo-sources.json` neu erzeugen. Beide Kisten haben keine externen Abhängigkeiten, es kommt kein Crate von crates.io hinzu. Erst eine geteilte Kiste **mit** Fremdabhängigkeiten verlangt den Generator-Lauf.

### 3. Ein echter Stream, mit Blick ins Protokoll

Streamen, dann das Sidecar-Protokoll auf Stream-Schlüssel absuchen. Die Push-Adresse taucht mehrfach auf — in der Start-Antwort, in der argv-Ausgabe, in Fehlerketten. **Jede Stelle prüfen.** Es darf nirgends ein Schlüssel im Klartext stehen.

---

## Auf dem WINDOWS-Rechner

### 1. Baut es überhaupt?

```powershell
git fetch; git checkout feat/gemeinsame-bausteine
cd streaming\win-hq-sidecar; cargo test
```

Auch hier ist `Cargo.lock` getrackt und kennt die neuen Kisten noch nicht — geänderte Datei mitcommitten und melden.

### 2. Das Labor — der Nutzer, der leicht übersehen wird

`streaming/win-hq-labor` ruft an drei Stellen `pulse_win_hq_sidecar::redact::secrets` auf. Unter Windows hieß die Funktion `secrets`, unter Linux und macOS `redact_url`. Damit das Labor nicht angefasst werden muss, bietet die Weiterleitung **beide** Namen an — `secrets` ist jetzt ein Einzeiler, der `redact_url` ruft.

```powershell
cd streaming\win-hq-labor; cargo check
```

Bricht das, ist die Weiterleitung falsch aufgesetzt. Auch `streaming/win-hq-labor/Cargo.lock` ist getrackt und kennt die neue Kiste noch nicht — ebenfalls mitcommitten und melden (leicht zu übersehen, weil es ein zweites `Cargo.lock` neben dem des Sidecars ist).

### 3. Ein echter Stream, mit Blick ins Protokoll

Wie auf Linux. **Zusätzlich hier interessant**, weil es die Verhaltensänderung ist, die Windows betrifft: Wenn du eine Adresse mit großgeschriebenem Parameternamen erzeugen kannst (`?Token=…` statt `?token=…`), muss sie jetzt maskiert werden. Vorher wurde sie es nicht.

---

## Was zurückzumelden ist

Von beiden Maschinen:

1. **Testausgabe im Wortlaut** (`cargo test`, die Ergebniszeile genügt).
2. **Hast du `Cargo.lock` mitcommittet?** (Windows: sowohl `win-hq-sidecar/Cargo.lock` als auch `win-hq-labor/Cargo.lock`.)
3. **Das Ergebnis der Protokoll-Prüfung.** Nicht „sah gut aus", sondern: Wo hast du nachgesehen, und stand irgendwo ein Schlüssel?
4. Windows zusätzlich: **baut das Labor?**
5. Linux zusätzlich: **baut der Flatpak, und liegt das Binary am erwarteten Pfad?**

Wenn etwas bricht: Fehlermeldung im Wortlaut, nicht zusammengefasst. Die beiden Kisten sind klein, und der wahrscheinlichste Fehler ist eine Pfadangabe — dafür braucht es den genauen Text.

## Was danach kommt

Etappe 3 (der WHIP-Sendeweg) ist der große Brocken: `sdp.rs` liegt **dreimal bitgleich** vor, `av1.rs` weicht zwischen Windows und Linux nur in der Position eines Kommentarblocks ab. Zusammen 2.366 überzählige Zeilen. `pacer.rs` ist der Sonderfall — die Windows-Fassung ist substanziell anders und wird einzeln geprüft, nicht mitgewunken. Etappe 4 (`zeigerbild.rs`) trifft zusätzlich den Player, **der genauso offline baut** und deshalb denselben Flatpak-Eintrag braucht.
