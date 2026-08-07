# Probe: Semaphor-Kopplung CUDA ↔ Vulkan unter wgpu 29 (Linux/NVIDIA)

Beantwortet **zwei getrennte Fragen**, nachprüfbar:

1. Trägt `cuImportExternalSemaphore` gegen ein Vulkan-Semaphor, das über
   `VK_KHR_external_semaphore_fd` / `vkGetSemaphoreFdKHR` als OPAQUE_FD
   exportiert wurde? **Binär** und **Zeitlinie** sind dabei zwei Fälle, nicht
   zwei Zahlenwerte — beide werden geprüft und getrennt berichtet.
2. Nimmt **wgpu 29** ein *selbst angelegtes* `VkDevice` entgegen, auf dem die
   Erweiterung eingeschaltet ist? Nötig, weil wgpu 29 sie von sich aus **nicht**
   anfordert, obwohl die Karte sie anbietet.

Davon hängt ab, ob der Zero-Copy-Umbau des `pulse-player` über den Betrieb
hinwegkommt: die beiden Vorgängerproben haben sich die Synchronisierung
ausdrücklich vom Hals gehalten, indem sie die Warteschlange vor jedem Schritt
leerten. Im Betrieb geht das nicht — der Decoder schreibt, während gezeichnet
wird.

**Antwort auf beide: ja.** Gemessen auf RTX 5080, Treiber 610.43.03, drei volle
Läufe zu je 2×5 Wiederholungen; Rohausgaben unten unter „Ergebnis".

## Wie sie sich zu den Nachbarproben verhält

| Probe | fragt |
|---|---|
| `../cuda-vulkan-import` | Teilen sich CUDA und Vulkan denselben Speicher? (**ohne** wgpu) |
| `../wgpu-cuda-import` | Nimmt **wgpu 29** ein fremdes `VkImage` mitsamt Inhalt an? |
| **diese** | Lassen sich die Zugriffe **ordnen**, ohne die Warteschlange zu leeren? Und nimmt wgpu 29 dafür ein eigenes `VkDevice`? |

**Warum eine eigene Kiste.** Jene beiden messen Speicher-Weitergabe auf einem
Aufbau, der bewusst ohne Synchronisierung auskommt. Genau das ist hier der
Gegenstand. In einer gemeinsamen Kiste wäre bei einem Fehlschlag nicht mehr
zuzuordnen, ob die Speicher- oder die Synchronisierungsseite gescheitert ist —
und die Messakten der Nachbarn liefen nicht mehr auf demselben Aufbau.

Der teure Teil wird trotzdem **nicht** verdoppelt: die von Hand nachgebauten
CUDA-Speicher-Layouts kommen per `#[path]` aus `../cuda-vulkan-import`, samt
ihrem Selbsttest. Neu sind hier allein die drei **Semaphor**-Strukturen
(`src/cudasem.rs`); sie tragen ihren eigenen Selbsttest nach demselben
Verfahren — Größen **und Versätze**, gegen ein kompiliertes
`sizeof`/`offsetof` aus `/opt/cuda/include/cuda.h`.

## Warum diese Richtung

Der Player braucht beide Richtungen, und sie sind nicht dasselbe:

- **CUDA schreibt → wgpu liest** (der Decoder liefert ein Bild). Das ist der
  Fall, den Stufe D als Wettrennen nachweist.
- **wgpu ist fertig → CUDA darf überschreiben** (der Puffer wird recycelt). Das
  ist Stufe B, und sie ist hier ausdrücklich nur ein **Funktions**nachweis.

Die Alternative wäre, es bei `queue_wait_idle` zu belassen. Das kostet im Player
ein Bild Wartezeit je Zugriff und macht die Zielgrößen 3 (flüssige Darstellung)
und 4 (Verzögerung) gegeneinander aus — genau der Handel, den das Labor nicht
eingehen will.

## Warum so gebaut

**Gearbeitet wird mit Puffern, nicht mit Bildern.** Die Bild-Frage ist von den
Nachbarn beantwortet; ein Puffer lässt sich Byte für Byte gegen ein Muster
halten, ohne dass eine undurchsichtige Kachelung dazwischensteht. Ein
Wettrennen sähe man in einem gekachelten Bild schlechter, nicht besser.

**Das `VkDevice` wird auf genau dem Weg gebaut, den wgpu-hal intern nimmt**
(`open_with_callback`, `adapter.rs:2834`): dieselben Hilfsfunktionen
(`required_device_extensions`, `physical_device_features`,
`add_to_device_create`), dieselbe Reihenfolge, nur ein Eintrag mehr in der
Erweiterungsliste. Wäre es ein anderer Weg, könnte ein Fehlschlag auch daran
liegen, dass wir das Gerät anders bauen als wgpu es erwartet — und Frage 2 wäre
nicht beantwortet, sondern verschoben.

## Bauen und laufen lassen

```bash
cd streaming/player-labor/semaphor-kopplung
cargo build --release
./target/release/semaphor-kopplung
```

Braucht kein CUDA-Toolkit zum Laufen (`libcuda.so.1` kommt mit dem Treiber),
kein FFmpeg, keinen Server, kein Fenster. Die Header unter
`/opt/cuda/include/cuda.h` werden nur *gelesen*, wenn man die Layout-Zahlen
nachprüfen will — zur Laufzeit nicht. Rückgabewert 0 = der geprüfte Weg trägt.

| Schalter | |
|---|---|
| `SPIKE_EIGENES_GERAET` (`1`) | `VkDevice` selbst anlegen und per `device_from_raw` übergeben. `0` = **Gegenprobe zu Frage 2**: wgpu öffnet das Gerät, die Erweiterung fehlt, der Lauf bricht mit genau dieser Begründung ab |
| `SPIKE_MIB` (`256`) | Größe jedes Puffers. Wirkt auf die Breite des Zeitfensters |
| `SPIKE_RUNDEN` (`5`) | Wiederholungen je Stufe. Ein Lauf je Variante trägt keine Entscheidung |
| `SPIKE_VORKOPIEN` (`8`) | Zusätzliche CUDA-Kopien vor der entscheidenden. Sie kosten nur Zeit — und genau darum geht es |
| `SPIKE_BINAER` (`1`) | Bauart `CU_EXTERNAL_SEMAPHORE_HANDLE_TYPE_OPAQUE_FD` prüfen |
| `SPIKE_ZEITLINIE` (`1`) | Bauart `..._TIMELINE_SEMAPHORE_FD` prüfen |
| `SPIKE_EMPFINDLICHKEIT` (`1`) | Stufe C — der Aufbau **ohne** Semaphor |
| `SPIKE_HAUPTLAUF` (`1`) | Stufe D — der Aufbau **mit** Semaphor |
| `SPIKE_PRUEFSCHICHT` (`0`) | Vulkan-Prüfschicht an (braucht `vulkan-validation-layers`) |

**Beim Nachfahren einer Matrix gilt die Kopfzeile des Laufs als Beleg, nicht die
eigene Beschriftung.** Sie gibt jede Schalterstellung aus. Ein nicht greifender
Schalter hat in diesem Labor schon dreimal Matrixzeilen entwertet.

**Die mitprotokollierte Größe, die sich ändern MUSS, wenn `SPIKE_EIGENES_GERAET`
greift**, ist die Zahl der am Gerät eingeschalteten Erweiterungen: **6 auf dem
wgpu-Weg, 7 auf dem eigenen** — plus die ausdrückliche Zeile, ob
`VK_KHR_external_semaphore_fd` darunter ist. Für die Stufen C/D ist es die Zahl
der **veralteten Bytes**; sie ist ohne Semaphor sechsstellig und mit Semaphor
null.

## Was die Probe absichert

Vier Stufen, getrennt berichtet, weil ein „ja" auf der ersten über die letzte
nichts aussagt:

| Stufe | Frage | Art des Nachweises |
|---|---|---|
| **A** | Lässt sich der Dateideskriptor überhaupt importieren? | Rückgabewert von `cuImportExternalSemaphore` |
| **B** | Trägt die Rückrichtung (Vulkan signalisiert, CUDA wartet)? | **Funktionsnachweis** — läuft durch, kein Wettrennen |
| **C** | **Bemerkt die Probe ein FEHLENDES Warten?** | Wettrennen ohne jede Synchronisierung |
| **D** | Ordnet das Semaphor die Zugriffe wirklich? | dasselbe Wettrennen, mit Semaphor |

**Stufe C ist die entscheidende, nicht D.** Eine Synchronisierung, die nichts
tut, fällt nicht auf, wenn das Wettrennen zufällig nie eintritt. Ein sauberes D
ohne bestandenes C ist deshalb kein Erfolg. Dieser Fall hat einen **eigenen,
benannten Ausgang** im Programm (`Ausgang::Unentscheidbar`), keine Fußnote:

> URTEIL: für BINAER (OPAQUE_FD) KANN DIESER LAUF DIE SACHE NICHT ENTSCHEIDEN.
> Das Wettrennen ist nicht eingetreten — auch ohne Semaphor kam durchweg das
> Richtige heraus. Damit ist WEDER belegt, dass die Kopplung trägt, NOCH dass
> sie es nicht tut; es ist ein Befund über die Probe, nicht über den Treiber.

Der Ausgang ist erreichbar und wurde vorgeführt (`SPIKE_MIB=1
SPIKE_VORKOPIEN=0`, Rohausgabe unten). Er gibt **nicht** 0 zurück: „unentscheidbar"
ist nicht „trägt".

Wie das Wettrennen gebaut ist, und warum jedes Stück davon nötig ist:

- **Große Kopie**, wiederholt: CUDA legt `SPIKE_VORKOPIEN + 1` Kopien à
  `SPIKE_MIB` auf einen Strom (Vorgabe 9 × 256 MiB ≈ 4,6 GiB Verkehr). Vulkan
  sendet unmittelbar danach seine eine Lesekopie ab.
- **Alt/neu getrennt**: die Vorkopien schreiben das **alte** Muster, nur die
  letzte das neue. Wer zu früh liest, sieht deshalb *alte* Bytes und nicht bloß
  halb geschriebene — das ist der Unterschied zwischen einem auswertbaren und
  einem ratenden Befund. Der Zähler weist beides getrennt aus (`veraltet` /
  `fremd`).
- **Positionsabhängiges Prüfmuster**: jedes Byte hängt an seiner Position. Ein
  gleichförmiges Muster ließe einen um einen Versatz daneben lesenden Weg als
  fehlerfrei durchgehen.
- **Die Varianten unterscheiden sich an JEDER Position** (der Variantenschlüssel
  wird per XOR aufgetragen). Gäbe es Stellen, an denen alt und neu zufällig
  gleich sind, wären das Stellen, an denen ein fehlendes Warten unsichtbar
  bliebe.
- **Ausgangslage wird je Wiederholung synchron hergestellt** — eine
  Verschleppung über Wiederholungen hinweg ist damit ausgeschlossen.

Dazu die Absicherungen, die die Nachbarproben schon haben:

- **UUID-Abgleich Vulkan/CUDA.** Auf einer Maschine mit zwei Karten schlüge der
  Import sonst aus einem Grund fehl, der mit der Frage nichts zu tun hat.
- **Layout-Selbsttest beim Start**, Größen *und* Versätze. Er hat beim ersten
  Lauf sofort zugeschlagen, siehe unten.
- **Mehrere Wiederholungen** je Stufe und Bauart.

## Ein Fehlgriff, den der Selbsttest gefangen hat

Der allererste Lauf endete mit:

```
Error: CUDA_EXTERNAL_SEMAPHORE_HANDLE_DESC: 92 Bytes, erwartet 96 — Layout weicht von cuda.h ab
```

Alle Felder dieser Struktur sind vier Byte breit oder Byte-Felder; Rust rechnet
daraus Ausrichtung 4 und Größe **92**. C kommt auf 96, weil die union eine
Variante mit zwei Zeigern enthält und damit auf 8 ausgerichtet ist — eine
Information, die verschwindet, sobald man die union durch ein Byte-Feld ersetzt.
Das Speicher-Gegenstück der Nachbarkiste hat das Problem nicht, weil es ein
`u64 size` trägt, das die Ausrichtung von selbst erzwingt; **wer von dort
abschreibt, übersieht es deshalb.** Behoben mit `#[repr(C, align(8))]`.

Ohne den Selbsttest hätte der Treiber `flags` und `reserved` um vier Byte
verschoben gelesen. Das hätte keinen Fehler erzeugt, sondern wäre unbemerkt
durchgelaufen — genau die Fehlerklasse, gegen die der Selbsttest steht.

## Ergebnis

Rohausgabe des Hauptlaufs (gekürzt um Wiederholungen, die identisch aussehen):

```
Lauf: eigenes VkDevice: true, 256 MiB je Puffer, 5 Wiederholungen, 8 Vorkopien,
      binaer: true, Zeitlinie: true, Stufe C (Empfindlichkeit): true,
      Stufe D (Hauptlauf): true, Pruefschicht: false
Struct-Layouts gegen cuda.h geprueft (Speicher UND Semaphor): ok
  GPU NVIDIA GeForce RTX 5080 (Vulkan, Treiber NVIDIA)
  eigenes VkDevice: wgpu wuerde 6 Erweiterungen anfordern, wir fordern 7 an
  Erweiterungen am Geraet: 7 · VK_KHR_external_semaphore_fd ist AN
ANTWORT AUF FRAGE 2: wgpu 29 nimmt das selbst angelegte VkDevice an — das Geraet
  fuehrt VK_KHR_external_semaphore_fd und ist ueber create_device_from_hal bei
  wgpu angekommen.
  CUDA-Geraet 0: UUID 1640a1b36a75f91fd31f82f937659d25
  UUIDs stimmen ueberein — dieselbe Karte

=== BINAER (OPAQUE_FD) ===
  Stufe A Import: ok (Griff 0x56072c28e790)
  Stufe B Rueckrichtung (Vulkan signalisiert, CUDA wartet): ok — Funktionsnachweis,
      KEIN Wettrennen-Nachweis
  Stufe C (OHNE Semaphor), 5 Wiederholungen je 256 MiB, 8 Vorkopien:
      Wiederholung 1: 52975616 veraltet, 0 fremd
      Wiederholung 2: 52200960 veraltet, 0 fremd
      Wiederholung 3: 52265728 veraltet, 0 fremd
      Wiederholung 4: 52225536 veraltet, 0 fremd
      Wiederholung 5: 52061696 veraltet, 0 fremd
  Stufe D (MIT Semaphor), 5 Wiederholungen je 256 MiB, 8 Vorkopien:
      Wiederholung 1..5: 268435456 Bytes alle neu

=== ZEITLINIE (TIMELINE_SEMAPHORE_FD) ===
  Stufe A Import: ok (Griff 0x56072c374d10)
  Stufe B Rueckrichtung: ok
  Stufe C (OHNE Semaphor): 53581824 / 53419776 / 52953600 / 52748032 / 53574400
      veraltet, 0 fremd
  Stufe D (MIT Semaphor): 5 × 268435456 Bytes alle neu

ERGEBNIS auf NVIDIA GeForce RTX 5080 (7 Erweiterungen am Geraet):
  BINAER (OPAQUE_FD)                 TRAEGT
  ZEITLINIE (TIMELINE_SEMAPHORE_FD)  TRAEGT
URTEIL: beide gepruefte Bauarten tragen.
```

Drei volle Läufe, gleiches Bild. Die veralteten Anteile in Stufe C lagen über
alle Läufe zwischen **42,1 und 54,0 MiB von 256 MiB** (16,4–21,1 Prozent) — je
Wiederholung verschieden, wie es bei einem Wettrennen sein muss, und nie null.

**Beide Bauarten tragen, keine ist die schwächere.** Für den Player heißt das:
er kann sich die Bauart nach der Zeichenschleife aussuchen und muss sie nicht
nach dem Treiber wählen. Die Zeitlinie ist trotzdem die naheliegendere — sie
verlangt kein Buchhalten über signalisiert/nicht signalisiert, und wgpu-hal
fordert `VK_KHR_timeline_semaphore` ohnehin schon an.

**Frage 2 hat eine ausdrückliche Gegenprobe** (`SPIKE_EIGENES_GERAET=0`):

```
  Erweiterungen am Geraet: 6 · VK_KHR_external_semaphore_fd ist NICHT an
Error: ANTWORT AUF FRAGE 2: das Geraet hat VK_KHR_external_semaphore_fd NICHT an
  (6 Erweiterungen). Ohne sie faellt kein Dateideskriptor aus
  vkGetSemaphoreFdKHR, und Frage 1 ist gar nicht erst pruefbar.
```

6 gegen 7 Erweiterungen: der Schalter greift nachweislich, und der Umweg über
`device_from_raw` ist nicht Zierde, sondern die Bedingung.

## Was daran ungeprüft bleibt

- **Stufe B ist ein Funktionsnachweis, kein Wettrennen-Nachweis.** Dass CUDA auf
  ein von Vulkan signalisiertes Semaphor wartet und danach die richtigen Daten
  sieht, ist belegt; dass dieses Warten ein *verfrühtes Überschreiben* verhindert,
  ist es **nicht**. Wer die Rückrichtung im Player scharf schaltet, sollte das
  Gegenstück zu Stufe C dafür nachbauen.
- **Nur Puffer, keine Bilder.** Ein `VkImage` bringt zusätzlich Layout-Übergänge
  mit, und welches Layout CUDA beim Schreiben erwartet, ist nirgends
  dokumentiert (siehe `../cuda-vulkan-import`). Die Semaphor-Frage ist davon
  unabhängig, die *Gesamt*kette nicht.
- **Nur eine Karte, ein Treiber.** RTX 5080 / 610.43.03. Über ältere
  NVIDIA-Treiber, über AMD (dort gibt es kein CUDA) und über Windows (dort
  OPAQUE_WIN32 statt OPAQUE_FD) sagt der Lauf nichts.
- **Es wird nichts über Zeiten gesagt.** Die GPU-Takte sind hier nicht
  festgenagelt; die Probe meldet ausschließlich Korrektheit. Ob die Kopplung
  *schneller* ist als `queue_wait_idle`, ist eine andere Messung.
- **Ein Semaphor je Bauart, ein Strom, eine Warteschlange.** Der Player wird
  mehrere Bilder in Flug haben; ob eine Kette aus mehreren Semaphoren dieselbe
  Ordnung hält, ist damit nicht gezeigt.
- **Die Prüfschicht ist zu hören, meldet aber zum geprüften Weg nichts.**
  Mit `SPIKE_PRUEFSCHICHT=1` kommt genau eine Meldung, und zwar beim Beenden:
  `VUID-vkDestroyDevice-device-05137`, zehn nicht abgeräumte Objekte. Das ist
  unsere eigene Unordnung beim Ausgang (Puffer und Semaphoren werden absichtlich
  bis zum Prozessende gehalten, weil CUDA sie über die importierten Deskriptoren
  hält), **kein Regelverstoß im geprüften Ablauf**. Der Wert der Meldung liegt
  darin, dass sie überhaupt kommt: „die Schicht meldet nichts" wäre sonst nicht
  von „die Schicht ist nicht zu hören" zu unterscheiden — genau die Falle, in die
  `../wgpu-cuda-import` zuerst getappt ist.
