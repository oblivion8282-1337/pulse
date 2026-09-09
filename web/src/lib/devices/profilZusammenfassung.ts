/**
 * Eine Zeile, die das Übertragungsprofil eines Remote-Rechners zusammenfasst —
 * für die eingeklappte Karte im Reiter, damit man sieht, was gilt, ohne das
 * Formular zu öffnen.
 *
 * Importfrei (Nodes Testläufer); die übersetzten Teile — den Namen der Quelle
 * und das Wort für „nativ" — reicht der Aufrufer herein.
 */
export interface ProfilAuszug {
  quelleName: string;
  codec: 'h264' | 'av1';
  /** Wert aus dem Katalog (`Native`, `4K`, …) — `Native` wird übersetzt. */
  aufloesung: string;
  aufloesungNativ: string;
  fps: number;
  bitrate_kbps: number;
  zehn_bit: boolean;
  hdr: boolean;
}

export function profilZusammenfassung(p: ProfilAuszug): string {
  const teile = [
    p.quelleName,
    p.codec === 'av1' ? 'AV1' : 'H.264',
    p.aufloesung === 'Native' ? p.aufloesungNativ : p.aufloesung,
    `${p.fps} fps`,
    `${p.bitrate_kbps} kbit/s`,
  ];
  if (p.hdr) teile.push('HDR');
  else if (p.zehn_bit) teile.push('10 Bit');
  return teile.join(' · ');
}
