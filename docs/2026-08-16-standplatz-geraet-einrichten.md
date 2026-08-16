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

## Einrichten (fünf Schritte, alle am Gerät selbst)

1. **Pulse auf dem Rechner anmelden** — mit dem Konto, dem das Gerät gehören
   soll. Die Anmeldung bleibt dort; sie ist später der Ausweis des Geräts.
2. **Einstellungen → Standplatz → „Diesen Rechner als Gerät eintragen"**:
   Community, Standplatz (ein Sprachkanal) und ein Name (`werkstatt-pc`).
   Der Name ist klein geschrieben, ohne Leerzeichen — Geräte sollen nicht wie
   Menschen heissen können.
3. **Dauerfreigabe erteilen** — im selben Bild. Wer ohne Rückfrage übernehmen
   darf (einzelne Personen oder jeder mit dem Recht) und wie lange (bis zum
   Neustart / acht Stunden / dauerhaft).
4. **Rechte in der Community vergeben**: `REMOTE_CONTROL` (Bit 37) steht **nicht**
   in den Vorgaben für `@everyone`. Ohne ausdrückliche Zuteilung sieht niemand
   den Übernahme-Weg — das ist Absicht und der eigentliche Zugangsriegel.
5. **Pulse offen lassen.** Das Gerät meldet sich mit jeder Verbindung an; ein
   geschlossenes Pulse ist ein offline stehendes Gerät.

Danach steht der Rechner in der Kanalliste unter „Geräte". Ein Klick darauf
öffnet ihn im Hauptbereich, ein weiterer weckt ihn und holt das Bild.

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
