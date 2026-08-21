# Geräte-Konto: Entwurf, kein Code

Kurzes Begründungsdokument, 2026-08-20. Ausgeklammert aus
`docs/superpowers/specs/2026-08-20-geraeteverwaltung-design.md` §13 („Nicht in
diesem Umbau"). Nachfolger von §11.1/§4 (E5) in
`docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md`, wo die
Entscheidung „an den Ausweis des Besitzers gebunden statt eigenes Konto"
bewusst als vorläufig markiert wurde: der kleine Weg zuerst, der Umstieg
später möglich.

## 1. Das Problem

Ein Standplatz-Gerät ist heute unter dem **Konto seines Besitzers** angemeldet
— das ist der Ausweis, mit dem es sich einträgt und mit dem es bei jeder
Verbindung beweist, wer es sein will (`web/src/lib/devices/anmeldung.svelte.ts`).
Das ist der kleine, sofort tragende Weg gewesen. Er hat drei Preise, die mit
mehr Standplatz-Rechnern grösser werden, nicht kleiner:

1. **Private Nachrichten liegen auf jedem Standplatz-Rechner offen.** Wer sich
   an einem Schnittplatz anmeldet, sitzt technisch im Konto des Besitzers.
   Der Sichtschutz (`DeviceSichtschutz.svelte`) blendet Chat, Verlauf und
   Direktnachrichten nur **solange jemand fernsteuert** aus — er verhindert das
   Lesen durch einen Steuernden, nicht das Vorhandensein der Daten auf dem
   Gerät. Ein zwölf Schnittplätze umfassender Betrieb bedeutet zwölf
   Rechner, auf denen die Postfächer des Besitzers grundsätzlich erreichbar
   sind, sobald jemand physisch davorsitzt.
2. **Das Gerät hält seinen Besitzer dauerhaft „online".** `ws_ready` sendet bei
   jeder Geräte-Verbindung `presence_update(online=True)` für den Besitzer —
   unabhängig davon, ob er selbst gerade an einem anderen Rechner sitzt oder
   überhaupt am Rechner ist. Der Anwesenheitsstatus wird damit für jeden
   bedeutungslos, der ein Standplatz-Gerät betreibt.
3. **Geräte sterben mit der Mitgliedschaft des Einrichters.** `owner_user_id`
   ist unveränderlich (siehe Randbedingungen unten). Verlässt der Einrichter
   die Community — Kündigung, Rauswurf, Wechsel der Abteilung —, verschwinden
   alle seine Geräte mit ihm, unabhängig davon, ob sie ihm oder der Werkstatt
   gehören. Ein Rechner, der als Ausrüstung eines Projekts gedacht war, ist
   an eine einzelne Person gekettet.

Alle drei Punkte sind Fortsetzungen von Lücke 7 aus dem Vorgänger-Entwurf
(`docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md` §6, Absatz
zum „Haken"): dort wurde für die Cloud entschieden, das Chat-Leck über einen
Sichtschutz statt einen Server-Riegel zu schliessen, **weil** der Riegel weder
den REST-Weg trifft noch den eigenen Laptop des Besitzers verschonen könnte.
Diese Entscheidung bleibt richtig, solange das Gerät das Konto des Besitzers
trägt — sie löst aber keinen der drei Punkte oben, sie macht nur den
gefährlichsten Einzelfall (Mitlesen während einer aktiven Sitzung) erträglich.

## 2. Randbedingungen

* **Cloud-Identität ist zentral** (`IDENTITY_CONCEPT.md`, Minecraft-Modell):
  jedes Konto — Mensch oder Maschine — braucht letztlich einen Ausweis, den
  entweder die Cloud oder ein Self-Host-Zertifikat ausstellt. Ein Geräte-Konto
  kann sich dem nicht entziehen, ohne einen zweiten, schwächeren
  Identitätsbegriff neben dem echten einzuführen — genau das hat E5 im
  Vorgänger-Entwurf für die Ausweisbindung bereits verworfen und gilt hier
  ebenso.
* **`owner_user_id` ist unveränderlich** (`chat.devices`, aktueller Stand nach
  `2026-08-20-geraeteverwaltung-design.md`). Ein Besitzerwechsel ist in diesem
  Umbau bewusst nicht enthalten (§13 dort) — er hängt am Geräte-Konto und wird
  erst dort sinnvoll entscheidbar: „wem gehört das Gerät" ist erst eine
  interessante Frage, wenn ein Gerät auch ohne seinen ursprünglichen Einrichter
  weiterleben kann.
* **Der bestehende Schutzapparat darf nicht dünner werden.** Rechteprüfung am
  Standplatz-Kanal, Rechte-Wache im 30-s-Takt, Sitzungsdeckel, Abbau bei
  Rauswurf/Bann — keiner dieser Mechanismen darf an einer neuen Kontoart
  vorbeigehen. Ein Geräte-Konto ist kein Weg, um `REMOTE_CONTROL` zu umgehen.
* **Migration muss verlustfrei möglich sein.** Es gibt zum Zeitpunkt dieses
  Entwurfs produktiv eingerichtete Geräte unter Besitzerkonten; ein Umstieg
  darf sie nicht implizit unbenutzbar machen.

## 3. Drei mögliche Richtungen

### Richtung A — Eigener Kontentyp „Gerät"

Ein Gerät bekommt eine echte Zeile in `auth.users` (oder eine Parallel-Tabelle
mit denselben Fremdschlüsseln), markiert mit einem Konto-Typ. Es meldet sich
mit einem eigenen, langlebigen Berechtigungsnachweis an (kein Passwort, kein
2FA — etwa ein rotierbares Gerätegeheimnis oder ein eigener Zertifikatspfad
analog zum Self-Host-Cert-Login). Mitgliedschaft, Rollen und die
Freigabeliste (`chat.device_grants`) hängen dann konsequent am Geräte-Konto,
nicht mehr am Besitzer.

* **Löst alle drei Punkte aus §1 bauartbedingt:** kein Chat-Zugang, weil das
  Konto nie eine DM-Fähigkeit hatte; kein falscher „online"-Status des
  Besitzers, weil Anwesenheit dem Gerät gehört (und dort auch ehrlicher ist —
  ein Standplatz-Rechner, der läuft, ist tatsächlich online); kein Sterben mit
  dem Einrichter, weil `owner_user_id` zu einer reinen Verwaltungsreferenz
  wird statt zum Identitätsanker.
* **Preis:** der grösste Eingriff. Ein neuer Kontentyp berührt Registrierung,
  Mitgliederlisten, Moderation (Bann/Kick eines „Nutzers", der keiner ist),
  Anwesenheitsanzeige, vermutlich auch Lizenz-/Nutzerzählungen. Jede Stelle,
  die heute `users` mit „Mensch" gleichsetzt, muss geprüft werden.

### Richtung B — Geräte-Rolle statt Geräte-Konto

Kein neuer Kontentyp; stattdessen bekommt jedes Standplatz-Gerät weiterhin
einen menschlichen Ausweis zum Anmelden, aber der **Chat-Zugang wird dem
Ausweis entzogen, sobald er als „Standplatz-Gerät" markiert ist** — nicht nur
während einer aktiven Sitzung wie beim heutigen Sichtschutz, sondern
dauerhaft, solange die Markierung steht. Anwesenheit würde für diesen Ausweis
nicht mehr gemeldet.

* **Löst Punkt 1 und 2 aus §1** vollständig und ohne neuen Kontentyp — im
  Kern eine Erweiterung des vorhandenen `DeviceSichtschutz`-Gedankens von
  „während der Sitzung" auf „dauerhaft, solange als Standplatz markiert".
* **Löst Punkt 3 nicht:** das Gerät hängt weiterhin am Konto des Einrichters,
  `owner_user_id` bliebe die Identität. Verlässt er die Community, verschwindet
  das Gerät weiterhin mit ihm.
* **Preis:** ein Konto, das „mal Mensch, mal Gerät" ist, je nachdem ob gerade
  eine Standplatz-Markierung gesetzt ist — ein Statuswechsel, der an mehreren
  Stellen (Login, WS-Ready, Anwesenheit) beachtet werden muss und leicht
  auseinanderlaufen kann, wenn eine Stelle vergessen wird. Löst insgesamt
  weniger als Richtung A, bei nicht viel weniger Aufwand.

### Richtung C — Werkstatt-/Projekt-Konto als Zwischenschicht

Statt eines Kontentyps „Gerät" ein Kontentyp „Team"/„Werkstatt", der bereits
heute für gemeinsam verwaltete Ressourcen denkbar wäre (mehrere Standplatz-
Geräte, evtl. später weitere Automatisierung). Ein Standplatz-Gerät gehört
dann nicht mehr einem Menschen, sondern diesem Team-Konto; Menschen sind
Mitglieder des Team-Kontos mit eigenen Rechten darauf (wer darf Geräte
umbenennen, wer die Freigabeliste ändern).

* **Löst Punkt 3 besonders gut:** ein Gerät überlebt jeden einzelnen
  Mitarbeiter, weil es nie an eine Person gekettet war, sondern an die
  Werkstatt. Löst Punkt 1/2 ebenso wie Richtung A, wenn das Team-Konto analog
  zum Geräte-Konto keinen persönlichen Chat-Zugang hat.
* **Preis:** die grösste Neuerung — ein Konto-Konto-Verhältnis
  (Team-Mitgliedschaft) existiert im Datenmodell heute nicht und bräuchte
  eigene Rechte, eigene Verwaltung, eigene Einladungslogik. Deutlich mehr als
  eine Fernsteuer-Erweiterung; ein eigenständiges Feature mit eigenem
  Rechtfertigungsbedarf über die Fernsteuerung hinaus.

## 4. Einordnung, keine Entscheidung

Dieses Dokument entscheidet nichts — die drei Richtungen unterscheiden sich
vor allem darin, **wie viel** sie lösen und **wie tief** sie ins Datenmodell
eingreifen: B ist der kleinste Schritt und lässt Punkt 3 liegen; A löst alles
Genannte, ist aber ein eigener Kontentyp; C löst alles und mehr, ist aber der
grösste Eingriff und im Kern ein eigenständiges „Team"-Feature, das die
Fernsteuerung nur mitnimmt. Die Wahl hängt davon ab, ob „Gerät stirbt mit dem
Einrichter" in der Praxis tatsächlich stört — solange Standplatz-Geräte
überwiegend von derselben Person eingerichtet und betreut werden, die auch
dauerhaft in der Community bleibt, ist der Leidensdruck für Punkt 3 gering und
Richtung B die naheliegende erste Stufe.

## 5. Was diesmal *nicht* verworfen wird

Anders als beim Ausweisbezug (E5, wartet auf das Cloud-Token) gibt es hier
keine Sackgasse zu vermeiden — nur eine offene Aufwand-Nutzen-Abwägung. Der
einzige harte Ausschluss bleibt ein **zweiter, schwächerer Identitätsbegriff**
neben dem echten Cloud-/Cert-Ausweis (dieselbe Linie wie E5): egal welche
Richtung, das Geräte-Konto muss sich in `IDENTITY_CONCEPT.md` einfügen, nicht
daneben existieren.
