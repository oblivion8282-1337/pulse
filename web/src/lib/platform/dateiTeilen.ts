/**
 * Anhänge speichern — Web-Share mit Dateien, Anker-Fallback nur auf Desktop.
 *
 * WARUM: In der iOS-WKWebView gibt es keinen Download-Manager — der bisherige
 * `<a download>`-Trick erzeugt dort nur eine Warnung und speichert nichts.
 * Die Web-Share-API mit Dateien (`navigator.share({ files })`) läuft in der
 * WKWebView nativ (iOS 15+) und öffnet das System-Share-Sheet mit „In Dateien
 * sichern“/„Bild sichern“ — kein Capacitor-Plugin nötig. Wo `canShare` die
 * Dateien verweigert (Desktop/Electron), bleibt der bewährte Anker-Trick
 * unverändert.
 *
 * Sicherheits-Schiene: Ein leerer Dateiname fällt auf `anhang` zurück — mit
 * `undefined`/`''` würde der Anker-Klick in die `blob:`-Adresse NAVIGIEREN
 * statt zu speichern (ein `text/html`-Anhang liefe dann als Skript im
 * Ursprung der Anwendung; Muster aus `MessageAttachments.svelte`,
 * `ERSATZ_DATEINAME`).
 *
 * Objekt-URL-Besitz: Diese Funktion erzeugt selbst nur im Anker-Fall eine
 * Objekt-URL und revoket sie nach dem Klick selbst (Frist gibt dem Download
 * Zeit zu starten). Eine als `quelle` übergebene `blob:`-Adresse gehört dem
 * Aufrufer und wird NICHT revoket — die Blätter halten ihre Objekt-URLs für
 * wiederholte Klicks am Leben und räumen beim Abbau selbst auf.
 */

export type DateiTeilenErgebnis = 'geteilt' | 'geladen' | 'abgebrochen';

const ERSATZ_DATEINAME = 'anhang';

/** Reiner Kern (für den Test): leerer Name → Ersatzname, s. Modulkopf. */
export function dateiNameOderErsatz(dateiname: string): string {
  return dateiname || ERSATZ_DATEINAME;
}

/**
 * Stellt `quelle` als Datei bereit und reicht sie weiter: über das native
 * Share-Sheet, wo die Web-Share-API Dateien annimmt (iOS-WKWebView, Android-
 * Browser), sonst über den klassischen Anker-Download (Desktop/Electron).
 * `fetch` funktioniert auch für `blob:`-Adressen — der Aufrufer muss nicht
 * wissen, ob hinter `quelle` der Server oder der Objektspeicher steht.
 * Scheitert das Holen (z. B. abgelaufene Adresse), wird geworfen — der
 * Aufrufer fängt still, wie bisher bei `blob === null`.
 */
export async function dateiTeilenOderLaden(
  quelle: string,
  dateiname: string
): Promise<DateiTeilenErgebnis> {
  const name = dateiNameOderErsatz(dateiname);
  const antwort = await fetch(quelle);
  const blob = await antwort.blob();
  const datei = new File([blob], name, {
    type: blob.type || 'application/octet-stream'
  });

  if (navigator.canShare?.({ files: [datei] })) {
    try {
      await navigator.share({ files: [datei] });
      return 'geteilt';
    } catch (e) {
      // Share-Sheet vom Nutzer geschlossen — kein Fehler, kein Download.
      // Jede andere Share-Störung bleibt ebenfalls still (Ergebnis ist
      // informativ; ein Anker-Fallback half in der WKWebView ohnehin nicht).
      if (e instanceof DOMException && e.name === 'AbortError') return 'abgebrochen';
      return 'geteilt';
    }
  }

  // Desktop-Fallback: der bewährte Anker-Trick. Die Objekt-URL gehört dieser
  // Funktion und wird nach der Frist selbst freigegeben.
  const adresse = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = adresse;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(adresse), 10_000);
  return 'geladen';
}
