# Managed-Server-Vermietung — Recherche & Notizen

> Status: **Recherche/Ideensammlung**, nichts gebaut. Stand: 2026-07-14.
> Kontext: Vision, in Pulse „gehostete Server" zu vermieten — der User klickt *Server mieten*,
> im Hintergrund entsteht automatisch eine Maschine mit dem Pulse-Server-Stack. Passt zum
> geparkten App-Hosting-Strang (`project_app_hosting_pivot_server_app`) und zum
> Monetarisierungs-Gate (`project_unified_hosting_applications`).
>
> ⚠️ **Kein Rechtsrat.** Die rechtlichen Punkte sind Recherche und ersetzen keine anwaltliche Beratung.

---

## 1. Anbieter-Wahl: Wer kann Auto-Provisionierung per API?

Kernkriterium: Eine **API**, über die Pulse selbstständig Server anlegen/starten/löschen kann.

Kernkriterien: **API zum Auto-Erzeugen** von Servern + Abrechnungsmodell, das zum Vermieten passt.
**Hinweis 2026-07-14:** Da Kunden ohnehin **monatlich** mieten und wir monatlich einkaufen, ist
stundengenaue Abrechnung **kein Muss** mehr — dadurch werden monatliche Billig-Anbieter (Contabo)
wieder ernsthafte Kandidaten. Kritisch bleibt nur, dass der Anbieter überhaupt **per API bestellen** lässt.

### Anbieter in Deutschland / EU

| Anbieter | Sitz | Auto-Provisioning-API | Abrechnung | Bewertung |
|---|---|---|---|---|
| **Hetzner Cloud** | Nürnberg/Falkenstein | ✅ voll | stundengenau | **Bester** — billig, elastisch, gute Netzqualität |
| **Contabo** | München | ✅ REST + Terraform | **nur monatlich** | **Mehr Server pro €**, aber langsamere shared vCPU, Port-Limit, träges Provisioning |
| **IONOS Cloud** | Montabaur (1&1) | ✅ voll | minutengenau | Deutsche Marke, teurer + enterprise-lastige API — Fallback |
| Vultr | US/EU | ✅ (sauberste API) | stundengenau | Nicht DE, aber sehr gute API |
| Open Telekom Cloud / STACKIT | DE | ✅ (OpenStack) | stundengenau | Enterprise/„souverän", zu teuer für Freundeskreis |
| gridscale (OVH) | Köln | ✅ API-first | stundengenau | Nische |
| **netcup** (unsere Cloud!) | Karlsruhe | ❌ **kein Bestellen per API** | Vertrag | **Ungeeignet** als Vermiet-Backend |

**netcup taugt nicht als Vermiet-Backend**, obwohl howispulse.com dort läuft: kein Auto-Bestellen per API
(nur bestehende Server steuern) → man müsste Server manuell auf Vorrat kaufen. Für die eigene, feste Cloud
super, fürs Vermieten nein. Wir würden also **zwei Anbieter parallel** fahren: netcup = eigene Cloud,
Hetzner/Contabo = vermietete Kunden-Server.

Fertige Baukästen (WHMCS, HostBill, Caasify, ModulesGarden) existieren als „Shop-Software für Hoster",
sind aber schwergewichtig und optisch fremd. Für Pulse eher Eigenbau direkt gegen die Anbieter-API.

---

## 2. Rechtliche Absicherung — sechs Schichten

### 2.1 Härteste Wahrheit: volle Haftung gegenüber Hetzner
Hetzner hat **kein echtes Reseller-Programm mit Reseller-Preisen** für Cloud. Du kaufst zum Marktpreis
und bleibst **alleiniger Vertragspartner** — du haftest **voll** für alles, was deine Mieter anstellen.
Spam/Betrug eines einzelnen Kunden kann den **ganzen Account** gefährden.
- **Absicherung:** jeder Kunden-Server in **eigenem Hetzner-Projekt / eigenem API-Token** (Isolation),
  KYC light (wer sind die Mieter), **Notbremse** in Pulse (Server sofort suspendieren/löschen).

### 2.2 Du wirst selbst „Host-Provider" → Providerprivileg nutzen
Nach **DDG** (seit Mai 2024, löst TMG ab) und EU-**DSA**: Du haftest **nicht** für Kundeninhalte,
**solange du nichts davon weißt** — musst aber bei Hinweis **unverzüglich** sperren/löschen
(„Notice-and-Takedown").
- **Absicherung:** funktionierender **Abuse-Kanal** (`abuse@howispulse.com`), dokumentierte Reaktions-
  Routine, technische Fähigkeit einzelne Server stillzulegen.

### 2.3 Eigene AGB + Nutzungsregeln mit den Mietern (Anwalt)
- **Acceptable Use Policy** deckungsgleich mit Hetzners Regeln (Pflichten 1:1 weitergeben).
- **Sperr-/Kündigungsrecht** bei Verstoß, sofort, ohne Erstattung.
- **Haftungsbegrenzung** (gedeckelt, keine Verfügbarkeitsgarantie, „Backups sind Kundensache").
- **Freistellungsklausel** (Kunde stellt dich frei, wenn Dritte *dich* wegen seines Handelns verklagen).

### 2.4 Datenschutz-Kette (DSGVO)
- Kunde = Verantwortlicher · **du = Auftragsverarbeiter** → **AVV mit jedem Kunden** (Art. 28).
- **Hetzner = dein Unterauftragsverarbeiter** → Hetzners DPA nutzen, Kunden stimmen Sub-Prozessor zu.
- Reiht sich in die offenen DSGVO-To-dos ein (AVV netcup, DPA Resend).

### 2.5 Größter Hebel: Rechtsform
Aktuell **Kleinunternehmer / Einzelunternehmen (Oblivion Pictures)** → Haftung mit **Privatvermögen**.
Beim Vermieten fremd-genutzter Server ist das riskant. **UG (haftungsbeschränkt)** (ab 1 € Stammkapital)
oder **GmbH** begrenzt die Haftung auf die Firma. **Vor dem Live-Gang klären** — größter Einzeleffekt.

### 2.6 Versicherung als Netz
Betriebs-/Berufshaftpflicht mit IT-/Hosting-Baustein · ggf. Cyber-Versicherung · Vermögensschaden-Haftpflicht.

**Empfohlene Reihenfolge:** (1) Rechtsform klären → (2) Anwalt IT-Recht (AGB+AUP+Haftung+Freistellung+AVV)
→ (3) technische Isolation + Not-Aus + Abuse-Postfach → (4) erst dann live.

---

## 3. Was braucht ein Pulse-Server an Ressourcen?

Der Self-Host-Stack (Docker-Compose): 6 FastAPI-Services + Postgres + Redis + MinIO + LiveKit + MediaMTX
+ Caddy + web-nginx. Einzeln leichtgewichtig; die Last hängt an **Voice** (LiveKit-SFU, CPU) und
**HQ-Streaming** (MediaMTX — v.a. **Bandbreite**, kein Transcoding). Chat/DB/Redis/MinIO sind für kleine
Gruppen genügsam.

**Der echte Kostentreiber ist Traffic** (HQ-Streams sind hochbitratig: mehrere Zuschauer × hohe Bitrate).
Hetzners 20 TB/Monat inklusive sind großzügig, aber bei Dauer-Streaming im Blick behalten.

Engpass ist **RAM**, nicht CPU. Hetzners neue Cloud-Linie fängt bei **2 vCPU / 4 GB** an (die alten
1-vCPU/2-GB-CX11 sind weg) — das ist der echte Boden, und er reicht für kleine Gruppen bereits.

| Gruppe | Nutzung | Realistischer Server | Hetzner |
|---|---|---|---|
| **Mini (~8–10)** | Chat + Voice, selten 1 Stream | 2 vCPU / 4 GB / 40 GB | **CX23** |
| Klein (~10–15) | Chat + Voice, gelegentlich 1 Stream | 4 vCPU / 8 GB / 80 GB | **CX33** |
| Mittel (~30–40) | mehr Voice + regelmäßig HQ-Stream | 8 vCPU / 16 GB | **CX43** oder dediziert |
| Groß / voice-schwer | viele Parallel-Voice, mehrere HQ-Streams | dedizierte vCPU wg. Latenz | **CCX23/CCX33** |

**Boden = CX23** (2/4/40, €5,49). Trägt den ganzen Container-Stack im Normalbetrieb; engster Punkt ist
die 40-GB-Platte (MinIO-Uploads) → per Volume nachrüstbar. Voice-Qualität profitiert bei Wachstum von
**dedizierten vCPUs** (CCX-Linie), weil LiveKit latenzsensibel ist.

**Zwei Fallstricke bei „ganz billig":**
- **ARM (CAX11, €5,99)** sieht gleich günstig aus, verlangt aber **multi-arch Images** (MediaMTX-Fork,
  GSR-Sidecar, Service-Images) — ungeprüft. Bis dahin bei **x86 (CX23)** bleiben.
- **Gleichzeitigkeit**: einzelner Stream/wenige Voice ok auf 2 geteilten vCPUs; mehrere Parallel-Voice
  *plus* HQ-Stream können die 2 Kerne zumachen → dann CX33.

---

## 3b. Reale Messung auf dem netcup-Prod-Server (2026-07-14)

Live gemessen auf howispulse.com (netcup, 8 Kerne / 15 GB) — beantwortet die Größen-Frage empirisch
statt geschätzt.

**Leerlauf-Baseline (ein paar Nutzer aktiv, kein Stream):**
- **CPU-Load: 0,26** von 8 Kernen (≈ ¼ eines Kerns). Kein Container über 5 %.
- **RAM: Gesamtsystem 2,5 GB — reiner Pulse-Stack nur ~1,4 GB.** Aktivster Dienst: LiveKit (Voice) ~5 %.
- Fazit: Der komplette Stack läuft mit **<1 Kern und ~1,4 GB RAM**.

**Mit aktivem HQ-Stream + 1 Zuschauer:**
- Bitrate rein vom Streamer = raus zum Zuschauer (**MediaMTX relayt 1:1, kein Transcoding**).
- CPU MediaMTX 5 %, Load 0,61 — **CPU zu keinem Zeitpunkt der Engpass**.
- **Jeder Zuschauer bekommt eine eigene Kopie** → Ausgangs-Bandbreite = Bitrate × Zuschauer.

**Kernerkenntnis — der einzige echte Engpass ist die Ausgangs-Bandbreite, nicht CPU/RAM.**
Sie skaliert linear mit *Bitrate × Zuschauerzahl*. **Bitrate ist bei Pulse gedeckelt** (Wunsch-Bitrate,
im getesteten Fall **max. 10 Mbit/s pro Stream**, real lief er mit 4). Damit ist die Bandbreite gut planbar:

| Server-Port | Zuschauer/Stream bei 10 Mbit/s (Deckel) |
|---|---|
| Contabo VPS 10 (200 Mbit/s) | ~20 |
| Contabo VPS 30 (600 Mbit/s) | ~60 |
| Hetzner / 1 Gbit | ~100 |

**Ergebnis:** Für eine normale Freundesrunde reicht der **kleinste Server locker** — CPU und RAM sowieso,
und dank Bitraten-Deckel auch die Bandbreite. Eng wird's nur bei *vielen parallelen Streams × vielen
Zuschauern* gleichzeitig → dann größeres Tier. Der Einstiegs-Server (Contabo VPS 10 / Hetzner CX23) trägt
den typischen Fall problemlos.

---

## 4. Hetzner-Cloud-Preise (Stand Juli 2026, DE/FI)

> ⚠️ Preise stiegen 2026 mehrfach (v.a. CPX). Vor Kalkulation **live prüfen**. +€0,50/Monat je IPv4.

### CX — Cost-Optimized (shared Intel)
| Modell | vCPU | RAM | NVMe | Traffic | Preis/Mon |
|---|---|---|---|---|---|
| CX23 | 2 | 4 GB | 40 GB | 20 TB | €5,49 |
| **CX33** | **4** | **8 GB** | **80 GB** | 20 TB | **€8,49** |
| CX43 | 8 | 16 GB | 160 GB | 20 TB | €15,99 |
| CX53 | 16 | 32 GB | 320 GB | 20 TB | €29,49 |

### CAX — ARM (shared)
| Modell | vCPU | RAM | NVMe | Traffic | Preis/Mon |
|---|---|---|---|---|---|
| CAX11 | 2 | 4 GB | 40 GB | 20 TB | €5,99 |
| CAX21 | 4 | 8 GB | 80 GB | 20 TB | €10,49 |
| CAX31 | 8 | 16 GB | 160 GB | 20 TB | €20,99 |

### CCX — Dedizierte vCPU (für voice-/stream-schwer)
| Modell | vCPU | RAM | NVMe | Traffic | Preis/Mon |
|---|---|---|---|---|---|
| CCX13 | 2 | 8 GB | 80 GB | 20 TB | €42,99 |
| CCX23 | 4 | 16 GB | 160 GB | 20 TB | €85,99 |
| CCX33 | 8 | 32 GB | 240 GB | 30 TB | €138,49 |

Add-ons: IPv4 +€0,50/Mon · Traffic-Überzug €1,00/TB (EU/US).

### Contabo Cloud VPS — Alternative (München, monatlich)
> Keine Setup-Gebühr, Mindestlaufzeit 1 Monat, „unlimited traffic" (Fair-Use). Zwei Preise: monatlich
> kündbar / bei 12-Monats-Bindung.

| Plan | vCPU | RAM | NVMe | Port | Preis/Mon |
|---|---|---|---|---|---|
| **VPS 10** | 4 | 8 GB | 75 GB | 200 Mbit/s | €5,50 (12M: €4,40) |
| VPS 20 | 6 | 12 GB | 100 GB | 300 Mbit/s | €7,50 |
| VPS 30 | 8 | 24 GB | 200 GB | 600 Mbit/s | €14,00 |
| VPS 40 | 12 | 48 GB | 250 GB | 800 Mbit/s | €25,00 |

**Contabo VPS 10 vs. Hetzner CX23 — beide ~€5,50, aber Contabo = doppelt so viel** (4/8/75 statt 2/4/40).
Fürs RAM-hungrige Pulse ein echter Vorteil. Drei Haken: (1) shared vCPU stärker überbucht → **Voice-Latenz**
am echten Server messen; (2) **Port-Limit** — VPS 10 nur 200 Mbit/s → für HQ-Streaming (~10–20 Mbit/s je
Zuschauer) ab ~10 Zuschauern dicht; stream-lastig erst ab VPS 30 (600 Mbit/s); (3) **Provisioning** kann
träger sein als bei Hetzner (Sekunden vs. Minuten) → UX bei „sofort loslegen" testen.

**Faustregel:** Chat/Voice-lastig → Contabo (mehr Server pro €). Stream-lastig → Hetzner (Netzqualität,
20 TB, schnelles Provisioning) oder Contabo VPS 30+.

---

## 5. Was könnte man realistisch verlangen?

Deine **Kosten pro Server sind fix** (Hetzner-Miete + IPv4 + anteilig dein Aufwand/Support/Risiko).
Preis an den Kunden = Kosten + Marge. Faustregel im Managed-Hosting: **Einkaufspreis × 1,5–2,5**,
um Support, Ausfallzeit, Abuse-Bearbeitung und Haftungsrisiko zu decken.

| Tier | Basis | Hetzner-Kost + IPv4 | Realistischer Mietpreis |
|---|---|---|---|
| **Mini** | CX23 (2/4/40) | ~€6,00 | **€9,99–12,99 / Mon** |
| Klein | CX33 (4/8/80) | ~€9,00 | **€14,99–19,99 / Mon** |
| Mittel | CX43 (8/16) | ~€16,50 | **€24,99–34,99 / Mon** |
| Premium (voice/stream) | CCX23 (4/16 ded.) | ~€86,50 | **€119–149 / Mon** |

Anmerkungen:
- Marge muss auch **Leerlauf** (bezahlte, aber ungenutzte Kapazität) und **Traffic-Überzug** abfedern.
- Stundengenaue Hetzner-Abrechnung erlaubt **„nur laufen lassen, solange gemietet"** → Kosten sinken,
  wenn Kunden pausieren/kündigen (Server löschen, Daten-Snapshot behalten).
- Alternativ **Freemium**: kleiner Gratis-Slot auf Shared-Kapazität, bezahlt erst ab eigener Maschine.
- Zahlungsabwicklung (Stripe o.ä.) + wiederkehrende Abrechnung + MwSt/Kleinunternehmer-Grenze beachten
  (bei echtem Umsatz kippt der Kleinunternehmer-Status → Rechtsform-Frage aus §2.5).

---

## 6. Offene Punkte / nächste Schritte
- [ ] Rechtsform-Entscheidung (Einzelunternehmen vs. UG vs. GmbH) für dieses Modell durchrechnen.
- [ ] Anwalt IT-Recht: AGB + AUP + Haftungsbegrenzung + Freistellung + AVV-Vorlage.
- [ ] Technischer Prototyp: Hetzner-API → Server anlegen → Pulse-Stack automatisch aufsetzen → Not-Aus.
- [ ] Traffic-Realmessung eines echten HQ-Streams (Bitrate × Zuschauer × Stunden) für Marge.
- [ ] Abuse-Prozess + `abuse@howispulse.com` einrichten.

## Quellen
- Hetzner Cloud API: https://jentic.com/apis/hetzner-cloud
- Hetzner AGB / Terms: https://www.hetzner.com/legal/terms-and-conditions/
- Hetzner System Policies: https://www.hetzner.com/de/legal/system-policies/
- Hetzner DPA (AVV): https://www.hetzner.com/AV/DPA_de.pdf
- Hetzner Cloud Preise (Kalkulator, Juli 2026): https://costgoat.com/pricing/hetzner
- netcup — kein VPS-Auto-Provisioning per API: https://forum.netcup.de/thread/22232-official-api-for-automatic-vps-provisioning/
- DDG-Pflichten (e-recht24): https://www.e-recht24.de/datenschutz/13328-digitale-dienste-gesetz-ddg.html
- Providerhaftung/Störerhaftung (IT-Recht-Kanzlei): https://www.it-recht-kanzlei.de/providerhaftung-stoererhaftung.html
- Host-Provider-Pflichten (comp/lex): https://comp-lex.de/host-provider-haftung/
- Reselling Hetzner Cloud — Account-Risiko (LowEndTalk): https://lowendtalk.com/discussion/173575/reselling-hetzner-cloud
