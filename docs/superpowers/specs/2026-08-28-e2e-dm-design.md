# Ende-zu-Ende-verschlüsselte Direktnachrichten — Entwurf

**Ziel:** Direktnachrichten, **private Gruppenchats** und ihre Anhänge werden
auf dem Gerät verschlüsselt und auf dem Gerät des Empfängers wieder geöffnet.
Der Pulse-Server bewegt sie, ohne sie lesen zu können, und behält sie nicht.

Private Gruppen gibt es heute nicht und sind damit **neue Funktion**, nicht nur
neue Krypto (§9).

**Schutzziel:** Datensparsamkeit — geschützt wird gegen Datenbank-Leak,
Beschlagnahme, Haftung und neugierige Admins. **Nicht** gegen ein Pulse, das
seine eigenen Nutzer angreift. Dieser Satz entscheidet jede spätere Abwägung:
er erlaubt, dass die Krypto im Browser läuft, dass die Apps ihre Oberfläche
entfernt laden, und dass das Schlüsselverzeichnis vom Server verwaltet wird.

**Krypto:** [vodozemac](https://docs.rs/vodozemac/) 0.10.0, Apache-2.0.
Modul `olm` (Double Ratchet für Gespräche zu zweit), später `megolm` für
Gruppen. Kein libsignal — AGPL-3.0-only, kollidiert mit der Lizenzlage.

**Vorgänger:** `docs/superpowers/plans/2026-08-28-e2e-dm-etappen.md` (Übergabe),
`docs/superpowers/specs/2026-08-27-einladungen-ohne-dm-design.md` (Etappe 1).
Dieser Entwurf **ersetzt** die Etappen 2 bis 7 des Übergabedokuments; die
Koexistenz-Regel in §3 widerspricht dessen Grundsatzentscheidung
„Verschlüsselung ist Pflicht ab Stichtag" bewusst.

---

## 1. Was heute existiert

Eine ehrliche Bestandsaufnahme, weil an genau einer Stelle mehr da ist, als man
erwartet, und an einer anderen weniger.

**Es gibt heute keinerlei Inhaltsverschlüsselung.** HTTPS schützt die Leitung
und endet am Server; jede Direktnachricht liegt im Klartext in
`messages.content` (`models/messages.py:39,48`).

**Es gibt aber bereits ein beglaubigtes Geräteverzeichnis** — bei einem
E2E-System der Teil, an dem die meisten Projekte scheitern. Es wurde für den
Cert-Login gebaut und wird hier weiterverwendet:

| Stück | Wo |
|---|---|
| Ed25519-Paar je Gerät, privater Teil `extractable: false`, in IndexedDB | `web/src/lib/identity/keypair.svelte.ts:15,79-93` |
| Wird bei **jedem** Login und jeder Registrierung angelegt | `runIssueFlow`, aufgerufen aus `routes/login/+page.svelte:118` und `routes/register/+page.svelte:64` |
| Öffentlicher Teil beim Server, von der Cloud signiert | `IssuedCredential`, `services/auth/src/dcc_auth/models_credentials.py:30-84` |
| Ausstellung, max. 20 aktive Geräte, 3 Anfragen/Stunde | `routes_credentials.py:38,40,154-281` |
| Geräteliste und Widerruf | `GET /credentials/list` (`routes_credentials.py:333-337`), CRL, Grabsteine |

Dass jedes angemeldete Gerät bereits einen signierten Schlüssel besitzt, ist
die Voraussetzung dafür, dass dieser Entwurf ohne ein zweites Vertrauenssystem
auskommt.

**Was der DM-Weg heute tut** (Karte, damit später klar ist, was sich ändert):

- Senden: WS-Op `send` (`routes/ws_op_send.py:68`), daneben `POST /channels/{id}/messages` (`routes/messages.py:134`).
- Verteilen: Redis `chat:channel:{id}` (`pubsub_channels.py:11`) bei `ws_op_send.py:281`, dazu `dm_bump` (`:337-345`) und Web-Push (`:354`).
- Verlauf: `GET /channels/{id}/messages` (`routes/messages.py:79`), Cursor über `before`/`after`.
- DM-Liste: `DirectMessageChannel` (`models/channels.py:69`), Paar **sortiert und eindeutig** (`:84-85,93`) — DMs sind strikt zu zweit.
- Vorschautexte: `dm_vorschau.py`, zwei Aufrufstellen — `routes/dms.py:234` und `routes/ws_ready.py:367`.
- Gelesen/Ungelesen: **nur im Klienten**, `web/src/lib/stores/readState.svelte.ts`, `localStorage`. Es gibt serverseitig keine Lesebestätigungen.
- Anhänge: vorsignierter PUT direkt zu MinIO (`routes/attachments.py:206-288`), Abruf über kurzlebige signierte GET-Adressen (`:382-428`, Nachsignieren `:294-326`). In DMs auf der Cloud abgeschaltet (`config.py:155`, geprüft in `:117-131`, Oberfläche versteckt es über `serverCapabilities`).

`MessageAttachment` (`models/messages.py:140-180`) trägt bereits den Docstring:
`mime`/`filename`/`width`/`height` seien „nullable by-design — Phase-2 E2EE DMs
will store ciphertext blobs where the server doesn't know any of those."

---

## 2. Das Modell

### Zwei Schlüssel je Gerät, der zweite huckepack auf dem ersten

Beim ersten Start legt ein Gerät zusätzlich einen **vodozemac-Account** an:
eine Curve25519-Identität plus einen Vorrat an Einmalschlüsseln und einen
Fallback-Schlüssel. Deren öffentliche Teile lässt es von seinem **vorhandenen**
Ed25519-Anmeldeschlüssel unterschreiben und veröffentlicht sie.

Der Gewinn: der Anmeldeschlüssel ist bereits von der Cloud beglaubigt und hat
Widerruf und Sperrliste. Der neue Verschlüsselungsschlüssel erbt diese Kette,
statt eine zweite aufzumachen. Das Ed25519-Paar kann nur signieren — deshalb
braucht es überhaupt ein zweites Paar; ein X25519-Schlüssel aus dem Ed25519
abzuleiten ist zwar mathematisch möglich, aber ein Krypto-Anti-Muster, wenn man
es selbst tut.

Der private Teil bleibt auf dem Gerät. Der Sitzungszustand wird über
`pickle`/`from_pickle` eingefroren und überlebt damit einen Neustart.

### Der Einmalschlüssel-Vorrat ist erschöpfbar, und das ist eingeplant

Wer an ein Gerät schreibt, verbraucht einen von dessen Einmalschlüsseln. Ein
Gerät, das lange nicht online war, kann seinen Vorrat nicht nachfüllen — und
ein Gegenüber kann ihn, ohne etwas zu brechen, aufbrauchen. Deshalb hat jedes
Gerät zusätzlich einen **Rückfallschlüssel**, der nicht verbraucht wird.

Der Preis ist ehrlich zu benennen: Sitzungen, die über den Rückfallschlüssel
aufgebaut werden, haben schwächere Vorwärtssicherheit als solche über einen
frischen Einmalschlüssel — derselbe Schlüssel trägt dann mehrere Sitzungsanfänge.
Signal und Matrix machen dasselbe und aus demselben Grund: die Alternative wäre,
an ein ausgeschaltetes Telefon gar nicht mehr schreiben zu können.

Gemildert wird es an zwei Stellen: Schlüssel bekommt nur, wer der Person auch
schreiben dürfte (dieselbe Freundschafts- und Blockregel wie beim Anlegen einer
DM) — ein Fremder kann einen Vorrat also nicht leerziehen. Und der Klient füllt
nach, sobald er online ist und der Vorrat unter eine Schwelle fällt.

### Der Server hält zwei Dinge, und keine Inhalte

1. **Ein Verzeichnis:** welches Konto hat welche Geräte, mit welchem
   öffentlichen Verschlüsselungsschlüssel und welchen freien Einmalschlüsseln.
2. **Ein Postfach:** verschlüsselte Umschläge, die auf Abholung warten.

Das Verzeichnis lebt im **chat-gateway**, nicht im auth-svc. Grund: ein
Self-Host führt seine eigenen Gespräche und braucht das Verzeichnis lokal;
Dienste teilen bei Pulse keine Tabellen, sondern reden über HTTP oder Redis.

**Wie ein Gerät nachweist, dass es sich selbst meint.** Naheliegend wäre, den
Gateway aus der Verbindung ablesen zu lassen, wer da veröffentlicht — das geht
aber nur auf einem Self-Host. Dort meldet sich der Klient per Cert-Login, und
`credential_validator.py:45-52,220-234` kennt `user_id` und `device_pubkey`.
**Auf der Cloud verbindet sich derselbe Klient mit einem Access-Token, und
darin steht kein Gerät.** Ein Verzeichnis, das nur auf Self-Hosts befüllbar
ist, wäre nutzlos.

Das Gerät legt seinen Nachweis deshalb selbst bei: es schickt sein
Schlüsselbündel zusammen mit seinem **Identitäts-Zertifikat** und einer
Unterschrift über das Bündel. Der Gateway prüft das Zertifikat gegen die
Cloud-JWKS (dieselbe Prüfung, die er ohnehin beherrscht), prüft die
Unterschrift gegen den darin enthaltenen `device_pubkey`, und verlangt, dass
`cert.user_id` mit dem angemeldeten Nutzer übereinstimmt. Das funktioniert auf
Cloud und Self-Host gleich, ohne zweiten Anmeldeweg.

**Geräte werden über `device_pubkey` geführt, nicht über `cert_id`.** Die
Zertifikatserneuerung (`cert-rotation.svelte.ts`) stellt alle 30 Tage ein neues
Zertifikat für **denselben** Pubkey aus — an `cert_id` gebundene Postfächer und
Sitzungen würden dabei monatlich verwaisen.

### Verschickt wird an Geräte, nicht an Personen

Der Absender holt die Gerätebündel des Empfängers, verschlüsselt die Nachricht
**einzeln für jedes Gerät des Empfängers und zusätzlich für jedes eigene
andere Gerät** und übergibt die Umschläge dem Server. Bei zwei Geräten je Seite
sind das vier.

Daraus folgt die Mehrgeräte-Fähigkeit ohne eigenen Abgleich-Mechanismus: ein
vom Handy verschicktes Bild erscheint später auf dem Desktop, weil der Desktop
von Anfang an mitadressiert war — nicht, weil nachträglich synchronisiert wird.

---

## 3. Wann verschlüsselt wird

**Die Regel hängt am Konto, nicht am Programm:** hat ein Konto mindestens ein
dauerhaftes Gerät registriert — Electron-App oder Android-App —, laufen seine
Direktnachrichten verschlüsselt. Hat es keines, bleibt alles wie heute.

Der Grund ist nicht Krypto-Fähigkeit, sondern **Haltbarkeit**. Der Browser kann
verschlüsseln (WebCrypto ist da, der Geräteschlüssel liegt bereits in
IndexedDB). Was er nicht kann, ist etwas verlässlich behalten: Browserdaten
aufräumen, privates Fenster, Verdrängung bei Platzmangel — und weil es kein
serverseitiges Backup gibt, wäre der Verlauf dann endgültig weg. Electron
speichert im App-Profil unter `userData`, Capacitor unter
`/data/data/com.howispulse.app/`; beides überlebt das Aufräumen des Browsers.

Beide Apps laden dieselbe entfernte Web-App (`mobile/capacitor.config.json`:
`server.url = https://howispulse.com/app`). Es gibt keinen getrennten
App-Quellcode — die Erkennung ist `isElectron()` / `isCapacitorAndroid()` aus
`web/src/lib/platform/runtime.ts`, und der Krypto-Kern ist überall derselbe.

**Daraus folgt, dass es keinen nativen Android-Krypto-Pfad braucht.** Die
Kiste läuft auf dem Telefon als WASM in der WebView, nicht über JNI. Ein
nativer Bau (NDK) wäre erst nötig, wenn Pulse eine eigenständige Android-App
bekäme, die ihre Oberfläche mitbringt statt sie zu laden — oder wenn im
Hintergrund ohne WebView entschlüsselt werden müsste, was §8 ausschliesst.

Daraus folgt:

| Lage | Verhalten |
|---|---|
| Beide Seiten haben ein App-Gerät | verschlüsselt, Anhänge frei |
| Eine Seite hat keines | heutiger Weg, ruhiger Hinweis im Gesprächskopf; schaltet automatisch um, sobald sie eines einrichtet |
| Browser, aber das Konto hat ein Handy | Browser koppelt sich als weiteres Gerät und macht verschlüsselt mit |
| Konto ganz ohne App | heutiger Weg, Verlauf beim Server, keine Anhänge |

`cloud_dm_attachments_enabled` bleibt und bedeutet künftig „Anhänge im
**unverschlüsselten** Weg" — also weiterhin aus. Anhänge sind der sichtbare
Gegenwert für das Installieren der App.

Der Umschaltmoment ist die einzige erklärungsbedürftige Stelle: ab da vergisst
der Server mit. Was vorher im Klartext liegt, bleibt liegen, bis es aufgeräumt
wird (§8).

### 3a. Diese Regel ist überholt (Entscheidung vom 2026-08-29)

**Die Tabelle oben beschreibt nicht mehr, was gebaut werden soll.** Sie steht
hier, weil der Code sie heute noch umsetzt und weil die Begründungen darunter
weiter gelten; die Regel selbst ist ersetzt durch:

> **Ohne App-Gerät gibt es keine Direktnachrichten.** Wer weder die
> Desktop-App noch eine Mobil-App hat und auch keinen Browser gekoppelt hat,
> kann keine Direktnachrichten senden. Damit ist **jede** Direktnachricht
> verschlüsselt, und der unverschlüsselte Weg entfällt ersatzlos.

**Warum.** Die Koexistenz war der Preis dafür, niemanden auszusperren. Sie
kostet dafür an jeder Stelle eine Fallunterscheidung — und die hat in sechs
Bughunt-Runden wiederholt Fehler getragen: Antworten fielen still auf Klartext
zurück, ein vorübergehender Lesefehler ebenso, die Büroklammer versprach etwas,
das der Sendeweg gleich darauf verweigerte. Eine Regel ohne Ausnahme kann
solche Fehler nicht haben.

Das Vorbild ist nicht neu: WhatsApp Web und Signal Desktop verlangen dasselbe,
aus demselben Grund — bei Ende-zu-Ende-Verschlüsselung ist das Gerät die
einzige Kopie, und ein beliebiger Browser-Tab kann das nicht tragen.

**Was dadurch entfällt** (und damit nicht mehr gepflegt werden muss): der
Klartext-Sendeweg für DMs, der Koexistenz-Rückfall, die Frage „läuft dieses
Gespräch verschlüsselt?" samt der Auskunft, die dafür gebaut wurde, und die
Fallunterscheidung bei Anhängen, Vorschautexten und der Suche.

**Was dadurch nötig wird:**

1. **Ein Weg hinein für Leute ohne App.** Eine leere Liste ist keine Antwort.
   Wer ohne App auf die Direktnachrichten geht, braucht eine Stelle, die sagt,
   was fehlt und wie er es bekommt — inklusive des Kopplungswegs (Etappe F),
   der den fremden Rechner ohne Installation einbindet.
2. **Ein gekoppelter Browser zählt — aber er verfällt.** Entschieden am
   2026-08-29 nach dem WhatsApp-Vorbild: ein gekoppelter Browser ist ein
   vollwertiges Gerät, seine Kopplung läuft aber nach **14 Tagen ohne
   Benutzung** ab. Danach ist er kein Empfänger mehr, sein Schlüsselbündel
   fällt weg, und er muss neu gekoppelt werden.

   **Zwei Dinge gehören zwingend dazu**, sonst ist der Ablauf eine leere
   Geste. Erstens muss der abgelaufene Browser seinen **lokalen Verlauf
   löschen**, wenn er das nächste Mal geöffnet wird — genau der Fall „auf dem
   fremden Rechner gekoppelt und vergessen" ist der Grund für diese Regel, und
   dort nützt es nichts, wenn nur die Schlüssel verfallen, während der Verlauf
   liegen bleibt. Zweitens braucht der Server dafür ein echtes **„zuletzt
   benutzt" je Gerät**, das es heute nicht gibt: `DeviceKeyBundle.updated_at`
   ist der Zeitpunkt der letzten *Veröffentlichung*, nicht der letzten
   Benutzung. Das ist dieselbe Lücke, die die Verdrängung bei 20 Geräten heute
   in die falsche Richtung ziehen lässt (ein lange angemeldetes Gerät gilt dort
   als das älteste, gerade weil es sich nicht neu meldet) — beide werden von
   demselben Feld geheilt.

   Der Ablauf gilt **nur für gekoppelte Browser**, nicht für Desktop- und
   Mobil-Apps. Die bringen ihre Dauerhaftigkeit selbst mit; ein Telefon, das
   drei Wochen in der Schublade liegt, soll seine Gespräche behalten.
3. **Die bestehenden unverschlüsselten Direktnachrichten verschwinden.**
   Entschieden am 2026-08-29: **sofort löschen, ohne Frist** — die Alternativen
   (übernehmen und dann löschen, Frist mit Vorwarnung, nur ausblenden) wurden
   ausdrücklich verworfen.

**Zur Löschung, verbindlich:** sie ist ein **eigener, ausdrücklich ausgelöster
Schritt**, niemals eine Nebenwirkung eines Deploys. Sonst entscheidet der
Zeitpunkt eines Container-Neustarts über die Daten der Nutzer. Vorher wird eine
frische Sicherung nachgewiesen — nicht als Vorbehalt gegen die Entscheidung,
sondern weil bei einem Fehler im Löschweg die Sicherung den Unterschied
zwischen Ärger und Katastrophe macht. Betroffen sind ausschliesslich
Nachrichten in DM-Kanälen samt ihrer Anhänge; Community-Kanäle bleiben
unangetastet.

---

## 3b. Das Gerätezertifikat ist weg — der Geräte-Nachweis wird eigenständig

**Entscheidung vom 2026-08-30.** Parallel zu dieser Arbeit ist auf `main` am
2026-08-28 die Anmeldung radikal vereinfacht worden: Gerätezertifikate,
Ausstellung, Widerruf, Sperrliste und Cert-Login sind ersatzlos entfernt,
angemeldet wird über ein kurzlebiges Cloud-Ticket, das gegen eine
Server-Sitzung getauscht wird. Grund waren massive Probleme bei der
Einrichtung von Self-Host-Servern. **Das bleibt so.** Dieser Entwurf baute auf
den Zertifikaten auf und wird darauf umgestellt.

### Was nachgesehen wurde

**Auf `main` identifiziert nichts ein Gerät.** Der Sitzungs-Token trägt eine
Kennung (`cert_id` = die `jti` des eingelösten Tickets), aber die ist bei jeder
Anmeldung und bei jedem stündlichen Auffrischen neu und wird von keiner Stelle
gelesen. Es gibt keine Sitzungstabelle auf dem Self-Host, und im Web-Klienten
kein gerätegebundenes Geheimnis mehr — die Suche nach Schlüsselerzeugung im
ganzen Baum liefert null Treffer. Eine zweite Anmeldung verdrängt die erste
nicht, sie steht daneben.

**Auf diesem Zweig hängt der Nachweis an vierzehn Stellen an einer
Geräte-Identität** (Olm ist Gerät-zu-Gerät: Sitzungen je Gerätepaar, Umschläge
an ein Gerät, Quittungen von einem Gerät) und an etwa zwölf Stellen am
Zertifikat als beglaubigtem Papier. Die Krypto selbst — Olm-Identität,
Einmalschlüssel, Sitzungen — kennt weder Zertifikat noch Konto.

### Die Einsicht

**Das Zertifikat hat eine Arbeit geleistet, die die Anmeldung schon leistet.**
Es bewies dem Server „dieses Gerät gehört zu diesem Konto" — aber ein
Schlüsselbündel wird immer nur ins EIGENE Konto geschrieben, und welches das
ist, sagt die Sitzung bereits. Gegen einen Angreifer half es nie: wer eine
Sitzung stiehlt, hätte sich damit früher auch ein Zertifikat ausstellen
lassen.

Die Gerätekennung braucht deshalb keine Beglaubigung von aussen. **Die
Verschlüsselung bringt ihre eigene mit**: die Olm-Identität ist bereits ein
Schlüsselpaar je Gerät, im Gerät erzeugt und nicht auslesbar.

### Das neue Modell

1. **Geräte-Identität gehört der Krypto-Schicht.** Sie entsteht beim ersten
   Start, liegt neben dem Olm-Account in der IndexedDB und verlässt das Gerät
   nie. Sie ist der Bezeichner, den die vierzehn Stellen brauchen.

   **Korrektur vom 2026-08-30, beim Bauen aufgefallen:** dieser Punkt stand
   hier zu grob. Die Frage zerfällt in zwei, und die Antwort ist verschieden.
   Die **Kennung** ist öffentlich und muss nur stabil, vergleichbar und
   identisch mit dem sein, was der Server gespeichert hat — dafür braucht es
   kein eigenes Schlüsselpaar. Der **Pickle-Schlüssel** dagegen ist geheim und
   kann **nicht** aus der Olm-Identität stammen: er wird gebraucht, BEVOR der
   Olm-Account überhaupt geöffnet werden kann. Er ist deshalb ein eigenes,
   nicht auslesbares Geheimnis neben dem Account (rohe Bytes wären beim ersten
   Auskippen der IndexedDB mit weg).

   **Und die Kennung bleibt derselbe Wert wie bisher, nur die Quelle
   wechselt.** Eine neue Kennung wäre kein Umzug, sondern ein zweites, leeres
   Gerät neben dem eigenen: der Server hat das Bündel unter dem alten Wert
   abgelegt, und jede bestehende Olm-Sitzung trägt ihn in ihrem
   Speicherschlüssel.
2. **Schlüssel veröffentlichen weist sich über die Sitzung aus**, nicht über
   ein Zertifikat. Der Geräteschlüssel im Bündel ist selbstbehauptet — das ist
   tragfähig, weil er ausschliesslich in die eigene Geräteliste schreibt.
3. **`pruefe_geraet` entfällt** samt Unterschrift, `baue_nutzlast`, den
   dreizehn Zwecken und ihrem Prüfstein. An seine Stelle tritt „welches Konto
   ist angemeldet" plus „welches Gerät behauptet der Aufrufer zu sein".
4. **Widerruf wird sichtbar statt kryptographisch.** Bisher trug ihn die
   Sperrliste des Zertifikats. Künftig eine Geräteliste mit „entfernen" — der
   Weg, den Signal und WhatsApp auch gehen, und der bessere: der Nutzer sieht,
   wer mitliest, statt es einer Sperrliste zu überlassen.
5. **Die Kopplung braucht keinen eigenen Nachweis mehr.** Beide Seiten sind
   ohnehin als dasselbe Konto angemeldet; der Kopplungscode beweist, dass
   dieselbe Person beide Geräte hält. Das war schon immer seine Aufgabe.

### Was dabei verloren geht — ausgesprochen

Der Server bescheinigt Geräte nicht mehr. Wer eine Kontositzung übernimmt,
kann ein eigenes Gerät eintragen und ab dann mitlesen. **Das war mit
Zertifikaten nicht anders** (eine übernommene Sitzung durfte sich eines
ausstellen lassen), aber es ist jetzt der einzige Schutzwall, und deshalb ist
die Geräteliste aus Punkt 4 kein Beiwerk, sondern die Stelle, an der ein
Nutzer das bemerken und beenden kann.

### Reihenfolge — der eine Punkt, der nicht verschiebbar ist

**Der Pickle-Schlüssel muss ZUERST umgestellt werden.** Er wird heute aus dem
Ed25519-Anmeldeschlüssel abgeleitet (`account.svelte.ts::pickelschluessel-
DesGeraets` → `loadKeypair()`), und genau der ist auf `main` gelöscht. Fällt er
weg, bevor die Ableitung auf einen krypto-eigenen Schlüssel umgestellt ist,
lässt sich eingefrorener Olm-Zustand nicht mehr auftauen — der lokale Verlauf
ist dann unwiederbringlich, und ein Rückfall ist an der Stelle ausdrücklich
verboten. Heute trifft das niemanden (die Schalter sind aus, es gibt keinen
echten Bestand), auf einer Entwicklermaschine mit Testdaten aber sehr wohl.

Danach: Geräte-Identität einführen · `pruefe_geraet` ersetzen und die dreizehn
Aufrufer nachziehen · `cert_id` und die Sperrlisten-Filterung aus dem
Schlüsselverzeichnis nehmen · Geräteliste bauen · Kopplungs-Nachweis auf die
Sitzung umstellen.

**Stand 2026-08-30.** Erledigt: Pickle-Schlüssel, Geräte-Identität,
`pruefe_geraet`, alle dreizehn Aufrufer, `cert_id` samt Sperrlisten-Filterung
und der Kopplungs-Nachweis (er fiel mit den übrigen zwölf, ohne eigenen
Schritt). Die `cert_id` musste mitkommen, obwohl sie als eigener Schritt
notiert war: mit `pruefe_geraet` verlor sie ihre einzige Quelle, und eine
Spalte weiterzuführen, die niemand befüllen kann, wäre eine Behauptung ohne
Deckung gewesen. Mit ihr fiel `device_key_bundles.signatur` — die
Selbstunterschrift des Geräts über sein eigenes Bündel, die gespeichert und
weitergereicht, aber von keiner Fassung des Klienten je geprüft wurde
(Migration 0079).

**Offen bleibt allein die Geräteliste (Punkt 4), und sie ist damit zur
Voraussetzung geworden**, nicht mehr zum Beiwerk: bis es sie gibt, hat ein
Konto keinerlei Widerruf für ein einzelnes Gerät. Vorher trug ihn die
Sperrliste des Zertifikats; die ist weg, der Ersatz noch nicht gebaut.

---

## 4. Zustellung und Löschen

Verschlüsselte Nachrichten gehen **nicht** in `messages`, sondern in ein
Postfach je Empfängergerät. Der Grund ist das Fächern: eine Nachricht wird zu
mehreren Umschlägen, jeder wird einzeln quittiert und einzeln gelöscht.
`messages` bleibt unberührt und trägt weiter unverschlüsselte DMs und alle
Community-Kanäle.

Das Postfach besteht aus **zwei** Tabellen, und diese Trennung ist der Grund,
warum Gruppen (§9) ohne Sonderweg dazupassen:

1. **Die Nutzlast** — der verschlüsselte Umschlag selbst, mit Kanal,
   Absendergerät, Typ (Sitzungsaufbau oder laufend) und Eingangszeit.
2. **Die Zustellung** — je Empfängergerät eine Zeile, die auf eine Nutzlast
   zeigt, mit Frist und Quittungsstand.

Bei einer DM ist die Nutzlast für jedes Gerät eine andere (Olm verschlüsselt je
Empfänger einzeln), es gibt also so viele Nutzlasten wie Zustellzeilen. Bei
einer Gruppe ist die Nutzlast für alle **dieselbe** (Megolm), und viele
Zustellzeilen zeigen auf eine. Eine Nutzlast wird gelöscht, sobald ihre letzte
Zustellzeile weg ist.

**Geführt wird nach Gerät und Kanal, nicht nach DM-Paar** — das ist die
Voraussetzung dafür, dass dasselbe Postfach jede Kanalart trägt.

Der Verteilweg bleibt derselbe: dieselben Redis-Kanäle, dieselben Sockets, nur
mit einem Umschlag statt Text als Nutzlast.

**Gelöscht wird zweifach:** sobald ein Gerät quittiert, fällt seine Zeile weg;
was nach einer Frist niemand abgeholt hat, fällt ebenfalls weg. Die Frist
gehört in die Einstellungen, Vorbild ist `push_subscription_idle_days`.

**Folge für die DM-Liste:** `dm_bump` trägt heute den Vorschautext mit. Der
fällt weg — der Server kennt ihn nicht mehr. Die **Sortierung** überlebt (der
Server weiß weiterhin, *dass* etwas ankam), den **Text** ergänzt der Klient aus
seinem lokalen Speicher.

---

## 5. Anhänge

Der heutige Weg passt fast unverändert, weil die Bytes ohnehin direkt zwischen
Klient und MinIO fließen und der Gateway sie nie sieht.

Neu ist nur: der Klient erzeugt je Datei einen Zufallsschlüssel, verschlüsselt
die Bytes damit und lädt den Klumpen hoch. Der Dateischlüssel reist **in der
verschlüsselten Nachricht** mit. Vorschaubild und Bildmaße erzeugt der Klient
selbst und verschlüsselt sie genauso — sonst springt beim Empfänger das Layout,
weil der Server die Maße nicht mehr kennt.

Der Server speichert zu einem verschlüsselten Anhang **keinen Dateinamen,
keinen Typ und keine Maße**. `MessageAttachment` ist dafür bereits gebaut.

Anhänge werden zusammen mit ihrer letzten Postfachzeile gefegt — ein Anhang
ohne Umschlag, der ihn öffnen könnte, ist Müll.

---

## 6. Geräte koppeln und Verlaufsumzug

QR-Code am alten Gerät, abscannen am neuen, **zusätzlich als Textcode
eintippbar** — für Barrierefreiheit und damit es ohne Kamera prüfbar ist.

Dabei passieren zwei Dinge: das neue Gerät veröffentlicht seine Schlüssel, und
das alte schiebt seinen **vollständigen** Verlauf hinüber. Verschlüsselt, in
Stücken, fortsetzbar, mit Fortschrittsanzeige — bei Jahren an Bildern ist das
kein Knopfdruck.

Die Kopplung ist zugleich der **einzige Rettungsweg** bei Geräteverlust, weil
es kein serverseitiges Backup gibt. Wer nur ein Gerät hat und es verliert,
verliert seinen Verlauf endgültig. Die App muss aktiv zu einem zweiten Gerät
drängen; ein einmaliger Hinweis reicht dafür nicht.

**Falle im Bestand:** ein Konto darf 20 aktive Geräte haben, und beim 21. wird
das älteste **stillschweigend verdrängt** (`_MAX_ACTIVE_CERTS`,
`routes_credentials.py:38`). Heute bedeutet das „dort neu anmelden". Nach der
Umstellung bedeutet es „dieses Gerät kann nichts Neues mehr entschlüsseln", und
der Nutzer erfährt es nicht. Die Verdrängung braucht eine sichtbare Meldung.

### Was davon gebaut ist (Stand 2026-08-29)

Hinter `GERAETE_KOPPLUNG_ENABLED` (`web/src/lib/krypto/schalter.ts`, **aus**).
Die vollständige Sicherheitsabwägung zum Code steht im Kopf von
`services/chat-gateway/.../routes/kopplung.py`, die Begründung des
Transportwegs in `routes/kopplung_umzug.py`.

- **Kopplung:** Code (20 Zeichen Crockford-Base32, 100 Bit) am alten Gerät,
  eintippbar am neuen. Der Server sieht nur `SHA-256(Code)`; der Schlüssel der
  Umzugsstücke wird per HKDF aus dem Code abgeleitet, der die Leitung nie
  überquert. Einmal einlösbar (atomares `UPDATE … WHERE eingeloest_am IS
  NULL`), 10 Minuten gültig. Das neue Gerät veröffentlicht beim Einlösen seine
  Schlüssel.
- **Umzug:** eigene Tabellen (`kopplungen`, `umzug_stuecke`, Migration 0074),
  **nicht** das Postfach — das verlangt einen DM-Kanal, den es zwischen zwei
  Geräten desselben Kontos nicht gibt, deckelt bei 50 offenen Zustellungen je
  Absender/Gerät und wäre als Olm-Strom nicht wiederholbar. Stücke à ≤512 KiB
  unter AES-GCM, Position in den AAD. Fortsetzbar über
  `vorhandene_stuecke` aus `POST /kopplung/stand`.
- **Anhang-Bytes ziehen NICHT mit.** Die Angaben (Name, Grösse, Masse) reisen
  im Satz mit, die Bytes bleiben auf dem alten Gerät; die Oberfläche sagt das
  an. Grund: es sind Blobs, und das Abrufrecht im Objektspeicher hängt an
  einer offenen Zustellung, die es beim Umzug nicht gibt.
- **Offen:** QR (der Klient hat keine QR-Bibliothek, und eine serverseitig
  gerenderte Grafik scheidet aus — der Code darf den Server nicht erreichen),
  die sichtbare Meldung bei der 20-Geräte-Verdrängung, und das aktive Drängen
  zu einem zweiten Gerät.

---

## 7. Der Klient bekommt ein Gedächtnis

Das ist der größte Posten des Vorhabens, und er hat mit Krypto nichts zu tun.
Der Klient ist heute ein Fenster auf den Server; er muss ein Speicher werden.

Was heute der Server rechnet und künftig lokal entsteht:

- die Nachrichtenliste selbst (`MessageStore.byChannel` hält sie heute nur
  flüchtig, LRU-begrenzt auf 15 Kanäle),
- die Vorschautexte der DM-Liste — **zwei** Aufrufstellen, `routes/dms.py:234`
  und der `ready`-Rahmen (`ws_ready.py:367`), der die Liste im Klienten
  überschreibt,
- das Nachladen beim Hochscrollen, heute über Server-Cursor.

Gelesen/Ungelesen liegt **bereits heute** nur im Klienten und bleibt, wie es
ist — ein Stück weniger Umbau als erwartet. Es ist dabei mehr als ein
Lesezeichen: neben dem Marker je Kanal wird auch ein Zähler geführt
(`pulse.unread.<uid>`), und beide sind auf das beschränkt, was der Klient
**während einer laufenden Sitzung** gesehen hat.

**Ein Fehler im Bestand, den dieser Umbau nebenbei behebt:** `upsertFromBump`
fasst `last_message_preview` nicht an. Kommt eine Nachricht live herein,
rückt die DM-Liste in der Sortierung nach, ihr Vorschautext bleibt aber der
alte, bis neu geladen wird. Sobald der Text lokal entsteht, ist immer der
richtige da — die Ursache verschwindet, statt behandelt zu werden.

**Und ein Stück, das ersetzt werden MUSS:** es gibt heute eine
WhatsApp-artige Suche über die eigene DM-Historie —
`GET /dm-channels-search` (`routes/dms.py:261`), serverseitig per SQL `ilike`
über `messages.content`, benutzt von `MobileChatsSuche.svelte` im Bereich
„Chats" am Telefon. Sie ist ausgeliefert und sichtbar.

**Diese Route kann E2E nicht überleben** — sie liest genau das, was der Server
künftig nicht mehr hat. Die Suche muss lokal neu gebaut werden, über den
Bestand, den dieser Umbau anlegt.

Das hat eine Folge, die man beim Zuschneiden von Etappe C leicht übersieht:
**eine lokale Suche ist nur so vollständig wie der lokale Verlauf.** Wer den
lokalen Speicher begrenzt, begrenzt damit auch, was auffindbar ist — und
zwar unsichtbar, weil eine Suche ohne Treffer nicht sagt, ob es keinen gibt
oder ob sie nur nicht so weit zurückreicht. Die Obergrenze und die Suche sind
deshalb **eine** Entscheidung, nicht zwei.

Dieser Umbau kommt **vor** der Verschlüsselung und zunächst mit lesbaren Daten.
Steht er, ist der Rest ein Austausch der Nutzlast.

---

## 8. Was danach nicht mehr geht

Diese Punkte sind Folgen, keine Fehler — sie gehören vor der Umsetzung
entschieden, nicht danach entdeckt.

- **Benachrichtigungen werden generisch.** Der Server kennt den Inhalt nicht;
  auf dem Sperrbildschirm steht „Neue Nachricht von …". Entschlüsselt wird
  beim Öffnen. Der Service Worker entschlüsselt **nicht** — der Double Ratchet
  hat Zustand, und zwei Stellen, die gleichzeitig daran drehen, beschädigen ihn.
- **Android hat heute gar keine Benachrichtigungen** (Capacitor-WebView kann
  kein Web-Push). Verschlüsselte DMs auf dem Handy sind ohne einen Weckruf über
  Data-only-FCM nur halb nützlich. Braucht ein Firebase-Projekt und ein echtes
  Gerät — der einzige Punkt des Vorhabens, der an Hardware hängt.
- **Moderation in DMs endet.** Eine gemeldete Direktnachricht kann niemand mehr
  nachlesen. Das ist bei WhatsApp genauso und meist gewollt, muss aber eine
  Entscheidung sein.
- **Die serverseitige DM-Suche entfällt — sie existiert und wird benutzt.**
  `GET /dm-channels-search` sucht heute per SQL im Klartext; am Telefon hängt
  die Suche im Bereich „Chats" daran. Sie muss lokal nachgebaut werden, sonst
  verlieren Nutzer eine sichtbare Funktion. **Das ist eine eigene Aufgabe in
  Etappe C** und keine Nebenwirkung, die sich von selbst erledigt.
- **Altbestand.** Der Klartext-Verlauf bleibt zunächst liegen. Vorwarnung,
  Frist, Löschlauf — klein, aber der Moment, in dem Nutzer sichtbar etwas
  verlieren.

---

## 9. Private Gruppen

Private Gruppenchats sind Teil dieses Vorhabens. **Es gibt sie heute nicht** —
`DirectMessageChannel` ist per `CheckConstraint` und Unique-Index hart auf zwei
Personen verdrahtet (`models/channels.py:84-85,93`). Es kommt also eine neue
Kanalart samt Mitgliederverwaltung dazu; das ist neue Funktion, nicht nur neue
Krypto.

Daraus folgt die wichtigste Vereinfachung des ganzen Entwurfs: **weil es keinen
Altbestand gibt, werden Gruppen von Geburt an verschlüsselt.** Kein
Rückfallweg, keine Koexistenz-Regel, kein Umschaltmoment. **Teilnahme setzt ein
App-Gerät voraus** — wer nur im Browser sitzt und kein dauerhaftes Gerät hat,
kann einer Gruppe nicht beitreten und wird beim Hinzufügen mit Begründung
abgelehnt. Eine gemischte Gruppe gäbe es sonst nur unverschlüsselt, und dann
wäre für alle anderen der Schutz weg.

### Wie verschlüsselt wird

vodozemacs `megolm`-Modul. Megolm ersetzt Olm nicht, es sitzt darauf: der
Absender erzeugt einen Gruppenschlüssel, verschlüsselt die Nachricht **einmal**
damit, und verteilt den Gruppenschlüssel einzeln an jedes Gerät jedes
Mitglieds — über die 1:1-Olm-Sitzungen aus §2. Ohne Olm kein Megolm; die
1:1-Arbeit ist Fundament, keine Vorstufe zum Wegwerfen.

Der Grund für die zwei Verfahren ist die Menge: bei 20 Mitgliedern mit je zwei
Geräten wären es sonst 40 verschlüsselte Kopien **pro Nachricht**. Mit Megolm
ist es eine Kopie plus 40 kleine Schlüsselumschläge — und die nur, wenn sich
der Gruppenschlüssel ändert.

### Mitgliedschaft — hier liegt die eigentliche Arbeit

- **Wer geht oder entfernt wird, darf nichts Neues mehr lesen.** Also wird bei
  jeder Änderung der Mitgliederliste ein **neuer Gruppenschlüssel** erzeugt und
  verteilt. Ohne diesen Wechsel liest ein Hinausgeworfener weiter mit.
- **Wer dazukommt, sieht den Verlauf davor nicht** — er hatte den alten
  Schlüssel nie. Das ist Absicht und muss in der Oberfläche stehen, sonst wirkt
  es wie ein Fehler.
- **Der Schlüssel wird auch ohne Anlass gewechselt**, nach Anzahl Nachrichten
  oder Zeit. Megolm hat schwächere Vorwärtssicherheit als Olm: wer einen
  Gruppenschlüssel erbeutet, liest alles, was mit ihm noch verschlüsselt wird.
  Regelmässiger Wechsel begrenzt das Fenster.
- **Rechte bleiben einfach:** wer die Gruppe anlegt, darf hinzufügen und
  entfernen; jedes Mitglied darf selbst gehen. Keine Rollen, keine Overwrites —
  das ist der Unterschied zu einer Community.
- **Obergrenze** für die Mitgliederzahl, damit die Schlüsselverteilung
  beherrschbar bleibt.

### Was Gruppen mit dem Rest teilen

Postfach, Löschpolitik, Anhänge, lokaler Verlauf und Gerätekopplung sind
dieselben wie bei DMs — deshalb sind sie in §4 bis §7 bereits nach **Gerät und
Kanal** entworfen und nicht nach „DM-Paar". Der Fächer-Aufsatz aus §4
(Nutzlast einmal, Zustellzeile je Gerät) trägt beide Fälle ohne Sonderweg: bei
einer DM ist die Nutzlast je Gerät verschieden, bei einer Gruppe für alle
dieselbe.

### Community-Kanäle bleiben unverschlüsselt

Sie leben davon, dass der Server die Inhalte kennt: Verlauf für neue
Mitglieder, Moderation, Rechte-Overwrites, Plugins, Suche. Die Trennlinie ist
**privat und klein → verschlüsselt, öffentlich und geteilt → wie bisher**.
Discord verschlüsselt aus denselben Gründen nur Sprache, nicht Text.

---

## 10. Schnitt in Etappen

Jede Etappe braucht vor der Umsetzung einen eigenen Plan.

| | Etappe | Prüfbar durch | Hängt an |
|---|---|---|---|
| A | Krypto-Kern: Rust-Kiste `pulse-krypto` um vodozemac (Olm **und** Megolm), WASM-Ausgabe | `cargo test`, Node-Läufer | nichts |
| B | Schlüsselverzeichnis: Veröffentlichen, Abrufen, Einmalschlüssel-Vorrat und Nachfüllen | pytest, Playwright | A |
| C | Lokaler Verlauf im Klienten, noch mit lesbaren Daten — **in C1 bis C4 aufgeteilt**, s. unten | Node-Läufer, Playwright | nichts (parallel zu A/B möglich) |
| D | Verschlüsselte Zustellung: Postfach (Nutzlast + Zustellung), Quittung, Frist | pytest | A, B, C |
| E | Anhänge im verschlüsselten Weg | pytest, Playwright | D |
| F | Geräte koppeln und Verlaufsumzug | Playwright (Textcode-Weg) | A, B, C |
| G | Private Gruppen: neue Kanalart, Mitgliederverwaltung, Megolm-Sitzungen, Schlüsselwechsel | pytest, Playwright | D |
| H | Android-Weckruf (Data-only-FCM) | nur am Gerät | Firebase, Hardware |
| I | Altbestand: Vorwarnung, Frist, Löschlauf | pytest | D |

**A und C sind die beiden Enden, an denen begonnen werden kann**, und sie
behindern sich nicht. A ist klein und geschlossen, C ist der große Brocken.

**C ist zu gross für einen Plan** (das Übergabedokument schätzt drei bis fünf
Wochen) und deshalb aufgeteilt:

| | Was | Verhaltensänderung |
|---|---|---|
| C1 | Lokaler Speicher, **nur Schreiben** — alles, was ankommt, wird zusätzlich abgelegt | keine |
| C2 | Verlauf wird **lokal gelesen**, der Server nur noch bei einer Lücke gefragt | spürbar |
| C3 | Vorschautexte der DM-Liste entstehen lokal (die zwei Server-Aufrufstellen fallen) | spürbar |
| C4 | Sortierung und Ungelesen-Stand aus dem lokalen Bestand | spürbar |
| C5 | **Suche lokal** — Ersatz für `GET /dm-channels-search`, das E2E nicht überlebt | spürbar |

C1 ist der einzige Schnitt ohne Risiko: ist der Speicher gefüllt und stimmt
sein Inhalt, sind C2 bis C4 Umschaltungen. Wer gleich lokal liest, debuggt
Speicher und Anzeige gleichzeitig. Plan für C1:
`docs/superpowers/plans/2026-08-28-etappe-c1-lokaler-verlauf.md`.

**Drei Etappen sind in zwei Hälften zerfallen**, und zwar erst beim Bauen —
die Tabelle oben nennt jeweils nur die erste. Server- und Klienten-Hälfte
sind getrennt planbar und getrennt prüfbar, und genau daran ist die
Aufteilung entstanden:

| | Server-Hälfte | Klienten-Hälfte |
|---|---|---|
| B | `etappe-b-schluesselverzeichnis.md` | `etappe-b2-klient-veroeffentlicht.md` |
| D | `etappe-d-postfach.md` | `etappe-d2-klient-verschluesselt.md` |
| G | `etappe-g1-private-gruppen-kanal.md` (Kanalart) | G2 (Megolm) — noch nicht geplant |

**Der Grund, warum das hier steht:** eine frühere Fassung behauptete, G sei
die einzige Etappe mit zwei Hälften. Das war beim Schreiben richtig und
wurde falsch, als B und D beim Bauen genauso zerfielen — und wer die
Plandateien gegen diese Liste hielt, fand drei davon nicht wieder.

**G bleibt der Sonderfall in einer anderen Hinsicht:**
die Kanalart samt Mitgliederverwaltung ist gewöhnliche Produktarbeit und
unabhängig von der Krypto prüfbar; die Megolm-Sitzungen und der
Schlüsselwechsel setzen D voraus. Wer sie zusammen angeht, verliert die
Möglichkeit, die eine Hälfte allein rot werden zu sehen.

---

## 11. Randbedingungen

- **Kein GPL/AGPL.** vodozemac ist Apache-2.0. libsignal ist ausgeschlossen.
- **Quelldateien ≤ 350 Zeilen (hart 500), Svelte-Komponenten ≤ 250.**
- **Alembic-Revision-ID ≤ 32 Zeichen.**
- **Niemals Schlüssel, Umschläge oder Klartext loggen.** Auch nicht gekürzt.
- **Node-Unit-Tests:** eine geprüfte Datei darf keinen erweiterungslosen
  Laufzeit-Import haben. Reine Rechnung gehört in ein importfreies Modul
  (Muster: `lib/remote/zeigerbildPruefung.ts`).
- **Prüfen vor dem Landen:** `bash scripts/gate.sh`. Playwright hängt in keinem
  Gate — „Gate grün" ist nicht „E2E grün".
- **Merge nach `main` ist ein Prod-Deploy** und braucht Freigabe.
- **Changelog:** user-sichtbare Änderungen brauchen einen Eintrag in
  `web/static/changelog.json`, Stil vom Eigentümer wählen lassen, keine Emojis,
  echte Umlaute.

## 12. Werkzeuge

Auf dieser Maschine bereits eingerichtet (2026-08-28):
`rustup target add wasm32-unknown-unknown`, `cargo install wasm-pack` (0.15.0,
liegt unter `~/.cargo/bin`, das nicht in jedem PATH steht).

Noch nicht eingerichtet, erst für den Android-Cross-Build nötig:
`rustup target add aarch64-linux-android armv7-linux-androideabi` und ein
Android-NDK.
