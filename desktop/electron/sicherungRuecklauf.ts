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
let wartende: Array<(url: string) => void> = [];

function starteZuhörer(): Promise<number> {
  return new Promise((resolve, ablehnen) => {
    const zuhörer = http.createServer((anfrage, antwort) => {
      const adresse = new URL(anfrage.url ?? '/', 'http://127.0.0.1');
      antwort.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      antwort.end(
        '<html><body style="font-family: sans-serif; text-align: center; padding-top: 4em">' +
          '<h2>Google verbunden</h2><p>Dieses Fenster kannst du schließen und in Pulse weitermachen.</p>' +
          '</body></html>',
      );
      const erlöst = wartende;
      wartende = [];
      for (const erledige of erlöst) erledige(adresse.toString());
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
    try {
      return await starteZuhörer();
    } catch (fehler) {
      // Ein toter Zuhörer (Fremdprozess auf unserem Socket, Netzwerkwechsel)
      // wird einmal weggeworfen und neu gebaut — scheitert auch das, sieht
      // der Renderer den Fehler statt eines stillen Hängens.
      server = null;
      wartende = [];
      if (fehler && (fehler as { code?: string }).code !== 'EADDRINUSE') {
        throw fehler;
      }
      return await starteZuhörer();
    }
  });

  ipcMain.handle('sicherung:oauthStart', async (_ereignis, adresse: unknown) => {
    if (typeof adresse !== 'string' || !adresse.startsWith('https://accounts.google.com/')) {
      throw new Error('Unerwartete Anmelde-Adresse');
    }
    if (server === null) await starteZuhörer();
    const rueckgabe = new Promise<string>((resolve, ablehnen) => {
      const erledige = (url: string): void => {
        clearTimeout(frist);
        resolve(url);
      };
      const frist = setTimeout(() => {
        wartende = wartende.filter((w) => w !== erledige);
        ablehnen(new Error('Zeit abgelaufen — bitte erneut verbinden.'));
      }, FRIST_MS);
      frist.unref();
      wartende.push(erledige);
    });
    await shell.openExternal(adresse);
    return rueckgabe;
  });
}
