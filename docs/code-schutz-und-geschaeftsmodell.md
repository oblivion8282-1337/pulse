# Code-Schutz & Geschäftsmodell — wie sich Pulse trotz öffentlichem Quellcode schützt

> Status: **Strategie-Notiz**, Stand 2026-07-14; Lizenz-Fakten korrigiert 2026-09-28. Kontext: Der Quellcode
> ist öffentlich einsehbar, aber **source-available, nicht Open Source** (`LICENSE`: „Pulse is source-available,
> not open source") — zweiteilig: **Pulse Server License 1.0** (Server-Komponenten: 32 Tage Testbetrieb,
> danach kommerzielle Lizenz; Modifikation/Redistribution nie erlaubt) und **Pulse Client License 1.0**
> (Client-Komponenten: Nutzung frei, auch kommerziell; Modifikation/Redistribution verboten).
> Frage: Wie verhindert man, dass jemand den Code „klaut" und selbst hostet — evtl. unbemerkt?
> ⚠️ Kein Rechtsrat. Verwandt: `project_pulse_license_status`, `IDEAS.md` (Monetarisierung),
> `docs/managed-server-vermietung.md`.

## Die harte Wahrheit
**Öffentlichen Code kann man NICHT technisch „unbenutzbar" machen.** Jeder eingebaute Schutz (Lizenzschlüssel,
Phone-Home-Check, Kill-Switch) steht **im offenen Quellcode** → sichtbar + in Minuten entfernbar. Man kann
nicht gleichzeitig „hier ist der Bauplan" und „ihr dürft ihn nicht nachbauen" sagen. Analogie: ein
veröffentlichtes Kochrezept lässt sich nicht am Nachkochen hindern.
→ **Der Wunsch „technisch unmöglich machen" ist bei öffentlich einsehbarem Quellcode nicht erfüllbar. Nicht versuchen — Zeitverschwendung.**
Der Schutz liegt **drumherum**, nicht im Code.

## Die fünf echten Schutzschilde

**1. Das Nutzer-Netzwerk ist der Burggraben, nicht der Code.**
Wahrer Wert = howispulse.com selbst (Accounts, Freundesgraph, laufende Instanz). Ein Dieb kopiert den Code,
aber **nicht die Nutzer**. Genau deshalb dominieren bei Mastodon/Matrix die Haupt-Instanzen trotz offenem Code.
Pulse = *der* Ort, wo die Identität lebt.

**2. Markenname (Trademark) — billigster + stärkster Schutz.**
Code laufen lassen kann man nicht verbieten — aber es **„Pulse" nennen**, Logo/Optik nutzen sehr wohl. Marke
eintragen → ein Klon muss sich umbenennen und verliert den Wiedererkennungswert. **Empfehlung: eintragen.**

**3. Die Lizenz = juristischer Schild gegen Konkurrenz (nicht gegen Selbst-Hosten).**
Die Pulse-Lizenzen sind proprietär: Lesen und Auditieren erlaubt, **Modifikation + Redistribution nie** —
der Server darf nur 32 Tage testweise betrieben werden, danach braucht jede Betriebsform (auch privat oder
non-profit) eine kommerzielle Lizenz. → Niemand kann Pulse heimlich verbessern + als geschlossenes
Konkurrenzprodukt verkaufen — das ist nicht bloß eine Offenlegungspflicht, sondern schlicht untersagt.
Tut er's doch = Lizenzverstoß, verfolgbar.

**4. Der CLA sichert die Durchsetzbarkeit (Geheimtipp, schon vorhanden).**
Durch den CLA gehören **dir** die Gesamtrechte am gesamten Code → die proprietären Pulse-Lizenzen sind
durchsetzbar, und du kannst das Modell frei weiterentwickeln (z. B. kommerzielle Zusatz-Lizenzen für
Weiterverwendung/Embedded verkaufen). Aus „jemand will meinen Code nutzen" bleibt eine **Einnahmequelle** —
die kommerzielle Server-Lizenz ist sie heute schon.

**5. Open Core für die Zukunft.**
Nicht alles offenlegen: wertvollste Server-Teile **privat + nur bei dir laufend** → Self-Hoster
kriegt abgespeckte Version. Teils schon so (Identitäts-System hängt an der Cloud). Der publizierte Teil ist
source-available — öffentlich einsehbar, proprietär lizenziert, nicht offen nutzbar; die offene Entscheidung
betrifft *künftige* Kronjuwelen, die ganz aus der Veröffentlichung raus bleiben.

## Zur Sorge „ich bekomme es gar nicht mit"
Stimmt — und ist okay. Man **muss** nicht jeden privaten Selbst-Hoster entdecken. Die meisten Bastler sind
kein Schaden, eher Gratis-Werbung. Gefährlich wären nur **kommerzielle Nachahmer** — und die sind **sichtbar**
(sie werben), also genau die, gegen die Marke + Lizenz greifen. Der unsichtbare Keller-Bastler ist kein zu
lösendes Problem.
Bonus: Wer den **offiziellen** Self-Host-Weg nutzt (mit deinem Identitäts-System), meldet sich bei der Cloud
an → sichtbar + sperrbar (`/.well-known/pulse-suspended-instances`). Nur wer forkt + die Anbindung rausreißt,
verschwindet — hat sich dann aber vom Nutzer-Netzwerk abgeschnitten (= anderes, leeres Produkt).

## Empfehlung (ein Satz)
Nicht nach dem technischen Schloss suchen (gibt es nicht) — auf die vier wirksamen Schilde setzen:
**Marke eintragen · Nutzer-Netzwerk pflegen · proprietäre Lizenz + CLA · künftige Kronjuwelen privat halten.**

## Offene Punkte
- [ ] Marke „Pulse"/„howispulse" prüfen + eintragen (DPMA/EUIPO) — Namenskollision vorab recherchieren.
- [ ] Dual-Licensing konkret ausformulieren (kommerzielle Lizenz + Preis) — an Monetarisierung koppeln.
- [ ] Entscheiden, welche künftigen Server-Teile privat bleiben (Open-Core-Grenze definieren).
