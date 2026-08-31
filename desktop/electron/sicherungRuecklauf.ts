/**
 * Loopback-Zuhörer für den Google-Konsent der Sicherung — der Grund, warum
 * der Desktop-Nutzer nur einen Knopf sieht: der Main-Prozess lauscht auf
 * `http://127.0.0.1:9109/ruecklauf`, öffnet die Google-Seite im
 * Standardbrowser, und die Weiterleitung landet hier statt im Leeren.
 *
 * Ein Zuhörer gleichzeitig (IPC-Aufrufe der Renderer überlappen sonst im
 * Port); die Frist von fünf Minuten räumt einen vergessenen Lauf auf, sonst
 * bliebe der Port belegt, bis Pulse endet. Die Antwort-Seite sagt dem
 * Nutzer nur, dass er den Browser-Tab schließen kann — der Code selbst
 * wandert synchron an den Renderer zurück.
 */

import { ipcMain, shell } from 'electron';
import * as http from 'node:http';

const PORT = 9109;
const FRIST_MS = 5 * 60_000;

export function wireSicherungRuecklauf(): void {
  ipcMain.handle('sicherung:oauthStart', async (_ereignis, adresse: unknown) => {
    if (typeof adresse !== 'string' || !adresse.startsWith('https://accounts.google.com/')) {
      throw new Error('Unerwartete Anmelde-Adresse');
    }
    const rueckgabe = await new Promise<string>((resolve, ablehnen) => {
      const server = http.createServer((anfrage, antwort) => {
        const adresse2 = new URL(anfrage.url ?? '/', 'http://127.0.0.1');
        antwort.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        antwort.end(
          '<html><body style="font-family: sans-serif; text-align: center; padding-top: 4em">' +
            '<h2>Google verbunden</h2><p>Dieses Fenster kannst du schließen und in Pulse weitermachen.</p>' +
            '</body></html>',
        );
        server.close();
        resolve(adresse2.toString());
      });
      server.on('error', (fehler) => {
        ablehnen(fehler);
      });
      server.listen(PORT, '127.0.0.1', () => {
        void shell.openExternal(adresse);
      });
      setTimeout(() => {
        server.close();
        ablehnen(new Error('Zeit abgelaufen — bitte erneut verbinden.'));
      }, FRIST_MS).unref();
    });
    return rueckgabe;
  });
}
