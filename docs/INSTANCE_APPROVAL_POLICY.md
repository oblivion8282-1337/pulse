# Instance-Approval-Policy (Cloud-intern)

Cloud-interne Dokumentation für den Bootstrap-Admin (du) zum Review von
Self-Host-Anträgen in der Stealth-Beta (DE 11).

Ziel: Squatting, Phishing-Hostnamen und fragwürdige Betreiber draußen halten,
ohne legitime Self-Hoster zu blockieren.

---

## Review-Checkliste

Für jeden Antrag:

- [ ] Hostname Anti-Squatting-Check (s.u.)
- [ ] Risk-TLD-Check (s.u.)
- [ ] E-Mail-Domain plausibel zum Hostname?
- [ ] Notes-Feld: schlüssiger Use-Case vorhanden?
- [ ] Cloud-Account hat MFA aktiviert?
- [ ] Antragssteller-Account ist nicht neu erstellt + sofort Antrag (Spam-Signal)?

---

## Hostname Anti-Squatting-Policy

**Ablehnen wenn der Hostname verwechslungsfähig mit Pulse-offiziellen Domains ist:**

| Muster | Beispiel | Grund |
|--------|----------|-------|
| `pulse-unicutmedia.com` | Bindestrich statt Punkt | Lookalike-Domain |
| `unicutmedia.de` / `unicutmedia.*` | Andere TLD | Brand-Squatting |
| `pulse.*` auf unbekannter TLD | `pulse.io`, `pulse.app` | Impliziert offiziell |
| Tippfehler-Varianten | `pulsee.de`, `pu1se.de` | Typosquatting |
| Unterdomain von bekannter Phishing-Domain | — | Evidenz aus VirusTotal |

**Erlaubt:**
- `chat.firma.de`, `messaging.team.io`, `intern.company.com` — klarer eigener Kontext
- `pulse.intern.firma.de` — Subdomain mit eigenem organisatorischem Kontext (keine
  öffentliche Root-Domain `pulse.de` etc.)

**Grenzfall:** Im Zweifel ablehnen + Begründung. Self-Hoster kann Domain ändern
und neu beantragen.

---

## Risk-TLD-Liste

Direkt ablehnen ohne Einzelfall-Review:

- `.zip` (verwechselbar mit Dateiendung, missbrauchsanfällig)
- `.review` (häufig für Phishing)
- `.click` (häufig für Malvertising)
- `.gq`, `.ml`, `.tk`, `.cf`, `.ga` (kostenlose TLDs, extrem hoher Missbrauchs-Anteil)

Erhöhte Aufmerksamkeit (nicht automatisch ablehnen, aber gründlicher prüfen):
- `.xyz`, `.top`, `.online`, `.site` (oft missbraucht, aber auch legitim)
- `.ru`, `.cn` für westliche Nutzer-Zielgruppe ohne plausiblen Grund

---

## E-Mail-Domain-Plausibilität

Beispiele:

| Antrag-Hostname | E-Mail-Domain | Bewertung |
|-----------------|---------------|-----------|
| `chat.firma.de` | `firma.de` | OK — passt zur Domain |
| `chat.firma.de` | `gmail.com` | Neutral — Privatperson |
| `intern.company.com` | `company.com` | OK |
| `chat.firma.de` | `tempmail.org` | REJECT — Wegwerf-Mail |
| `chat.firma.de` | komplett anderer Unternehmensname | Klärung nötig |

**Wegwerf-Mail-Domains** → automatisch ablehnen. Bekannte Liste:
`tempmail.org`, `guerrillamail.com`, `mailinator.com`, `throwam.com`, `yopmail.com`.

---

## Use-Case-Bewertung (Notes-Feld)

**Gute Use-Cases:**
- "Interner Chat für unser 10-köpfiges Entwickler-Team"
- "Vereins-Server für unser Open-Source-Projekt"
- "Familie/Freundeskreis, ich hoste selbst auf meinem Server"
- "Firmen-interner Server, kein Externzugang"

**Rote Flags:**
- Leeres Notes-Feld ohne schlüssige Erklärung
- "Reselling", "für Kunden", "öffentlicher Service" — Self-Host-Lizenz gilt nur
  für eigene Community, nicht als Reselling-Plattform
- Unklare oder widersprüchliche Angaben

---

## Standard-Ablehnungstexte

Kopierfertig für die Approval-UI:

**Hostname-Verwechslung:**
> Dein beantragter Hostname `[HOSTNAME]` ist zu ähnlich zur offiziellen
> Pulse-Domain und könnte Nutzer verwechseln. Bitte wähle einen Hostnamen
> der klar deinen eigenen Kontext widerspiegelt (z.B. `chat.deindomain.de`).

**Fehlende Begründung:**
> Bitte fülle das Notes-Feld mit einer kurzen Beschreibung deines Use-Cases aus
> (z.B. "interner Team-Chat für 15 Personen"). Das hilft uns beim Review.

**Risk-TLD:**
> Die Top-Level-Domain deines Hostnamens wird wegen erhöhten Missbrauchs-Risikos
> nicht für Self-Host-Instanzen freigegeben. Bitte nutze eine andere TLD.

**Wegwerf-Mail:**
> Bitte verwende eine permanente E-Mail-Adresse für den Antrag.
> Temporäre Mail-Services werden nicht akzeptiert.

**MFA fehlt:**
> Self-Hoster müssen vor dem Antrag MFA auf ihrem Cloud-Account aktivieren.
> Bitte einrichten unter Einstellungen → Sicherheit → Zwei-Faktor.

---

## Prozess nach Approval

1. `client_id` + `client_secret` im Cloud-UI generieren → Antragssteller bekommt
   E-Mail mit Link zum einmaligen Anzeigen.
2. Instanz-Eintrag in Cloud-DB mit Status `approved` + Hostname.
3. Hostname ab jetzt gesperrt für andere Anträge (1:1-Mapping).
4. Instance-ID (Snowflake) wird der Instanz zugewiesen.

---

## Revocation

Genehmigte Instanz sperren (z.B. nach Beschwerde):

1. Status im Cloud-UI auf `suspended` setzen.
2. CRL-Update pushen → `client_id` landet auf der Revocation-Liste.
3. Alle Sessions der Instanz werden beim nächsten CRL-Poll invalidiert (~30 s).
4. E-Mail an Betreiber mit Begründung.

Endgültige Löschung: Status `revoked`, Hostname freigegeben nach 30 Tagen
(Grace-Period für Neuantrag mit neuem Hostname).
