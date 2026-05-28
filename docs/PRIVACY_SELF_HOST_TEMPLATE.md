# Datenschutzerklärung — Pulse Self-Hosted Instance

> **Vorlage für Self-Hoster.** Ersetze `[DEIN HOSTNAME]`, `[DEIN NAME]`,
> `[DEINE E-MAIL]` und `[DEINE ADRESSE]` mit deinen Angaben.
> Pulse haftet nicht für den Inhalt dieser Datenschutzerklärung —
> der Self-Hoster ist Verantwortlicher im Sinne der DSGVO (Art. 4 Nr. 7 DSGVO).

---

## Datenschutzerklärung für [DEIN HOSTNAME]

**Stand:** [DATUM]

### Verantwortlicher

Verantwortlicher im Sinne der DSGVO für diese Pulse-Instanz:

**Name:** [DEIN NAME]
**E-Mail:** [DEINE E-MAIL]
**Adresse:** [DEINE ADRESSE]

Die Nutzer-Identität (Konto, Profil, Cloud-übergreifende Identität) wird von
Pulse Cloud (`howispulse.com`) verwaltet. Für diese Daten ist
Pulse/unicutmedia Medien verantwortlich.

---

### Welche Daten werden gespeichert?

Auf diesem Server (`[DEIN HOSTNAME]`) werden folgende Daten lokal gespeichert:

**Chat-Inhalte:**
- Textnachrichten, Reaktionen, Anhänge die in Guilds auf diesem Server gesendet werden
- Guild-Struktur (Channels, Rollen, Berechtigungen)
- Mitgliedschaften in Guilds auf diesem Server

**Voice/Streaming:**
- Keine dauerhafte Speicherung von Voice-/Video-Streams
- Verbindungsmetadaten (wer ist wann in welchem Voice-Channel) als transiente
  Redis-Daten (TTL 6 Stunden)

**Technische Logs:**
- Service-Logs (strukturiert JSON auf stdout → Docker-Logging-Treiber)
- PII wird in Error-Logs redactiert (`username`, `email`)
- Log-Retention abhängig von Docker-Konfiguration auf diesem Server

**Backups:**
- `pg_dump`-Backups in `/data/backups/` auf dem Host-System

**Nicht auf diesem Server gespeichert:**
- Passwort-Hashes, MFA-Secrets, Passkeys
- E-Mail-Adressen (nur in Pulse Cloud)
- Cloud-Identitäts-Token

---

### Datenübermittlung an Pulse Cloud

Diese Instanz kommuniziert mit `howispulse.com` für folgende Zwecke:

1. **JWKS-Fetch** (JSON Web Key Set): Öffentliche Schlüssel zur Verifikation von
   Session-Tokens. Kein User-Content wird dabei übertragen.
2. **CRL-Fetch** (Certificate Revocation List): Liste widerrufener Zertifikate.
   Kein User-Content wird dabei übertragen.
3. **Version-Policy-Abfrage**: Versions-Kompatibilitätsdokument für Update-Banner.
   Kein User-Content wird dabei übertragen.
4. **Health-Probe nach Updates**: Cloud prüft Verfügbarkeit dieser Instanz nach
   automatischen Updates. Kein User-Content wird dabei übertragen.
5. **Instanz-Authentifizierung**: Bei jedem der vier oben genannten Calls (und
   beim Cert-Login-Flow für Nutzer) sendet diese Instanz ihre öffentliche
   `PULSE_CLOUD_CLIENT_ID` mit — Pulse Cloud erkennt sie als "die Instanz X,
   die wir beim Approval-Prozess registriert haben". Es ist ein
   Identifikator-Token, kein Geheimnis und kein User-Content; aber die bloße
   Tatsache "Instanz X war zur Zeit T online und hat einen Call gemacht" wird
   bei Pulse Cloud geloggt.

**Kein User-Content** (Nachrichten, Dateien, Profilbilder) verlässt diese
Instanz in Richtung Pulse Cloud.

---

### DNS-Leakage

Der DNS-Resolver deiner Nutzer sieht den Hostnamen `[DEIN HOSTNAME]` bei jeder
Verbindung zu diesem Server. Das ist bei jeder Website weltweit so und technisch
unvermeidbar.

**Was das bedeutet:** Dein Internet-Provider oder DNS-Resolver-Betreiber kann
sehen, dass du `[DEIN HOSTNAME]` aufrufst — aber nicht was du schreibst (HTTPS
verschlüsselt den Inhalt).

**Workaround für Nutzer:** DNS-over-HTTPS im Browser aktivieren oder einen
datenschutzfreundlichen DNS-Resolver nutzen (z.B. Cloudflare 1.1.1.1, Quad9).

---

### TLS / Transportverschlüsselung

Die Verbindung zwischen deinem Browser und diesem Server ist mit TLS (HTTPS)
verschlüsselt. TLS-Zertifikat von: [Let's Encrypt / eigenem CA / Cloudflare].

WebRTC-Voice-Verbindungen sind ebenfalls verschlüsselt (DTLS/SRTP).

---

### Rechte der Nutzer (DSGVO Art. 15–22)

Nutzer können ihre Daten über das Cloud-Interface auf `howispulse.com`
verwalten:

- **Auskunft (Art. 15):** Profil-Daten über Cloud-UI einsehbar
- **Berichtigung (Art. 16):** Profil bearbeitbar in Cloud-Settings
- **Löschung (Art. 17):** Account-Löschung über Cloud-Settings löscht auch
  alle Daten auf verbundenen Self-Host-Instanzen
- **Datenportabilität (Art. 20):** Nachrichten-Export: [NOCH NICHT IMPLEMENTIERT /
  KONTAKTIERE MICH]

Für Anfragen zum lokalen Server: [DEINE E-MAIL]

---

### Speicherdauer

Chat-Nachrichten: bis zur Account-Löschung oder manuellen Löschung durch den Nutzer.
Logs: [DEINE LOG-RETENTION-POLICY, z.B. "7 Tage rollierend"].
Backups: werden automatisch nach [3 / 4 Kopien] rotiert.

---

### Haftungshinweis

Pulse (unicutmedia Medien) betreibt diese Instanz nicht und ist für den Betrieb
und die hier erhobenen Daten nicht verantwortlich. Diese Instanz wird unabhängig
betrieben von [DEIN NAME].

Fragen zu Pulse Cloud: privacy@unicutmedia.com
Fragen zu dieser Instanz: [DEINE E-MAIL]
