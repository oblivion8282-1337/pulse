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
}
