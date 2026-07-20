# User-gehostete Kanäle auf fremdem Cloud-Speicher — Machbarkeits- und Rechtsanalyse

> Status: **Analyse abgeschlossen, Empfehlung: NICHT in der Reinform bauen.** Stand: 2026-07-16.
> Idee (Owner-Vorgabe): Ein User stellt seinen Cloud-Speicher (Google Drive / OneDrive / Dropbox /
> Nextcloud) bereit; komplette Textkanäle (Nachrichten + Bilder) laufen darauf; andere Mitglieder
> lesen/schreiben direkt; die Pulse Cloud hat "nichts damit zu tun"; die Verantwortung liegt beim
> Speicher-Owner. Motivation: Pulse-Cloud-Kanäle könnten dann entschärft werden.
>
> ⚠️ **Kein Rechtsrat.** Drei parallele Recherchen (Speicher-APIs, Prior Art, Rechtslage DE/EU) mit
> adversarialer Verifikation gegen Primärquellen. Verwandt: `docs/medien-speicher-und-scanning.md`
> (Scanning/Haftung Cloud), `IDENTITY_CONCEPT.md` (Self-Host-Verantwortungsmodell).

---

## Ergebnis in einem Satz

Die Konstruktion **verfehlt beide Ziele gleichzeitig**: Sie macht die Pulse Cloud rechtlich NICHT frei
(sie behält die zentrale Vermittlerrolle — Kanal-Name, Mitgliederliste, Zugangs-Token, Realtime-Ping),
und sie macht den privaten Owner nicht zum geschützten "Provider", sondern zum **schutzlosesten
Beteiligten im ganzen System** — mit realem Risiko von Hausdurchsuchung und endgültigem
Cloud-Konto-Verlust, wenn ein einziges Mitglied Missbrauchsmaterial hochlädt.

---

## 1. Die drei Wände (Kurzfassung der Recherchen)

### Wand 1 — Technik: Kein Anbieter kann das Wunsch-Szenario

Geprüft: Mitglieder ohne eigenes Anbieter-Konto, nur mit Freigabe-Link, direkt aus dem **Browser**
(Pulse ist Web-First) lesen UND schreiben. Ergebnis pro Anbieter (Details/Belege in der Recherche):

| Anbieter | Härtester Blocker |
|---|---|
| **Nextcloud** | Einziger mit kontolosem Zugriff (anonymes WebDAV via Share-Token) — aber **keine CORS-Header** → aus dem Browser fremder Origin unmöglich (Issue offen seit 2017, nextcloud/server#3131). Nur via Owner-eigenem Reverse-Proxy oder Electron-only. |
| **Google Drive** | Schreiben verlangt zwingend ein Google-Konto des Mitglieds; Vollzugriffs-Scope = "restricted" → **jährliches CASA-Security-Assessment** (~540–1.800 USD). Dafür beste Quoten + offizielles Browser-CORS. |
| **OneDrive/Graph** | Jeder API-Call braucht ein MS-Konto (anonymer Link ersetzt nur die Berechtigung, nicht die Anmeldung); Change-Detection auf fremden Ordnern **undokumentiert**; Consumer-Rate-Limits unpubliziert. |
| **Dropbox** | Owner-Token an Mitglieder verteilen ist **per Developer-ToS §2.6(c) explizit verboten**; geteilte Rate-Limits + Write-Lock-Contention → Owner-Konto-Sperr-Risiko. |

Dazu quer über alle: **Quasi-Realtime existiert nicht** — nur Polling mit Sekunden- bis Minuten-Jitter,
keine Read-after-Write-Garantie in Listings. Discord-Gefühl ist auf Consumer-Speichern nicht erreichbar.

### Wand 2 — Prior Art: 15 Jahre Versuche, eine klare Lehre

Delta Chat (Chat über IMAP), Solid PODs, remoteStorage/unhosted, Nostr, Secure Scuttlebutt,
YNAB-über-Dropbox — alle untersucht. Die fünf übertragbaren Lehren:

1. **Der fremde Speicher darf nie im Echtzeit-Pfad liegen** — alle funktionierenden Systeme trennen
   Realtime-Signalweg und Speicher (Archiv/Autorität).
2. **Genau ein Owner pro Datenraum ist das einzige Modell, in dem Löschen/Moderation funktioniert**
   (Nostr musste das mit NIP-29 mühsam wieder zentralisieren; SSB kann prinzipbedingt nie löschen).
3. **"Bring your own storage" als Pflicht ist der Onboarding-Killer** — jedes System, das die
   Speicherwahl VOR die Nutzung stellte, ist gestorben (Solid, remoteStorage, klassisches Delta Chat).
   Überlebt hat nur, wer den eigenen Speicher optional machte (chatmail).
4. **"Formal dezentral, praktisch zentral" ist unvermeidlich** — der Wert des Musters ist
   Kostenverlagerung + Datenhoheit, NICHT "die Plattform ist raus".
5. Ohne Plattform-Index/Cache über dem Speicher gibt es keine Historie für Neumitglieder, keine Suche,
   keine Pagination (Solid scheiterte genau daran).

### Wand 3 — Recht: Die Übergabe funktioniert in beide Richtungen nicht

Kernbefunde des Rechts-Gutachtens (verifiziert gegen Primärquellen; Details dort):

**(a) Der private Owner bekommt KEIN Haftungsprivileg — er steht schlechter als die Plattform.**
Die DSA-Privilegien (Art. 4–6) gelten nur für "Dienste der Informationsgesellschaft" = "in der Regel
gegen Entgelt". Eine Privatperson, die unentgeltlich ihren Ordner für eine Hobby-Community öffnet, ist
kein solcher Dienst. Das alte TMG (dessen Privilegien auch Privaten offenstanden) wurde **14.05.2024
ersatzlos aufgehoben**. Ergebnis: Der Owner haftet nach allgemeinem Zivil- und Strafrecht — Störer-/
Täterhaftung, Konto-Zurechnungsvermutungen (BGH "Halzband", Filesharing-Linie), **volle
Besitz-Strafbarkeit nach §184b StGB ab Kenntnis + Nichtlöschen** — ohne die Verfahrens-Schutzschicht,
die ein Provider hat.

**(b) Das Owner-Opfer-Szenario ist dokumentierte, häufige Praxis.** Google/Microsoft/Dropbox scannen
Consumer-Speicher proaktiv (PhotoDNA u.a.) und melden an NCMEC → BKA (**205.728 NCMEC-Hinweise 2024,
davon 106.353 strafrechtlich relevant**). Das Verfahren trifft den **Konto-Inhaber**: Hausdurchsuchung,
Beschlagnahme aller Geräte — und der "Mark"-Fall (NYT 2022) zeigt: **dauerhafter Verlust des gesamten
Google-Kontos ohne Wiederherstellung, selbst nachdem die Polizei die Unschuld festgestellt hat.**
Ein einziger böswilliger Upload eines Mitglieds genügt. Kein Warnhinweis-Klick macht das ungeschehen.

**(c) Die Plattform wird trotzdem nicht frei.** Sie hostet weiter den Kanal-Namen + die Mitgliederliste
(→ Art. 11–18 DSA in voller Größe, größenunabhängig), und ihre **Token-Verteilung** liegt nach der
Rechtsprechungslinie näher an eigener Zugänglichmachung als am neutralen Link: EuGH *The Pirate Bay*
(C-610/15) — **null eigene Inhalte, nur Metadaten-Verwaltung, trotzdem Täterhaftung** wegen "zentraler
Rolle"; BGH 2 StR 151/11 — schon ein Link auf CSAM ist Zugänglichmachung i.S.d. §184b; ein Token, ohne
den der Zugriff gar nicht möglich ist, erst recht. Der inhaltslose Realtime-Ping verbessert die Position
nicht — er dokumentiert die laufende aktive Rolle.

**(d) Der Entschärfungs-Plan ist der Bumerang.** "Eigene Kanäle entschärft, alles Riskante zu privaten
Ownern verschoben" erfüllt wörtlich die Formel aus EuGH C-682/18 (*YouTube/uploaded*): Täterhaftung
statt Störerhaftung, wenn der Betreiber "weiß oder wissen müsste" und ein "Geschäftsmodell, das anregt"
betreibt bzw. geeignete Maßnahmen bewusst unterlässt. Die Usenet-Zwillingsfälle zeigen: **dieselbe
Technik gewinnt (NSE/NL: Neutralität + Notice-and-Takedown) oder verliert (Alphaload/DE: die eigene
Kommunikation "anonym laden") — entscheidend ist die dokumentierte Motivation.** Interne Docs mit der
Begründung "damit hafte ich nicht mehr" sind im Ernstfall verwertbar (Megaupload-Muster).

**(e) DSGVO: strukturell defekt.** Owner ohne Haushaltsausnahme (EuGH-Linie: eng; Zugänglichmachung an
teils fremden Personenkreis fällt raus), als Verantwortlicher **ohne erfüllbaren AV-Vertrag**
(Consumer-Konten bei Google/Dropbox bieten keinen), Plattform wohl gemeinsam verantwortlich
(EuGH *Jehovan todistajat*: Organisieren genügt, Datenzugriff nicht nötig) ohne Art.-26-Vereinbarung.

---

## 2. Was daraus folgt: Der Mittelweg existiert nicht

Die Analyse ergibt eine harte Gabelung. **"In meiner Oberfläche, aber nicht mein Problem" ist rechtlich
nicht konstruierbar** — wer Verzeichnis, Mitglieder, Zugang und Live-Signal stellt, spielt die zentrale
Rolle, egal wo die Bytes liegen (Pirate-Bay-Lektion). Es gibt nur zwei stabile Positionen:

### Position A — Volle Trennung: Self-Hosting (EXISTIERT BEREITS)
Will eine Community komplette Autonomie (eigener Speicher, eigene Regeln, eigene Verantwortung), ist
die Antwort **eine eigene Pulse-Instanz** (All-in-One-Image, Cert-Login, Direktpfad). Dort stimmt alles,
was beim Kanal-Modell bricht: Der Betreiber führt einen **echten, vollständigen Dienst** (nicht bloß
einen Ordner), die Pulse Cloud stellt nur Identität + Verzeichnis und verteilt keine Inhalts-Zugänge,
Moderation/Löschen funktioniert (ein Owner, eine Kopie), und die Verantwortungsübergabe ist die
Minecraft-Analogie, die schon im Identity-Konzept trägt. **Das gewünschte Feature ist im Kern schon
gebaut — es heißt Self-Hosting.** Sinnvolle Investition hier statt in Kanal-Hosting:
- **Community-Umzug**: Export einer Cloud-Community → Import in eine Self-Host-Instanz (Migrations-
  Werkzeug). Senkt die Schwelle, die Autonomie wirklich zu nehmen.
- Self-Host-Onboarding weiter vereinfachen (die geparkte Server-App-Richtung zahlt hierauf ein).

### Position B — Ehrliche Beteiligung: BYO-Bucket für Medien (Konzept aus dem Vorgespräch)
Community-Owner verbindet einen **S3-kompatiblen Bucket** (Hetzner etc.); Anhänge der Community landen
dort über den bestehenden presigned-URL-Pfad (`s3.py`); die Pulse Cloud **bleibt bewusst im Spiel**
(hält die Bucket-Credentials, signiert, kann löschen, scannt im Upload-Pfad — Arachnid-Quarantäne
funktioniert speicherunabhängig). Das verlagert **Kosten + Datenhoheit** zum Owner, hält aber Michaels
Handlungsfähigkeit — was nach der Kenntnis-Mechanik (OLG Hamburg) die BESSERE Position ist als
konstruierte Blindheit. Wichtige Owner-Schutz-Differenz zur Reinform: dedizierter Bucket ≠ persönliches
Google-Konto — ein Missbrauchsfall kostet schlimmstenfalls den Bucket, nicht Mail/Fotos/digitale
Identität des Owners.

### Was NICHT gebaut werden sollte
- ❌ Komplette Kanäle (Text+Medien) auf Consumer-Cloud-Speicher — alle drei Wände.
- ❌ Zugangs-Token-Verteilung zu fremdem Speicher durch die Pulse Cloud — eigene Haftungsfigur,
  schlechter als ein Link.
- ❌ Die Kopplung "normale Kanäle entschärfen, Riskantes nur noch bei Ownern" — juristisch der
  Bumerang (C-682/18), produktseitig der Onboarding-Killer (Prior-Art-Lehre 3).
- ❌ Ein "Verantwortungs-Hinweis"-Klick als Schutzkonzept — er schützt den Owner nicht und
  dokumentiert nur, dass die Plattform das Risiko kannte.

### Randnotiz: „Externer Kanal" als bloßer Verweis (falls je gewünscht)
Ein Kanal-Typ, der nur einen **vom Owner gesetzten Link** auf dessen komplett externe Infrastruktur
zeigt (seine Nextcloud, sein Forum, sein Matrix-Space) — ohne Token-Verteilung, ohne Mitglieder-Sync,
ohne Pings — bliebe in der sicheren „Paperboy"-Zone (normaler Link, Notice-and-Takedown wie für jeden
User-Link). Das ist ehrlich eine „Tür nach draußen", kein Pulse-Kanal — aber es ist die maximale
Externalisierung, die ohne Übernahme der zentralen Rolle geht.

---

## 3. Zum Entschärfen der normalen Kanäle

Die laufenden Maßnahmen (PMs ohne Anhänge, Kanäle nur Bilder, Dateiablage aus) sind als
**Risiko-Reduktion der Cloud** sinnvoll und unproblematisch. Zwei Grenzen:

1. **"Keine Links" bringt rechtlich fast nichts und kostet produktseitig viel.** Link-Haftung entsteht
   erst ab Kenntnis (BGH-Linie) — das fängt der normale Melde-und-Lösch-Prozess. URLs lassen sich
   ohnehin nicht wirksam verbieten (Menschen tippen sie als Text). Der Hebel ist ein funktionierender
   Art.-16-Meldeweg + zügiges Handeln, nicht das Feature-Verbot.
2. **Die Begründung zählt.** Maßnahmen als das dokumentieren, was sie ehrlich sind (Missbrauchs-
   Prävention, Betriebskosten, Moderierbarkeit) — nicht als Haftungsverschiebung zu den Usern.

---

## 4. Offene Punkte

- [ ] Entscheidung Position A vs. B (oder beide: Self-Host-Migration UND BYO-Bucket sind komplementär).
- [ ] Falls BYO-Bucket: Konzept aus dem Vorgespräch ausarbeiten (per-Guild `S3_*`, Schlüssel-Verwahrung,
      Owner-Aufklärung, Scan-Hook bleibt) — eigenes Plan-Dokument.
- [ ] Falls Community-Umzug: Export/Import-Format definieren (Messages + Attachments + Rollen).
- [ ] Anwaltliche Prüfung der Gesamt-Roadmap (ohnehin geplant, siehe medien-speicher-Doc §7) um die
      Fragen aus diesem Doc erweitern: Token-Verteilung, Owner-Position, Art.-26-Konstellationen.

## Quellen (Auswahl — Vollbelege in den Recherche-Berichten)

**Technik:** Nextcloud CORS-Issue: https://github.com/nextcloud/server/issues/3131 · Google
restricted scopes/CASA: https://support.google.com/cloud/answer/13464321 · Graph shares-get (Token
Pflicht): https://learn.microsoft.com/en-us/graph/api/shares-get · Dropbox Developer-ToS §2.6(c):
https://www.dropbox.com/developers/reference/tos · Drive-API-Limits:
https://developers.google.com/workspace/drive/api/guides/limits
**Prior Art:** Delta Chat: https://delta.chat/en/help · unhosted-Fazit:
https://unhosted.org/practice/34/Conclusions.html · NIP-29: https://github.com/nostr-protocol/nips/blob/master/29.md ·
HN „User's Google Drive als DB": https://news.ycombinator.com/item?id=38519864
**Recht:** DSA (Entgelt-Definition über RL 2015/1535): https://eur-lex.europa.eu/legal-content/DE/TXT/HTML/?uri=CELEX:32022R2065 ·
TMG-Aufhebung: https://dejure.org/BGBl/2024/BGBl._I_Nr._149 · Bundestag WD 7-3000-011/24 (Privilegien-
Lücke): https://www.bundestag.de/resource/blob/997210/WD-7-011-24-pdf.pdf · EuGH Pirate Bay C-610/15:
https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:62015CJ0610 · EuGH YouTube/uploaded C-682/18:
https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:62018CJ0682 · BGH 2 StR 151/11 (Link = Zugäng-
lichmachung): https://www.hrr-strafrecht.de/hrr/2/11/2-151-11.php · §184b StGB:
https://www.gesetze-im-internet.de/stgb/__184b.html · BKA-Bundeslagebild 2024:
https://www.bka.de/SharedDocs/Downloads/DE/Publikationen/JahresberichteUndLagebilder/SexualdeliktezNvKindernuJugendlichen/BLBSexualdeliktezNvKindernuJugendlichen2024.pdf ·
„Mark"-Fall (netzpolitik): https://netzpolitik.org/2022/falscher-verdacht-gegen-vater-ein-fall-aus-den-usa-zeigt-die-gefahr-der-geplanten-chatkontrolle/ ·
EuGH Jehovan todistajat C-25/17: https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:62017CJ0025 ·
Usenet-Zwillinge: https://torrentfreak.com/usenet-provider-claims-supreme-court-victory-against-anti-piracy-group-brein-230127/ ·
https://www.telemedicus.info/urteile/Internetrecht/Filesharing/705-OLG-Hamburg-Az-5-U-25507-Alphaload.html
