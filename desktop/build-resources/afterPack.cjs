// electron-builder afterPack-Hook — korrekte Ad-hoc-Signatur für die unsignierte
// macOS-Distribution (Stufe A, kein Apple Developer ID).
//
// Problem: ohne Signing-Identity legt electron-builder die .app nur mit der
// Linker-Default-Ad-hoc-Signatur ab (flags=…linker-signed) und versiegelt das
// Bundle NICHT (Sealed Resources=none). Auf Apple Silicon meldet Gatekeeper eine
// so geladene (quarantänisierte) App als „ist beschädigt und kann nicht geöffnet
// werden" — und Rechtsklick→Öffnen räumt das NICHT weg.
//
// Fix: nach dem Packen die .app einmal sauber ad-hoc signieren
// (`codesign --force --deep --sign -`). Das versiegelt das Bundle (CodeResources)
// und signiert die verschachtelten Mach-Os konsistent. Damit wird die Meldung
// zur normalen „nicht verifizierter Entwickler", die man über
// Systemeinstellungen → Datenschutz & Sicherheit → „Dennoch öffnen" freigibt.
// Komplett nahtlos wird es erst mit Notarisierung (Stufe B, Apple-Account).
//
// Läuft NACH dem Packen der .app (inkl. extraResources/hq-sidecar), aber VOR dem
// Bauen von DMG/zip — die Artefakte enthalten also die signierte App. Der
// HQ-Sidecar in Contents/Resources/hq-sidecar/ behält seine eigene, von
// bundle-dylibs.sh gesetzte Ad-hoc-Signatur (codesign --deep fasst lose Mach-Os
// in Resources nicht an) und wird vom äußeren Siegel nur per Hash erfasst.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[afterPack] ad-hoc signing ${appPath}`);
  // --force: bestehende (Linker-)Signatur überschreiben. --deep: verschachtelte
  // Bundles (Electron Framework, Helfer) mit signieren. --sign -: ad-hoc.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });

  // Sanity-Check: das Siegel MUSS jetzt verifizieren (vor diesem Hook schlug
  // `codesign --verify` mit „code has no resources but signature indicates they
  // must be present" fehl). Schlägt fehl → Build bricht ab statt eine erneut
  // „beschädigte" DMG auszuliefern.
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
    stdio: 'inherit',
  });
  console.log('[afterPack] ad-hoc signature verified');
};
