import UIKit
import Capacitor
import WebKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    /// Safe-Area-Insets als CSS-Variablen in die WebView injizieren — dasselbe
    /// Rezept wie das Android-Gegenstück (SystemBars-Plugin): Die Web-App liest
    /// bereits `var(--safe-area-inset-*, env(...))` (Kette in app.css), dort
    /// landen die Werte zuverlässig. Grund: In der WKWebView liefert env()
    /// 0 (am Gerät gemessen 2026-10-06), deshalb contentInset "never" +
    /// randfüllende Seite + Injektion auf diesem Weg.
    /// ponytail: Insets werden EINMAL gelesen — die Hülle ist auf Portrait
    /// gelockt, die Werte ändern sich im Betrieb nicht. Rotation/iPad-
    /// Multitasking bräuchten einen traitCollection-Observer (Ausbaustufe).
    private var safeAreaInjected = false

    private func injectSafeAreaInsets() {
        if safeAreaInjected { return }
        guard let webView = window?.rootViewController?.view as? WKWebView else { return }
        let insets = webView.safeAreaInsets
        // Noch kein Layout passiert → beim nächsten applicationDidBecomeActive erneut versuchen.
        if insets.top == 0, insets.bottom == 0 { return }
        safeAreaInjected = true
        let css = """
        document.documentElement.style.setProperty('--safe-area-inset-top', '\(insets.top)px');
        document.documentElement.style.setProperty('--safe-area-inset-bottom', '\(insets.bottom)px');
        document.documentElement.style.setProperty('--safe-area-inset-left', '\(insets.left)px');
        document.documentElement.style.setProperty('--safe-area-inset-right', '\(insets.right)px');
        """
        // Künftige Ladevorgänge: Document-Start (vor jedem Paint). Aktuelles
        // Dokument (lädt evtl. schon): sofort nachreichen.
        webView.configuration.userContentController.addUserScript(
            WKUserScript(source: css, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView.evaluateJavaScript(css, completionHandler: nil)
    }

    /// Privacy-Screen: Beim Verlassen in den App-Umschalter/Sperrbildschirm
    /// wird der Inhalt verunklart, damit Chat-Vorschau nicht im Multitasking-
    /// Snapshot lesbar ist. Nativ statt Web-Overlay, weil applicationWillResign-
    /// Active VOR der Aufnahme des Snapshots läuft — ein JS-Overlay im Web
    /// verliert dieses Rennen. Die Blur-Regel sitzt als Document-Start-
    /// UserScript im Stylesheet der Seite; geschaltet wird nur die body-Klasse.
    private func privacySchutz(_ an: Bool) {
        guard let webView = window?.rootViewController?.view as? WKWebView else { return }
        webView.evaluateJavaScript(
            "document.body.classList.\(an ? "add" : "remove")('privacy-blur');",
            completionHandler: nil
        )
    }

    private static let privacyCss = """
    (function () {
      var style = document.createElement('style');
      style.textContent = 'body.privacy-blur { filter: blur(28px); }';
      document.head.appendChild(style);
    })();
    """
    private var privacyCssEingebracht = false

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
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
        if !privacyCssEingebracht, let webView = window?.rootViewController?.view as? WKWebView {
            privacyCssEingebracht = true
            webView.configuration.userContentController.addUserScript(
                WKUserScript(source: Self.privacyCss, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            webView.evaluateJavaScript(Self.privacyCss, completionHandler: nil)
        }
        injectSafeAreaInsets()
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
