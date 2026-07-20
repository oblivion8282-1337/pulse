# Code-Schutz & Geschäftsmodell — wie sich Pulse trotz Open Source schützt

> Status: **Strategie-Notiz**, Stand 2026-07-14. Kontext: Pulse ist öffentlich auf GitHub (AGPL-3.0).
> Frage: Wie verhindert man, dass jemand den Code „klaut" und selbst hostet — evtl. unbemerkt?
> ⚠️ Kein Rechtsrat. Verwandt: `project_pulse_license_status` (AGPL entschieden, LICENSE+CLA committed),
> `IDEAS.md` (Monetarisierung), `docs/managed-server-vermietung.md`.

## Die harte Wahrheit
**Öffentlichen Code kann man NICHT technisch „unbenutzbar" machen.** Jeder eingebaute Schutz (Lizenzschlüssel,
Phone-Home-Check, Kill-Switch) steht **im offenen Quellcode** → sichtbar + in Minuten entfernbar. Man kann
nicht gleichzeitig „hier ist der Bauplan" und „ihr dürft ihn nicht nachbauen" sagen. Analogie: ein
veröffentlichtes Kochrezept lässt sich nicht am Nachkochen hindern.
→ **Der Wunsch „technisch unmöglich machen" ist bei OSS nicht erfüllbar. Nicht versuchen — Zeitverschwendung.**
Der Schutz liegt **drumherum**, nicht im Code.

## Die fünf echten Schutzschilde

**1. Das Nutzer-Netzwerk ist der Burggraben, nicht der Code.**
Wahrer Wert = howispulse.com selbst (Accounts, Freundesgraph, laufende Instanz). Ein Dieb kopiert den Code,
aber **nicht die Nutzer**. Genau deshalb dominieren bei Mastodon/Matrix die Haupt-Instanzen trotz offenem Code.
Pulse = *der* Ort, wo die Identität lebt.

**2. Markenname (Trademark) — billigster + stärkster Schutz.**
Code laufen lassen kann man nicht verbieten — aber es **„Pulse" nennen**, Logo/Optik nutzen sehr wohl. Marke
eintragen → ein Klon muss sich umbenennen und verliert den Wiedererkennungswert. **Empfehlung: eintragen.**

**3. AGPL = juristischer Schild gegen Konkurrenz (nicht gegen Selbst-Hosten).**
AGPL erlaubt Selbst-Hosten (gewollt), **zwingt** aber jeden, der eine veränderte Version als Dienst anbietet,
seinen Code offenzulegen. → Niemand kann Pulse heimlich verbessern + als geschlossenes Konkurrenzprodukt
verkaufen. Tut er's doch = Lizenzverstoß, verfolgbar.

**4. Der CLA ermöglicht Dual-Licensing (Geheimtipp, schon vorhanden).**
Durch den CLA gehören **dir** die Gesamtrechte → du kannst doppelt lizenzieren: Öffentlichkeit = AGPL (mit
Offenlegungspflicht); wer das nicht will (z.B. Firma, geschlossene Nutzung) muss eine **kostenpflichtige
kommerzielle Lizenz** kaufen. Aus „jemand will meinen Code nutzen" wird eine **Einnahmequelle**. Modell
MongoDB/Qt.

**5. Open Core für die Zukunft.**
Nicht alles offenlegen: Kern offen, wertvollste Server-Teile **privat + nur bei dir laufend** → Selbst-Hoster
kriegt abgespeckte Version. Teils schon so (Identitäts-/Cert-System hängt an der Cloud). Da der Code aktuell
komplett offen ist: Entscheidung für *künftige* Kronjuwelen, die dann privat bleiben.

## Zur Sorge „ich bekomme es gar nicht mit"
Stimmt — und ist okay. Man **muss** nicht jeden privaten Selbst-Hoster entdecken. Die meisten Bastler sind
kein Schaden, eher Gratis-Werbung. Gefährlich wären nur **kommerzielle Nachahmer** — und die sind **sichtbar**
(sie werben), also genau die, gegen die Marke + AGPL greifen. Der unsichtbare Keller-Bastler ist kein zu
lösendes Problem.
Bonus: Wer den **offiziellen** Self-Host-Weg nutzt (mit deinem Identitäts-System), meldet sich bei der Cloud
an → sichtbar + sperrbar (`/.well-known/pulse-suspended-instances`). Nur wer forkt + die Anbindung rausreißt,
verschwindet — hat sich dann aber vom Nutzer-Netzwerk abgeschnitten (= anderes, leeres Produkt).

## Empfehlung (ein Satz)
Nicht nach dem technischen Schloss suchen (gibt es nicht) — auf die vier wirksamen Schilde setzen:
**Marke eintragen · Nutzer-Netzwerk pflegen · AGPL+CLA für Dual-Licensing · künftige Kronjuwelen privat halten.**

## Offene Punkte
- [ ] Marke „Pulse"/„howispulse" prüfen + eintragen (DPMA/EUIPO) — Namenskollision vorab recherchieren.
- [ ] Dual-Licensing konkret ausformulieren (kommerzielle Lizenz + Preis) — an Monetarisierung koppeln.
- [ ] Entscheiden, welche künftigen Server-Teile privat bleiben (Open-Core-Grenze definieren).
