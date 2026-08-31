# Ablage-Kanäle, eigene Laufwerke, persönliches Archiv — Entwurf

> Entscheidungen des Eigentümers vom 2026-08-31, gefällt Punkt für Punkt.
> Ersetzt Teile von `docs/user-gehostete-kanaele-konzept.md` §2a — die
> abweichenden Stellen sind hier ausdrücklich benannt (§9).
> Zweig: `feat/e2e-dm-krypto-weg-a`.

---

## 0. Ergebnis in einem Satz

Ein Kanal lebt auf dem Cloud-Laufwerk seines Erstellers; **gelesen wird direkt
von dort**, **geschrieben wird immer über Pulse** (verschlüsselt), und wer
beitreten darf, bekommt beim Beitritt den Schlüssel dazu.

---

## 1. Die Kernaufteilung

Zwei Richtungen, zwei Wege — daraus folgt fast alles Weitere:

| Richtung | Weg | Warum nicht anders |
|---|---|---|
| **Lesen** (Verlauf, Dateien) | direkt vom Laufwerk des Erstellers | Der Verlauf ist dann auch da, wenn der Ersteller seit Wochen offline ist. Genau das war die Schwäche des reinen Pulse-Wegs. |
| **Schreiben** (neue Nachricht, Datei-Upload) | über Pulse, verschlüsselt | Ein Mitglied hat auf einem fremden Google Drive keinen Schreibzugriff, und es soll auch keinen bekommen. Ein Gerät des Erstellers **festigt** danach in die Ablage. |

Das ist keine Notlösung, sondern deckt sich mit dem, was im Zweig schon steht:
Postfach → `nachzieher.ts` → `schreiber.ts` ist genau diese Festigung.

**Ehrliche Folge:** Ist kein Gerät des Erstellers erreichbar, bleiben neue
Nachrichten im Postfach liegen und wandern erst später ins Archiv. Sie sind
in der Zwischenzeit trotzdem lesbar (aus dem Postfach). Sichtbar gemacht wird
das durch den Verbindungszustand (§6).

---

## 2. Speicher und Anbieter

### 2.1 Getragene Anbieter

| Anbieter | Stand | Rolle |
|---|---|---|
| **Google Drive** | gebaut, live erprobt | Vollwertig, auch im Browser lesbar |
| **Nextcloud** (WebDAV) | Adapter gebaut, gegen NC 34 erprobt | Vollwertig; Leseweg im Browser über §4.2 |
| **Dropbox** | gebaut, live erprobt | Vollwertig |
| ~~OneDrive~~ | gebaut, nie echt gelaufen | **Entfällt vorerst** — braucht Azure-Konto mit Kartenprüfung |
| ~~S3~~ | gebaut | **Entfällt vorerst** — Zielgruppe zu schmal |

Die Adapter für OneDrive und S3 bleiben im Baum, werden aber in der
Oberfläche nicht angeboten und nicht gepflegt. Der Auswahl-Punkt dafür steht
an genau einer Stelle (§6.1).

### 2.2 Regel: Kanäle brauchen eine Cloud

Ein Kanal darf **nicht** auf einem reinen Offline-Ordner liegen — es gäbe
keine Adresse, von der Mitglieder lesen könnten. Beim Anlegen ist deshalb nur
ein Ziel wählbar, das eine erreichbare Adresse hat.

Ein lokaler Ordner, der von einem Sync-Client (Nextcloud, Google Drive,
Dropbox) in die Cloud getragen wird, **zählt als Cloud** — er hat eine
Adresse. Pulse prüft das beim Verbinden, indem es die Freigabe-Adresse
verlangt (§4.1); ohne sie ist die Verbindung „nur persönlich".

### 2.3 Nextcloud verbinden — den Freigabe-Link einfügen

**Entschieden am 2026-08-31, nach Messung an einer echten Nextcloud.**

Der Nutzer legt in seiner Nextcloud einen Freigabe-Link mit Schreibrecht auf
einen Ordner an und fügt ihn in Pulse ein. Das ist alles. Kein Serveradresse-
Eintippen, kein Zustimmungsfenster, kein App-Passwort, kein OAuth.

Technisch ist ein solcher Link ein WebDAV-Zugang: Freigabe-Token als
Benutzername, leeres Passwort, Basis
`https://<wirt>/public.php/dav/files/<token>`. Der vorhandene
`webdav.ts`-Adapter spricht das **unverändert**.

#### Was dafür gemessen wurde (2026-08-31, `nx50337.your-storageshare.de`)

| Prüfung | Ergebnis |
|---|---|
| `POST /index.php/login/v2` (Login Flow v2) | 200 — aber **keine einzige CORS-Kopfzeile**, Vorabfrage 405 |
| Freigabe-Link: schreiben / lesen / vergleichen / löschen | 201 / 200 (Bytes identisch) / 204 / danach 404 |
| Lesen mit fremder Herkunft | 200, aber **keine CORS-Kopfzeile** |
| `webdavAdapter` + `probiere()` gegen den echten Server | `{ gut: true }`, Ordner danach leer |

Daraus folgt zweierlei. **Login Flow v2 wäre App-only** — der Browser darf
die Antwort nicht lesen, und ihn durch den Pulse-Server zu leiten hiesse, ein
frisches App-Passwort durch fremde Hände zu schicken. Und **der Freigabe-Weg
ist nicht nur einfacher, er ist auch schon gebaut**: kein Zeilencode
Änderung nötig.

#### Was der Nutzer wissen muss, und was daraus folgt

Ein Freigabe-Link mit Schreibrecht **ist ein Schlüssel in Textform**: wer ihn
hat, darf in diesen Ordner schreiben und daraus löschen. Zwei Folgen, beide
gehören in die Oberfläche und nicht ins Kleingedruckte:

- **Widerruf ist ein Klick** in Nextcloud — deutlich einfacher als ein
  App-Passwort zurückzuziehen. Das ist der Vorteil dieser Bauart und sollte
  beim Verbinden auch dastehen.
- **Im Browser läuft der Link über den Pulse-Server** (dieselbe CORS-Wand,
  §4.2), und zwar auch beim Schreiben. Der Server hält damit für die Dauer
  einer Anfrage eine Fähigkeit, die in diesen Ordner schreiben darf. In der
  Desktop-App verlässt der Link das Gerät nie. Der Eigentümer hat das
  ausdrücklich abgewogen und den einen Weg für alle gewählt.

Daraus folgt fürs Bauen: der Link wird **nie geloggt**, **nie länger als für
die Anfrage gehalten** und **nie an eine andere Gegenstelle als die im Link
genannte** geschickt.

Der manuelle App-Passwort-Weg entfällt ersatzlos aus der Oberfläche.

---

## 3. Zugriff: die Freigabe beim Beitritt

### 3.1 Was ein Mitglied bekommt

Wer einem Kanal beitreten darf, erhält über das bestehende Postfach
(to-device, verschlüsselt) drei Dinge:

1. die **Gruppensitzung** des Kanals (Megolm-artig, Etappe G1/G2 im Zweig)
2. den **Ablage-Hauptschlüssel** des Kanalordners — er öffnet Manifest,
   Verzeichnis und Dateinamen
3. die **Freigabe-Adresse** des Kanalordners (§4.1)

Erst alle drei zusammen ergeben Lesbarkeit. Die Adresse allein liefert nur
Chiffrat.

### 3.2 Austritt und Rauswurf

Entschieden: **ab jetzt nichts Neues mehr, Altes bleibt bei ihm.**

Beim Mitgliederwechsel passiert zweierlei:

- Der Ersteller **rotiert die Gruppensitzung**. Alles, was danach geschrieben
  wird, ist für den Ausgeschiedenen unlesbar. Alte Segmente bleiben mit der
  alten Sitzung lesbar — das ist die Entscheidung, und es ist auch die
  einzige technisch ehrliche Aussage: er hatte die Inhalte bereits.
- Die **Freigabe-Adresse wird erneuert** (alte Freigabe zurückziehen, neue
  anlegen, neue Adresse an die verbleibenden Mitglieder verteilen). Damit
  kann der Ausgeschiedene nicht einmal mehr Chiffrat herunterladen und
  verbraucht kein fremdes Kontingent mehr.

Das Erneuern der Adresse ist ein Anbieter-Aufruf und gehört deshalb in den
Adapter (`freigabeErneuern()`), nicht in die Kanal-Logik.

---

## 4. Der Leseweg

### 4.1 Freigabe-Adresse

Beim Anlegen eines Kanals erzeugt der Klient über den Adapter eine
**Lese-Freigabe auf den Kanalordner** und meldet die entstandene Adresse
zusammen mit dem Kanal an den Server. Der Server speichert sie als
Kanal-Metadatum — er kann damit nichts anfangen außer weiterreichen (§4.2),
denn der Inhalt ist Chiffrat.

- Google Drive: Datei-/Ordner-Freigabe „jeder mit dem Link", gelesen über die
  Drive-API mit API-Schlüssel
- Nextcloud: öffentlicher Freigabe-Link (`/public.php/dav/…`)
- Dropbox: geteilter Link mit direktem Inhaltsabruf

Eine Freigabe-Adresse ist ein **Fähigkeits-Verweis**: wer sie hat, darf
Chiffrat abrufen. Sie ist kein Geheimnis im Sinne von Zugangsdaten und
enthält keine. Trotzdem wird sie nur an Mitglieder verteilt und beim
Mitgliederwechsel erneuert (§3.2).

### 4.2 Direkt probieren, sonst über Pulse

Der Klient nimmt immer den kurzen Weg und fällt nur bei Bedarf zurück:

```
hole(pfad):
  versuche direkt (fetch auf die Freigabe-Adresse)
    → Erfolg: fertig
    → Netz-/CORS-Fehler: einmal über Pulse, Ergebnis merken
  merke je Kanal, welcher Weg funktioniert hat (Sitzungsdauer)
```

Die Weiterreich-Route im chat-gateway:

```
GET /channels/{channel_id}/ablage/abruf?pfad=<relativ>
```

Regeln, ohne die diese Route ein offener Umleitungsdienst wäre:

- **Mitgliedschaft wird geprüft**, wie bei jeder anderen Kanal-Route
- **Die Basis-Adresse kommt vom Server**, nicht vom Aufrufer — der Aufrufer
  liefert nur einen relativen Pfad
- Der Pfad wird normalisiert; `..`, absolute Pfade und Schema-Wechsel werden
  abgewiesen
- **Keine Umleitungen zu privaten Adressbereichen** (127/8, 10/8, 172.16/12,
  192.168/16, ::1, link-local) — sonst ist die Route eine SSRF-Brücke in das
  Server-Netz. Umleitungen werden höchstens einmal verfolgt und erneut geprüft.
- Größen- und Zeitlimit je Abruf; Ratenbegrenzung je Nutzer
- **Nichts wird gespeichert**, nichts protokolliert außer Zähler
- Der Server sieht ausschließlich Chiffrat und kennt keine Zugangsdaten des
  Erstellers

### 4.3 Zweites Laufwerk als Abkürzung

Wer spiegelt (§5.3), hinterlegt zwei Freigabe-Adressen. Der Klient probiert
die, die zu seiner Umgebung passt. Ein Nextcloud-Ersteller mit Google Drive
als zweitem Ziel macht den Umweg über Pulse damit gegenstandslos.

---

## 5. Das persönliche Archiv

### 5.1 Was hineinkommt

Entschieden: **das komplette Archiv** — private Nachrichten, Kanalverläufe,
Dateien. Alles verschlüsselt.

### 5.2 Wo es liegt

| Umgebung | Ort | Auswahl durch den Nutzer |
|---|---|---|
| Desktop-App (Electron) | Ordner freier Wahl | ja, echter Ordnerdialog |
| Chrome/Edge | Ordner freier Wahl | ja, File System Access API |
| Firefox/Safari | Browser-Speicher wie heute | nein — Hinweis auf die App |

Ausdrücklich entschieden: In Firefox und Safari **funktioniert alles weiter
wie heute**. Nur die Ordner-Auswahl fehlt, und dort steht ein Hinweis, dass
die Desktop-App sie bietet. Es wird nichts abgeschaltet.

Die Berechtigung auf einen Ordner der File System Access API überlebt einen
Neustart nicht von selbst — der Griff (`FileSystemDirectoryHandle`) wird in
IndexedDB abgelegt und beim Start erneut bestätigt. Wird die Bestätigung
verweigert, fällt der Klient auf den Browser-Speicher zurück und sagt es.

### 5.3 Spiegelung auf zwei Laufwerke

Der Schreiber schreibt an alle konfigurierten Ziele. Ein Ziel gilt als
gesund, wenn es die letzte Schreibrunde bestätigt hat.

- Erfolgreich ist eine Runde, wenn **mindestens ein** Ziel bestätigt
- Ein zurückgefallenes Ziel wird als „hinterher" markiert und beim nächsten
  Durchlauf nachgeführt, nicht übersprungen
- Der Zustand je Ziel steht in der Verbindungsanzeige (§6.2)

---

## 6. Oberfläche

### 6.1 Ein Ort: die Einstellungen

Alles rund um Laufwerke lebt in einem Einstellungs-Abschnitt **Speicher**:
verbinden, Zustand sehen, Ordner wählen, spiegeln, exportieren,
Wiederherstellungs-Satz.

Was verschwindet:

- die Route `/ablage-probe` (Testseite) — ersatzlos
- die Route `/app/ablage` als eigener Menüpunkt — ihre Dateiansicht zieht
  dorthin, wo sie hingehört (Community-Dateiablage, §7)

### 6.2 Verbindungszustand

Je Verbindung eine Zeile mit: Anbieter, verbunden seit, zuletzt gesichert,
wie viel noch aussteht, Kontingent (soweit der Anbieter es meldet), und ob
das Ziel gerade hinterherhängt.

Dies ist der Ort, an dem „Anmeldung abgelaufen" sichtbar wird. Ohne ihn
bleibt der häufigste Dauerfehler unsichtbar.

### 6.3 Probe beim Verbinden

Eine Verbindung meldet sich erst als benutzbar, nachdem sie **einmal
geschrieben, gelesen, verglichen und gelöscht** hat. Schlägt die Probe fehl,
zeigt die Oberfläche, an welchem der vier Schritte es lag.

### 6.4 Kanal anlegen ohne Laufwerk

Der Erstellen-Dialog zeigt einen Hinweis mit Link in die Einstellungen —
kein eingebetteter Assistent, keine ausgegrauten Knöpfe.

### 6.5 Kennzeichnung eines Ablage-Kanals

Ein Schloss am Kanalnamen. Ein Klick öffnet eine kurze Erklärung:
verschlüsselt, Verlauf liegt beim Ersteller, Pulse kann nicht mitlesen, und
was das für den Verlauf bedeutet.

### 6.6 Klartext-Export

Ein Knopf „Alles lesbar exportieren" gibt das persönliche Archiv als
Verzeichnis mit Klartext-Dateien heraus (Nachrichten als Textdateien je Kanal
und Tag, Anhänge unter ihrem echten Namen). Damit ist „deine Daten gehören
dir" nachprüfbar statt behauptet.

---

## 7. Community-Dateiablage

- Das Laufwerk gehört dem **Community-Besitzer**.
- Ist keines verbunden, gibt es den Bereich nicht — stattdessen steht dort
  für den Besitzer eine Aufforderung mit einem Klick zum Verbinden. Für
  Mitglieder bleibt der Bereich unsichtbar.
- Dateien laufen über `dateiablage.ts` (Kopf und Inhalt getrennt
  verschlüsselt, Klartext-Name nur im verschlüsselten Kopf).
- **Hochladen folgt der Kernaufteilung (§1):** Das Mitglied verschlüsselt
  lokal und legt das Chiffrat über Pulse ab; ein Gerät des Besitzers festigt
  es ins Laufwerk. Bis dahin ist die Datei aus dem Zwischenlager lesbar,
  also sofort nutzbar.
- Das Zwischenlager hat eine Obergrenze (Größe und Alter). Wird sie erreicht,
  meldet die Oberfläche „Der Besitzer war lange nicht online" — nicht
  „Upload fehlgeschlagen".

---

## 8. Wiederherstellung

Ohne Netz gäbe es einen Totalverlust-Fall, der nicht reparabel ist: alle
Geräte weg heißt, das eigene Archiv ist für immer Chiffrat.

- Beim Einrichten bekommt der Nutzer **einen Wiederherstellungs-Satz**
  (Wörterfolge) zum Aufschreiben, mit einer Bestätigungsabfrage.
- Daraus wird ein Schlüssel abgeleitet, der die Archiv-Hauptschlüssel und die
  Geräte-Identität in einem verschlüsselten Päckchen aufschließt.
- Das Päckchen liegt **in der Ablage selbst** und zusätzlich als
  undurchsichtiger Block auf Pulse — es muss erreichbar sein, wenn kein Gerät
  mehr da ist.
- Ohne den Satz ist das Päckchen für Pulse wertlos.

**Muss von Anfang an mitgebaut werden.** Nachrüsten hieße, jedes bestehende
Archiv umzuschlüsseln.

Die Ableitung nutzt die vorhandene Rust/WASM-Kiste `krypto/pulse-krypto`,
nicht eine neue Abhängigkeit.

### 8.1 Wege, die schon geprüft und verworfen wurden

Aus der Übergabe-Notiz von `feat/dm-attachment-e2ee`
(`docs/superpowers/2026-07-20-dm-e2ee-stand.md`, Commit `7b5113d4`). **Nicht
erneut ausprobieren:**

- **Passkey mit PRF** für den Fall „fremder Rechner, nichts dabei": PRF über
  den Handy-Weg (hybrid transport) ist nicht standardisiert. Für die eigenen
  Geräte später ein Komfortgewinn, für den Totalverlust-Fall untauglich.
- **Der vorhandene QR-Code** (`TotpEnableDialog`) ist die 2FA-Einrichtung und
  läuft in die falsche Richtung. Ein Geräte-Kopplungs-Login über QR gibt es
  weder im Backend noch im Frontend.
- **Selbst gewählte Passphrase** für den Export: wird schwach gewählt, und
  alle Bündel lägen am selben Ort. Deshalb der **generierte** Satz nach dem
  Muster der MFA-Ersatzcodes — die Entscheidung des Eigentümers vom
  2026-08-31 deckt sich damit.

Zwei Merkposten aus derselben Notiz, die für die Oberfläche gelten: Der
Sicherheitsanker ist, dass das zweite Gerät **zeigt, was freigegeben wird**,
statt nur „Bestätigen?" zu fragen. Und iOS hat keine App — dort läuft alles
in Safari, dessen Speicher nach sieben Tagen geräumt wird; ein iPhone ist
deshalb kein verlässlicher Schlüsselträger.

---

## 9. Umstellung — und was sich gegenüber §2a ändert

Entschieden: **Neue Kanäle sind überall verschlüsselt, auch auf
howispulse.com. Bestehende Kanäle werden nur noch lesbar.**

Das ändert zwei Aussagen im bestehenden Konzept, die mitgezogen werden
müssen (`docs/user-gehostete-kanaele-konzept.md`):

| Alte Aussage (§2a) | Neu |
|---|---|
| „Teilnehmen braucht keine Ablage — Nutzer erhalten Inhalte über Pulse, **nicht durch Zugriff auf das Laufwerk**" | Gelesen wird direkt vom Laufwerk; Pulse ist der Schreibweg und der Rückfall-Leseweg |
| „Die Pulse-Cloud kann im Regulär-Modus bleiben" | Die Cloud stellt ebenfalls um |
| „Bestehende Kanäle bleiben beim Modus-Wechsel lesbar (Legacy-Modus)" | Präzisiert: lesbar **und nicht mehr beschreibbar** |

Der Umstellungs-Schalter bleibt die vorhandene Instanz-Einstellung
`channel_creation_policy`. Neu ist ein zweiter Zustand am Alt-Kanal
(`legacy_readonly`), der das Schreiben serverseitig abweist — mit einer
Meldung, die den Grund nennt, nicht mit einem nackten 403.

**Betriebliche Empfehlung, nicht Teil der Entscheidung:** den Schalter auf
howispulse.com erst umlegen, wenn alles Übrige nachweislich läuft. Am Tag der
Umstellung frieren dort alle laufenden Unterhaltungen ein, und wer kein
Laufwerk verbindet, kann keinen Kanal mehr anlegen. Das ist keine Warnung
gegen die Entscheidung, sondern gegen eine ungünstige Reihenfolge.

---

## 10. Was dadurch nicht mehr geht

Unverändert gegenüber §5 des Konzepts, hier nur zur Vollständigkeit:
serverseitige Suche, Moderations-Einsicht, Plugins mit Inhaltszugriff,
serverseitige Bearbeitungshistorie. Neu hinzu:

- **Uploads sind nicht sofort im Laufwerk**, sondern erst nach der Festigung
  durch ein Gerät des Erstellers. Lesbar sind sie trotzdem sofort.
- **Ein Kanal ohne erreichbares Laufwerk kann nicht angelegt werden.**

---

## 11. Offene Punkte, die gemessen und nicht vermutet werden

1. ~~Setzt Nextclouds Login-Flow-v2-Poll CORS-Header?~~ **Gemessen am
   2026-08-31: nein, keine einzige.** Der Weg entfällt zugunsten des
   Freigabe-Links (§2.3). Auch der öffentliche DAV-Endpunkt setzt keine —
   der Rückfall über den Pulse-Server aus §4.2 gilt für Nextcloud also
   immer, nicht nur manchmal.
2. Liefert die Google-Drive-API für öffentlich freigegebene Dateien
   CORS-Header beim Abruf mit API-Schlüssel? Wenn nein, gilt für Drive
   derselbe Rückfallweg wie für Nextcloud — die Bauform trägt das bereits.
3. Erlaubt Dropbox das Zurückziehen und Neuanlegen eines geteilten Links
   ohne Kontingentfolgen? (§3.2)
4. Kontingent-Abfrage je Anbieter — welche melden sie überhaupt? (§6.2)

Jede dieser vier Fragen wird durch einen echten Aufruf beantwortet und das
Ergebnis am Code vermerkt, nicht aus Dokumentation gefolgert.

---

## 12. Verwandte Dokumente

- `docs/user-gehostete-kanaele-konzept.md` — Ursprungskonzept (§2a wird durch §9 hier korrigiert)
- `docs/ablage-umsetzung-stand.md` — Stand des Zweigs vor diesem Entwurf
- `docs/ablage-krypto-schnittanalyse.md` — Schnitt DM-Krypto ↔ Ablage
- `docs/superpowers/specs/2026-08-28-e2e-dm-design.md` — DM-Krypto-Entwurf
- `docs/superpowers/plans/2026-08-28-etappe-g1-private-gruppen-kanal.md` — Gruppensitzungen
