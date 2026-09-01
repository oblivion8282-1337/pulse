# E4 — Der Wiederherstellungs-Satz

> Rahmen: `docs/superpowers/plans/2026-08-31-ablage-etappen.md`.
> Entwurf: `docs/superpowers/specs/2026-08-31-ablage-kanaele-design.md` §8.

**Ziel:** Ein neues Gerät kommt mit Anmeldung plus einem aufgeschriebenen Code
an dasselbe Archiv wie das alte.

## Warum das vor dem Archiv kommt

Ursprünglich war das ein Sicherheitsnetz gegen Totalverlust. Die
Präzisierung des Eigentümers vom 2026-08-31 macht mehr daraus: das Archiv ist
in erster Linie der Weg, auf dem **das Handy dieselben Nachrichten zeigt wie
der Rechner**. Ohne diesen Code findet das zweite Gerät im Ordner aber nur
Dateien, die es nicht öffnen kann — die Schlüssel liegen je Gerät und wandern
nicht mit.

Der Code ist damit **Voraussetzung für Synchronisation**, nicht ein Zusatz.

---

## Zwei Entscheidungen, die schon getroffen sind

**Ein GENERIERTER Code, keine selbst gewählte Passphrase.** Das steht schon
in Entwurf §8.1: auf `feat/dm-attachment-e2ee` wurde die selbst gewählte
Passphrase bereits verworfen — sie wird schwach gewählt, und alle Bündel
lägen an einem Ort. Muster ist der vorhandene MFA-Ersatzcode.

**Daraus folgt: keine Schlüsselstreckung.** Argon2id und Verwandte existieren,
weil ein von Menschen gewähltes Passwort wenig Entropie hat. Ein generierter
Code mit 128 Bit oder mehr braucht das nicht — HKDF genügt, und das kann
WebCrypto von sich aus.

**Deshalb: keine neue Abhängigkeit, keine Rust-Änderung.** `pulse-krypto`
trägt heute nur `vodozemac` und `wasm-bindgen`; für Verpacken und Öffnen
reicht dasselbe WebCrypto-AES-GCM, das `lib/ablage/dateiablage.ts` schon
benutzt. Wer hier eine KDF-Kiste hinzufügt, sollte vorher begründen, wogegen
sie schützen soll.

---

## Globale Randbedingungen

Wie im E1-Plan: Nodes Testläufer statt Vitest, Quelldateien ≤ 350 Zeilen,
Svelte-Komponenten ≤ 250, Deutsch mit echten Umlauten, keine Emojis, keine
neuen Abhängigkeiten, `command grep` statt `grep`. Vor jedem Commit
`pnpm test:unit` und `pnpm check`.

**Zusätzlich, und hier härter als sonst:**
- **Der Code darf nirgends geloggt werden**, auch nicht gekürzt, auch nicht
  in einer Fehlermeldung.
- **Der Code darf den Klienten nie verlassen.** Was zum Server geht, ist
  ausschliesslich das verschlüsselte Päckchen.
- Jede Zufallszahl kommt aus `globalThis.crypto.getRandomValues`.

---

## Aufgabe 1: Code erzeugen und darstellen

**Dateien:** `web/src/lib/krypto/wiederherstellungsCode.ts` (**importfrei**),
Test.

**Schritte**

1. Zuerst den vorhandenen MFA-Ersatzcode ansehen
   (`command grep -rn "backup.*code" web/src/lib services/auth/src`) und
   Alphabet, Gruppierung und Länge übernehmen, statt ein zweites Format zu
   erfinden. Zwei Codeformate in einer App sind eines zu viel.
2. Erzeugen: mindestens 128 Bit echter Zufall, in Gruppen dargestellt.
   **Ein Alphabet ohne verwechselbare Zeichen** (kein 0/O, kein 1/l/I) — der
   Code wird abgeschrieben und wieder abgetippt, und ein Tippfehler kostet
   hier das Archiv.
3. Eingabe **grosszügig normalisieren**: Grossschreibung, Leerzeichen,
   Bindestriche egal. Wer den Code von einem Zettel abtippt, soll nicht an
   der Form scheitern.
4. Tests: Erzeugung ist zufällig (zwei Aufrufe verschieden), Normalisierung
   macht aus allen plausiblen Schreibweisen denselben Wert, ein verstümmelter
   Code wird abgewiesen statt still gedeutet.

**Abnahme:** `pnpm test:unit` grün; das Alphabet enthält kein verwechselbares
Zeichen (als Test formuliert, nicht als Kommentar).

---

## Aufgabe 2: Das Päckchen

**Dateien:** `web/src/lib/krypto/wiederherstellungsPaeckchen.ts`, Test.

**Was hineingehört** — und das ist der Kern der Etappe. Zuerst lesen und
aufschreiben, was ein zweites Gerät **tatsächlich** braucht, um dasselbe zu
sehen:

- die Ablage-Hauptschlüssel der Verbindungen (`verbindungen.ts`)
- die **Verbindungen selbst**, inklusive der Links — sonst weiss das neue
  Gerät zwar, wie es entschlüsselt, aber nicht, wo etwas liegt
- alles, was zum Öffnen des abgelegten Verlaufs nötig ist (hier gilt: erst
  am Code nachsehen, was `verlauf/` und `krypto/` dafür brauchen, dann
  festlegen — **nicht raten**)

**Was NICHT hineingehört:** der Geräte-Anmeldeschlüssel. Ein neues Gerät
meldet sich selbst an und veröffentlicht seine eigenen Schlüssel; eine
kopierte Geräte-Identität wäre zwei Geräte mit einem Namen.

**Verpacken:** HKDF aus dem Code (mit einem zufälligen Salz), daraus ein
AES-256-GCM-Schlüssel, damit das Päckchen. Format wie in
`dateiablage.ts`: Kennung, Fassung, Salz, IV, Geheimtext. **Die Fassung ist
kein Beiwerk** — ein Päckchen wird Jahre später geöffnet.

**Tests:** Rundlauf; falscher Code schlägt fehl; verändertes Päckchen schlägt
fehl (GCM); ein Päckchen mit unbekannter Fassung wird mit klarer Meldung
abgewiesen statt falsch gedeutet.

---

## Aufgabe 3: Wo das Päckchen liegt

**Entschieden (Entwurf §8): in der Ablage UND als undurchsichtiger Block auf
Pulse.** Der Grund, warum beides und nicht nur die Ablage, ist ein
Henne-und-Ei-Problem, das man leicht übersieht:

> Um das Päckchen aus der Ablage zu holen, muss das neue Gerät wissen, **wo
> die Ablage liegt** — und diese Angabe steht in der gerätelokalen
> Verbindungsliste, die es ja gerade nicht hat.

Deshalb liegt es zusätzlich beim Server, an das Konto gebunden. Ein neues
Gerät meldet sich an, holt das Päckchen, öffnet es mit dem Code — und darin
stehen die Verbindungen samt Links. Ein Schritt für den Nutzer statt drei.

**Was der Server dabei hält:** einen verschlüsselten Block, der die Links
enthält. Ohne den Code ist er wertlos. Das ist dieselbe Abwägung, die der
Eigentümer bei den Schreib-Links schon getroffen hat (§4.0), und sie gehört
an der Route wiederholt: nie loggen, nie an einen anderen als den
Konto-Eigentümer herausgeben, Grösse begrenzen.

**Serverseitig** (chat-gateway oder auth-svc — beim Bauen entscheiden und
begründen): ablegen, holen, ersetzen, löschen. Ein Päckchen je Konto.

---

## Aufgabe 4: Der Weg durch die Oberfläche

**Erzeugen** — beim Einrichten eines Archivs, nicht beim ersten Start. Der
Code wird **einmal** gezeigt, mit einer Bestätigungsabfrage („tippe die
dritte Gruppe ab"), damit niemand ihn wegklickt, ohne ihn zu haben.

**Einlösen** — auf einem neuen Gerät: anmelden, Code eingeben, fertig.
Fehlermeldungen müssen die drei Fälle trennen, sonst rät der Nutzer:
- Code falsch
- kein Päckchen für dieses Konto vorhanden
- Päckchen da, aber das Laufwerk antwortet nicht

**Erneuern** — der Nutzer kann einen neuen Code erzeugen; der alte gilt dann
nicht mehr. Das ist der Widerruf für den Fall, dass der Zettel abhandenkommt.

**Was die Oberfläche ehrlich sagen muss:** ohne diesen Code ist das Archiv
nach Verlust aller Geräte endgültig verloren — auch für uns. Das ist der
Punkt des Ganzen und darf nicht im Kleingedruckten stehen.

---

## Abnahme der Etappe

Ein Test, der den ganzen Zweck abbildet: Archiv einrichten, Code notieren,
**alle Geräteschlüssel löschen**, mit dem Code wiederherstellen — und danach
denselben Verlauf lesen. Genau dieses Szenario stand schon in
`dm-keyring-backup.spec.ts` des Juli-Zweigs; der Code dort hängt am
abgelösten Krypto, das Szenario nicht.

- `bash scripts/gate.sh` grün, Playwright mindestens so grün wie vorher
- Changelog-Eintrag: ja
