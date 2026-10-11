import UIKit
import Capacitor
import UserNotifications
import WebKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    /// Wurde das Nutzerskript für künftige Ladevorgänge schon angehängt? Es
    /// wird nur EINMAL angehängt — sonst sammelte jede Drehung ein weiteres an.
    private var safeAreaSkriptGesetzt = false

    /// Safe-Area-Insets als CSS-Variablen in die WebView injizieren — dasselbe
    /// Rezept wie das Android-Gegenstück (SystemBars-Plugin): Die Web-App liest
    /// bereits `var(--safe-area-inset-*, env(...))` (Kette in app.css), dort
    /// landen die Werte zuverlässig. Grund: In der WKWebView liefert env()
    /// 0 (am Gerät gemessen 2026-10-06), deshalb contentInset "never" +
    /// randfüllende Seite + Injektion auf diesem Weg.
    ///
    /// **Seit dem 2026-10-08 wird NACHGELESEN.** Hier stand vorher, die Werte
    /// änderten sich im Betrieb nicht, weil die Hülle auf Hochformat gelockt
    /// sei — das galt genau so lange, wie die Hülle nicht drehen konnte. Mit
    /// dem Querformat fürs Stream-Vollbild (`OrientationLockPlugin`) wandern
    /// die Einzüge: im Querformat sitzt die Aussparung links oder rechts, der
    /// Streifen unten wird flacher. Eingefrorene Startwerte legten die
    /// schwebenden Vollbild-Knöpfe unter die Aussparung.
    private func injectSafeAreaInsets() {
        guard let webView = window?.rootViewController?.view as? WKWebView else { return }
        // Vom Fenster lesen, nicht von der WebView: UIWindow.safeAreaInsets
        // steht früher verlässlich (Bughunt 2026-10-06 — der WebView-Layout-
        // Pass kann beim ersten Active noch 0 liefern).
        let insets = window?.safeAreaInsets ?? webView.safeAreaInsets
        // Noch kein Layout passiert → beim nächsten applicationDidBecomeActive
        // beziehungsweise bei der nächsten Drehung erneut versuchen. Als „noch
        // nicht vermessen" gilt nur, wenn ALLE VIER Seiten 0 sind: im
        // Querformat sind oben und unten beide klein, links/rechts aber nicht.
        if insets == .zero { return }
        let css = """
        document.documentElement.style.setProperty('--safe-area-inset-top', '\(insets.top)px');
        document.documentElement.style.setProperty('--safe-area-inset-bottom', '\(insets.bottom)px');
        document.documentElement.style.setProperty('--safe-area-inset-left', '\(insets.left)px');
        document.documentElement.style.setProperty('--safe-area-inset-right', '\(insets.right)px');
        """
        // Künftige Ladevorgänge: Document-Start (vor jedem Paint). Aktuelles
        // Dokument (lädt evtl. schon): sofort nachreichen.
        if !safeAreaSkriptGesetzt {
            safeAreaSkriptGesetzt = true
            webView.configuration.userContentController.addUserScript(
                WKUserScript(source: css, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        webView.evaluateJavaScript(css, completionHandler: nil)
    }

    /// Systemschriftgröße in die WebView melden (Punkt 38).
    ///
    /// **Warum über ein Attribut und nicht über ein Plugin.** Es ist ein
    /// EINWEG-Signal: nativ weiss es, das Web will es wissen, und es gibt
    /// nichts zu fragen. Ein Plugin bräuchte einen Aufruf vom Web aus und
    /// zusätzlich einen Melder für den Wechsel; das Attribut ist beides in
    /// einem — dasselbe Rezept wie bei den Safe-Area-Einzügen darüber.
    ///
    /// **Die ROHE Kategorie wird gemeldet, nicht ein Faktor.** Die Umrechnung
    /// samt Obergrenze liegt im Web (`platform/schriftskala.ts`) und ist dort
    /// geprüft; hier wäre sie von Nodes Testläufer nicht erreichbar.
    private func schriftKategorieMelden() {
        guard let webView = window?.rootViewController?.view as? WKWebView else { return }
        let kategorie = UIApplication.shared.preferredContentSizeCategory.rawValue
        let js = """
        document.documentElement.setAttribute('data-schriftkategorie', '\(kategorie)');
        """
        if !schriftSkriptGesetzt {
            schriftSkriptGesetzt = true
            webView.configuration.userContentController.addUserScript(
                WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    /// Wie beim Safe-Area-Skript: das Nutzerskript für künftige Ladevorgänge
    /// wird nur EINMAL angehängt, der aktuelle Stand jedes Mal nachgereicht.
    /// Der Startwert im Skript veraltet dabei nicht gefährlich — bei einem
    /// Wechsel läuft diese Methode erneut und reicht den neuen nach.
    private var schriftSkriptGesetzt = false

    @objc private func schriftGroesseGewechselt() {
        schriftKategorieMelden()
    }

    /// Privacy-Screen: Beim Verlassen in den App-Umschalter/Sperrbildschirm
    /// wird eine matte Glasscheibe NATIV über den Inhalt gelegt, damit die
    /// Chat-Vorschau im Multitasking-Snapshot nicht lesbar ist. Synchron auf
    /// dem UI-Thread — kein JS-Rundtrip, der das Rennen gegen den Snapshot
    /// verliert (erste Fassung mit body-Klasse+CSS-Blur war am Gerät zu
    /// langsam, Befund 2026-10-06).
    private var privacyDeck: UIView?

    private func privacySchutz(_ an: Bool) {
        guard let rootView = window?.rootViewController?.view else { return }
        if an {
            // Schon eine Scheibe drauf? Dann NICHT noch eine. `willResignActive`
            // kann ohne dazwischenliegendes `didBecomeActive` ein zweites Mal
            // feuern (System-Alert über der App, danach Sperrbildschirm). Ohne
            // diesen Riegel überschriebe die zweite Scheibe die Referenz auf
            // die erste — `privacySchutz(false)` entfernt dann nur die zweite,
            // und die erste bleibt als matter Schleier über dem Chat liegen,
            // für immer und durch nichts mehr erreichbar.
            guard privacyDeck == nil else { return }
            let deck = UIVisualEffectView(effect: UIBlurEffect(style: .regular))
            deck.frame = rootView.bounds
            deck.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            rootView.addSubview(deck)
            privacyDeck = deck
        } else {
            privacyDeck?.removeFromSuperview()
            privacyDeck = nil
        }
    }

    /// Mitteilungs-Aktionen fuer Direktnachrichten.
    ///
    /// **Warum nur ein Eingabefeld und kein Inhalt im Banner:** Die
    /// Nachrichten sind Ende-zu-Ende verschluesselt, und die Schluessel
    /// liegen in der WebView. Ein Notification-Service-Extension-Prozess
    /// kaeme nicht an sie heran (eigener Prozess; das Geraetegeheimnis ist
    /// zudem `extractable: false`) — er koennte also weder Text noch Bild
    /// anzeigen. Was ohne Entschluesselung geht, ist genau das hier: ein
    /// Antwort-Feld, dessen Text die APP verschluesselt und sendet, sobald
    /// sie durch die Aktion in den Vordergrund kommt.
    ///
    /// Der Bezeichner `dm` muss dem `category`-Feld des Servers entsprechen
    /// (`dcc_chat_gateway/fcm.py::DM_KATEGORIE`). Stimmt er nicht ueberein,
    /// erscheint die Meldung ohne Aktionen — ohne jede Fehlermeldung.
    private func mitteilungsAktionenRegistrieren() {
        let antworten = UNTextInputNotificationAction(
            identifier: "antworten",
            title: NSLocalizedString("Antworten", comment: "Mitteilungs-Aktion"),
            options: [.foreground],
            textInputButtonTitle: NSLocalizedString("Senden", comment: "Mitteilungs-Aktion"),
            textInputPlaceholder: NSLocalizedString("Nachricht", comment: "Mitteilungs-Aktion")
        )
        let dm = UNNotificationCategory(
            identifier: "dm",
            actions: [antworten],
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([dm])
    }

    /// Schnellwahl bei LAUFENDER App (Punkt 44). Der Kaltstart-Fall läuft
    /// nicht hier durch, sondern über die `launchOptions` — s. unten.
    func application(
        _ application: UIApplication,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        Schnellwahl.gewaehlt(shortcutItem)
        completionHandler(true)
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Frueh und unbedingt: die Kategorien muessen stehen, BEVOR die erste
        // Meldung eintrifft. Sie haengen nicht an der Mitteilungserlaubnis —
        // registrieren darf man sie immer.
        mitteilungsAktionenRegistrieren()
        // PushKit + CallKit SOFORT scharf machen (Punkt 40). Hier und nicht im
        // Plugin: ein VoIP-Push trifft die App auch kalt gestartet, bevor
        // irgendeine WebView existiert — ein Capacitor-Plugin gibt es dann
        // noch nicht. Begründung im Kopf von `AnrufPlugin.swift`.
        Anrufverwaltung.geteilt.starten()
        #if DEBUG
            // Prüfpfad für den nativen Sprachweg — tut nichts ohne das
            // Startargument, und existiert in Release-Bauten gar nicht.
            // Begründung im Kopf von `SprachePlugin.swift`.
            SprachePlugin.probeAusStartargumenten()
            AnrufProbe.ausStartargumenten()
            AnrufPushProbe.ausStartargumenten()
        #endif
        // Schnellwahl beim KALTSTART: iOS legt die Wahl in die
        // `launchOptions` und ruft `performActionFor` dann NICHT. Wer nur den
        // einen Weg verdrahtet, hat eine Schnellwahl, die aus dem laufenden
        // Betrieb funktioniert und aus dem Symbol heraus nichts tut — also
        // genau im Hauptfall nicht.
        if let wahl = launchOptions?[.shortcutItem] as? UIApplicationShortcutItem {
            Schnellwahl.gewaehlt(wahl)
        }
        NotificationCenter.default.addObserver(
            self, selector: #selector(lageGewechselt),
            name: UIDevice.orientationDidChangeNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(schriftGroesseGewechselt),
            name: UIContentSizeCategory.didChangeNotification, object: nil)
        return true
    }

    /// Lagen-Riegel. Die `Info.plist` erlaubt dem iPhone alle drei Lagen —
    /// das ist die Erlaubnis zu drehen, nicht die Entscheidung. Entschieden
    /// wird hier: quer nur, solange das Web es fürs Stream-Vollbild
    /// angefordert hat (`OrientationLockPlugin`, JS-Seite
    /// `platform/orientation.ts`). Ohne diesen Riegel drehten Chat, Listen und
    /// Einstellungen mit.
    ///
    /// Das iPad bleibt frei — es war schon vor dem 2026-10-08 in allen vier
    /// Lagen erlaubt (`UISupportedInterfaceOrientations~ipad`), und die Regel
    /// „nur fürs Stream-Vollbild" ist eine Telefon-Regel.
    func application(
        _ application: UIApplication,
        supportedInterfaceOrientationsFor window: UIWindow?
    ) -> UIInterfaceOrientationMask {
        if UIDevice.current.userInterfaceIdiom == .pad { return .all }
        return Lagen.querErlaubt ? [.portrait, .landscapeLeft, .landscapeRight] : .portrait
    }

    /// Nach einer Drehung stehen die Safe-Area-Einzüge erst, wenn der
    /// Layout-Durchgang durch ist. Deshalb zweimal nachlesen: sofort (greift,
    /// wenn das Fenster schon neu vermessen ist) und noch einmal nach der
    /// System-Dreh-Animation. Die 0,4 s sind NICHT gemessen, sondern grosszügig
    /// hinter die Animation gelegt; liest der zweite Versuch trotzdem alte
    /// Werte, korrigiert sie das nächste `applicationDidBecomeActive`.
    /// Die Injektion ist idempotent — mehrfaches Setzen derselben Werte kostet
    /// nichts.
    @objc private func lageGewechselt() {
        injectSafeAreaInsets()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.injectSafeAreaInsets()
        }
    }

    func applicationWillResignActive(_ application: UIApplication) {
        privacySchutz(true)
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
        injectSafeAreaInsets()
        schriftKategorieMelden()
        privacySchutz(false)
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
