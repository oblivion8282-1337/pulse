# Übergabe: Etappen 3 und 4 auf dem Windows- und dem Linux-Rechner prüfen

**Stand 2026-08-20. Zweig `feat/gemeinsame-bausteine`. Nicht gelandet.**

Zweiter Teil der Übergabe; der erste ist `docs/plans/2026-08-20-uebergabe-etappe-1-2.md`. **Beide gehören zusammen** — dieselben Maschinen, derselbe Zweig, ein Durchgang. Wenn du beides an einem Stück machst, prüf zuerst das andere Dokument, dann dieses.

Geschrieben auf dem Mac. Der Windows-Sidecar baut dort nicht, Flatpak ebenso wenig. Der **Player baut auf dem Mac** — seine 381 Tests sind gelaufen und grün.

## Was diese beiden Etappen geändert haben

**Etappe 3** zieht die zwei Dateien des WHIP-Sendewegs zusammen, die in allen drei Sidecars gleich waren: `av1.rs` (RTP-Paketierung von AV1, 791 Zeilen) und `sdp.rs` (SDP-Aushandlung, 392 Zeilen). `sdp.rs` lag **dreimal bitgleich** vor; `av1.rs` unterschied sich zwischen Windows und Linux nur in der **Position** eines Doc-Kommentarblocks. Beide liegen jetzt in `streaming/pulse-whip`.

**Etappe 4** zieht `zeigerbild.rs` zusammen (499 Zeilen, das Format für Mauszeiger-Bilder vom Sidecar zum Player). Es lag **bitgleich** in `win-hq-sidecar` und `pulse-player` und hat keine einzige Abhängigkeit. Jetzt in `streaming/pulse-zeigerbild`.

**Kein Verhalten ändert sich.** Anders als bei der Maskierung in Etappe 1 ist das hier ein reiner Umzug. Die alten Dateien sind Weiterleitungen, keine Aufrufstelle wurde angefasst.

**Eine Ausnahme, und sie ist gemeldet, nicht versteckt:** Sieben Symbole mussten von `pub(super)` auf `pub` erweitert werden (`SpurZustand` samt drei Methoden in `av1.rs`, dazu `codec_capability`, `baue_api`, `opus_capability` in `sdp.rs`). Grund: In der neuen Kiste liegen sie an der Wurzel, wo `pub(super)` faktisch „nur innerhalb dieser Kiste" bedeutet — die Sidecars sähen sie dann nicht mehr. Jede der sieben wurde einzeln nachgeprüft und wird tatsächlich von allen drei Sidecars gerufen. Eine achte (`register_codecs`) wird nicht von aussen gebraucht und ist korrekt intern geblieben.

## Was `pacer.rs` angeht: das ist kein Versehen

`streaming/*/src/whip/pacer.rs` liegt weiterhin dreifach vor und wurde **bewusst nicht** mitgezogen. Der Linux-Modulkopf sagt es selbst:

> Die Windows-Schwester weicht bewusst ab […] gleiches Prinzip, anderer Zuschnitt […] Wer einen Pacer-Fehler behebt, sieht sich BEIDE an.

Beide wurden am 2026-08-13/14 unabhängig neu gebaut, nachdem ein erster Versuch messbar gescheitert war, und beide zogen dieselben zwei Lehren. Sie unterscheiden sich im Zuschnitt des Sendefensters: Linux' Fenster wächst mit der Paketzahl (ein Zwei-Paket-Bild bekommt keine künstliche Latenz), Windows teilt Fenster und Gruppen anders auf. **Welcher Zuschnitt besser ist, ist nicht gemessen** — die Gegenmessung über die echte Leitung steht laut beiden Modulköpfen noch aus.

Sie zusammenzulegen hiesse, unter Unwissen eine inhaltliche Entscheidung zu treffen und sie als Aufräumarbeit auszugeben. Das gehört in ein eigenes Vorhaben — mit Messungen auf genau den beiden Maschinen, an denen ihr sitzt.

**Damit sind `mod.rs` und `pacer.rs` die letzten Dateien des Sendewegs, die je Plattform doppelt vorliegen, und keine davon ist von einem Test bewacht.** Das steht jetzt in beiden Modulköpfen; vorher war es nur implizit.

---

## Auf dem LINUX-Rechner

### 1. Baut der Sidecar?

```bash
git fetch && git checkout feat/gemeinsame-bausteine
cd streaming/linux-hq-sidecar && cargo test
```

**`Cargo.lock` mitcommitten.** Die Datei ist getrackt und kennt jetzt **keine** der vier neuen Kisten (`pulse-redact`, `pulse-zeitbasis`, `pulse-whip`, `pulse-zeigerbild` — letztere betrifft Linux nicht). Der erste Bau trägt sie ein. Meld ausdrücklich, dass du es getan hast.

### 2. Der Flatpak — der eigentliche Grund für diese Übergabe

**Das ist die Stelle, an der beide Etappen am ehesten scheitern, und sie lässt sich nur hier prüfen.**

Der Flatpak baut mit `cargo --offline` und hängt Module per `type: dir` ein — das kopiert **ausschliesslich das genannte Verzeichnis**. Ohne eigenen Eintrag je geteilter Kiste zeigt `../pulse-whip` im Bauordner ins Leere, und ohne Netz gibt es kein Nachladen. **Zwei Module sind umgebaut:**

- **`pulse-linux-hq-sidecar`** — vier `type: dir`-Quellen (Sidecar plus die drei Kisten, die er braucht), `cd` im Baubefehl, ein Verzeichnis im `install`-Pfad.
- **`pulse-player`** — derselbe Umbau, **und hier war er grösser**: Die gepatchte webrtc-Kopie und ihre drei Patches mussten von `vendor/webrtc-rs` auf `pulse-player/vendor/webrtc-rs` mitziehen, sonst landen sie neben dem Player statt darin.

```bash
flatpak-builder --repo=/tmp/pulse-pruef --force-clean build/flatpak packaging/com.howispulse.Pulse.yml
```

**Nicht `packaging/build.fish` nehmen** — das endet auf `--user --install` und ersetzt die installierte App.

Danach müssen **beide** Binärdateien liegen:
- `build/flatpak/files/bin/pulse-linux-hq-sidecar`
- `build/flatpak/files/bin/pulse-player`

Die Pfadrechnung ist auf dem Mac von Hand nachvollzogen und mit einem `cp -r`-Nachbau der Verzeichnisstruktur gegengeprüft, aber **nie ausgeführt worden**. Bricht der Bau, schick die Fehlermeldung im Wortlaut — der `dest:`-Umbau ist die wahrscheinlichste Ursache, und beim Player besonders der webrtc-Umzug.

**Was du NICHT tun musst:** die beiden `*-cargo-sources.json` neu erzeugen. `pulse-whip` bringt zwar Abhängigkeiten mit (`webrtc`, `anyhow`), aber beide stehen bereits in den Sidecars und sind in `packaging/linux-hq-sidecar-cargo-sources.json` nachgewiesen vorhanden. Die anderen drei Kisten haben gar keine.

### 3. Ein echter Stream

Streamen und beim Zuschauer nachsehen. **Kommt ein Bild, und zwar in AV1?** Das ist der Zweck der beiden verschobenen Dateien; ein Umzug, der die SDP-Aushandlung beschädigt, fällt nur hier auf und nirgends im Test.

---

## Auf dem WINDOWS-Rechner

### 1. Baut der Sidecar?

```powershell
git fetch; git checkout feat/gemeinsame-bausteine
cd streaming\win-hq-sidecar; cargo test
```

**`Cargo.lock` mitcommitten**, kennt jetzt alle vier Kisten nicht.

Windows ist der einzige Rechner, auf dem **beide** Etappen zusammentreffen: Der Sidecar hängt an `pulse-whip` **und** an `pulse-zeigerbild`.

### 2. Das Labor

```powershell
cd streaming\win-hq-labor; cargo check
```

Es zieht den Sidecar als Bibliothek und ist damit der Nutzer, der bei Sichtbarkeits-Fehlern zuerst umfällt — genau der Punkt, an dem sieben Symbole erweitert wurden. Auch `streaming/win-hq-labor/Cargo.lock` ist getrackt und kennt die vier Kisten noch nicht — separat von `win-hq-sidecar/Cargo.lock` mitcommitten und melden.

### 3. Ein echter Stream, und zwar mit Fernsteuerung

Zwei Dinge, die nur hier auffallen:

1. **AV1-Stream zum Zuschauer** — kommt ein Bild? (Etappe 3)
2. **Fernsteuerung mit Zeigerformen** — fahr mit der Maus über etwas, das den Zeiger wechselt (Textfeld → I-Balken, Fensterrand → Grössenpfeil), und über etwas mit einem **selbstgemalten** Zeiger, den Windows nicht kennt (Resolve, Premiere, Blender). Der Steuernde muss beide sehen. Das ist der Weg, der durch `zeigerbild.rs` läuft (Etappe 4) — und die Datei liegt jetzt gemeinsam mit dem Player, der sie auf der Gegenseite wieder auspackt.

Der Prüfstein `streaming/zeigerbild-formen.json` ist unangetastet geblieben; die drei Stationen prüfen weiter gegen ihn.

---

## Was zurückzumelden ist

Von beiden Maschinen:

1. **Testausgabe im Wortlaut** (Ergebniszeile genügt).
2. **Hast du `Cargo.lock` mitcommittet?** (Windows: sowohl `win-hq-sidecar/Cargo.lock` als auch `win-hq-labor/Cargo.lock`.)
3. **Kam beim Zuschauer ein AV1-Bild?**

Linux zusätzlich: **baut der Flatpak, und liegen BEIDE Binärdateien?**
Windows zusätzlich: **baut das Labor?** Und: **sieht der Steuernde die Zeigerformen, auch die selbstgemalten?**

Bricht etwas: Fehlermeldung im Wortlaut, nicht zusammengefasst. Der wahrscheinlichste Fehler ist eine Pfadangabe im Flatpak-Manifest — dafür braucht es den genauen Text.

## Stand nach beiden Übergaben

Vier gemeinsame Kisten, **rund 3.400 überzählige Zeilen weg** (Gesamtbilanz des Zweiges: 2.858 hinzu, 5.374 entfernt). Web und Backend sind nicht berührt worden — der Zweig fasst ausschliesslich Rust unter `streaming/`, das Flatpak-Manifest und Dokumente an.
