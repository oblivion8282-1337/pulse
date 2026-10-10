// Eingabe des Beitrittsfelds zerlegen — importfrei (Node-Unit-Tests,
// CLAUDE.md). joinByInvite.ts reicht den Cloud-Host als `parseJoinInput` ein.

/**
 * Ergebnis des Parsens eines Join-Inputs.
 */
export type ParsedJoinInput =
  | { kind: 'invite'; code: string; host: string | null }
  | { kind: 'public'; handle: string; host: string | null }
  | { kind: 'host'; host: string };

/** Nackte Hostadresse: optionales Schema, FQDN (≥2 Labels), optionaler Port,
 *  KEIN Pfad. Bare Invite-Codes enthalten keinen Punkt → keine Kollision. */
const _BARE_HOST_RE =
  /^(https?:\/\/)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?\/?$/i;

/** Ein kaputtes %-Escape wirft `URIError`; den Rohwert behalten, damit `zielHost`
 *  ihn als ungültigen Host abweist (dieselbe Meldung wie jeder andere ungültige Host). */
function hostDekodieren(roh: string): string {
  try {
    return decodeURIComponent(roh);
  } catch {
    return roh;
  }
}

/**
 * Zerlegt einen gepasteten Link oder bare Code in sein strukturiertes Format.
 *
 * Erkannte Formate:
 *  - Einladungslink: `<any>/invite/<code>[?host=<fqdn>]`
 *  - Öffentliche Community-Adresse: `<any>/c/<handle>[?host=<fqdn>]`
 *  - Bare Community-Handle: `c/<handle>` (kein Leading-Slash nötig)
 *  - Nackte Hostadresse: `chat.firma.de` / `https://chat.firma.de` (kein Pfad)
 *    → Universal-Beitrittsfeld: Server direkt ansprechen (Cert-Login ohne
 *    Grant; verlangt der Server eine Einladung, fragt das UI nach dem Code)
 *  - Bare Invite-Code: alles andere (Fallback)
 *
 * ``host`` ist der bare FQDN aus ``?host=`` (oder null bei Cloud/bare Code).
 * ``cloudHostname`` ist `CLOUD_HOSTNAME` (mit Schema).
 */
export function beitrittsEingabeZerlegen(input: string, cloudHostname: string): ParsedJoinInput {
  const trimmed = input.trim();

  // Öffentliche Community-Adresse: <scheme://host>/c/<handle>[?...]
  // oder bare c/<handle>
  const publicMatch = trimmed.match(/(?:^|\/)(c)\/([a-z0-9][a-z0-9-]{0,30}[a-z0-9]|[a-z0-9])(?:[/?#]|$)/i);
  if (publicMatch) {
    const handle = publicMatch[2].toLowerCase();
    // Extrahiere den Host aus der URL (falls vorhanden, z.B. https://chat.firma.de/c/meine-community)
    let host: string | null = null;
    const hostParam = trimmed.match(/[?&]host=([^\s&#]+)/i);
    if (hostParam) {
      host = hostDekodieren(hostParam[1]);
    } else {
      // Host aus dem URL-Schema extrahieren (wenn URL mit http(s):// beginnt).
      // Nur als Self-Host behandeln, wenn es NICHT der Cloud-Host ist.
      const urlHostMatch = trimmed.match(/^https?:\/\/([^/]+)\//i);
      const cloudHost = cloudHostname.replace('https://', '');
      if (urlHostMatch && !trimmed.includes(cloudHost)) {
        host = urlHostMatch[1];
      }
    }
    return { kind: 'public', handle, host };
  }

  // Nackte Hostadresse (vor dem Invite-Fallback, NACH /invite- und /c/-Links):
  // eine Server-URL ohne Pfad ist nie ein Invite-Code (Codes haben keine Punkte).
  // Der Cloud-Host ist keine "Adresse zum Beitreten" — er ist immer schon da;
  // Durchfallen zum Code-Pfad erzeugt die normale "Code ungültig"-Meldung.
  if (_BARE_HOST_RE.test(trimmed)) {
    const bare = trimmed.replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase();
    const cloudHost = cloudHostname.replace(/^https?:\/\//, '');
    if (bare !== cloudHost) return { kind: 'host', host: bare };
  }

  // Einladungslink: <any>/invite/<code>[?host=<fqdn>]
  const codeMatch = trimmed.match(/\/invite\/([^/?#\s]+)/i);
  const code = (codeMatch ? codeMatch[1] : trimmed).trim();
  const hostMatch = trimmed.match(/[?&]host=([^\s&#]+)/i);
  const host = hostMatch ? hostDekodieren(hostMatch[1]) : null;
  return { kind: 'invite', code, host };
}
