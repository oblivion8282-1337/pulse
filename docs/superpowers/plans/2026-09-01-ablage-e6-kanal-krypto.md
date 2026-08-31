# E6 — Kanal-Krypto: der verschlüsselte Ablage-Kanal

> Rahmen: `docs/superpowers/plans/2026-08-31-ablage-etappen.md`.
> Entwurf: `docs/superpowers/specs/2026-08-31-ablage-kanaele-design.md`.

**Ziel:** Ein Kanal mit `ablage=true` trägt verschlüsselte Nachrichten über
das Postfach, und ein Gerät des Erstellers festigt sie als Typ-2-Rahmen in
sein Ablage-Log.

## Was schon da ist (kartiert am 2026-09-01)

- **Megolm-Gruppensitzungen** für private Gruppen: `krypto/gruppe/*`. Eine
  Sitzung entsteht **implizit beim ersten Senden** (`sitzungswahl.ts`), wird
  als gewöhnlicher Olm-Umschlag über das Postfach an jedes Gerät jedes
  Mitglieds verteilt (`gruppenNutzlast.ts::baueVerteilNutzlast`). Es gibt
  keinen Sitzungsserver — jeder Absender ist sein eigener Verteiler.
- **Das Postfach** (`routes/postfach*.py`) samt Abholen, Quittung und
  inhaltslosem WS-Weckruf. Übernehmbar.
- **`TYP_MEGOLM = 2`** ist in `ablage/format.ts` reserviert — aber **kein
  Code öffnet Typ-2-Rahmen beim Lesen**.
- **`NachzieherQuelle` ist winzig:** `holen(nachId, limit) => AblageEintrag[]`
  mit `AblageEintrag = { id: bigint; nutzlast: Uint8Array; typ?: number }`.
  `nachzieher.ts` und `schreiber.ts` sind postfach-agnostisch und fertig.

## Zwei Entscheidungen, hier getroffen

**1. Ein Ablage-Kanal ist eine Mehrpersonen-Gruppe, kein Ein-Personen-Archiv.**
Der Kartierer hat gezweifelt, weil der Kanal „im Laufwerk des Erstellers"
liegt. Das ist die Speicherfrage, nicht die Mitgliederfrage: laut Entwurf §2
ist es ein Realtime-Chat für alle Mitglieder, die lesen **und schreiben**
(§4.0a). Megolm bleibt also richtig, ein 1:1-Weg wäre falsch.

**2. Mitgliederwechsel kommt über Ereignisse, nicht über Nachfragen.** Private
Gruppen lesen vor JEDEM Senden die Mitgliederliste frisch — bei einer Guild
mit vielen Mitgliedern hiesse das ein `GET` plus `keys/claim` über alle
Geräte je Nachricht. Guild-Kanäle haben aber etwas, das private Gruppen nicht
haben: **Ereignisse für Mitglieder- und Rechteänderungen**. Die
Sitzungswahl hängt sich daran, statt zu pollen. Wer das übergeht, baut eine
Anwendung, die beim hundertsten Mitglied stehen bleibt.

## Globale Randbedingungen

Wie im E1-Plan (Nodes Testläufer, Dateigrenzen, Deutsch, keine neuen
Abhängigkeiten, `command grep`). Zusätzlich:

- **Runen nur in `.svelte`/`.svelte.ts`** — sonst reisst zur Laufzeit die
  ganze Route ab, und keine Prüfung findet es (`CLAUDE.md`).
- **Fail-closed**: eine fehlende Prüfung heisst abweisen, nicht durchwinken.
- **Nichts Geheimes ins Log** — keine Schlüssel, keine Klartexte, keine
  Sitzungs-Kennungen.

---

## Aufgabe 1: Das Postfach für Ablage-Kanäle öffnen

**Ohne das kommt keine verschlüsselte Nutzlast in ein Postfach.**

`_postfach_deps.py::_channel_zugriff_pruefen` kennt heute zwei Fälle: DM und
private Gruppe. Es braucht einen dritten für den Guild-Kanal mit
`ablage=true`.

**Dateien:** `services/chat-gateway/.../routes/_postfach_deps.py`,
`postfach.py`, Tests daneben.

**Regeln**

- Zugelassen ist nur ein Kanal mit `ablage=true`. Ein gewöhnlicher
  Textkanal darf **kein** Postfach-Ziel werden — sonst entstünde genau der
  Mischzustand, den B1 dieses Zweigs schon einmal geöffnet hat.
- Die Berechtigung ist `VIEW_CHANNEL` über den vorhandenen Resolver, nicht
  eine neue Mitgliedertabelle.
- **Zweifach prüfen**: Route UND Ereignisweg. Der Weckruf
  (`PostfachNeuEvent`) läuft über den Kanal-Pub/Sub; prüfe, ob der
  Guild-Filter (`pubsub_perm_filter.py`) ihn schon abdeckt, oder ob er wie
  bei den Gruppen einen eigenen Zweig braucht.
- Ein Empfänger, der den Kanal nicht sehen darf, wird abgewiesen wie heute
  bei den Gruppen (`empfaenger_nicht_im_kanal`).

**Abnahme:** Ein Mitglied kann einliefern und abholen; ein Nicht-Mitglied
nicht; ein gewöhnlicher Textkanal wird abgewiesen. Der volle Backend-Lauf
bleibt grün.

---

## Aufgabe 2: Die Postfach-Quelle für den Nachzieher

**Der kleinste Hebel mit der grössten Wirkung** — `nachzieher.ts` und
`schreiber.ts` sind fertig und warten nur auf eine andere Quelle.

**Dateien:** `web/src/lib/ablage/postfachQuelle.ts` (neu), Tests.

**Schnittstelle:** dieselbe wie `quelle.ts`
(`holen(nachId, limit) => AblageEintrag[]`), aufsteigend hinter dem
Wasserzeichen.

**Zwei Fragen, die vor dem Code zu klären sind — am Code, nicht am Gefühl:**

1. **Liefert `POST /postfach/abholen` streng aufsteigend?** Der Kartierer
   fand „älteste zuerst", aber ungeprüft gegen „streng aufsteigend, exklusiv
   nach `nachId`". Nachsehen und, falls nötig, serverseitig festschreiben —
   ein Nachzieher auf einer unsicheren Ordnung baut Lücken.
2. **Roh oder entschlüsselt ablegen?** Legt der Schreiber den Megolm-Geheimtext
   ab (`typ = TYP_MEGOLM`), ist das Archiv ohne Sitzungsschlüssel wertlos —
   und Megolm-Sitzungen rotieren. Legt er den entschlüsselten Text ab, ist
   das Archiv für sich lesbar, aber der Klartext liegt beim Ersteller auf der
   Platte (verschlüsselt durch die Ablage-Container, s. `dateiablage.ts`).
   **Entscheide für das Zweite und begründe es im Code:** das Archiv soll
   Jahre überleben, und ein Schlüssel, der rotiert, ist kein Fundament. Der
   reservierte `TYP_MEGOLM` bleibt für den Fall, dass jemand später doch roh
   ablegen will.

**Abnahme:** Ein Test füttert eine gefälschte Postfach-Antwort durch
`nachziehen()` in einen Speicher-Schreiber und liest das Ergebnis zurück.

---

## Aufgabe 3: Gruppensitzung für den Ablage-Kanal

**Dateien:** `web/src/lib/krypto/gruppe/*` erweitern oder daneben, Tests.

**Schritte**

1. `sitzungswahl.ts` lesen: sie ist laut Kommentar bereits generisch über den
   Sitzungstyp. Prüfen, ob ein Kanal-Sitzungstyp dazupasst, ohne den
   Gruppen-Weg zu stören.
2. Die Mitgliederliste kommt aus der Guild-Mitgliedschaft mit
   `VIEW_CHANNEL`, nicht aus `PrivateGroupMember`.
3. **Der Wechselgrund hängt an Ereignissen** (Entscheidung 2 oben): auf
   Mitglieder- und Rechteänderungen des Kanals hören und daraufhin die
   Sitzung als überholt markieren. Erst beim nächsten Senden wird rotiert —
   wie bei den Gruppen, aber ohne Nachfrage vor jeder Nachricht.
4. **Ehrlich benennen, was das nicht leistet:** ein Ausgeschiedener kann
   weiterlesen, was er schon hat, und bis zur nächsten Rotation auch noch
   Mitgelesenes öffnen. Das ist die Zusage eines ehrlichen Absenders, keine
   kryptografische Garantie — genau wie bei den privaten Gruppen, und es
   deckt sich mit der Entscheidung des Eigentümers („ab jetzt nichts Neues
   mehr").

**Abnahme:** Mitglied tritt bei → nächste Nachricht rotiert die Sitzung;
Mitglied fliegt → dasselbe; ohne Wechsel wird **nicht** rotiert (sonst ist
jede Nachricht eine neue Sitzung und der Vorrat brennt).

---

## Aufgabe 4: Typ-2-Rahmen im Leser

`format.ts` reserviert das Byte, aber nichts öffnet es. Je nach Entscheidung
aus Aufgabe 2 ist das entweder ein kurzer Zweig (falls entschlüsselt
abgelegt wird, bleibt Typ 2 ungenutzt und der Leser braucht nur eine klare
Fehlermeldung für einen Typ, den er nicht öffnen kann) oder die volle
Entschlüsselung.

**In beiden Fällen gilt:** ein unbekannter Rahmentyp darf den Leser nicht
abwerfen. Er wird als Lücke benannt, wie `leser.ts` es für beschädigte
Segmente schon tut.

---

## Aufgabe 5: Verdrahten

Senden und Empfangen im Ablage-Kanal an den vorhandenen Chat-Weg hängen,
hinter dem `ablage`-Merkmal des Kanals. Der Klartext-Weg ist serverseitig
schon gesperrt (B1) — jetzt kommt der verschlüsselte daneben.

---

## Aufgabe 6: Der Nachweis

Ein Zwei-Geräte-Lauf gegen den Hetzner-Stack, nach dem Muster von
`web/tests/e2e/e2e-dm-hetzner.spec.ts` (eigene Playwright-Fassung, s.
`playwright.config.ts`): verschlüsselt schreiben, festigen, mit dem zweiten
Gerät lesen — und die **Gegenprobe in Postgres**, dass in `chat.messages`
für diesen Kanal nichts steht.

Das ist die Abnahme der ganzen Etappe: ohne diese Gegenprobe ist „der Server
sieht den Inhalt nie" eine Behauptung.
