/**
 * Loopback-Zuhörer für den Google-Konsent der Sicherung — der Grund, warum
 * der Desktop-Nutzer nur einen Knopf sieht: der Main-Prozess lauscht auf
 * `127.0.0.1`, öffnet die Google-Seite im Standardbrowser, und die
 * Weiterleitung landet hier statt im Leeren.
 *
 * **Der Port ist dynamisch** (`listen(0)`): es kann zwei Pulse-Instanzen
 * geben (zwei Geräte-Profile im Test, zwei Kontos im Alltag), und mit einem
 * festen Port käme die zweite beim Binden mit EADDRINUSE zu Fall — oder
 * schlimmer: fängt die Rückgabe der ersten ab. Der Renderer fragt den Port
 * VOR dem Bau der Anmelde-Adresse ab (`sicherung:oauthPort`) und Google
 * akzeptiert bei Desktop-Clients jeden Loopback-Port.
 *
 * Der Zuhörer bleibt nach dem ersten Start für die Lebensdauer der App
 * bestehen; mehrere gleichzeitige Anmeldungen werden als Warteliste
 * geführt, jede Rückgabe erlöst alle Wartenden (der Nutzer sieht eh nur
 * einen Konsent-Tab). Die Frist von fünf Minuten räumt vergessene Läufe ab.
 */

import { ipcMain, shell } from 'electron';
import * as http from 'node:http';

const FRIST_MS = 5 * 60_000;

let server: http.Server | null = null;
type Wartender = { state: string; erloest: (url: string) => void };
let wartende: Wartender[] = [];
// Bughunt Runde 42 (Entscheidung 4.10): Port-Anfragen teilen sich EIN
// In-Flight-Versprechen — zwei gleichzeitige `oauthPort`-Aufrufe sahen sonst
// beide `server === null` und bauten je einen Listener (ein Port war geleckt,
// Google-Clients hingen an veralteten Adressen). Die Idempotenzprüfung oben
// deckt nur den sequenziellen Fall.
let portAnfrage: Promise<number> | null = null;

function oeffneZuhörer(): Promise<number> {
  portAnfrage ??= starteZuhörer().finally(() => {
    portAnfrage = null;
  });
  return portAnfrage;
}

function starteZuhörer(): Promise<number> {
  return new Promise((resolve, ablehnen) => {
    const zuhörer = http.createServer((anfrage, antwort) => {
      const adresse = new URL(anfrage.url ?? '/', 'http://127.0.0.1');
      antwort.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      // Bughunt Runde 38: ein Fehler-Callback (Zustimmung verweigert) renderte
      // vorher die Erfolgsmeldung — der echte Grund steht erst in der
      // Einstellungssektion, der Tab behauptete das Gegenteil. Der Fehlerwert
      // wird HTML-escaped: JEDER lokale Prozess kann diese URL mit beliebigen
      // Parametern aufrufen, auch wenn der state den Wartenden-Zweig nie
      // erreicht.
      const fehler = adresse.searchParams.get('error');
      const escapet = (roh: string): string =>
        roh
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      antwort.end(
        '<html><body style="font-family: sans-serif; text-align: center; padding-top: 4em">' +
          (fehler !== null
            ? `<h2>Verbindung abgelehnt</h2><p>Google meldete: ${escapet(fehler)}</p>` +
              '<p>Fenster schließen und in Pulse erneut verbinden.</p>'
            : '<h2>Google verbunden</h2><p>Dieses Fenster kannst du schließen und in Pulse weitermachen.</p>') +
          '</body></html>',
      );
      // Security-Scan 2026-09-18: Nur eine Rückgabe mit ERWARTETEM state
      // erlöst ihren Wartenden. Vorher löste JEDE Anfrage auf dem (dynamischen,
      // aber auffindbaren) Port alle Wartenden aus — ein lokaler Fremdprozess
      // konnte selbstgebaute OAuth-Rückgaben injizieren. Der state stammt aus
      // der Anmelde-Adresse (der Renderer validiert ihn zusätzlich noch einmal
      // gegen seinen eigenen Zustand, googleClient.ts).
      const state = adresse.searchParams.get('state');
      if (!state) return;
      const treffer = wartende.find((w) => w.state === state);
      if (!treffer) return;
      wartende = wartende.filter((w) => w !== treffer);
      treffer.erloest(adresse.toString());
    });
    zuhörer.on('error', ablehnen);
    zuhörer.listen(0, '127.0.0.1', () => {
      server = zuhörer;
      resolve((zuhörer.address() as { port: number }).port);
    });
  });
}

export function wireSicherungRuecklauf(): void {
  ipcMain.handle('sicherung:oauthPort', async () => {
    // Der bestehende Zuhörer bleibt (Modulkopf). Vorher baute jeder Aufruf
    // einen NEUEN Listener auf und ließ den alten laufen — ein Leck pro
    // Anmelde-Versuch, und Google-Clients hingen an veralteten Ports.
    if (server?.listening) {
      return (server.address() as { port: number }).port;
    }
    try {
      return await oeffneZuhörer();
    } catch (fehler) {
      // Ein toter Zuhörer (Fremdprozess auf unserem Socket, Netzwerkwechsel)
      // wird einmal weggeworfen und neu gebaut — scheitert auch das, sieht
      // der Renderer den Fehler statt eines stillen Hängens.
      server = null;
      wartende = [];
      if (fehler && (fehler as { code?: string }).code !== 'EADDRINUSE') {
        throw fehler;
      }
      return await oeffneZuhörer();
    }
  });

  ipcMain.handle('sicherung:oauthStart', async (_ereignis, adresse: unknown) => {
    if (typeof adresse !== 'string' || !adresse.startsWith('https://accounts.google.com/')) {
      throw new Error('Unerwartete Anmelde-Adresse');
    }
    // Der state gehört zum Start der Anmeldung — ohne ihn kann der Zuhörer
    // Rückgaben später niemandem zuordnen (fail-closed, s. Zuhörer-Kommentar).
    let state: string;
    try {
      state = new URL(adresse).searchParams.get('state') ?? '';
    } catch {
      state = '';
    }
    if (!state) throw new Error('Anmelde-Adresse ohne state-Parameter');
    // Bughunt Runde 42: auch einen GECRASHten Listener (existiert, lauscht
    // aber nicht mehr) neu aufmachen — sonst öffnete der Konsent mit einer
    // toten Weiterleitungs-Adresse und der Flow hing bis zur Frist.
    if (!server?.listening) await oeffneZuhörer();
    const rueckgabe = new Promise<string>((resolve, ablehnen) => {
      const erledige = (url: string): void => {
        clearTimeout(frist);
        resolve(url);
      };
      const frist = setTimeout(() => {
        wartende = wartende.filter((w) => w.erloest !== erledige);
        ablehnen(new Error('Zeit abgelaufen — bitte erneut verbinden.'));
      }, FRIST_MS);
      frist.unref();
      wartende.push({ state, erloest: erledige });
    });
    await shell.openExternal(adresse);
    return rueckgabe;
  });
}
