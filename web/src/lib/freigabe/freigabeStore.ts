/**
 * Ablage für einen geteilten Inhalt (Übergabe P1.8, Share-Target) —
 * importfreier Zustand, damit der Node-Testlauf die Ablauf-Regeln prüft
 * und die Brücke (platform/shareEmpfang.ts) ohne Krypto-Importkegel
 * auskommt.
 *
 * Regel: die Freigabe bleibt liegen, BIS ein Verbraucher sie übernimmt
 * (Composer der geöffneten Unterhaltung) — nicht „bis zum nächsten
 * Klick“. Ein zweiter Share ERSETZT den ersten (der Nutzer teilt erneut,
 * der alte war nicht mehr gemeint).
 */

export type GeteilteFreigabe = {
  text: string | null;
  bild: { base64: string; mime: string } | null;
};

let freigabe: GeteilteFreigabe | null = null;

export function freigabeAnkommen(paket: {
  text?: string | null;
  bild?: { base64: string; mime: string } | null;
}): void {
  const text = typeof paket.text === 'string' && paket.text !== '' ? paket.text : null;
  const bild =
    paket.bild && typeof paket.bild.base64 === 'string' && paket.bild.base64 !== ''
      ? { base64: paket.bild.base64, mime: paket.bild.mime || 'image/jpeg' }
      : null;
  freigabe = text || bild ? { text, bild } : null;
}

export function freigabeHolen(): GeteilteFreigabe | null {
  return freigabe;
}

export function freigabeLeeren(): void {
  freigabe = null;
}
