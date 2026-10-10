import AVFoundation
import Capacitor
import UIKit

/// QR-Scanner für die Gerätekopplung (iOS-Liste Punkt 34).
///
/// **Warum nativ.** Der Kopplungs-Code ist 20 Zeichen lang. Das eingerichtete
/// Gerät zeigt ihn längst als QR (`kopplung/qr.ts`), das neue Gerät muss ihn
/// bis hierher aber ABTIPPEN — und zwar fehlerfrei, in einem Alphabet, in dem
/// man 0 und O verwechselt. Die Web-Schnittstelle dafür (`BarcodeDetector`)
/// gibt es in WebKit nicht, also auch nicht in dieser Hülle.
///
/// **Kein Fremdpaket**, gleiche Begründung wie beim Bewertungs-Plugin: der
/// Inhalt ist ein Systemaufruf. AVFoundation erkennt QR-Codes selbst, es
/// braucht dafür nur eine Sitzung, eine Vorschau und einen Abnehmer.
///
/// Rückgabe: `{ code: "<Inhalt>" }` oder `{ code: null }` bei Abbruch. Ein
/// Abbruch ist KEIN Fehler — er bedeutet „ich tippe doch", und die Eingabe
/// daneben bleibt der vollwertige Weg.
@objc(QrScanPlugin)
public class QrScanPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "QrScanPlugin"
    public let jsName = "QrScan"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scannen", returnType: CAPPluginReturnPromise)
    ]

    @objc func scannen(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let wurzel = self.bridge?.viewController else {
                call.reject("keine Ansicht")
                return
            }
            let scanner = QrScanAnsicht { code in
                call.resolve(["code": code as Any])
            }
            scanner.modalPresentationStyle = .fullScreen
            wurzel.present(scanner, animated: true)
        }
    }

    #if DEBUG
        /// **Prüfpfad, nur in Debug-Bauten** — zeigt den Scanner ohne
        /// Anmeldung und Oberfläche (sonst führt der Weg durch die WebView):
        ///
        ///     xcrun simctl launch <sim> com.howispulse.app -PulseQrScanProbe YES
        ///
        /// Der Simulator hat keine Kamera und läuft damit durch den Zweig
        /// „Aufbau gescheitert" — derselbe wie bei verweigerter Erlaubnis.
        public override func load() {
            guard UserDefaults.standard.bool(forKey: "PulseQrScanProbe") else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                guard let wurzel = self.bridge?.viewController else {
                    NSLog("[PulseQr] Probe: keine Ansicht")
                    return
                }
                NSLog("[PulseQr] Probe: Scanner wird gezeigt")
                let scanner = QrScanAnsicht { code in
                    NSLog("[PulseQr] Probe: Ergebnis %@", code ?? "nil")
                }
                scanner.modalPresentationStyle = .fullScreen
                wurzel.present(scanner, animated: true) {
                    NSLog("[PulseQr] Probe: Praesentation fertig")
                }
            }
        }
    #endif
}

/// Vollbild-Kamera, die den ersten erkannten QR-Code zurückgibt.
final class QrScanAnsicht: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let fertig: (String?) -> Void
    private let sitzung = AVCaptureSession()
    private var vorschau: AVCaptureVideoPreviewLayer?
    /// Gegen Mehrfach-Auflösung: die Abnehmer-Methode kann mehrfach feuern,
    /// bevor die Sitzung wirklich steht, und ein `CAPPluginCall` darf nur
    /// EINMAL aufgelöst werden.
    private var erledigt = false
    /// Aufbau gescheitert (keine Kamera, keine Erlaubnis) — gemeldet wird das
    /// erst in `viewDidAppear`, s. dort.
    private var aufbauGescheitert = false

    init(fertig: @escaping (String?) -> Void) {
        self.fertig = fertig
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("nicht aus einem Storyboard") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        aufbauen()
        abbrechenKnopf()
    }

    private func aufbauen() {
        guard let gerät = AVCaptureDevice.default(for: .video),
              let eingang = try? AVCaptureDeviceInput(device: gerät),
              sitzung.canAddInput(eingang) else {
            // Keine Kamera oder keine Erlaubnis: wie ein Abbruch behandeln.
            // Die Erlaubnis selbst erfragt iOS beim ersten Zugriff mit dem
            // Text aus NSCameraUsageDescription.
            aufbauGescheitert = true
            return
        }
        sitzung.addInput(eingang)

        let ausgang = AVCaptureMetadataOutput()
        guard sitzung.canAddOutput(ausgang) else {
            aufbauGescheitert = true
            return
        }
        sitzung.addOutput(ausgang)
        ausgang.setMetadataObjectsDelegate(self, queue: .main)
        // NACH dem Hinzufügen setzen — vorher ist `.qr` nicht verfügbar und
        // die Zuweisung wirft (dokumentierte Reihenfolge von AVFoundation).
        ausgang.metadataObjectTypes = [.qr]

        let schicht = AVCaptureVideoPreviewLayer(session: sitzung)
        schicht.videoGravity = .resizeAspectFill
        schicht.frame = view.layer.bounds
        view.layer.addSublayer(schicht)
        vorschau = schicht

        // Nicht auf dem Haupt-Thread starten: `startRunning` blockiert, bis
        // die Kamera läuft, und das friert sonst die Darstellung ein.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.sitzung.startRunning()
        }
    }

    private func abbrechenKnopf() {
        let knopf = UIButton(type: .system)
        knopf.setTitle(
            NSLocalizedString("Abbrechen", comment: "QR-Scanner abbrechen"), for: .normal)
        knopf.setTitleColor(.white, for: .normal)
        knopf.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        knopf.backgroundColor = UIColor.black.withAlphaComponent(0.6)
        knopf.layer.cornerRadius = 22
        knopf.addTarget(self, action: #selector(abbrechen), for: .touchUpInside)
        knopf.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(knopf)
        NSLayoutConstraint.activate([
            knopf.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            knopf.bottomAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
            knopf.widthAnchor.constraint(equalToConstant: 160),
            knopf.heightAnchor.constraint(equalToConstant: 44)
        ])
    }

    /// Ein gescheiterter Aufbau wird ERST HIER gemeldet, nicht schon in
    /// `viewDidLoad`. Dort läuft die Präsentation noch: `presentingViewController`
    /// ist `nil`, `melden` löste also sofort auf, ohne zu schliessen — danach
    /// erschien die schwarze Ansicht doch, `erledigt` stand schon, und
    /// „Abbrechen" tat nichts mehr. Ein Ausweg blieb nicht — im Simulator
    /// nachgestellt (Prüfpfad oben; er hat keine Kamera und landet im selben
    /// `guard` wie eine verweigerte Erlaubnis). Nach dem Erscheinen schliesst
    /// `dismiss` die Ansicht, ebenfalls dort nachgemessen.
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if aufbauGescheitert { melden(nil) }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        vorschau?.frame = view.layer.bounds
    }

    @objc private func abbrechen() {
        melden(nil)
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard
            let erster = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
            let inhalt = erster.stringValue
        else { return }
        melden(inhalt)
    }

    /// Einmal auflösen, Sitzung beenden, Ansicht schliessen — in dieser
    /// Reihenfolge, damit ein weiterer Treffer unterwegs nichts mehr findet.
    private func melden(_ code: String?) {
        if erledigt { return }
        erledigt = true
        if sitzung.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { [sitzung] in
                sitzung.stopRunning()
            }
        }
        let abschluss = { self.fertig(code) }
        if presentingViewController != nil {
            dismiss(animated: true, completion: abschluss)
        } else {
            abschluss()
        }
    }
}
