# Medien-Speicher auslagern & Content-Scanning

> Status: **Recherche/Plan, nichts gebaut.** Stand: **2026-07-16** (Vollrevision des Scanning- und
> Rechtsteils; Erstfassung 2026-07-14).
> Motivation: Fotos/Videos aus Textkanälen + PMs sollen (a) **nicht mehr physisch auf dem netcup-Server**
> liegen und (b) auf **illegale Inhalte (v.a. CSAM) gescannt** werden.
>
> ⚠️ **Kein Rechtsrat.** Rechtliche Punkte sind Recherche, ersetzen keine anwaltliche Beratung.
> Verwandt: `docs/managed-server-vermietung.md` (Host-Provider-Haftung, AGB/AUP).

> ### Was sich am 2026-07-16 geändert hat (Kurzfassung)
> Eine Faktenprüfung gegen die Primärquellen hat drei tragende Annahmen der Erstfassung widerlegt:
> 1. **„Cloudflare meldet Treffer selbst an die Behörden" — FALSCH.** Cloudflare sagt ausdrücklich, der
>    Betreiber muss weiterhin **selbst** melden. Du bekommst nur eine tägliche Treffer-Mail.
> 2. **„Freiwilliges Scannen ist bis April 2028 gedeckt" — FALSCH.** Die EU-Derogation ist am
>    **03.04.2026 ausgelaufen**; der Wiederherstellungs-Rechtsakt war nicht als final verifizierbar.
>    Und sie gilt ohnehin **nur für PMs, nicht für Hosting**.
> 3. **„Gratis geht nur bei Cloudflare, europäisch heißt pro Bild bezahlen" — FALSCH.** **Arachnid Shield**
>    (C3P, Kanada) ist kostenlos, EEA-tauglich und deckt **Bild UND Video** ab.
>    *(Tiefenprüfung Arachnid am selben Tag, siehe §3b-2: „self-serve" stimmt NICHT — es ist ein Antrag;
>    dazu zwei ernste Auflagen: HAM-Klassifikation + DSGVO-Transferlücke.)*
>
> **Folge: Der Cloudflare-Weg ist nicht mehr Rückfall-Option, sondern geprüft und verworfen** (§3d).
> Neuer Zielweg: **Hash-Matching im Upload-Pfad** (§3b) — unabhängig vom Speicheranbieter.

---

## 1. Ist-Zustand — wie Uploads heute laufen

Kern: `services/chat-gateway/src/dcc_chat_gateway/s3.py` + `config.py`. (Verifiziert 2026-07-16.)

- Der Speicher-Code spricht **Standard-S3** und redet mit **MinIO** (`pulse_minio`-Container auf netcup)
  nur, weil MinIO ebenfalls S3 spricht. **Kein MinIO-spezifischer Code.**
- **Browser-Direkt-Upload über presigned URLs:** chat-gateway signiert einen Einmal-Link
  (`presigned_put_url`), der Browser lädt die Datei **direkt** zu MinIO hoch. Die Bytes laufen
  **nicht** durch den FastAPI-Dienst. Beim Anzeigen dasselbe umgekehrt (`presigned_get_url`).
- **Jeder Link ist frisch signiert und kurzlebig:** `s3_presigned_ttl_seconds`, **Default 600 s**.
  Derselbe Anhang bekommt bei jedem Abruf eine **andere URL mit anderer Signatur**.
  → Für Teil B entscheidend, siehe §3d.
- Prod-Auslieferung: Browser erreicht MinIO über nginx `/s3/*` → MinIO (Signatur enthält den Host,
  darum signiert der Code mit dem **public** Endpoint = `s3_public_endpoint`).
- Betroffene Inhalte: **Nachrichten-Attachments** + **Dropbox-Dateien** + Guild-Sound-Overrides.
  (Guild-**Icons** liegen separat lokal via `guild_icon_upload_dir`, winzige Admin-Bilder — bleiben.)

**Folge:** Weil der Code reines S3 spricht und der Browser direkt hochlädt, ist Auslagern fast geschenkt.

> **Produkt-Änderung in Arbeit (2026-07-16, andere Session):** PMs sollen **keine Anhänge** mehr erlauben,
> Textkanäle **nur noch Bilder**, die Dateiablage (Dropbox) wird **vorerst deaktiviert**. Wenn das landet,
> schrumpft der Scan-Scope auf **Bilder in Kanälen** — das PM-Scanning-Problem (§5) löst sich dann durch
> Wegfall des Features, und die Video-Frage wird zweitrangig. Dieses Doc beschreibt weiter den vollen
> Umfang, falls Anhänge später zurückkommen.

---

## 2. Teil A — Speicher auslagern (nichts mehr auf netcup)

> **Wichtig (neu 2026-07-16): Teil A und Teil B sind vollständig unabhängig.** Der empfohlene Scan-Weg
> hängt im **Upload-Pfad**, nicht am Auslieferungs-Cache — er funktioniert bei **jedem** Speicheranbieter
> gleich. Die Speicherwahl ist damit eine reine Kosten-/DSGVO-Frage, kein Scanning-Argument mehr.

### Warum es fast geschenkt ist
Ein externer S3-Anbieter statt lokalem MinIO ist eine **Konfig-Änderung**, kein Umbau. Und weil der
Browser direkt zum Speicher lädt, landet — wenn der Speicher extern zeigt — **keine** dieser Dateien
je auf dem netcup-Server. Das ist genau das gewünschte Ergebnis.

### Umstell-Fläche (Env-Variablen, `Settings` in `config.py`, kein Prefix → Feldname in GROSS)
| Env-Var | heute (MinIO/dev) | extern (Beispiel) |
|---|---|---|
| `S3_INTERNAL_ENDPOINT` | `http://minio:9000` | öffentl. S3-Endpoint des Anbieters |
| `S3_PUBLIC_ENDPOINT` | `https://howispulse.com/s3` | **exakt der Host, den der Browser trifft** |
| `S3_REGION` | `us-east-1` | Region des Anbieters |
| `S3_BUCKET` | `pulse-attachments` | Bucket-Name beim Anbieter |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | `minioadmin` | Anbieter-Credentials |
| `S3_PRESIGNED_TTL_SECONDS` | `600` | bleibt |

### Stolpersteine (wichtig!)
1. **`S3_PUBLIC_ENDPOINT` muss exakt der Host sein, den der Browser aufruft** — die S3-Signatur bettet
   den Host ein. Falscher Host → 403 beim Upload/Download.
2. **CORS am externen Bucket** muss die Browser-Origin (`https://howispulse.com`) für PUT+GET erlauben,
   sonst blockt der Browser den Direkt-Upload.
3. **nginx `/s3/*`-Proxy wird überflüssig**, wenn direkt zum Anbieter-Host ausgeliefert wird (bzw. man
   proxied stattdessen zum externen Host — je nach gewünschter Domain).
4. **Bestehende Objekte** einmalig migrieren (z.B. `rclone`/`mc mirror` MinIO → neuer Bucket), sonst
   sind alte Attachments tot.
5. **Presigned-PUT-Kompatibilität** prüfen (Content-Type/Content-Length-Pinning aus `presigned_put_url`
   — die meisten S3-kompatiblen Anbieter unterstützen das, kurz verifizieren).
6. **`path`-Addressing:** `s3.py` erzwingt `addressing_style: path`. Anbieter, die nur virtual-host-Style
   können, brauchen hier eine Anpassung — vorher prüfen.

### Anbieter-Optionen (EU/DSGVO)
| Anbieter | Preis | Besonderheit |
|---|---|---|
| **Hetzner Object Storage** | €6,49/Mon inkl. 1 TB + 1 TB Egress | EU, deutscher Vertragspartner, DSGVO am einfachsten |
| DanubeData (Falkenstein) | ~€3,99/TB | EU |
| Scaleway (FR) | — | EU |
| IONOS S3 | günstig, keine Request-Gebühren | deutsche Marke |
| ~~Cloudflare R2~~ | ~$0,015/GB, Egress gratis | **US-Firma (CLOUD Act).** Der frühere Vorteil „integriert nativ mit dem CSAM-Tool" ist **hinfällig** — siehe §3d. Ohne diesen Bonus bleibt nur „billig + US" → raus. |
| Backblaze B2 | ~$6/TB | sehr billig, US-Firma (EU-Region Amsterdam) |

**Tendenz: Hetzner Object Storage.** Kein DNS-Umzug, deutscher Vertragspartner, reine `S3_*`-Umstellung.
(Formal noch nicht entschieden, siehe §7.)

### Die ehrliche Einschränkung
Auslagern ändert, **auf welcher Platte** es liegt — **nicht, wer verantwortlich ist.** Auch auf Hetzner
Object Storage unter deinem Account bleibst du Host-Provider im Rechtssinn. Gewinn ist trotzdem real:
netcup-Server bleibt sauber, Isolation (Bucket wegwerfbar), leichteres Wipen. **Frei macht dich erst
das Scannen (Teil B) + Notice-and-Takedown + AGB/AUP.**

---

## 3. Teil B — Content-Scanning (v.a. CSAM)

### 3a. Zwei Ebenen auseinanderhalten
1. **Bekanntes Material per Fingerabdruck (Hash-Matching):** unscharfer „perceptual hash" jedes Uploads
   → Abgleich gegen Behörden-/NCMEC-Datenbanken bekannter Missbrauchsbilder (erkennt auch veränderte
   Kopien). **Der rechtlich etablierte Hauptweg gegen CSAM.**
2. **Allgemeine KI-Erkennung** (nackt/Gewalt generell — Sightengine, AWS Rekognition, Google Vision):
   fängt *neues* Material, ungenauer, **nicht** CSAM-spezifisch. Nur Vorfilter.

**Der entscheidende Unterschied ist nicht der Preis, sondern wer hinschauen muss** (neu, wichtig):
Ein Klassifikator erkennt **kein CSAM**. Er erkennt „nackt" + „vermutlich minderjährig" — das ist ein
**Verdacht, den ein Mensch prüfen müsste**. In Deutschland ist genau das heikel: es gibt kein
Provider-Privileg, das die Sichtung strafbaren Materials deckt (§184b StGB).
**Hash-Matching umgeht das:** der Treffer ist bereits von einer autorisierten Stelle klassifiziert —
du musst **nichts anschauen**, um zu löschen und zu melden.
→ Das ist das stärkste Argument für Hash-Matching, noch **vor** dem Preis.

### 3b. Der empfohlene Weg: Hash-Matching im Upload-Pfad (kostenlos, EU-tauglich, Bild + Video)

Weil Uploads über presigned URLs laufen, ist **Quarantäne-dann-freigeben** sauber baubar:
Upload in `quarantine/`-Prefix → Scan per API → „sauber" = sichtbar schalten, Treffer = löschen + melden.
**Kein Auslieferungs-Fenster, kein Cache-Trick, unabhängig vom Speicheranbieter.**

| Dienst | Zugang | Kosten | Video? | Bewertung |
|---|---|---|---|---|
| **Arachnid Shield** (C3P, Kanada) | **Antrag, kein Self-Serve** („Request an account", Pflichtfelder Organization/Title; SDK: „obtain credentials by **contacting** Project Arachnid"). Formular hat **„European Economic Area"** als Jurisdiktions-Option | **kostenlos** („There is no cost to using this tool") | **Ja, nativ** — `/v1/media` nimmt `video/*`, serverseitige Frame-Extraktion, Antwort liefert **Timestamps** der Fundstelle | **Erste Wahl — mit Auflagen, siehe §3b-2.** Bester Aufwand/Nutzen mit Abstand |
| **IWF Image Intercept** (UK) | für „smaller companies and startups"; Antrag wird geprüft | **kostenlos bis 1 Mio. Checks/Monat** | Ja (Bild + Video) | **Zweite Quelle** (andere DB = andere Treffer). Nicht-UK-Eignung **unbestätigt** → bei IWF klären |
| **PhotoDNA Cloud** (Microsoft) | Vetting durch Drittanbieter | kostenlos für qualifizierte Kunden | bildbasiert (Video über Frames) | dritte Gratis-Quelle, falls Vetting durchgeht |
| Videntifier Nexus (IS) | self-serve-nah | **ab €100/Mon.** | **Ja** — überlebt Re-Encode/Crop/Watermark | erst bei echtem Umgehungs-Problem |
| Thorn Safer Essential | offen, aber Preis = K.o. | **$30.720/Jahr** | Ja | für uns nicht begründbar |
| Hive CSAM Detection | Enterprise/Sales | kein Preis veröffentlicht | Ja | Enterprise-Zuschnitt |

**Klassifikatoren (nur als späterer Zusatz, falls überhaupt):** Sightengine (FR) Free 2.000 Ops/Mon.,
Starter $29/10k — erkennt aber **kein CSAM**, nur Nacktheit + Alters-Schätzung. Video kostet **pro Frame**
(60-s-Video bei 1 fps = 60 Ops) — hier explodieren die Kosten, nicht bei Bildern.
Echte CSAM-Klassifikatoren gibt es nur bei Thorn und Hive, also genau bei den beiden ohne Self-Serve.

**Kostenrahmen bei 1.000–10.000 Uploads/Monat: praktisch null.** Arachnid ist gratis und
volumenunabhängig; IWF gratis bis 1 Mio./Mon. — unser Volumen liegt 2–3 Größenordnungen darunter.
**Die Kosten liegen nicht im Scannen, sondern im Meldeprozess (§3c).**

**Warum kein Self-Hosting des Abgleichs:** Metas **PDQ/TMK/HMA** ist frei
([GitHub](https://github.com/facebook/ThreatExchange)), aber **HMA bringt keine CSAM-Hash-Datenbank mit** —
der Betreiber muss eigene Hash-Listen mitbringen. Ein Motor ohne Treibstoff.
**Die Liste gibt niemand heraus** (aus gutem Grund: eine CSAM-Hash-Liste in Umlauf ist ein Werkzeug zum
Testen, was durchrutscht). Deshalb sind alle offenen Angebote **gehostete API-Dienste**: Medien oder
Hashes hin, Match/No-Match zurück. **Du kommst an den Abgleich, nicht an die Daten** — und das reicht.

### 3b-2. Arachnid Shield — Tiefenprüfung (2026-07-16): erste Wahl bleibt, aber mit vier Auflagen

> Adversariale Prüfung gegen die Primärquellen (rohe `openapi.json` v1.1.0, SDK-Quellcode, C3P-Policies,
> Live-Probe des Auth-Pfads, gezielte Suche nach Kritik). Ergebnis: **bestätigt als bester Kandidat,
> aber kein Häkchen — eine Entscheidung mit Auflagen.**

**Bestätigt (wörtlich belegt):** kostenlos ohne Volumen-Caveat · Video nativ mit serverseitiger
Frame-Extraktion + Timestamps · EEA als erste Option im Jurisdiktions-Dropdown · Auth = HTTP Basic
(live verifiziert, 401 + `www-authenticate: Basic`) · Dienst lebt (API antwortet, Stand heute).

**Korrigiert:** „Self-serve" stimmt nicht — es ist ein **Antrag** („Request an account"/„Submit request",
Organization + Title Pflicht). Ob dahinter manuelles Vetting läuft, ist **undokumentiert**; einziger
öffentlicher Erfahrungsbericht weltweit: ein japanischer Einzelentwickler, dem C3P 2026-06 bestätigte,
dass auch kleine Betreiber Shield nutzen dürfen (Eignungs-Zusage, keine ausgestellten Credentials).
Öffentliche Stichprobe = N=1. **Kein einziger dokumentierter EEA-Nutzer.** Referenzliste: 11 von 12 sind
DNS-Filter/ISPs — **keine Chat-Plattform, kein UGC-Host**. Wir wären öffentlich sichtbar die Ersten.

**Die vier Endpunkte** (aus der rohen Spec — es gibt KEINEN SHA256/MD5-Lookup):
| Pfad | Nimmt an | Bedeutung für uns |
|---|---|---|
| `POST /v1/pdq` | **nur PDQ-Hashes** (JSON) | **Empfohlener Pfad**: Datei bleibt bei uns, nur der perzeptuelle Hash geht nach Kanada. PDQ selbst berechnen; Video = Frames selbst extrahieren + einzeln hashen |
| `POST /v1/media` | `image/*`, `video/*` roh | bequem, aber **die Datei geht zu C3P**; Retention **undokumentiert** |
| `POST /v1/media/submit` | Verdachts-Einreichung | Medium wird „retained for future detection" — nur für bewusste Meldungen |
| `POST /v1/url` | URL-Scan | Domains müssen vorab am Account autorisiert sein — passt nicht zu presigned URLs |

**⚠️ Auflage 1 — die HAM-Klassifikation (designentscheidend):**
`classification` kennt vier Werte: `csam` · `harmful-abusive-material` · `test` · `no-known-match`.
Aus C3Ps eigenem Arachnid-Report (Tab. 2.2, 2018–2020): von 5,42 Mio. verifizierten Funden sind
**1,89 Mio. = 34,9 % „harmful-abusive-material"** — Material, das nach C3Ps eigener Beschreibung
*„über mehrere Jurisdiktionen hinweg keine Strafbarkeitsschwelle zu erreichen scheint"* (so hedged C3P
selbst; NICHT als „nicht strafbar" verkürzen — C3Ps Beispiele sind in manchen Ländern sehr wohl strafbar).
HAM ist **kontextabhängig, nicht bildinhärent** (ein Badeanzug-Foto wird HAM, weil es *woanders*
sexualisiert gepostet wurde) — **ein Hash kann diesen Kontext nicht transportieren**. Der Enum-Wert hat
in der API-Spec **keinerlei Beschreibung**; die Definition steht nur in einem PDF.
→ **Harte Regel: auf `csam` handeln (§3c-Prozess); auf HAM NIEMALS automatisch löschen** — höchstens
menschliche Review-Queue. Sonst löschen wir legales Material auf Zuruf einer kanadischen NGO — gegen
Art. 14 DSA („sorgfältig, objektiv, verhältnismäßig") und BGH III ZR 179/20 (Lösch-AGB-Kontrolle,
Anhörungspflicht).

**⚠️ Auflage 2 — die DSGVO-Transferlücke (härter als in §4d zunächst notiert):**
Kanada-Angemessenheit (2002/2/EC) gilt nur für Empfänger, die **PIPEDA unterliegen**; PIPEDA erfasst nur
**kommerzielle Tätigkeit** (Non-Profits/Charities ausgenommen). C3P = eingetragene Charity, Shield =
gratis → **sehr wahrscheinlich außerhalb der Angemessenheit**. C3P sagt es de facto selbst: „We adhere
to… PIPEDA, **when and as they apply**… **Where the laws don't apply**… adheres to the **spirit of**
PIPEDA" — und beruft sich auf die **aufgehobene** RL 95/46/EG. Kein DPA, keine SCC, kein Art.-27-
Vertreter auffindbar; „DSGVO/GDPR" kommt auf keiner C3P-Seite vor. **Diese Lücke hat öffentlich noch
niemand auf C3P bezogen — sie ist ungeprüft, nicht erledigt.**
→ Entschärfung: **`/v1/pdq` statt `/v1/media`** (nur Hash verlässt uns). Aber kein Freibrief: PDQ ist
perzeptuell und **invertierbar** (Rekonstruktion bis ~97 % Ähnlichkeit gezeigt), und nach EuGH
C-413/23 P (EDPS/SRB, 09/2025) ist Identifizierbarkeit **relativ zum Empfänger** — C3P hält die
Referenz-DB. → **Anwaltsfrage, vor Nutzung klären.**

**⚠️ Auflage 3 — der Vertrag ist unsichtbar:** Die Spec verweist als Terms auf C3Ps **Website-ToU von
2018** („personal use", Verbot kommerzieller Nutzung — offensichtlich das falsche Dokument; die in der
API erwähnten Shield-„Terms and Conditions of Use" sind **nicht auffindbar/404**). Man kann vor der
Registrierung nicht wissen, worauf man sich verpflichtet. → Vorab schriftlich anfordern.

**⚠️ Auflage 4 — SDK vendorn:** Offizielle SDKs existieren (PyPI `arachnid-shield-sdk` v0.2.2,
2025-07-17, httpx sync+async — passt zu unserem Stack), sind aber Ein-Personen-Beispielcode und
**nachweislich hinter der Spec** (Enum-Wert `test` fehlt; `near_match_details`-Schema widerspricht der
Spec — flach vs. verschachtelt, nur am Live-Endpunkt klärbar). → HTTP-Aufrufe selbst bauen oder SDK
vendorn, nicht blind dependen.

**Realistische Wirkungsgrenze (fair einordnen):**
- **Ein Filter, keine Mauer.** Spiegeln bringt die PDQ-Distanz auf ~0,4975 ≈ Zufallsniveau (Schwelle
  0,121); 5-%-Crop auf 0,33. Wer vorsätzlich verteilt, umgeht das gratis. Arachnid fängt **Unachtsame
  und Weiterverteiler** — laut Metas eigenen Zahlen >90 % des Aufkommens bereits bekanntes,
  rezirkulierendes Material, also genau das Zielprofil. (Ob Arachnid dihedrale PDQ-Varianten matched:
  undokumentiert → C3P fragen.)
- **Ein Treffer ist kein Täter-Beweis:** Meta: >75 % der gemeldeten Accounts ohne böse Absicht
  (Empörung/Humor-Weiterleitung). → Treffer-Prozess ja, **automatische Account-Vernichtung nein**.
- **Keine publizierte Fehlerrate, kein Confidence-Score, kein Schwellwert, kein Einspruchsweg** — C3P
  publiziert Volumen, nie Genauigkeit. Die kursierende Kritik (4 angebliche Fehlklassifikationen, u.a.
  „Pippi-Langstrumpf-Standbild") stammt komplett aus **einer** verbrannten Quelle (Prostasia, aufgelöst
  2025, Darstellung von R. Clayton/Cambridge als „untrue" widersprochen) — **nicht darauf stützen**.
  Die seriöse Kritik ist strukturell: private, staatlich finanzierte Stiftung, eigene „harmful"-Schwelle,
  keine Audits, kein Rechtsweg. Das spricht nicht gegen Nutzung — es begründet Auflage 1.
- Die berühmte Hash-Scanning-Kritik (Apple NeuralHash, Chatkontrolle, EFF) zielt auf **Client-Side-
  Scanning** und trifft unseren serverseitigen Fall nicht. PDQ ist unter realistischen Bedingungen sogar
  robuster als PhotoDNA (Madden et al., NeurIPS'24), und weil C3Ps Liste **nicht öffentlich** ist, sind
  Framing-Angriffe praktisch ausgeschlossen — struktureller Vorteil gegenüber NeuralHash.

**Vor der Registrierung schriftlich an `shield@projectarachnid.com`:**
(a) Shield-Vertragstext/DPA · (b) Versteht sich C3P als „subject to PIPEDA"? · (c) Werden SCC angeboten?
· (d) Retention bei `/v1/media` · (e) **Meldet C3P den einreichenden Anbieter selbst an Behörden?**
(Policy behält Polizei-Kontakt als Ermessen vor, dokumentiert ist für API-Einreichungen nichts) ·
(f) Wofür wird die EEA-Jurisdiktionsauswahl verwendet? · (g) Dihedral-Matching + `near`-Schwellwert ·
(h) Rate-Limits/Max-Dateigröße (nirgends dokumentiert).

### 3c. Der Treffer-Prozess — die eigentliche Arbeit (NICHT optional)

> **Kontraintuitiv, aber die wichtigste Erkenntnis der Recherche:**
> **Scannen ohne Reaktionsprozess ist rechtlich SCHLECHTER als gar nicht zu scannen.**

Ein Treffer erzeugt **„tatsächliche Kenntnis"** (Art. 6 DSA). Ab dieser Sekunde schützt das
Haftungsprivileg nur noch den, der **unverzüglich** handelt. Das OLG Hamburg (5 W 41/13) hat einen
Hostprovider als **Gehilfen** haften lassen — nicht bloß als Störer —, weil er zwischen Kenntnis und
Löschung untätig blieb (bedingter Vorsatz). Anderer Rechtsbereich, gleiche Mechanik; bei CSAM ist der
Maßstab strenger (faktisch: sofort).

**Vor dem ersten Scan muss stehen:**
1. **Löschen** — Inhalt sofort aus dem Speicher + unerreichbar schalten.
2. **Melden ans BKA** — Portal **`u-entrance.bka.de`** (Art. 18 DSA i.V.m. §13 DDG). Zu übermitteln:
   Inhalt, Veröffentlichungszeitpunkt, Username/User-ID, IP (falls vorhanden), internes Aktenzeichen.
   Das BKA stellt die Übermittlung solcher Beweismittel **straflos** (sonst §184b StGB).
   Optional zusätzlich NCMEC — man **darf** als Nicht-US-Anbieter (23 % der registrierten ESPs sind
   Nicht-US, freiwillig); BKA erlaubt, die NCMEC-Report-Nummer zu referenzieren (keine Doppelmeldung).
3. **Beweise sichern** — Kopie + Daten, **ein Jahr** aufbewahren (so auch Cloudflares eigene Empfehlung).
4. **Account-Konsequenz** + Eintrag im internen Log.

**Gegenläufig zur Beruhigung:** Das **KG Berlin** hat entschieden, dass ein Hosting-Provider für
**unerkannte** strafbare Inhalte seiner Nutzer **nicht selbst strafbar** ist (§10 TMG, heute §10 DDG).
Wer nach Kenntnis zügig handelt, ist auf dieser Seite der Linie. Wer Treffer liegen lässt, wandert
Richtung OLG Hamburg. **Bußgelder gegen kleine deutsche Anbieter wegen CSAM: keine auffindbar.** Die
verurteilten Fälle (LG Frankfurt „Boystown", LG Mönchengladbach) sind durchweg **vorsätzliche**
Darknet-Betreiber — eine andere Welt.

### 3d. Cloudflare CSAM Scanning Tool — GEPRÜFT UND VERWORFEN (2026-07-16)

> Die Erstfassung führte das als „einfachsten + billigsten Weg" und „Rückfall-Option". **Das hält der
> Prüfung gegen die Primärquellen nicht stand.** Vier Gründe, der erste allein genügt:

**1. Es würde unsere Bilder vermutlich nie zu sehen bekommen — der K.o.**
Cloudflare definiert den Auslöser wörtlich am **Cache**:
> „Cloudflare will compare content served for your website **through the Cloudflare cache** to known
> lists of CSAM." ([Doku](https://developers.cloudflare.com/cache/reference/csam-scanning/))
> „the tool automatically hashes images for enabled websites **as they enter the Cloudflare cache**."
> ([Changelog 2025-02-04](https://developers.cloudflare.com/changelog/post/2025-02-04-easier-onboarding-for-csam-scanning-tool/))

Unser Auslieferungsweg passt da schlecht rein: **jedes Bild kommt über eine frisch signierte presigned
URL mit 600-s-Ablauf** (§1). Jeder Abruf = andere Signatur = anderer Cache-Key = Cache-Miss; ein
etwaiger Eintrag ist 10 Minuten später an eine tote URL gebunden.
*Ehrlich beim Unsicherheitsgrad:* Die verbreitete Behauptung „CF cached keine Query-String-URLs" ist
**falsch** (Query-Strings sind Teil des Cache-Keys, sie verhindern Caching nicht) — es ist also nicht
ausgeschlossen, dass die Antworten trotzdem eintreten und gehasht werden. Aber: **Cloudflare
dokumentiert das Zusammenspiel presigned URL ↔ CSAM-Tool nirgends**, und es gibt eine **unbeantwortete
Frage in CFs eigenem Community-Forum**, ob das Tool bei proxied Custom Domain greift.
→ Man würde eine Schutzmaßnahme aktivieren, von der niemand sagen kann, ob sie feuert. **Und Fehlalarm
gibt es nicht: ein nicht scannender Scanner meldet einfach nie etwas.**

Für **R2** ist es schärfer: das Tool ist eine **Zone-Einstellung**
(`/zones/{zone_id}/settings/csam_scanner_third_party`). Presigned R2-URLs laufen gegen
`r2.cloudflarestorage.com` — **nicht unsere Zone**, dort existiert die Einstellung nicht. `r2.dev`
scheidet dokumentiert aus (kein Cache). Einziger plausibler Pfad wäre proxied Custom Domain mit
**öffentlich cachebaren** Objekten — das Gegenteil unserer privaten, signierten Links.

**2. Cloudflare meldet NICHT für uns.** (Das war der Hauptirrtum der Erstfassung.)
> „site operators are **still expected to continue to file their own reports with NCMEC** or their
> regional equivalent"
> ([Update-Blog](https://blog.cloudflare.com/a-simpler-path-to-a-safer-internet-an-update-to-our-csam-scanning-tool/))

Und ausdrücklich: die Nutzung „does not relieve you of any legal requirements... including obligations
that may be applicable in your **local jurisdiction**". Was man bekommt: eine **tägliche E-Mail mit den
Dateipfaden** + (best effort) ein Block mit **451**; schlägt der Block fehl, steht das in der Mail.
CFs eigene third-party-Reports an NCMEC sind laut CF „**not as comprehensive**" als eigene Meldungen.
→ Der ganze Vorteil „du fasst das Material nie an, CF meldet" **existiert nicht**.

**3. Video ist nicht abgedeckt.** CF spricht durchgehend nur von *images* (PhotoDNA = Bild-Hashing).
*Fairerweise:* eine ausdrückliche Aussage „Videos werden nicht gescannt" gibt es **nicht** — es ist
dokumentierte Abwesenheit, kein Dementi. Für unser Ziel (Bild **und** Video) trotzdem entscheidend.
**Arachnid kann Video nativ — gratis.**

**4. Preis-Nebenwirkungen:** DNS-Zone zu Cloudflare (die Subdomain-Variante `media.howispulse.com` ist
für das CSAM-Tool **nicht belegbar**) + **US-Firma im Datenpfad** (CLOUD Act) — der Bruch im sonst
durchgehend deutschen Stack, den wir bewusst nicht wollten.

**5. Nebenpunkt für die Vermietungspläne:** CFs Service-Terms erlauben das Tool „solely for your
**internal use**" und untersagen ausdrücklich, damit „a **managed service solution**" anzubieten
([Service-Specific Terms](https://www.cloudflare.com/service-specific-terms-application-services/)).
Für `docs/managed-server-vermietung.md` relevant.

**Was an Cloudflare stimmt** (der Vollständigkeit halber): kostenlos auf **allen** Plänen inkl. Free;
die **NCMEC-Credential-Hürde ist seit 2025-02-04 weg** — heute reicht eine **verifizierte E-Mail**.
Nur nützt das nichts, wenn Punkt 1 nicht trägt und Punkt 2 die Entlastung wegnimmt.

---

## 3e. Scope-Klärung: was läge WO? (verifiziert 2026-07-14, weiter gültig)
Häufiges Missverständnis: „Umweg über externen Speicher bei Textnachrichten" ≠ die Nachrichten
selbst wandern raus. **Nur die hochgeladenen Datei-Blobs** verlassen netcup, alles andere bleibt.

**Würde ausgelagert (nur diese Blobs, via `s3.py`):**
- Datei-Anhänge in Nachrichten (Fotos/Videos/**Dokumente**) — Kanäle **und** PMs
- Dropbox-Dateien · Guild-Sound-Overrides (Custom-Sounds)

**Bleibt auf netcup (praktisch das ganze Pulse):**
- **Der Text der Nachrichten selbst** (Postgres chat-DB) · alle Metadaten (wer/wann/an wen/Kanal)
- Konten/E-Mails/Passwörter (auth-DB) · **Avatare** (lokale Platte `avatar_upload_dir`, NICHT S3, verifiziert)
- Community-Icons (lokal) · Voice (LiveKit) · HQ-Streams (MediaMTX, live/ungespeichert) · Rollen/Rechte/
  Präsenz/Einstellungen

**Beim (verworfenen) Cloudflare-Weg wäre zusätzlich** die **Auslieferung** durch CF gelaufen → CF hätte
auch **Abruf-Metadaten** gesehen (welche IP holt wann welche Datei). Beim Hash-Matching-Weg (§3b)
entfällt das: der Scan-Dienst sieht **nur die Datei beim Upload**, keinen Auslieferungs-Traffic.
Auch dort gilt: **keine Texte, keine Konten, keine Nachrichten-Metadaten.**

---

## 3f. Live-Streaming — kein Speicher-Problem, aber ein Handlungs-Problem (neu 2026-07-16)

> **Kurz:** HQ-Streams sind rechtlich **entspannter** als die Dateien (nichts wird gespeichert), aber es
> fehlt der **Abschaltknopf** — und genau der ist die Achse, an der die Haftung hängt.

### Warum Streaming eine andere Risikoklasse ist
- **Es wird nichts gespeichert.** MediaMTX reicht live durch, danach ist der Inhalt weg (§3e). Kein
  Blob auf der Platte, nichts zu löschen, keine Altlast, nichts, was bei einer Durchsuchung auffindbar ist.
- **Rechtlich näher an der Durchleitung als am Hosting:** ohne Speicherung greift die Hosting-Logik aus
  Art. 6 DSA kaum; eine allgemeine Überwachungspflicht gibt es ohnehin nicht (§4c).
- **Scannen ist praktisch ausgeschlossen:** Hash-Matching braucht eine fertige Datei. Live bliebe nur
  Frame-Sampling durch einen Klassifikator — der **kein CSAM erkennt** (§3a) und pro Frame abrechnet.
  Twitch/YouTube lösen das über Meldungen + Moderatoren-Personal, nicht über Vorab-Erkennung.
- **Missbrauchsanreiz gering:** Stream läuft nur im Kanal, nur für anwesende Mitglieder, danach spurlos.
  Verbreitung funktioniert über Ablegen, nicht über einmaliges Zeigen.

→ **Der Schutz kann hier nur reaktiv sein: Meldung → unverzügliches Handeln.** Dieselbe
Kenntnis-dann-Handeln-Mechanik wie bei den Dateien (§3c).

### Die Lücke (Code-Stand verifiziert 2026-07-16)
| Ist | Fundstelle |
|---|---|
| Melde-Grund `csam` existiert bereits | `models/moderation.py::Report.reason_code` |
| Report-Ziele: **nur** `target_message_id` / `target_user_id` / `target_channel_id` | ebd. — **kein Stream-Ziel** |
| media-svc spricht MediaMTX **ausschließlich lesend** (`/v3/paths/list`, Poller) | `dcc_media_svc/poller.py`, `config.py` |
| **Kein Kick-/Terminate-Aufruf im ganzen Repo** | — |

**Konsequenz:** Meldung „in Kanal X läuft gerade ein illegaler Stream" → Bann des Nutzers **stoppt den
laufenden Stream nicht**. Der auth-hook prüft das Publish-Token **einmal beim Verbindungsaufbau**; danach
fragt MediaMTX nicht mehr nach. Der Bann verhindert den *nächsten* Stream. Auch bereits verbundene
Zuschauer behalten ihre WHEP-Session (Read-Token wird nur beim Request geprüft).
→ Einzige heutige Abhilfe: **SSH auf den Server + Container anfassen.**

**Warum das das eigentliche Problem ist:** Es ist **kein Erkennungs-, sondern ein Handlungsproblem**.
Kenntnis liegt vor, unverzügliches Handeln ist technisch nicht möglich — genau die Konstellation aus
OLG Hamburg (§3c), nur ohne Vorsatz-Vorwurf. Das ist der einzige Weg, auf dem Live-Inhalte dich
überhaupt treffen können.

### Lösungsskizze (überschaubar)
1. **Admin-Kill für laufende Streams** — MediaMTX hat Kick-Endpunkte für laufende Verbindungen/Sessions
   (**noch gegen die 1.19-API zu verifizieren**, siehe §7). API-Zugang (`:9997`) besteht bereits, media-svc
   müsste nur schreibend dürfen. Rechte-Bit über den bestehenden Resolver gaten.
2. **Stream als Melde-Ziel** — `target_stream_path` o.ä. im `Report`-Modell, damit die Meldung den
   konkreten Live-Pfad trifft statt nur „Kanal/Nutzer".
3. Optional: Kill-Aktion in `ModAuditLog` protokollieren (Beleg für „unverzüglich gehandelt").

**Nicht bauen:** Live-Frame-Scanning. Kosten + kein CSAM-Erkennungswert + §184b-Sichtungsproblem (§3a).

---

## 3g. Identifizierbarkeit — was kann eine Meldung überhaupt enthalten? (neu 2026-07-16)

> **Kurz:** Der **Username ist für Ermittlungen wertlos**. Der Schlüssel ist **IP + exakter Zeitstempel**.
> Den hat Pulse derzeit **nicht in verwertbarer Form** — §3c führt „IP (falls vorhanden)" als Meldefeld,
> faktisch heißt das heute **nein**.

### Der reale Ermittlungsweg
1. Betreiber meldet: Username + **Zeitstempel** + **IP** (+ idealerweise Quell-Port).
2. Behörde fragt per Beschluss beim **Zugangsanbieter** (Telekom/Vodafone/o2): wer hatte diese IP zu
   dieser Sekunde?
3. Zugangsanbieter kennt den **Anschlussinhaber** (Vertrag) → Name + Adresse.

Der Betreiber ist nur **der erste Datenpunkt** der Kette. **Kein Klarname nötig** — Discord/Reddit/X
haben ihn ebenso wenig.

### Drei Stellen, an denen die Kette reißt
| Bruchstelle | Wirkung |
|---|---|
| **Keine Vorratsdatenspeicherung in DE** — EuGH 2022 (C-793/19 SpaceNet) kippt §§113a/b TKG, BVerwG 2023 bestätigt | Zugangsanbieter speichert die IP-Zuordnung **nicht auf Vorrat** → Meldung 2 Wochen später läuft ins Leere. Daran scheitert real ein Großteil der Verfahren. **„Quick Freeze"/IP-Speicherpflicht: Stand 2026 UNGEPRÜFT** (§7) |
| **CGNAT im Mobilfunk** | Tausende Kunden teilen eine öffentliche IP. Ohne **Quell-Port** + sekundengenaue Zeit ist die Anfrage wertlos. Port protokolliert praktisch niemand — **wir auch nicht** |
| **Pulse hat den Datenpunkt nicht** | siehe unten |

### Code-Stand (verifiziert 2026-07-16)
| Pfad | Was | Verwertbar? |
|---|---|---|
| `RefreshToken.ip_hash` (`models.py:325`, via `_hash_ip` `routes.py:155`) | **SHA-256-Hash** der IP. Docstring ausdrücklich: „The raw IP is never persisted". Zweck: Sessions-Liste markiert „dieses Gerät" | **Nein** |
| `UserSession.ip` (`browser_sessions.py::create_session`) | **rohe IP**, aber an die **Login-Session** gebunden, **30-Min-Fenster** (`_DEFAULT_TTL=1800`, gleitend via `validate_session`) | **Kaum** — s.u. |
| Nachricht / Upload / Attachment | **keine IP, kein Port** | **Nein** |

**Konsequenz:** Für „wer hat Datei X um 14:32:07 hochgeladen?" müsste man den Nachrichten-Zeitstempel mit
einer zufällig zeitlich passenden Session-Zeile **korrelieren** — Indiz, kein Beleg. Nach Ablauf weg.
**Die Meldung ans BKA enthielte real fast nur einen Usernamen.**

**Nebenbefund (erklärungsbedürftig):** Die Zusicherung „rohe IP wird nie gespeichert" gilt nur für den
`ip_hash`-Pfad — die Spalte `UserSession.ip` daneben tut genau das. Für Datenschutzerklärung/Auskunft
sauber ziehen.

### Zwei Dinge auseinanderhalten
- **Pflicht:** Es gibt **keine Klarnamenpflicht**; Telemediendienste sollen anonyme Nutzung sogar
  ermöglichen, soweit zumutbar (§19 TDDDG, früher §13 VI TMG). Pflicht ist **entfernen + melden, was man
  hat** (§3c). Scheitert die Identifizierung an fehlenden Daten, ist das **kein Versäumnis des Betreibers**.
- **Wirksamkeit:** Wer „maximale Absicherung" will, sollte wissen: eine Meldung ohne IP ist **zahnlos**.

### Optionen (nicht entschieden)
1. **IP + Zeitstempel am Upload/Post selbst** für ein **kurzes Fenster** festhalten (Größenordnung aus der
   Sicherheits-Rechtsprechung: **7 Tage**). Braucht **dokumentierte Interessenabwägung (LIA)** — dieselbe,
   die für das Scannen ohnehin ansteht (§6.4). **Quell-Port mitschreiben**, sonst hilft es bei Mobilfunk nicht.
2. **Nichts tun** — vertretbar, siehe „Pflicht" oben. Dann aber wissen, dass Meldungen meist folgenlos bleiben.

**Bereits vorhanden und unterschätzt: die verifizierte E-Mail-Adresse.** Oft der **stärkere** Ansatz als
die IP, weil E-Mail-Anbieter im Gegensatz zu Zugangsanbietern **langfristig** speichern (Login-IPs über
Monate, Wiederherstellungsnummer, ggf. Zahlungsprofil). Das E-Mail-Verifizierungs-Gate macht die Meldung
überhaupt erst anschlussfähig — **das ist der Datenpunkt, den wir schon haben.**

---

## 4. Rechtslage (Stand 2026-07-16 — REVIDIERT, heißes Thema)

> **Die Erstfassung („freiwilliges Scannen bis April 2028 erlaubt") war falsch.** Richtig ist:

### 4a. Die ePrivacy-Derogation ist AUSGELAUFEN — und der Ersatz ist nicht verifizierbar final
- VO 2021/1232, verlängert durch VO (EU) 2024/1307 bis **03.04.2026**.
- **EUR-Lex führt VO 2021/1232 als „No longer in force", Ende 03/04/2026.**
- 11.03.2026: EP nimmt Änderungen an (458:103:63), will nur bis **03.08.2027** (Kommission: 03.04.2028).
- 26.03.2026: Verhandlungen scheitern; EP lehnt Verlängerung ab (311:228:92).
- **03.04.2026: Derogation läuft aus → echte Regelungslücke.**
- 02.07.2026: Rat nimmt Standpunkt erster Lesung an (unverändert bis **April 2028**).
- 09.07.2026: EP, zweite Lesung — Ablehnungsantrag 314:276 **verfehlt die absolute Mehrheit (360/361)**.
- **Update aus zweiter Recherche (2026-07-16):** netzpolitik.org und heise berichten übereinstimmend,
  die Wiederbelebung sei am 09.07.2026 **durchgegangen** (Verfahrens-Kuriosum: mehr Nein- als
  Ja-Stimmen, aber Ablehnung des Ratsstandpunkts hätte die absolute Mehrheit gebraucht) — Geltung bis
  **03.04.2028**, **E2E-verschlüsselte Dienste ausgenommen**.
  ([netzpolitik](https://netzpolitik.org/2026/eu-parlament-freiwillige-chatkontrolle-geht-mit-verfahrenstrick-durch/),
  [heise](https://www.heise.de/en/news/Procedural-trick-before-summer-break-EU-Parliament-reactivates-Chat-Control-1-0-11359605.html))
  **Amtsblatt-Verifikation (EUR-Lex) steht weiter aus** — vor einer PM-Scanning-Entscheidung prüfen.
  Für Pulse günstig: nicht-E2E → nicht ausgenommen → dürfte (nach Inkrafttreten) scannen.

### 4b. Der entscheidende Punkt: die Derogation betrifft unser Hauptthema gar nicht
Sie gilt **nur für „nummernunabhängige interpersonelle Kommunikationsdienste"** (Messaging, Webmail,
VoIP) — **nicht für allgemeine Hostingdienste**. Daraus folgt eine **Zweiteilung**:

| | Rechtsnatur | Braucht Derogation? | Bewertung |
|---|---|---|---|
| **Öffentliche Kanäle / hochgeladene Medien** | **Hosting** | **Nein** — Art. 5 ePrivacy-RL greift nicht | **Klar gangbar**, allein nach DSGVO (§4d) |
| **Private Nachrichten (DMs)** | interpersonelle Kommunikation | **Ja** | **In der Lücke rechtlich unsicher** → zurückstellen |

**Nicht-E2E ist hier ein Vorteil:** falls die Derogation zurückkommt, ist ein *nicht* verschlüsselter
Dienst gerade **nicht** ausgenommen — dürfte also scannen.

### 4c. Pflichten nach DSA — Art. 18 gilt auch für uns
- DSA gilt seit 17.02.2024 für **alle** Vermittlungsdienste, **unabhängig von der Größe** (Marktortprinzip).
- **Art. 19 nimmt nur Abschnitt 3 aus (Art. 20–28)** — **Art. 16, 17 und 18 gelten voll.**
  (Nur Art. 15 Transparenzberichte sind für Kleinst-/Kleinunternehmen ausgenommen.)
- **Art. 18 (Meldung des Verdachts auf Straftaten):** Bei Verdacht auf eine Straftat **mit Gefahr für
  Leben oder Sicherheit einer Person** ist **unverzüglich** die Strafverfolgungsbehörde zu informieren.
  Erwägungsgrund 56 nennt die RL 2011/93/EU ausdrücklich → **CSAM ist erfasst**; das BKA bestätigt:
  „Für alle übrigen Hostingdiensteanbieter gilt die Meldeverpflichtung seit dem 17. Februar 2024."
- **Keine Pflicht zur proaktiven Suche** (auch §2258A(f) US kennt keine Suchpflicht) —
  aber **Entfernungs- UND Meldepflicht nach Kenntnis**. Genau darum §3c.
- **18 U.S.C. §2258A gilt für uns nicht** (US-Provider-Pflicht). NCMEC behandelt Nicht-US-Anbieter als
  freiwillig registriert. Unser Pflichtweg ist das **BKA**.

### 4d. DSGVO
- **Öffentliche Uploads:** Art. 6 Abs. 1 lit. f (berechtigtes Interesse) gut vertretbar — Kinderschutz +
  Haftungsvermeidung, niedrige Erwartungshaltung bei öffentlich Geteiltem. Alternativ lit. c über
  Art. 16/18 DSA. **Dokumentierte Interessenabwägung (LIA) ist Pflicht** — eine bloß behauptete
  Abwägung trägt nicht.
- **PMs:** Hürde ist **nicht** Art. 6, sondern das **Fernmeldegeheimnis / die Vertraulichkeit der
  Kommunikation** — **lex specialis**, geht der DSGVO vor. Dass es überhaupt die Sondernorm
  VO 2021/1232 brauchte, zeigt: „berechtigtes Interesse" reicht dafür **nicht**. Zusätzlich potenziell
  **Art. 9** (Daten zum Sexualleben). **Einwilligung ist kein Ausweg** — der Empfänger/abgebildete
  Dritte haben nicht eingewilligt.
- **Drittlandtransfer** (falls je ein US-Dienst genutzt wird): AVV nach Art. 28 zwingend. Cloudflare ist
  **DPF-zertifiziert** (Participant ID 5666) → Art. 45, SCC als Fallback. **Bei Arachnid (Kanada):
  Angemessenheitsbeschluss trägt sehr wahrscheinlich NICHT** — er gilt nur für PIPEDA-unterworfene
  (= kommerzielle) Empfänger; C3P ist Charity, Shield gratis, und C3P beansprucht PIPEDA-Bindung selbst
  nicht („spirit of PIPEDA"). Voll-Analyse + Entschärfung über den Hash-only-Endpunkt: **§3b-2, Auflage 2.**
  Vor Nutzung anwaltlich klären.

---

## 5. PMs mitscannen — ENTSCHEIDUNG VOM 2026-07-14 STEHT AUF WACKLIGEM GRUND

**Damalige Entscheidung:** PMs werden mitgescannt. **Begründung damals:** „die Medien landen ohnehin auf
demselben Speicher" — und die Annahme, es sei „EU-rechtlich bis 2028 gedeckt".

**Revision 2026-07-16:** Die technische Begründung stimmt, **trägt die rechtliche Bewertung aber nicht** —
Speicherort und Kommunikationsgeheimnis sind zwei verschiedene Fragen (§4b/§4d). Die Rechtsgrundlage-
Annahme ist **weggebrochen** (§4a).

**Empfohlene Linie:**
1. **Öffentliche Kanäle zuerst scannen** — rechtlich klarer Pfad, braucht die Derogation nicht.
2. **PM-Scanning zurückstellen**, bis der Rechtsakt im Amtsblatt steht und die E2E-/Scope-Frage geklärt ist.
3. Dann neu entscheiden — **mit anwaltlicher Prüfung**, nicht auf Basis dieses Docs.

## 5b. Wer ist verantwortlich? Drei Fälle (unverändert gültig)
Das Scannen/die Haftung hängt daran, **wessen Speicher** die Inhalte liegen:

| Fall | Speicher liegt bei | Scannen / Haftung |
|---|---|---|
| **Pulse Cloud** (howispulse.com) | dir | **du** — scannst |
| **Echtes Self-Hosting** (eigene Kiste des Nutzers) | dem Nutzer | **der Nutzer** — du = nur Software-Autor, kein Zugriff |
| **Vermieteter „Managed"-Server** (über deinen Anbieter-Account provisioniert) | **dir** | **du** — trotz „sein" Server; Host-Provider-Haftung |

- **Echtes Self-Hosting = Fall 2:** Cert-Modell → isolierte DB-Welten, eigener Stack + eigener Speicher.
  Cloud sieht die Inhalte nie; du haftest nicht (wie Mastodon/Matrix-Softwareautor) und kannst deren Box
  auch nicht scannen.
- **Falle Fall 3:** „gemietet" ≠ „self-hosted". Läuft der Server unter *deinem* Anbieter-Account, ist es
  **deine** Infrastruktur → volle Host-Provider-Haftung (siehe `docs/managed-server-vermietung.md`).
  → Auf vermieteten Servern **auch scannen** (kannst du, da du sie selbst provisionierst).
  **Nebenbei:** genau hier hätte CFs „no managed service solution"-Klausel zusätzlich gestört (§3d.5).
- **Trumpf bei Fall 2:** Cert-Modell kann eine Self-Host-Instanz **sperren**
  (`/.well-known/pulse-suspended-instances`) → gemeldete Missbrauchs-Instanz vom Identitäts-System
  abklemmen. Kein Haftungsthema, aber Hausrecht → gehört in die AGB.

---

## 6. Empfohlenes Zielbild (revidiert 2026-07-16)

**Auslagern und Scannen sind vollständig ENTKOPPELT — der Scan-Weg ist speicheranbieter-unabhängig.**

1. **Teil A, jederzeit möglich — Uploads auf Hetzner Object Storage auslagern** (EU, kein DNS-Umzug,
   reine `S3_*`-Konfig-Umstellung). Erreicht das Ziel „nichts mehr auf netcup". **Nicht** von Teil B
   abhängig.
2. **Teil B, der eigentliche Schutz — Hash-Matching im Upload-Pfad:**
   **Arachnid Shield** (gratis, EEA-Option, Bild + Video nativ) als Quarantäne-dann-freigeben-Hook.
   Optional **IWF Image Intercept** als zweite Quelle. **Nur öffentliche Kanäle zuerst** (§5).
3. **Vor Schritt 2 zwingend: der Treffer-Prozess** (§3c) — löschen, BKA melden, sichern.
   **Ohne ihn produziert Scanning primär Haftung statt Sicherheit.**
4. **DSGVO-Hausaufgabe:** dokumentierte Interessenabwägung (LIA) für den Scan öffentlicher Uploads.
5. **AGB/AUP:** klarstellen, dass gescannt und illegale Inhalte gemeldet werden (Abschreckung + Absicherung).
6. **Klassifikator (Sightengine & Co.): vorerst nicht.** Erkennt kein CSAM, erzeugt Verdachtsfälle, die
   ein Mensch sichten müsste (§184b-Problem, §3a).
7. **Live-Streaming: nicht scannen, sondern abschaltbar machen** (§3f). Streams werden nicht gespeichert
   → kein Speicher-/Scan-Thema. Die Lücke ist der fehlende **Admin-Kill für laufende Streams** +
   Stream als Melde-Ziel. Klein, aber der einzige Weg, auf dem Live-Inhalte Haftung auslösen können.

> **Cloudflare ist raus** — nicht aus Ideologie, sondern weil es bei unserem presigned-URL-Setup
> vermutlich gar nicht scannt, Video auslässt und die Meldung nicht abnimmt (§3d).

---

## 7. Offene Punkte / nächste Schritte

**Teil A (Auslagern):**
- [ ] Anbieter formal entscheiden: **Hetzner Object Storage** (Tendenz) vs. DanubeData/Scaleway/IONOS.
- [ ] CORS + `S3_PUBLIC_ENDPOINT`-Host am Zielanbieter testen (Direkt-Upload-Kompatibilität).
- [ ] Prüfen, ob presigned-PUT mit Content-Type/Length-Pinning + **path-style addressing** dort funktioniert.
- [ ] Bestandsdaten-Migration MinIO → externer Bucket (`mc mirror`/`rclone`).
- [x] ~~DNS-Entscheid Cloudflare~~ — **entfällt**, Cloudflare-Weg verworfen (§3d).

**Teil B (Scannen):**
- [ ] **VOR der Arachnid-Registrierung: die 8 Fragen an `shield@projectarachnid.com`** (§3b-2, letzter
      Block) — Vertragstext, PIPEDA/SCC, Retention, Behörden-Meldeverhalten, Dihedral/Schwellwert, Limits.
      **Nicht registrieren, bevor der echte Vertragstext vorliegt.**
- [ ] **Arachnid-Antrag stellen** (kein Self-Serve — „Request an account" mit Organization/Title; Vetting
      undokumentiert, öffentliche Erfahrungsbasis N=1, kein bekannter EEA-Nutzer → Planungsrisiko).
- [ ] **HAM-Trennung ins Design** (§3b-2, Auflage 1): auf `csam` automatisch handeln, auf
      `harmful-abusive-material` nie automatisch löschen (34,9 % der C3P-Funde!). Review-Queue oder ignorieren.
- [ ] **`/v1/pdq` als Pfad festlegen** (Hash-only): PDQ-Berechnung + Video-Frame-Extraktion bei uns.
      Aufwand gegen `/v1/media` (Datei-Upload, Retention unklar) abwägen — DSGVO spricht klar für pdq.
- [ ] **IWF Image Intercept**: Eignung für **Nicht-UK-Firmen** direkt bei IWF erfragen.
- [x] ~~DSGVO-Transferprüfung Kanada/C3P „offen"~~ → **analysiert, Ergebnis negativ-tendierend**
      (§3b-2, Auflage 2): Angemessenheit trägt sehr wahrscheinlich nicht; SCC/DPA bei C3P nicht auffindbar
      → in die Anwalts-Prüfung, in den C3P-Fragenkatalog aufgenommen.
- [ ] **Treffer-Prozess schriftlich festlegen** (§3c), **bevor** der erste Scan läuft — inkl. Regel
      „Hash-Treffer ≠ automatische Account-Vernichtung" (Meta: >75 % der Gemeldeten ohne böse Absicht).
- [ ] **LIA (Interessenabwägung) dokumentieren** für öffentliche Uploads.
- [ ] **EUR-Lex prüfen**, ob der Derogations-Rechtsakt final veröffentlicht ist + ob E2E-Ausnahme drin
      ist → erst danach PM-Scanning neu bewerten (§5).
- [ ] Quarantäne-Prefix + Freigabe-Flow im Upload-Pfad entwerfen (`attachments.py` / `s3.py`).
- [ ] **Anwaltliche Prüfung** des Gesamtkonzepts vor Umsetzung.

**Teil C (Live-Streaming, §3f — neu 2026-07-16):**
- [ ] **MediaMTX-Kick-API gegen 1.19.1 verifizieren** (welche Endpunkte, welche Session-IDs liefert
      `/v3/paths/list` bzw. die conns-Listen? — Annahme, noch nicht belegt).
- [ ] **Admin-Kill für laufende Streams** bauen (media-svc schreibend + Rechte-Bit + `ModAuditLog`-Eintrag).
- [ ] **Stream als Melde-Ziel** im `Report`-Modell ergänzen (Migration).
- [ ] Prüfen, ob der Kill auch die **Zuschauer-WHEP-Sessions** trennt oder nur den Publisher
      (Publisher-Kick allein könnte Viewer auf einem toten Pfad hängen lassen).
- [x] ~~Live-Frame-Scanning~~ — **verworfen** (§3f: kein CSAM-Erkennungswert, Kosten, §184b-Sichtung).

**Teil D (Identifizierbarkeit, §3g — neu 2026-07-16):**
- [ ] **Entscheiden:** IP + Zeitstempel (+ **Quell-Port**) am Upload/Post für ~7 Tage festhalten — ja/nein?
      Ohne das bleiben BKA-Meldungen faktisch folgenlos; mit dem braucht es eine **LIA**.
- [ ] **Rechts-Stand prüfen:** „Quick Freeze" / IP-Speicherpflicht in DE, Stand 2026 (**ungeprüft**) —
      ändert die Erfolgsaussicht einer Meldung erheblich.
- [ ] **Widerspruch auflösen:** Docstring `_hash_ip` („raw IP is never persisted") vs. Spalte
      `UserSession.ip` (rohe IP). Datenschutzerklärung + Auskunftsprozess müssen dazu passen.
- [ ] **Aufbewahrung von `user_sessions` klären**: Werden abgelaufene Zeilen gelöscht/geprunt? (ungeprüft)
- [ ] Meldeformular-Felder gegen `u-entrance.bka.de` abgleichen — was erwartet das BKA konkret?

---

## Quellen

**Cloudflare (für §3d)**
- CSAM Scanning Tool Doku: https://developers.cloudflare.com/cache/reference/csam-scanning/
- Changelog „as they enter the Cloudflare cache" (2025-02-04): https://developers.cloudflare.com/changelog/post/2025-02-04-easier-onboarding-for-csam-scanning-tool/
- Blog (Ankündigung): https://blog.cloudflare.com/the-csam-scanning-tool/
- Blog-Update „still expected to file their own reports": https://blog.cloudflare.com/a-simpler-path-to-a-safer-internet-an-update-to-our-csam-scanning-tool/
- CSAM Scanner API (zone-scoped): https://developers.cloudflare.com/api/resources/csam_scanner
- Default cache behavior: https://developers.cloudflare.com/cache/concepts/default-cache-behavior/
- R2 Public buckets (r2.dev kein Cache): https://developers.cloudflare.com/r2/buckets/public-buckets/
- Service-Specific Terms („internal use", „no managed service"): https://www.cloudflare.com/service-specific-terms-application-services/
- Community-Frage (unbeantwortet): https://community.cloudflare.com/t/does-csam-scanning-cover-cloudflare-images-served-via-proxied-custom-domain/936643

**Scan-Dienste (für §3b/§3b-2)**
- Arachnid Shield: https://www.projectarachnid.ca/en/ · OpenAPI: https://shield.projectarachnid.com/docs/ · Registrierung: https://www.projectarachnid.ca/en/api/accounts/register/account/
- C3P Arachnid-Report (Tab. 2.2: 34,9 % HAM): https://content.c3p.ca/pdfs/C3P_ProjectArachnidReport_en.pdf
- C3P Terms of Use (2018, „personal use"): https://projectarachnid.ca/en/terms-of-use/
- SDK Python (v0.2.2, 2025-07-17): https://pypi.org/project/arachnid-shield-sdk/
- PDQ-Robustheit: McKeown/Buchanan (Spiegeln ≈ Zufall): https://arxiv.org/abs/2212.08035 · Madden et al. NeurIPS'24 (PDQ robuster als PhotoDNA): https://arxiv.org/abs/2406.00918 · PDQ-Invertierbarkeit: https://arxiv.org/abs/2412.06056
- EU-Kanada-Angemessenheit 2002/2/EC (nur PIPEDA-Empfänger): https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32002D0002
- EuGH C-413/23 P EDPS/SRB (Identifizierbarkeit relativ zum Empfänger)
- Meta (>75 % ohne böse Absicht, >90 % rezirkulierend): https://about.fb.com/news/2021/02/preventing-child-exploitation-on-our-apps/
- BGH III ZR 179/20 (AGB-Kontrolle bei Löschung/Anhörung)
- IWF Image Intercept: https://www.iwf.org.uk/our-technology/image-intercept/ · Fees: https://www.iwf.org.uk/membership/fees/
- PhotoDNA FAQ: https://www.microsoft.com/en-us/photodna/faq
- Thorn Safer Essential (Preis): https://aws.amazon.com/marketplace/pp/prodview-dfwekn4bx4ake
- Videntifier Nexus: https://videntifier.com/products/nexus
- Sightengine Pricing: https://sightengine.com/pricing
- Meta ThreatExchange / HMA (bringt keine DB mit): https://github.com/facebook/ThreatExchange

**Recht (für §3c/§4)**
- BKA FAQ Art. 18 DSA: https://www.bka.de/DE/DasBKA/OrganisationAufbau/Fachabteilungen/ZentralerInformationsUndFahndungsdienst/Digitale_Eingangsstelle/FAQ/faq_dsa_node.html
- BKA Verdachtsmeldungen Art. 18 DSA: https://www.bka.de/DE/DasBKA/OrganisationAufbau/Fachabteilungen/ZentralerInformationsUndFahndungsdienst/Digitale_Eingangsstelle/Guidelines/Verdachtsmeldungen_node.html
- Art. 6 DSA: https://gesetz-digitale-dienste.de/dsa/artikel-6/ · Art. 18: https://gesetz-digitale-dienste.de/dsa/artikel-18/ · Art. 19: https://gesetz-digitale-dienste.de/dsa/artikel-19/
- VO (EU) 2021/1232 (EUR-Lex, „No longer in force"): https://eur-lex.europa.eu/eli/reg/2021/1232/oj/eng
- EP-Pressemitteilung 09.07.2026: https://www.europarl.europa.eu/news/en/press-room/20260706IPR46318/combating-child-sexual-abuse-support-for-a-more-limited-eprivacy-derogation
- Freshfields (Scope: nur interpersonelle Kommunikation): https://www.freshfields.com/en/our-thinking/blogs/risk-and-compliance/an-uncertain-path-forward-the-eprivacy-derogation-and-child-safety-detection-102mopa
- 18 U.S.C. §2258A (inkl. (f) „no duty to search"): https://www.law.cornell.edu/uscode/text/18/2258A
- NCMEC CyberTipline-Daten (23 % Nicht-US, freiwillig): https://www.ncmec.org/gethelpnow/cybertipline/cybertiplinedata
- KG Berlin (Provider nicht strafbar für unerkannte Inhalte): https://www.damm-legal.de/kg-berlin-hosting-provider-macht-sich-fuer-unerkannte-strafbare-inhalte-seiner-kunden-auf-seinen-servern-nicht-selbst-strafbar-10-tmg
- OLG Hamburg 5 W 41/13 (Gehilfenhaftung bei zu später Löschung): https://www.raschlegal.de/aktuelles/olg-hamburg-hostprovider-haftet-wegen-zu-spaeter-loeschung-als-gehilfe/
- Cloudflare DPF-Eintrag (ID 5666): https://www.dataprivacyframework.gov/participant/5666

**Speicher (für §2)**
- S3-kompatible Objektspeicher EU-Vergleich: https://danubedata.ro/blog/best-s3-compatible-object-storage-europe-2025
- AWS S3 vs. Hetzner Object Storage: https://www.harbingerexplorer.com/aws/s3-vs-hetzner-object-storage
