// Teilbare Links bauen — importfrei (Node-Unit-Tests, CLAUDE.md). Die Hülle,
// die den aktiven Server einsetzt, steht in inviteLink.ts.

/** Der Server, auf dem die Community liegt; fehlt er, gilt die Cloud. */
export interface LinkServer {
  isCloud: boolean;
  hostname: string;
}

/** Self-Host: der Link zeigt auf die WEB-App-Origin (ein Self-Host liefert
 *  kein Web-UI aus) und trägt den Zielserver als `?host=`. */
function hostAnhang(server: LinkServer | undefined): string {
  if (!server || server.isCloud) return '';
  const host = server.hostname.replace(/^https?:\/\//, '');
  return `?host=${encodeURIComponent(host)}`;
}

export function einladungsLinkBauen(
  origin: string,
  code: string,
  server: LinkServer | undefined
): string {
  return `${origin}/invite/${code}${hostAnhang(server)}`;
}

export function adresseBauen(
  origin: string,
  handle: string,
  server: LinkServer | undefined
): string {
  return `${origin}/c/${encodeURIComponent(handle)}${hostAnhang(server)}`;
}
