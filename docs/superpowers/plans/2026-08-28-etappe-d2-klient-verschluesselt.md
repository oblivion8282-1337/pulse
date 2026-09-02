# Etappe D2 — Der Klient verschlüsselt und liest — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eine Direktnachricht wird auf dem Gerät verschlüsselt, über das
Postfach zugestellt und auf dem Gerät des Empfängers wieder geöffnet. **Hinter
einem Schalter, der aus ist.**

**Architecture:** Der Schlussstein. Alles Bisherige ist Gerüst — Krypto-Kern
(A), Schlüsselverzeichnis (B/B2), Postfach (D), lokaler Verlauf (C1/C2). Diese
Etappe verbindet sie: Schlüssel holen → Sitzung aufbauen → verschlüsseln →
einliefern → abholen → entschlüsseln → in den lokalen Verlauf.

**Tech Stack:** SvelteKit 5 Runes · WASM (`krypto/pulse-krypto`) · IndexedDB

**Spec:** `docs/superpowers/specs/2026-08-28-e2e-dm-design.md` §2 und §4

**Vorbedingungen (alle erfüllt):** A, B, B2, C1, C2, D sind fertig und im
Zweig. `POST /keys/claim`, `POST /postfach`, `POST /postfach/abholen`,
`POST /postfach/quittung` stehen.

## Der Schalter, und warum er aus bleibt

Wie bei den privaten Gruppen: **gebaut, geprüft, nicht freigeschaltet.**
`e2e_dms_enabled`, Vorgabe **aus**, am Vorbild von
`cloud_dm_attachments_enabled`. Solange er aus ist, läuft jede Direktnachricht
den heutigen Klartext-Weg.

Der Grund ist hier noch zwingender als bei Gruppen: eine verschlüsselte
Nachricht, die der Empfänger nicht öffnen kann, ist **unwiederbringlich
verloren** — der Server hat keine Kopie. Ein halb fertiger Weg darf niemanden
erreichen. Umgelegt wird der Schalter erst, wenn zwei echte Geräte
nachweislich miteinander sprechen (das ist Handarbeit und gehört dem
Eigentümer).

## Global Constraints

- **Quelldateien ≤ 350 Zeilen, Svelte-Komponenten ≤ 250.**
- **Node-Unit-Tests:** importfreie Module, **kein `$state()` auf Modulebene** (Runes sind Compiler-Symbole; Node stirbt mit `$state is not defined`).
- **Keine neuen Abhängigkeiten. Kein `git push`.**
- **Niemals Klartext, Schlüssel oder Umschläge loggen.**
- **Changelog: nein** — der Schalter ist aus, ein Nutzer merkt nichts.
- Deutsche Kommentare und Commit-Nachrichten, echte Umlaute.

---

### Task 1: Sitzungen verwalten

**Files:**
- Create: `web/src/lib/krypto/sitzungen.ts` (Speicher), `web/src/lib/krypto/sitzungsschluessel.ts` (importfrei)
- Test: `web/test/krypto-sitzungsschluessel.test.ts`

**Interfaces:**
- Produces: `sitzungsSchluessel(kanalId: string, geraetePubkey: string) -> string` — **importfrei**
- Produces: `sitzungLaden(...)`, `sitzungSichern(...)` — eingefrorene Olm-Sitzungen in IndexedDB

Eine Olm-Sitzung besteht **je Gerätepaar**, nicht je Gespräch: schreibt Alice
von zwei Geräten an Bobs drei Geräte, sind das sechs Sitzungen. Jede hat
Zustand, der nach jeder Nachricht weitergedreht wird.

**Die Falle, die alles kostet:** wird eine Sitzung nach dem Ver- oder
Entschlüsseln nicht gesichert, läuft ihr Zustand auseinander. Die nächste
Nachricht ist dann nicht mehr zu öffnen — **endgültig**, weil der Server keine
Kopie hat. Sichern ist hier kein Aufräumen, sondern Teil der Operation.

Gespeichert wird neben dem Account (`pulse-identity`), aber unter eigenen
Schlüsseln; derselbe Pickle-Schlüssel wie beim Account
(`pickelschluesselAbleiten`).

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben** — der Sitzungsschlüssel
      muss Kanal und Gerät eindeutig trennen und darf sich nicht überlagern
      (zwei verschiedene Paare, zwei verschiedene Schlüssel; dasselbe Paar
      zweimal, derselbe Schlüssel).
- [ ] **Schritt 2 bis 4:** Fehlschlag bestätigen, umsetzen, Tests, committen.

---

### Task 2: Verschlüsselt senden

**Files:**
- Create: `web/src/lib/krypto/senden.ts`
- Modify: `web/src/routes/app/@me/[[dmChannelId]]/+page.svelte`, `web/src/lib/api/postfach.ts` (neu)

**Ablauf, und jeder Schritt kann schiefgehen:**

1. **Gerätebündel holen** — `POST /keys/claim` mit dem eigenen und dem fremden
   Konto. **Beide**: die eigenen anderen Geräte müssen mitadressiert werden,
   sonst sieht der eigene Desktop die Nachricht nie (Spec §2).
2. **Je Zielgerät eine Sitzung** — vorhandene laden, sonst über
   `sitzungAusgehend(curve25519, einmalschluessel)` neu aufbauen.
3. **Verschlüsseln**, Sitzung **sichern**, Umschlag sammeln.
4. **Einliefern** — ein `POST /postfach` mit allen Umschlägen.
5. **Lokal ablegen** — der eigene Klartext geht in den lokalen Verlauf
   (Etappe C1); der Server bekommt ihn nie.

- [ ] **Schritt 1: Die fehlschlagenden Tests schreiben**

Die reine Rechnung — „welche Geräte muss diese Nachricht erreichen" — gehört
in ein importfreies Modul und wird dort geprüft:

```ts
test('die eigenen anderen Geraete sind dabei, das eigene nicht', () => {
  // Ohne die eigenen anderen Geraete sieht der eigene Desktop nie, was vom
  // Handy geschrieben wurde — und das faellt erst auf, wenn jemand zwei
  // Geraete benutzt. Das EIGENE Geraet gehoert nicht dazu: es hat den
  // Klartext bereits, und eine Sitzung mit sich selbst gibt es nicht.
});

test('ein Konto ganz ohne Geraete ergibt keine Empfaenger', () => {
  // Der Normalfall der Koexistenz-Regel, kein Fehler.
});
```

- [ ] **Schritt 2 bis 4:** Fehlschlag bestätigen, umsetzen, Tests, committen.

**Was passiert, wenn das Gegenüber keine Geräte hat:** dann ist die
Koexistenz-Regel der Spec zuständig — die Nachricht geht den heutigen
Klartext-Weg. **Nicht** stillschweigend verwerfen, und **nicht** verschlüsselt
ins Leere schicken.

---

### Task 3: Abholen und entschlüsseln

**Files:**
- Create: `web/src/lib/krypto/empfangen.ts`
- Modify: `web/src/lib/ws/handlers/chat.ts` (auf `postfach_neu` hören)

**Ablauf:**

1. Auf `postfach_neu` (WS) und beim Start abholen: `POST /postfach/abholen`.
2. Je Umschlag: Sitzung laden; ist es ein **Sitzungsaufbau**, über
   `sitzungEingehend` eine neue anlegen — dabei kommt der Klartext der ersten
   Nachricht gleich mit.
3. Sitzung **sichern**.
4. Klartext in den lokalen Verlauf und in die Anzeige.
5. **Erst dann quittieren** (`POST /postfach/quittung`).

- [ ] **Schritt 1: Die fehlschlagenden Tests schreiben**

```ts
test('quittiert wird erst NACH dem erfolgreichen Ablegen', () => {
  // Die wichtigste Reihenfolge des ganzen Vorhabens. Die Quittung loescht
  // den Umschlag auf dem Server, und es gibt keine zweite Kopie. Wer vor
  // dem Ablegen quittiert, verliert die Nachricht bei jedem Fehler
  // zwischen beidem — und zwar unwiederbringlich.
});

test('ein unlesbarer Umschlag wird NICHT quittiert', () => {
  // Sonst waere ein voruebergehender Fehler (Sitzung noch nicht geladen)
  // ein endgueltiger Verlust. Lieber liegen lassen und die Frist
  // ablaufen lassen, als falsch aufraeumen.
});
```

- [ ] **Schritt 2 bis 4:** Fehlschlag bestätigen, umsetzen, Tests, committen.

---

### Task 4: Der Nachweis, dass es wirklich funktioniert

**Files:**
- Create: `web/tests/e2e/e2e-dm.spec.ts`

Zwei Browser-Kontexte, beide mit eingeschaltetem Schalter, eine Nachricht von
A nach B. Geprüft wird:

- B sieht den Klartext.
- **Der Server hat ihn nie gesehen:** die `messages`-Tabelle bleibt für diesen
  Kanal leer, und im Postfach steht nach der Quittung nichts mehr. Das ist die
  eigentliche Behauptung dieses Vorhabens — ohne diese Prüfung ist alles
  andere nur Mechanik.
- Eine zweite Nachricht in derselben Sitzung kommt ebenfalls an (der Ratchet
  dreht korrekt weiter).

Playwright-Rezept siehe `docs`/Memory; Browser sind bereits verknüpft, **kein
`playwright install`**, **keine Änderung an Docker-Rechten**.

---

## Selbstprüfung dieses Plans

**Spec-Abdeckung:** §2 „Verschickt wird an Geräte, nicht an Personen" → Task 2
Schritt 1. §4 „Gelöscht wird, sobald ein Gerät quittiert" → Task 3 Schritt 5.
§3 Koexistenz → Task 2, Fall „keine Geräte".

**Nicht hier:** Anhänge (Etappe E), Gruppen (G2), das Löschen des
Klartext-Bestands (I), das Umlegen des Schalters (Handarbeit des Eigentümers
mit zwei echten Geräten).

**Die drei Stellen, an denen still und endgültig Daten verlorengehen**, und
die deshalb je einen eigenen Test haben: eine nicht gesicherte Sitzung
(Task 1), eine Quittung vor dem Ablegen (Task 3), und ein quittierter
unlesbarer Umschlag (Task 3). Alle drei sehen im Normalbetrieb wie Erfolg aus.

**Was dieser Plan NICHT löst und was vor dem Umlegen des Schalters geklärt
sein muss:** was geschieht, wenn ein Gerät eine Nachricht bekommt, deren
Sitzung es nicht kennt (etwa nach dem Wiedereinspielen eines alten
Zustands). Heute bleibt der Umschlag liegen und verfällt. Das ist die
sichere Richtung, aber es ist keine Lösung, sondern eine Vertagung.
