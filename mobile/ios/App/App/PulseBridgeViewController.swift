import Capacitor

/// Registriert die App-Target-Plugins an der Bridge — der dokumentierte Weg
/// für lokale Swift-Plugins, die der CLI-Scan (packageClassList aus
/// node_modules) nicht sieht. Ohne diese Registrierung ist
/// `window.Capacitor.Plugins.AudioSessionPlugin` undefined (Befund
/// Review-Etappe-3 2026-10-06).
public class PulseBridgeViewController: CAPBridgeViewController {
    override public func capacitorDidLoad() {
        bridge?.registerPluginType(AudioSessionPlugin.self)
        super.capacitorDidLoad()
    }
}
