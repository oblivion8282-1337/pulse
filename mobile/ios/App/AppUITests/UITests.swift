import XCTest

/// UI-Durchlauf gegen die echte App im Simulator (XCUITest — Accessibility-
/// Queries statt Koordinaten). Dev-Konto dev/test1234 wird vorausgesetzt;
/// ein bereits angemeldeter Zustand wird über die Freundeszeile erkannt.
/// Kaltstart + Vite-Load dauern bis ~30 s, deshalb die Fristen.
final class AppUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
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

        // **Typunabhaengig suchen.** Ob eine Kachel als Button, Link oder
        // StaticText im Baum erscheint, entscheidet das Markup — und das darf
        // einen Test nicht zum Scheitern bringen, wenn das Element sichtbar
        // da ist. `descendants(matching: .any)` sucht ueber alle Arten.
        Thread.sleep(forTimeInterval: 3)
        print("=== BAUM/RAEUME ===\n\(app.debugDescription)\n=== /BAUM ===")

        let community = app.webViews.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS[c] 'dev-stack'")
        ).firstMatch
        XCTAssertTrue(community.waitForExistence(timeout: 20), "Community nicht gefunden")
        community.tap()

        Thread.sleep(forTimeInterval: 3)
        let kanal = app.webViews.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS[c] 'test-voice'")
        ).firstMatch
        XCTAssertTrue(kanal.waitForExistence(timeout: 20), "Sprachkanal nicht gefunden")
        kanal.tap()

        // Dem Beitritt Zeit lassen — LiveKit-Handshake plus Session.
        Thread.sleep(forTimeInterval: 10)
        print("=== BAUM/IM-KANAL ===\n\(app.debugDescription)\n=== /BAUM ===")

        // Ausgabe-Wahl oeffnen. Der Knopf traegt ein Kopfhoerer-Symbol; die
        // Beschriftung kommt aus dem Paraglide-Katalog, deshalb mehrere
        // Kandidaten statt eines geratenen Namens.
        let ausgabe = app.webViews.buttons.matching(
            NSPredicate(format: "label CONTAINS[c] 'Ausgabe' OR label CONTAINS[c] 'Lautsprecher' OR label CONTAINS[c] 'Hörmuschel'")
        ).firstMatch
        if ausgabe.waitForExistence(timeout: 10) {
            ausgabe.tap()
            Thread.sleep(forTimeInterval: 2)
            print("=== BAUM/AUSGABEMENUE ===\n\(app.debugDescription)\n=== /BAUM ===")

            for wunsch in ["Hörmuschel", "Lautsprecher"] {
                let eintrag = app.webViews.buttons[wunsch].firstMatch
                if eintrag.waitForExistence(timeout: 5) {
                    print("=== TIPPE: \(wunsch) ===")
                    eintrag.tap()
                    Thread.sleep(forTimeInterval: 4)
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
}
