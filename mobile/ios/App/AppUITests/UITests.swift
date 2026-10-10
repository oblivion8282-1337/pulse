import XCTest

/// UI-Durchlauf gegen die echte App im Simulator (XCUITest — Accessibility-
/// Queries statt Koordinaten). Dev-Konto dev/test1234 wird vorausgesetzt;
/// ein bereits angemeldeter Zustand wird über die Freundeszeile erkannt.
/// Kaltstart + Vite-Load dauern bis ~30 s, deshalb die Fristen.
final class AppUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    // MARK: - Gemeinsame Handgriffe

    /// Ein Element BELIEBIGER Art, dessen Beschriftung `teil` enthaelt.
    ///
    /// **Typunabhaengig suchen.** Ob eine Kachel als Button, Link oder
    /// StaticText im Baum erscheint, entscheidet das Markup — und das darf
    /// einen Test nicht zum Scheitern bringen, wenn das Element sichtbar da
    /// ist. `descendants(matching: .any)` sucht ueber alle Arten.
    ///
    /// Jeder Ruf baut die Abfrage neu und haelt KEIN Element fest:
    /// `firstMatch` beschreibt nur, wonach gesucht wird — aufgeloest wird es
    /// erst beim Zugriff (`waitForExistence`, `tap`). Genau deshalb traegt ein
    /// zweiter Ruf auch dann, wenn die Route ihre Liste neu gebaut hat.
    private func elementMit(_ app: XCUIApplication, _ teil: String) -> XCUIElement {
        app.webViews.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS[c] %@", teil)
        ).firstMatch
    }

    /// Der Knopf der Sprachleiste, der den aktiven Ausgabeweg traegt — und
    /// zugleich der Oeffner der Ausgabe-Wahl. Die Beschriftung kommt aus dem
    /// Paraglide-Katalog, deshalb mehrere Kandidaten statt eines geratenen
    /// Namens.
    ///
    /// **Eine Abfrage, zwei Verwendungen, und das MUSS so sein:** der Lauf
    /// vergleicht die Beschriftung desselben Knopfes vor und nach dem
    /// Umschalten. Zwei getrennt hingeschriebene Kandidatenlisten koennten
    /// auseinanderlaufen, und der Vergleich traefe dann zwei verschiedene
    /// Knoepfe.
    private func ausgabeKnopf(_ app: XCUIApplication) -> XCUIElement {
        app.webViews.buttons.matching(
            NSPredicate(
                format: "label CONTAINS[c] 'Ausgabe' OR label CONTAINS[c] 'Lautsprecher'"
                    + " OR label CONTAINS[c] 'Hörmuschel'"
            )
        ).firstMatch
    }

    /// Zeitmarke zum Abgleich mit dem Geraetelog. UTC, weil `idevicesyslog`
    /// daneben in UTC stempelt — eine Ortszeit hier kostete bei jedem
    /// Vergleich eine Umrechnung im Kopf.
    private func stempel() -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        f.timeZone = TimeZone(identifier: "UTC")
        return f.string(from: Date())
    }

    func testNachrichtSendenImChat() throws {
        let app = XCUIApplication()
        app.launch()

        // Freunde-Ansicht: der schnelle „Nachricht senden"-Knopf der ersten
        // Zeile (Label aus dem Accessibility-Baum, s. Dump 2026-10-06).
        let schnell = app.webViews.buttons["Nachricht senden"].firstMatch
        XCTAssertTrue(schnell.waitForExistence(timeout: 30), "Freundesliste nicht geladen")
        schnell.tap()

        // Composer: der Platzhalter des Eingabefelds (textarea wird erst mit
        // Fokus als Eingabeelement exponiert — Antippen fokussiert).
        let composerPlatzhalter = app.webViews.staticTexts["Nachricht senden"].firstMatch
        XCTAssertTrue(composerPlatzhalter.waitForExistence(timeout: 20), "Composer nicht gefunden")
        // Der Platzhalter ist während des Ladens teils nicht „hittable" —
        // Koordinaten-Tap auf das Element umgeht den Hittability-Check.
        composerPlatzhalter.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        app.typeText("UI-Test: Nachricht aus XCUITest")

        let senden = app.webViews.buttons["Senden"].firstMatch
        XCTAssertTrue(senden.waitForExistence(timeout: 10), "Senden-Knopf nicht gefunden")
        senden.tap()

        // Die gesendete Nachricht muss im Verlauf auftauchen.
        let blase = app.webViews.staticTexts.matching(
            NSPredicate(format: "label CONTAINS 'UI-Test: Nachricht'")
        ).firstMatch
        XCTAssertTrue(blase.waitForExistence(timeout: 20), "Gesendete Nachricht nicht im Verlauf")
    }

    /// Sprachkanal betreten und die Ausgabe umschalten — am ECHTEN Geraet.
    ///
    /// **Warum dieser Test existiert.** Am 2026-10-10 ging die Fehlersuche am
    /// iOS-Tonweg stundenlang ueber „probier mal und sag mir, was du siehst".
    /// Das ist langsam, ungenau und verliert die Zuordnung zwischen Aenderung
    /// und Wirkung. Was sich antippen laesst, soll der Rechner antippen; was
    /// man hoeren muss, bleibt beim Menschen.
    ///
    /// Der Test URTEILT NICHT ueber Klang — das kann er nicht. Er stellt den
    /// Zustand her und gibt den Accessibility-Baum aus, damit die objektive
    /// Pruefung daneben laufen kann (`idevicesyslog`: Zeilen mit
    /// `overrideOutputAudioPort`, `RouteDidChange`, `has started recording`).
    func testSprachkanalAusgabeUmschalten() throws {
        let app = XCUIApplication()
        app.launch()

        // Erst wenn die Freundesliste steht, ist die App wirklich geladen.
        let geladen = app.webViews.buttons["Nachricht senden"].firstMatch
        XCTAssertTrue(geladen.waitForExistence(timeout: 40), "App nicht geladen")

        // Den Baum ausgeben, BEVOR navigiert wird: die Bereichsleiste traegt
        // keine sichtbaren Texte, ihre Beschriftungen stehen nur hier.
        print("=== BAUM/START ===\n\(app.debugDescription)\n=== /BAUM ===")

        // Bereich „Raeume". **Ein `Link`, kein Button** — die Bereichsleiste
        // sind echte Routen-Links (s. Baum-Ausgabe vom 2026-10-10). Mit
        // `app.buttons` findet man sie nicht.
        let raeume = app.webViews.links["Räume"].firstMatch
        XCTAssertTrue(raeume.waitForExistence(timeout: 15), "Bereichs-Link Raeume nicht gefunden")
        raeume.tap()

        Thread.sleep(forTimeInterval: 3)
        print("=== BAUM/RAEUME ===\n\(app.debugDescription)\n=== /BAUM ===")

        let community = elementMit(app, "dev-stack")
        XCTAssertTrue(community.waitForExistence(timeout: 20), "Community nicht gefunden")
        community.tap()

        Thread.sleep(forTimeInterval: 3)
        let kanal = elementMit(app, "test-voice")
        XCTAssertTrue(kanal.waitForExistence(timeout: 20), "Sprachkanal nicht gefunden")
        kanal.tap()

        // Dem Beitritt Zeit lassen — LiveKit-Handshake plus Session.
        Thread.sleep(forTimeInterval: 10)
        print("=== BAUM/IM-KANAL ===\n\(app.debugDescription)\n=== /BAUM ===")

        // Ausgabe-Wahl oeffnen. Der Knopf traegt ein Kopfhoerer-Symbol.
        let ausgabe = ausgabeKnopf(app)
        if ausgabe.waitForExistence(timeout: 10) {
            ausgabe.tap()
            Thread.sleep(forTimeInterval: 2)
            print("=== BAUM/AUSGABEMENUE ===\n\(app.debugDescription)\n=== /BAUM ===")

            // **Das Menue schliesst sich nach jeder Wahl** — fuer den zweiten
            // Weg muss es neu geoeffnet werden. Ohne das meldete der Lauf
            // „Lautsprecher nicht gefunden" und pruefte nur eine Richtung.
            for (i, wunsch) in ["Hörmuschel", "Lautsprecher"].enumerated() {
                if i > 0 {
                    ausgabe.tap()
                    Thread.sleep(forTimeInterval: 2)
                }
                // **Nur Knoepfe.** `descendants(matching: .any)` trifft auch
                // reinen Text — der Lauf meldete dann „getippt", ohne dass das
                // Plugin je gerufen wurde.
                let eintrag = app.webViews.buttons.matching(
                    NSPredicate(format: "label CONTAINS[c] %@", wunsch)
                ).firstMatch
                if eintrag.waitForExistence(timeout: 8) {
                    print("=== TIPPE: \(wunsch) ===")
                    eintrag.tap()
                    Thread.sleep(forTimeInterval: 4)
                    // Was steht DANACH auf dem Schirm? Der Knopf der
                    // Sprachleiste traegt den aktiven Weg als Beschriftung —
                    // damit ist pruefbar, ob die Anzeige dem Umschalten folgt
                    // oder nur die Session es tut.
                    let leiste = ausgabeKnopf(app)
                    print("=== ANZEIGE NACH \(wunsch): '\(leiste.exists ? leiste.label : "(kein Knopf)")' ===")
                } else {
                    print("=== NICHT GEFUNDEN: \(wunsch) ===")
                }
            }
        } else {
            print("=== AUSGABE-KNOPF NICHT GEFUNDEN ===")
        }

        // Noch kurz im Kanal bleiben, damit der Mitschnitt daneben etwas sieht.
        Thread.sleep(forTimeInterval: 5)
    }

    /// **Differenz-Versuch zum stummen Mikrofon.**
    ///
    /// Der Befund vom 2026-10-10: nach dem Beitritt traegt das Mikrofon keinen
    /// Ton; nach einmal Stummschalten und wieder Einschalten schon. Beides ist
    /// reproduzierbar — also laesst sich der Unterschied MESSEN, statt ihn zu
    /// erraten.
    ///
    /// Der Test stellt beide Zustaende nacheinander her und markiert sie mit
    /// Zeitstempeln. Was im Geraetelog (`idevicesyslog`) zwischen Phase A und
    /// Phase B anders ist, IST die Signatur eines tragenden Mikrofons — und
    /// damit das Messmittel, das fuer die eigentliche Behebung fehlt.
    ///
    /// Er urteilt selbst ueber nichts; er erzeugt nur zwei saubere Fenster.
    func testMikrofonVorUndNachMuteZyklus() throws {
        let app = XCUIApplication()
        app.launch()

        let geladen = app.webViews.buttons["Nachricht senden"].firstMatch
        XCTAssertTrue(geladen.waitForExistence(timeout: 40), "App nicht geladen")

        let raeume = app.webViews.links["Räume"].firstMatch
        XCTAssertTrue(raeume.waitForExistence(timeout: 15), "Bereichs-Link Raeume nicht gefunden")
        raeume.tap()

        let community = elementMit(app, "dev-stack")
        XCTAssertTrue(community.waitForExistence(timeout: 20), "Community nicht gefunden")
        community.tap()

        Thread.sleep(forTimeInterval: 3)
        let kanal = elementMit(app, "test-voice")
        XCTAssertTrue(kanal.waitForExistence(timeout: 20), "Sprachkanal nicht gefunden")
        kanal.tap()

        // Phase A: direkt nach dem Beitritt — hier soll das Mikrofon stumm sein.
        Thread.sleep(forTimeInterval: 8)
        print("=== PHASE-A-START \(stempel()) ===")
        Thread.sleep(forTimeInterval: 12)
        print("=== PHASE-A-ENDE \(stempel()) ===")

        // **Nur die beiden Knopf-Beschriftungen.** `CONTAINS 'Mikrofon'` traf
        // nach dem Stummschalten die Teilnehmer-Kachel („… Mikrofon stumm"),
        // und der Entstumm-Tipp ging ins Leere — der erste Lauf verglich
        // dadurch „an" gegen „stumm" statt gegen „nach dem Zyklus".
        let mikroKnopf = {
            app.webViews.buttons.matching(
                NSPredicate(format: "label == 'Mikrofon stummschalten' OR label == 'Mikrofon einschalten'")
            ).firstMatch
        }
        let mikro = mikroKnopf()
        XCTAssertTrue(mikro.waitForExistence(timeout: 10), "Mikrofon-Knopf nicht gefunden")
        // **Den Zustand nach JEDEM Tipp mitschreiben.** Ein erster Lauf
        // verglich unwissentlich „entstummt" gegen „stumm", weil der zweite
        // Tipp nicht ankam — die Beschriftung des Knopfes sagt, was wirklich
        // gilt („Mikrofon stummschalten" = gerade AN).
        print("=== VOR MUTE: '\(mikro.label)' \(stempel()) ===")
        mikro.tap()
        Thread.sleep(forTimeInterval: 3)
        let nachMute = mikroKnopf()
        print("=== NACH MUTE: '\(nachMute.label)' \(stempel()) ===")
        nachMute.tap()
        Thread.sleep(forTimeInterval: 3)
        let nachUnmute = mikroKnopf()
        print("=== NACH UNMUTE: '\(nachUnmute.label)' \(stempel()) ===")

        // Phase B: nach dem Zyklus — hier soll es tragen.
        print("=== PHASE-B-START \(stempel()) ===")
        Thread.sleep(forTimeInterval: 12)
        print("=== PHASE-B-ENDE \(stempel()) ===")
    }

    /// **Mehrfach-Beitritt: das Rennen einfangen.**
    ///
    /// Der Befund vom 2026-10-10 ist kein fester Fehler, sondern ein Rennen —
    /// ein Lauf mit wachsenden `totalSamplesDuration` in WebKits Statistik
    /// zeigte ein voellig gesundes Mikrofon direkt nach dem Beitritt. Ein
    /// einzelner Beitritt pro Lauf beweist deshalb NICHTS: weder „heil" noch
    /// „kaputt".
    ///
    /// Also drei Beitritte hintereinander, in EINEM Lauf, mit Zeitmarken. Das
    /// Messmittel liegt daneben im Geraetelog: `media-source` mit
    /// `totalSamplesDuration` — ein beendeter Track liefert keine Abtastwerte
    /// mehr, und das ist ohne jedes Zuhoeren sichtbar.
    ///
    /// Der zweite Zweck ist die Unterscheidung der beiden Kandidaten: bleibt
    /// ein spaeterer Beitritt kaputt, liegt es am Session-Umbau; wird er von
    /// sich aus heil, war es die Geraete-Abfrage vor dem Publish.
    func testBeitrittDreimalHintereinander() throws {
        let app = XCUIApplication()
        app.launch()

        let geladen = app.webViews.buttons["Nachricht senden"].firstMatch
        XCTAssertTrue(geladen.waitForExistence(timeout: 40), "App nicht geladen")

        let raeume = app.webViews.links["Räume"].firstMatch
        XCTAssertTrue(raeume.waitForExistence(timeout: 15), "Bereichs-Link Raeume nicht gefunden")
        raeume.tap()

        let community = elementMit(app, "dev-stack")
        XCTAssertTrue(community.waitForExistence(timeout: 20), "Community nicht gefunden")
        community.tap()
        Thread.sleep(forTimeInterval: 3)

        let verlassenSuche = { app.webViews.buttons["Sprachkanal verlassen"].firstMatch }

        for runde in 1...3 {
            // **Frisch suchen, nicht merken.** Nach dem Verlassen baut die
            // Route ihre Liste neu auf; ein festgehaltenes Element zeigt
            // danach auf einen Knoten, den es nicht mehr gibt (erster Entwurf
            // scheiterte beim zweiten Beitritt an genau dem).
            let kanal = elementMit(app, "test-voice")
            XCTAssertTrue(kanal.waitForExistence(timeout: 20), "Sprachkanal nicht gefunden (Runde \(runde))")
            // Koordinaten-Tipp: waehrend des Aufbaus ist die Kachel teils
            // nicht „hittable", der Treffer aber eindeutig.
            kanal.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()

            let verlassen = verlassenSuche()
            XCTAssertTrue(verlassen.waitForExistence(timeout: 25), "Nicht im Kanal (Runde \(runde))")
            print("=== BEITRITT-\(runde)-DRIN \(stempel()) ===")

            // 15 s stehen lassen: WebKit schreibt seine Statistik im
            // Sekundentakt, das reicht fuer einen eindeutigen Verlauf.
            Thread.sleep(forTimeInterval: 15)
            print("=== BEITRITT-\(runde)-ENDE \(stempel()) ===")

            let raus = verlassenSuche()
            if raus.exists {
                raus.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            }
            Thread.sleep(forTimeInterval: 5)
            // **Pruefen, dass der Knopf WEG ist.** Ohne das bewies der Lauf
            // das Verlassen nicht: blieb die Oberflaeche faelschlich im Kanal
            // stehen, fand die naechste Runde denselben Knopf noch vor und
            // der Test wurde gruen, obwohl nie etwas verlassen wurde. Genau
            // dieser Fehler war am 2026-10-10 im nativen Weg drin.
            XCTAssertFalse(
                verlassenSuche().waitForExistence(timeout: 3),
                "Nach dem Verlassen steht der Knopf noch da (Runde \(runde))")
            print("=== VERLASSEN-\(runde) \(stempel()) ===")
        }
    }

    /// **Traegt der Ton, wenn die App nicht im Vordergrund ist?**
    ///
    /// Eine Anforderung, die bis zum 2026-10-10 unbelegt war (Roadmap-Punkt 23
    /// stand auf „Geraetetest offen"). Sie steht und faellt mit dem
    /// `audio`-Hintergrundmodus und damit, dass WebKit die Seite weiterlaufen
    /// laesst, statt ihre Medien anzuhalten.
    ///
    /// **Was dieser Test NICHT prueft: den gesperrten Bildschirm.** XCUITest
    /// kann die Seitentaste nicht druecken, und `idevicediagnostics sleep`
    /// trennt die USB-Verbindung — damit waere der Mitschnitt daneben blind.
    /// Geprueft wird der Hintergrund (Taste Home), der denselben Pfad belastet;
    /// das Sperren legt nur noch den dunklen Schirm darueber. Wer den
    /// Sperrfall wirklich braucht, muss ihn von Hand druecken.
    ///
    /// Der Test urteilt nicht selbst. Er erzeugt drei saubere Fenster mit
    /// Zeitmarken — Vordergrund, Hintergrund, zurueck — und die Messung liegt
    /// daneben im Geraetelog (`media-source`: traegt die Aufnahme weiter?
    /// `cmsSetIs*`: bleibt WebKits Session am Spielen?).
    func testTonImHintergrund() throws {
        let app = XCUIApplication()
        app.launch()

        let geladen = app.webViews.buttons["Nachricht senden"].firstMatch
        XCTAssertTrue(geladen.waitForExistence(timeout: 40), "App nicht geladen")

        let raeume = app.webViews.links["Räume"].firstMatch
        XCTAssertTrue(raeume.waitForExistence(timeout: 15), "Bereichs-Link Raeume nicht gefunden")
        raeume.tap()

        let community = elementMit(app, "dev-stack")
        XCTAssertTrue(community.waitForExistence(timeout: 20), "Community nicht gefunden")
        community.tap()
        Thread.sleep(forTimeInterval: 3)

        let kanal = elementMit(app, "test-voice")
        XCTAssertTrue(kanal.waitForExistence(timeout: 20), "Sprachkanal nicht gefunden")
        kanal.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()

        let verlassen = app.webViews.buttons["Sprachkanal verlassen"].firstMatch
        XCTAssertTrue(verlassen.waitForExistence(timeout: 25), "Nicht im Kanal")

        print("=== VORDERGRUND-START \(stempel()) ===")
        Thread.sleep(forTimeInterval: 12)
        print("=== VORDERGRUND-ENDE \(stempel()) ===")

        XCUIDevice.shared.press(.home)
        print("=== HINTERGRUND-START \(stempel()) ===")
        Thread.sleep(forTimeInterval: 25)
        print("=== HINTERGRUND-ENDE \(stempel()) ===")

        app.activate()
        print("=== ZURUECK-START \(stempel()) ===")
        // **25 s, nicht 12.** WebKit schreibt seine Statistik nur alle paar
        // Sekunden; mit 12 s lag genau EIN Messpunkt hinter der Rueckkehr, und
        // der straddelt den Uebergang. Ein eingefrorenes Mikrofon ist davon
        // nicht zu unterscheiden — der Befund vom 2026-10-10 wurde erst
        // sichtbar, als zwei Punkte DANACH lagen.
        Thread.sleep(forTimeInterval: 25)
        print("=== ZURUECK-ENDE \(stempel()) ===")

        // Dass die App nach dem Wiederkommen noch im Kanal steht, ist Teil der
        // Anforderung: ein Ton, der nur ueberlebt, weil neu verbunden wurde,
        // waere keiner.
        let nochDrin = app.webViews.buttons["Sprachkanal verlassen"].firstMatch
        XCTAssertTrue(nochDrin.waitForExistence(timeout: 15), "Nach dem Hintergrund nicht mehr im Kanal")

        // **Heilt ein Mute-Zyklus?** Die entscheidende Frage fuer die Behebung:
        // LiveKit holt das Mikrofon beim Entstummen NUR neu, wenn die Spur
        // beendet ist (`stopOnMute` ist aus). Traegt sie danach wieder, war sie
        // beendet — und dann ist der richtige Griff, auf `ended` zu hoeren,
        // nicht an der Session zu drehen.
        let mikro = app.webViews.buttons.matching(
            NSPredicate(format: "label == 'Mikrofon stummschalten' OR label == 'Mikrofon einschalten'")
        ).firstMatch
        if mikro.waitForExistence(timeout: 10) {
            // **Zweimal dieselbe Stelle tippen, nicht zweimal suchen.** Nach
            // dem Stummschalten traegt der Knopf eine andere Beschriftung, und
            // die ist nicht verlaesslich vorherzusagen — ein Lauf endete
            // deshalb mit „KNOPF WEG", ohne je entstummt zu haben. Der Knopf
            // wandert nicht; seine Mitte ist der stabilere Bezug.
            // Die Stelle wird vom FENSTER aus gerechnet, nicht vom Knopf:
            // ein Koordinatenpunkt bleibt an seinem Element haengen, und
            // sobald das verschwindet, wirft der zweite Tipp (so geschehen,
            // der Lauf endete zwischen Stummschalten und Entstummen).
            let mitte = mikro.frame
            let stelle = app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: mitte.midX, dy: mitte.midY))
            print("=== ZYKLUS-VOR '\(mikro.label)' bei \(Int(mitte.midX)),\(Int(mitte.midY)) \(stempel()) ===")
            stelle.tap()
            Thread.sleep(forTimeInterval: 4)
            print("=== ZYKLUS-MITTE \(stempel()) ===")
            stelle.tap()
            Thread.sleep(forTimeInterval: 4)
            let danach = app.webViews.buttons.matching(
                NSPredicate(format: "label == 'Mikrofon stummschalten' OR label == 'Mikrofon einschalten'")
            ).firstMatch
            let stand = danach.exists ? danach.label : "(nicht gefunden)"
            print("=== ZYKLUS-NACH '\(stand)' \(stempel()) ===")
            Thread.sleep(forTimeInterval: 22)
            print("=== ZYKLUS-ENDE \(stempel()) ===")
        } else {
            print("=== MIKROFON-KNOPF NICHT GEFUNDEN ===")
        }
    }

    /// **Tippt den Sprachkanal an und bleibt dann stehen — ohne zu urteilen.**
    ///
    /// Gebaut am 2026-10-10, als der Beitritt über die Oberfläche scheiterte
    /// und die Ursache nicht zu fassen war: die anderen Läufe beenden die App
    /// am Ende, und damit ist der Zustand weg, den man lesen müsste. Dieser
    /// hält sie 90 s offen, sodass die Web-Konsole (`pymobiledevice3
    /// webinspector`) danebenher nachsehen kann, was die Oberfläche meldet.
    ///
    /// Ohne Zusicherungen, mit Absicht: er soll nicht scheitern, er soll einen
    /// Zustand stehen lassen.
    func testBeitretenUndStehenbleiben() throws {
        let app = XCUIApplication()
        app.launch()

        let geladen = app.webViews.buttons["Nachricht senden"].firstMatch
        _ = geladen.waitForExistence(timeout: 40)
        let raeume = app.webViews.links["Räume"].firstMatch
        if raeume.waitForExistence(timeout: 15) { raeume.tap() }
        let community = elementMit(app, "dev-stack")
        if community.waitForExistence(timeout: 20) { community.tap() }
        Thread.sleep(forTimeInterval: 3)
        let kanal = elementMit(app, "test-voice")
        if kanal.waitForExistence(timeout: 20) {
            kanal.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            print("=== KANAL GETIPPT \(stempel()) ===")
        } else {
            print("=== KANAL NICHT GEFUNDEN \(stempel()) ===")
        }
        Thread.sleep(forTimeInterval: 15)
        // **Den Baum ausgeben, nicht nur warten.** Was die Oberfläche nach dem
        // Beitritt sagt, ist die Diagnose — eine Fehlermeldung im Kanal ist
        // von aussen sonst nicht zu sehen, und die Web-Konsole ist während
        // eines XCUITest-Laufs nicht erreichbar.
        print("=== BAUM NACH TIPP \(stempel()) ===\n\(app.debugDescription)\n=== /BAUM ===")
        Thread.sleep(forTimeInterval: 60)
        print("=== ENDE \(stempel()) ===")
    }
}
