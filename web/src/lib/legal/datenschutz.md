# Datenschutzerklärung

> ⚠️ **Hinweis:** Sorgfältig erstellte Vorlage nach gängiger DSGVO-Praxis —
> **keine Rechtsberatung**. Diese Erklärung beschreibt die Datenverarbeitung
> nach aktuellem Kenntnisstand der Pulse-Architektur. Vor Veröffentlichung
> bitte juristisch prüfen und mit der **tatsächlichen** technischen Umsetzung
> abgleichen lassen. Mit `[…]` markierte Stellen müssen bestätigt/ergänzt werden.

## 1. Verantwortlicher

Verantwortlicher im Sinne der Datenschutz-Grundverordnung (DSGVO) ist:

**Oblivion Pictures**
Michael de Meyer
Maria-Luiko-Str. 6
80636 München
Deutschland
E-Mail: oblivion828282@gmail.com

`[Ein Datenschutzbeauftragter ist gesetzlich erst ab bestimmten Schwellen
verpflichtend (i. d. R. ≥ 20 Personen mit ständiger Datenverarbeitung). Falls
nicht zutreffend, ist keine Benennung erforderlich.]`

## 2. Allgemeines zur Datenverarbeitung

Wir verarbeiten personenbezogene Daten nur, soweit dies zur Bereitstellung des
Dienstes erforderlich ist oder eine andere Rechtsgrundlage besteht. Eine
Verarbeitung erfolgt insbesondere auf Grundlage von:

- **Art. 6 Abs. 1 lit. b DSGVO** (Vertragserfüllung — Bereitstellung des Dienstes
  für angemeldete Nutzer),
- **Art. 6 Abs. 1 lit. f DSGVO** (berechtigtes Interesse — z. B. technische
  Sicherheit, Stabilität, Missbrauchsvermeidung),
- **Art. 6 Abs. 1 lit. c DSGVO** (rechtliche Verpflichtung),
- **Art. 6 Abs. 1 lit. a DSGVO** (Einwilligung), soweit eine solche eingeholt wird.

## 3. Hosting

Der Dienst wird auf Servern der **netcup GmbH**, Daimlerstraße 25, 76185
Karlsruhe, Deutschland, betrieben. Die Server stehen in Deutschland. Mit dem
Hoster besteht ein Vertrag zur Auftragsverarbeitung (AVV) gemäß Art. 28 DSGVO.

`[AVV mit netcup abschließen/prüfen.]`

## 4. Server-Logfiles

Beim Aufruf des Dienstes werden automatisch Informationen erhoben, die der
Browser bzw. die App übermittelt und die technisch erforderlich sind:

- IP-Adresse,
- Datum und Uhrzeit der Anfrage,
- aufgerufene Ressource / angefragte Funktion,
- übertragene Datenmenge, Statuscode,
- User-Agent (Browser-/App-Typ und -Version).

Diese Daten dienen der technischen Auslieferung, der Sicherheit und der
Fehleranalyse. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Die Logs werden
nach 7 Tagen gelöscht bzw. anonymisiert, soweit sie nicht im Einzelfall zur
Aufklärung eines konkreten Sicherheitsvorfalls länger benötigt werden.

## 5. Transportverschlüsselung (TLS)

Die Verbindung zum Dienst erfolgt verschlüsselt über HTTPS/WSS (TLS). Die
Echtzeit-Sprach- und Streaming-Verbindungen sind ebenfalls verschlüsselt
(WebRTC/DTLS-SRTP bzw. RTMPS/TLS).

## 6. Registrierung und Nutzerkonto

Zur Nutzung des Dienstes ist ein Nutzerkonto erforderlich. Dabei verarbeiten wir:

- gewählter **Benutzername**,
- **E-Mail-Adresse**,
- **Passwort** (ausschließlich als kryptografischer Hash gespeichert, Argon2id —
  das Klartext-Passwort wird nicht gespeichert),
- ggf. **Profilbild/Avatar** (sofern hochgeladen),
- technische Konto- und Sitzungsdaten (z. B. Anmeldezeitpunkte, Sitzungstokens).

Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO (Vertragserfüllung).

### E-Mail-Verifizierung

Zur Bestätigung der E-Mail-Adresse versenden wir einen Bestätigungslink. Dies
dient der Sicherheit und der Missbrauchsvermeidung (Art. 6 Abs. 1 lit. f DSGVO).

### Zwei-Faktor-Authentifizierung (optional)

Aktivierst du die Zwei-Faktor-Authentifizierung, speichern wir die dafür
notwendigen Daten:

- bei **TOTP** (Authenticator-App): ein geheimer Schlüssel,
- bei **Passkeys/WebAuthn**: öffentliche Schlüssel-Anmeldedaten deiner Geräte,
- ggf. Backup-Codes (als Hash).

Rechtsgrundlage ist Art. 6 Abs. 1 lit. b und lit. f DSGVO.

## 7. Cookies und lokale Speicherung

Der Dienst verwendet **technisch notwendige** Mechanismen (z. B. Sitzungstokens
und lokale Browser-Speicherung für Anmeldung und Einstellungen). Diese sind für
den Betrieb erforderlich und bedürfen keiner Einwilligung (§ 25 Abs. 2 TDDDG).

Wir setzen **keine** Tracking-, Analyse- oder Werbe-Cookies und **keine**
Drittanbieter-Tracker ein.

## 8. Echtzeit-Sprach- und Videokommunikation

Für Sprach-Chat und browserbasiertes Bildschirmteilen wird eine selbst
betriebene Medien-Infrastruktur (LiveKit, auf den Servern des Hosters in
Deutschland) verwendet. Dabei werden Verbindungs- und Übertragungsdaten
verarbeitet, die zur Herstellung der Echtzeit-Verbindung erforderlich sind. Die
Audio-/Videoinhalte werden zur Vermittlung übertragen, aber **nicht dauerhaft
gespeichert**. Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO.

## 9. HQ-Bildschirm-Streaming

Für hochauflösendes Bildschirm-Streaming wird eine selbst betriebene
Streaming-Komponente (MediaMTX, auf den Servern des Hosters) verwendet. Die
Streams werden zur Auslieferung an Zuschauer übertragen und **nicht dauerhaft
gespeichert**. Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO.

## 10. Profilbilder/Avatare

Hochgeladene Profilbilder werden in einem selbst betriebenen Objektspeicher
(MinIO, auf den Servern des Hosters) abgelegt. Rechtsgrundlage ist
Art. 6 Abs. 1 lit. b DSGVO.

## 11. Nutzergenerierte Inhalte (Nachrichten)

Im Rahmen des Dienstes ausgetauschte Text-Nachrichten und zugehörige Metadaten
(z. B. Absender, Zeitstempel, Kanal-/Community-Zuordnung) werden gespeichert,
um die Kommunikationsfunktion bereitzustellen. Rechtsgrundlage ist
Art. 6 Abs. 1 lit. b DSGVO. Nachrichten in nicht-öffentlichen Räumen sind nur
für die jeweils berechtigten Teilnehmer einsehbar.

## 12. E-Mail-Versand

Für den Versand transaktionaler E-Mails (z. B. Verifizierung, Passwort-Reset)
nutzen wir den Dienst **Resend** (Anbieter: Plus Five Five, Inc., 2261 Market
Street #5039, San Francisco, CA 94114, USA). Dabei werden die E-Mail-Adresse und
der Nachrichteninhalt verarbeitet. Rechtsgrundlage ist Art. 6 Abs. 1 lit. b und
lit. f DSGVO. Da der Anbieter in den USA sitzt, findet eine Übermittlung in ein
Drittland statt — siehe Ziffer 15. `[Auftragsverarbeitungsvertrag (DPA) mit
Resend abschließen bzw. dessen Geltung über die Nutzungsbedingungen bestätigen.]`

## 13. Kontaktaufnahme

Wenn du uns per E-Mail kontaktierst, verarbeiten wir die übermittelten Daten zur
Bearbeitung deiner Anfrage (Art. 6 Abs. 1 lit. b bzw. lit. f DSGVO).

## 14. Empfänger / Auftragsverarbeiter

Personenbezogene Daten werden nur an Auftragsverarbeiter weitergegeben, soweit
dies für den Betrieb erforderlich ist (insbesondere der Hosting-Anbieter sowie
ggf. der E-Mail-Versanddienst). Mit diesen bestehen Verträge zur
Auftragsverarbeitung nach Art. 28 DSGVO. Eine darüber hinausgehende Weitergabe
oder ein Verkauf von Daten findet nicht statt.

## 15. Drittlandübermittlung

Im Zusammenhang mit dem E-Mail-Versand über Resend (Plus Five Five, Inc., USA —
siehe Ziffer 12) kann eine Übermittlung personenbezogener Daten in die USA
stattfinden. Resend sichert diese Übermittlung durch geeignete Garantien im
Sinne des Art. 46 DSGVO ab: Es gelten die EU-Standardvertragsklauseln (Standard
Contractual Clauses); zusätzlich ist Resend nach dem EU-U.S. Data Privacy
Framework (einschließlich der UK-Erweiterung) zertifiziert.

Eine darüber hinausgehende Übermittlung in Drittländer findet nicht statt.

## 16. Speicherdauer

Wir speichern personenbezogene Daten nur so lange, wie es für die genannten
Zwecke erforderlich ist oder gesetzliche Aufbewahrungspflichten bestehen.
Kontodaten werden bis zur Löschung des Kontos gespeichert. Du kannst dein Konto
jederzeit löschen; damit werden die zugehörigen personenbezogenen Daten
gelöscht, soweit keine gesetzlichen Pflichten entgegenstehen.

## 17. Deine Rechte als betroffene Person

Dir stehen gegenüber dem Verantwortlichen folgende Rechte hinsichtlich der dich
betreffenden personenbezogenen Daten zu:

- **Auskunft** (Art. 15 DSGVO),
- **Berichtigung** (Art. 16 DSGVO),
- **Löschung** (Art. 17 DSGVO),
- **Einschränkung der Verarbeitung** (Art. 18 DSGVO),
- **Datenübertragbarkeit** (Art. 20 DSGVO),
- **Widerspruch** gegen die Verarbeitung (Art. 21 DSGVO),
- **Widerruf einer erteilten Einwilligung** mit Wirkung für die Zukunft
  (Art. 7 Abs. 3 DSGVO).

Zur Ausübung genügt eine formlose Nachricht an die oben genannte E-Mail-Adresse.

## 18. Beschwerderecht bei der Aufsichtsbehörde

Unbeschadet anderweitiger Rechtsbehelfe steht dir ein Beschwerderecht bei einer
Datenschutz-Aufsichtsbehörde zu. Die für uns zuständige Behörde ist:

**Bayerisches Landesamt für Datenschutzaufsicht (BayLDA)**
Promenade 18, 91522 Ansbach

## 19. Keine automatisierte Entscheidungsfindung

Eine automatisierte Entscheidungsfindung oder ein Profiling im Sinne des
Art. 22 DSGVO findet nicht statt.

## 20. Änderungen dieser Datenschutzerklärung

Wir behalten uns vor, diese Datenschutzerklärung anzupassen, damit sie stets den
aktuellen rechtlichen Anforderungen entspricht oder um Änderungen des Dienstes
umzusetzen. Es gilt die jeweils aktuelle, hier veröffentlichte Fassung.

Stand: 30. Mai 2026

---

> **Self-Hosting:** Betreibst du eine eigene Pulse-Instanz, bist du für deren
> Datenverarbeitung selbst der Verantwortliche und benötigst eine **eigene
> Datenschutzerklärung**. Diese Erklärung gilt nur für den von Oblivion Pictures
> betriebenen Dienst unter howispulse.com.
