import XCTest

/// UI-Durchläufe gegen die echte App im Simulator (XCUITest — der saubere
/// Automationsweg: Accessibility-Queries statt Koordinaten, läuft in
/// `xcodebuild test`). Die App lädt im Dev die Web-App vom Vite; die Tests
/// setzen ein vorhandenes Dev-Konto voraus (dev/test1234).
final class AppUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// Anmelden und die Chatliste sehen — der Rauchtest für die ganze Kette
    /// (Hülle bootet, WebView lädt, Anmeldung funktioniert, Shell rendert).
    func testAnmeldungErreichtChatliste() throws {
        let app = XCUIApplication()
        app.launch()

        // Login-Seite: E-Mail/Benutzername + Passwort (Web-Inputs erscheinen
        // als TextFields), dann der Anmelden-Knopf per Beschriftung.
        let benutzer = app.webViews.textFields.firstMatch
        XCTAssertTrue(benutzer.waitForExistence(timeout: 30), "Login-Feld nicht gefunden — lädt die WebView?")
        benutzer.tap()
        benutzer.typeText("dev")

        let passwort = app.webViews.secureTextFields.firstMatch
        XCTAssertTrue(passwort.waitForExistence(timeout: 10))
        passwort.tap()
        passwort.typeText("test1234")

        let anmelden = app.webViews.buttons["Anmelden"].firstMatch
        XCTAssertTrue(anmelden.waitForExistence(timeout: 10), "Anmelden-Knopf nicht gefunden")
        anmelden.tap()

        // Nach der Anmeldung landet das Konto im zuletzt genutzten Bereich;
        // der Tab-Balken (Chats) ist auf jedem Startbildschirm vorhanden.
        let tabLeiste = app.otherElements["mobile-tab-bar"].firstMatch
        let chatliste = app.webViews.staticTexts["Freunde"].firstMatch
        XCTAssertTrue(
            chatliste.waitForExistence(timeout: 30) || tabLeiste.waitForExistence(timeout: 10),
            "Nach der Anmeldung weder Bereichs-Inhalt noch Tab-Balken sichtbar"
        )
    }
}
