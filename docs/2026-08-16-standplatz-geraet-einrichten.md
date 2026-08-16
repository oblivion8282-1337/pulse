# Ein Standplatz-Gerät einrichten — und was es nicht kann

**Stand 2026-08-16.** Gehört zu
`docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md` (Entwurf) und
beschreibt, was am gebauten Stand wirklich geht. Der Teil „was es nicht kann"
steht bewusst nicht am Ende, sondern gleich mit: bei einem Rechner, den niemand
beaufsichtigt, ist eine unausgesprochene Einschränkung teurer als eine fehlende
Funktion.

## Was ein Standplatz-Gerät ist

Ein Rechner, der in einem Sprachkanal **steht**, ohne dort Teilnehmer zu sein.
Wer den Kanal sehen darf, sieht ihn; wer `REMOTE_CONTROL` in dem Kanal hat, darf
ihn übernehmen. Er spricht nicht, schreibt nicht und taucht in keiner
Sprecherliste auf.

## Einrichten (sechs Schritte, alle am Gerät selbst)

1. **Pulse auf dem Rechner anmelden** — mit dem Konto, dem das Gerät gehören
   soll. Die Anmeldung bleibt dort; sie ist später der Ausweis des Geräts.
2. **Einstellungen → Standplatz → „Diesen Rechner als Gerät eintragen"**:
   Community, Standplatz (ein Sprachkanal) und ein Name (`werkstatt-pc`).
   Der Name ist klein geschrieben, ohne Leerzeichen — Geräte sollen nicht wie
   Menschen heissen können.
3. **Dauerfreigabe erteilen** — im selben Bild. Wer ohne Rückfrage übernehmen
   darf (einzelne Personen oder jeder mit dem Recht) und wie lange (bis zum
   Neustart / acht Stunden / dauerhaft).
4. **Übertragungs-Profil für den Fernbetrieb prüfen** — im selben Reiter unter
   „Womit dieser Rechner überträgt, wenn er geweckt wird". Es gilt **nur**,
   wenn jemand das Gerät aus der Ferne weckt; die eigenen Stream-Einstellungen
   des Besitzers bleiben unberührt. Vorgaben: Hauptbildschirm, H.264, native
   Auflösung, 30 Bilder/s, 8000 kbit/s, kein HDR. Begründung: Fernsteuern will
   lesbare Schrift und kurze Wege, Zuschauen will flüssige Bewegung — das sind
   gegensätzliche Einstellungen, und die Vorgaben bedienen den ersten Fall.
5. **Rechte in der Community vergeben**: `REMOTE_CONTROL` (Bit 37) steht **nicht**
   in den Vorgaben für `@everyone`. Ohne ausdrückliche Zuteilung sieht niemand
   den Übernahme-Weg — das ist Absicht und der eigentliche Zugangsriegel.
6. **Pulse offen lassen.** Das Gerät meldet sich mit jeder Verbindung an; ein
   geschlossenes Pulse ist ein offline stehendes Gerät.

Danach steht der Rechner in der Kanalliste unter „Geräte". Ein Klick darauf
öffnet ihn im Hauptbereich, ein weiterer weckt ihn, holt das Bild in ein eigenes
Player-Fenster **und übernimmt** — der Knopf heisst nicht umsonst „Wecken und
übernehmen". Ein getrenntes „Fernsteuerung anfragen" gibt es hier nicht mehr:
die Zustimmung ist als Dauerfreigabe vorverlegt, es gäbe nichts zu fragen. Die
Anfrage geht trotzdem erst hinaus, **wenn das Bild da ist** — sonst hinge eine
Sitzungszusage an einer Encoder-Initialisierung.

## Mehrere Bildschirme

Der erste Klick holt immer den **Hauptbildschirm**. Hat das Gerät mehrere
Schirme, schaltet der Steuernde die weiteren einzeln dazu — an zwei Stellen,
die dasselbe tun:

* in der **Geräteansicht** in der App, bevor man übernimmt,
* im **Menü am Griff im Player-Fenster**, während man steuert. Dort schaut man
  ohnehin hin, und man muss nicht aus dem Fenster wechseln.

Jeder Bildschirm wird **erst beim Anfordern** übertragen — einer, den niemand
sehen will, kostet weder Rechenzeit auf dem Gerät noch Bandbreite. Jeder bekommt
sein eigenes Fenster, und die Eingabe folgt dem Fenster, in dem die Maus gerade
ist; eine zweite Fernsteuer-Sitzung braucht es dafür nicht.

**Den Ton trägt genau ein Bildschirm** (der erste), die dazugeschalteten sind
stumm. Sonst käme derselbe Ton mehrfach leicht versetzt an.

> **Bekannte Grenze:** wird ausgerechnet der erste Bildschirm beendet, bleiben
> die übrigen stumm — der Ton wandert nicht mit. Er hängt am Start einer
> Übertragung, und ihn nachträglich umzuhängen hiesse, einen laufenden Strom
> neu zu starten. Wer den Ton zurück will, beendet die Fernsteuerung und weckt
> neu.

**Am Ende schläft das Gerät wieder ein:** endet die Fernsteuerung, werden die
Übertragungen beendet, die ein Weckruf gestartet hat. Was der Besitzer von Hand
gestartet hat, bleibt unangetastet.

## Betriebssystem-Einstellungen, die dazugehören

Pulse hält den **Bildschirm** wach, solange sein Fenster sichtbar ist
(`DeviceKiosk.svelte` → `powerSaveBlocker`). Alles andere muss im System
eingestellt werden:

* **Bildschirm nicht sperren.** Auf dem Sperrbildschirm existieren Electron und
  Sidecar nicht — siehe unten.
* **Kein Ruhezustand**, weder Standby noch Hibernate.
* **Automatische Anmeldung**, wenn der Rechner ohne Aufsicht neu startet
  (Windows-Update). Ohne sie steht er nach dem Neustart auf dem
  Anmeldebildschirm, und dort läuft nichts.
* **Pulse automatisch starten** (`desktop/electron/autostart.ts`).
* **Ein Monitor muss dran sein** — ein echter, ein Dummy-Stecker oder ein
  virtueller Anzeigetreiber. Ohne Ausgabe liefert Windows Graphics Capture kein
  Bild.
* **Nur EIN Bildschirm wird übertragen.** Windows Graphics Capture nimmt immer
  genau einen Schirm auf; „alle Schirme in einer Aufnahme" gibt es dort nicht.
  Wer aus der Ferne an mehrere Schirme muss, spiegelt sie über einen virtuellen
  Anzeigetreiber zu einem grossen zusammen — das ist eine Treiber-Frage, keine
  Pulse-Einstellung.
* **Pulse-Fenster nicht minimieren**: die Bildschirm-Wachhaltung gilt nur für ein
  sichtbares Fenster.

## Was ein Standplatz-Gerät nicht kann

Alle vier haben dieselbe Wurzel — der Sidecar ist ein gewöhnlicher
Userland-Prozess:

1. **Sperrbildschirm und abgemeldete Sitzung.** Dort gibt es weder Electron noch
   Sidecar. Sperrt sich der Rechner, ist das Gerät weg, bis sich jemand
   körperlich anmeldet. **Das ist mit dieser Bauweise nicht zu umgehen**; die
   kommerziellen Werkzeuge lösen es mit einem Systemdienst.
2. **UAC / Secure Desktop.** Der Sicherheitsschreibtisch verschluckt Bild *und*
   Eingabe (Laborbefund, `streaming/win-hq-labor/testbench/`). Ein UAC-Fenster
   auf einem unbeaufsichtigten Rechner ist eine Sackgasse, die niemand vor Ort
   wegklicken kann.
3. **Neustart aus der Ferne** endet ohne automatische Anmeldung im Nichts.
4. **Vorrang des Hosts greift weiterhin** (`remote_input/wache.rs`): setzt sich
   jemand an das Gerät und bewegt Maus oder Tastatur, wird die Fremdeingabe
   fünf Sekunden lang verworfen. Auf einem Standplatz-Gerät ist das gewollt —
   der Mensch vor Ort hat Vorrang —, kann aber überraschen, wenn jemand nur den
   Tisch anstösst.

Getragen wird also **der angemeldete, entsperrte Desktop**. Das ist die Linie,
die auch Intra-Refresh und HDR fahren: lieber ansagen, was nicht geht, als es
stillschweigend halb zu können.

## Was am Gerät sichtbar bleibt

* Ein Hinweis oben im Fenster, solange die Dauerfreigabe steht, mit Knopf zum
  sofortigen Aufheben.
* Das warnfarbene Banner, solange jemand steuert — samt „Beenden".
* Ein **Sichtschutz** über Chat, Verlauf und Direktnachrichten, solange jemand
  steuert (Begründung in `DeviceSichtschutz.svelte`).
* Ein **Protokoll** in den Einstellungen: wer wann wie lange übernommen hat, und
  ob dabei jemand zugestimmt hat oder die Dauerfreigabe geantwortet hat.

## Was noch fehlt

* **Der Ausweisbezug in der Cloud.** Das Zugangs-Token trägt heute keine
  Gerätekennung (`security.py` kennt nur `sub`/`admin`/`owner`/`email_blocked`).
  Die Anmeldung eines Geräts beweist deshalb „eine Verbindung des Besitzers
  behauptet, dieser Rechner zu sein" — nicht, dass es derselbe physische
  Rechner ist wie beim Eintragen. Auf Self-Hosts steht die Kennung bereits in
  der Sitzung (`SessionClaims.cert_id`).
* **Rollen in der Dauerfreigabe.** Heute tragen einzelne Nutzer und „jeder mit
  dem Recht"; Rollen brauchen den serverseitigen Standplatz (Begründung in
  `standplatz.svelte.ts`).
* **Ein eigenes Geräte-Konto** (Stufe 3 des Entwurfs, §11.1): dann überlebt ein
  Gerät seinen Besitzer, und der Chat-Zugang fällt bauartbedingt weg statt über
  einen Sichtschutz.
