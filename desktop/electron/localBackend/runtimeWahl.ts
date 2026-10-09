/**
 * Welche Container-Runtime trägt den Server? (aus containerRuntime.ts
 * herausgezogen, Größen-Policy.)
 *
 * Zwei Fehler der früheren Fassung, beide auf Linux:
 *  1. **Podman wurde immer vor Docker genommen**, und nirgends stand, wo der
 *     Container angelegt worden war. Kam Podman neben einem laufenden
 *     Docker-Server dazu, startete beim nächsten Mal ein LEERER Server im
 *     Podman — Communities und Schlüssel lagen unsichtbar im Docker-Volume.
 *     Jetzt merkt sich der Aufrufer die Runtime des erfolgreichen `run`
 *     (`RuntimeMerker`), und danach gilt nur noch sie. Ohne Merkung zählt
 *     ein vorhandener `pulse-host*`-Container bzw. ein `pulse-host-data*`-
 *     Volume (Bestandsnutzer von vor dem Merker).
 *  2. **„Verfügbar" hieß `--version` klappt** — das geht ohne laufenden
 *     Daemon und ohne Gruppenrecht am Docker-Socket. Der Start scheiterte
 *     dann irgendwo später und die Oberfläche stand auf „Pause". Jetzt fragt
 *     die Probe den Dienst selbst (`info`) und unterscheidet „bereit" von
 *     „installiert, aber kein Zugriff" samt Klartext-Grund.
 *
 * Win/Mac + Podman bleiben bei der reinen `--version`-Probe: dort läuft die
 * podman machine erst nach `ensureMachine()`, ein `info` davor schlüge immer
 * fehl. Keine Electron-Imports (node:test-tauglich).
 */

import { rtExec, type ContainerRuntime, type ExecResult } from './containerRuntime.ts';

export type RuntimeArt = ContainerRuntime['kind'];

/** Persistenz der gewählten Runtime — main.ts verdrahtet sie mit dem Store. */
export interface RuntimeMerker {
  lesen(): RuntimeArt | null;
  schreiben(kind: RuntimeArt): void;
}

export type ProbeErgebnis =
  | { status: 'bereit' }
  | { status: 'kein-zugriff'; grund: string }
  | { status: 'fehlt' };

export interface RuntimeWahl {
  rt: ContainerRuntime | null;
  /** Klartext für die Oberfläche, wenn `rt` null ist und es nicht schlicht
   *  an einer fehlenden Installation liegt. */
  problem: string | null;
  /** true, wenn die Wahl aus einem Bestands-Container/-Volume folgte und
   *  der Aufrufer sie merken sollte. */
  ausBestand: boolean;
}

const NAME: Record<RuntimeArt, string> = { podman: 'Podman', docker: 'Docker' };
const INFO_FRIST_MS = 10_000;

/** Gemeinsamer Text für fehlendes Recht am Docker-Socket (Probe UND `run`). */
export const DOCKER_KEIN_RECHT =
  'Docker ist installiert, aber dein Benutzer darf den Docker-Dienst nicht ansprechen (keine Berechtigung für docker.sock). '
  + 'Abhilfe: „sudo usermod -aG docker $USER“, danach ab- und wieder anmelden.';

/** Reine Auswertung des `info`-Aufrufs (Code -1 = von rtExec nach Frist
 *  abgeschossen). Die Gründe sind für Menschen geschrieben, nicht für Logs. */
export function infoAuswerten(kind: RuntimeArt, info: Pick<ExecResult, 'code' | 'stderr'>): ProbeErgebnis {
  if (info.code === 0) return { status: 'bereit' };
  const err = info.stderr;
  const name = NAME[kind];
  if (info.code === -1) {
    return { status: 'kein-zugriff', grund: `${name} ist installiert, antwortet aber nicht (keine Antwort binnen ${INFO_FRIST_MS / 1000} s).` };
  }
  if (kind === 'docker' && /permission denied/i.test(err)) {
    return { status: 'kein-zugriff', grund: DOCKER_KEIN_RECHT };
  }
  if (kind === 'docker' && /cannot connect to the docker daemon|is the docker daemon running|no such file or directory/i.test(err)) {
    return {
      status: 'kein-zugriff',
      grund: 'Docker ist installiert, aber der Docker-Dienst läuft nicht. Abhilfe: „sudo systemctl enable --now docker“ (bzw. Docker Desktop starten).',
    };
  }
  if (kind === 'podman' && /subuid|subgid|insufficient uids|newuidmap|newgidmap/i.test(err)) {
    return {
      status: 'kein-zugriff',
      grund: 'Podman ist installiert, aber für deinen Benutzer sind keine Unter-IDs eingerichtet (/etc/subuid, /etc/subgid). '
        + 'Abhilfe: „sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER“, danach „podman system migrate“.',
    };
  }
  const zeile = err.split('\n').map((z) => z.trim()).find(Boolean)?.slice(0, 200) ?? `exit ${info.code}`;
  return { status: 'kein-zugriff', grund: `${name} ist installiert, antwortet aber nicht: ${zeile}` };
}

/** Ist die Runtime da UND ansprechbar? */
export async function pruefeRuntime(
  rt: ContainerRuntime,
  plattform: NodeJS.Platform = process.platform,
): Promise<ProbeErgebnis> {
  const version = await rtExec(rt, ['--version'], { timeoutMs: 15_000 }).catch(() => null);
  if (version?.code !== 0) return { status: 'fehlt' };
  // Win/Mac: Podman-VM bzw. Docker Desktop fährt ensureMachine()/der Nutzer
  // erst noch hoch — hier bleibt es beim alten Kriterium „Binary da".
  if (plattform !== 'linux') return { status: 'bereit' };
  const args = rt.kind === 'docker' ? ['info', '--format', '{{.ServerVersion}}'] : ['info', '--format', '{{.Version.Version}}'];
  const info = await rtExec(rt, args, { timeoutMs: INFO_FRIST_MS }).catch(
    (e: unknown) => ({ code: 1, stdout: '', stderr: e instanceof Error ? e.message : String(e) }),
  );
  return infoAuswerten(rt.kind, info);
}

/** Liegt in dieser Runtime schon ein Pulse-Server (Container oder Volume)? */
export async function hatBestand(rt: ContainerRuntime): Promise<boolean> {
  const ps = await rtExec(rt, ['ps', '-a', '--format', '{{.Names}}'], { timeoutMs: 15_000 }).catch(() => null);
  if (ps?.code === 0 && ps.stdout.split('\n').some((n) => n.trim().startsWith('pulse-host'))) return true;
  const vol = await rtExec(rt, ['volume', 'ls', '--format', '{{.Name}}'], { timeoutMs: 15_000 }).catch(() => null);
  return vol?.code === 0 && vol.stdout.split('\n').some((n) => n.trim().startsWith('pulse-host-data'));
}

export interface Kandidat {
  rt: ContainerRuntime;
  probe: ProbeErgebnis;
  bestand?: boolean;
}

/** Reine Wahl aus geprüften Kandidaten (Reihenfolge = Präferenz):
 *  - gemerkt → NUR diese Art; ist sie nicht bereit, keine Runtime (lieber
 *    gar kein Server als ein leerer in der falschen Runtime);
 *  - sonst die erste bereite mit Bestand, sonst die erste bereite —
 *  - AUSSER auf einem Rechner, auf dem schon einmal ein Server lief
 *    (`frueherGestartet`), wenn eine andere Runtime gerade nicht ansprechbar
 *    ist und die bereite keinen Bestand hat: dann könnten die Daten genau in
 *    der stummen liegen (Docker-Dienst beim Anmelden noch nicht oben), und
 *    ein Start legte einen leeren Server an, den der Merker danach auch noch
 *    festschriebe. Lieber anhalten und den Grund nennen.
 *  `problem` nennt den Grund der gemerkten bzw. ersten nicht-bereiten Art. */
export function waehleRuntime(
  kandidaten: Kandidat[],
  gemerkt: RuntimeArt | null,
  frueherGestartet = false,
): RuntimeWahl {
  const grundVon = (k: Kandidat | undefined): string | null =>
    k?.probe.status === 'kein-zugriff' ? k.probe.grund : null;
  if (gemerkt) {
    const eigene = kandidaten.filter((k) => k.rt.kind === gemerkt);
    const bereit = eigene.find((k) => k.probe.status === 'bereit');
    if (bereit) return { rt: bereit.rt, problem: null, ausBestand: false };
    const grund = grundVon(eigene.find((k) => k.probe.status === 'kein-zugriff'))
      ?? `${NAME[gemerkt]} ist nicht (mehr) installiert.`;
    return {
      rt: null,
      problem: `Dein Server wurde mit ${NAME[gemerkt]} angelegt, seine Daten liegen dort. ${grund}`,
      ausBestand: false,
    };
  }
  const bereite = kandidaten.filter((k) => k.probe.status === 'bereit');
  const mitBestand = bereite.find((k) => k.bestand);
  if (mitBestand) return { rt: mitBestand.rt, problem: null, ausBestand: true };
  const stumm = kandidaten.find((k) => k.probe.status === 'kein-zugriff' && !bereite.some((b) => b.rt.kind === k.rt.kind));
  if (bereite.length && frueherGestartet && stumm) {
    return {
      rt: null,
      problem: `Auf diesem Rechner lief schon ein Pulse-Server, aber nicht in ${NAME[bereite[0].rt.kind]}. `
        + `${grundVon(stumm)} Solange nicht feststeht, wo seine Daten liegen, startet Pulse keinen neuen, leeren Server.`,
      ausBestand: false,
    };
  }
  if (bereite.length) return { rt: bereite[0].rt, problem: null, ausBestand: false };
  return { rt: null, problem: grundVon(kandidaten.find((k) => k.probe.status === 'kein-zugriff')), ausBestand: false };
}

/** Kandidaten prüfen (seriell, damit die Reihenfolge der Gründe stabil
 *  bleibt) und wählen. Bestand wird nur ohne Merkung abgefragt, und nur wenn
 *  er etwas entscheidet: mehr als eine bereite Runtime, oder ein Rechner, auf
 *  dem schon einmal ein Server lief. */
export async function ermittleRuntime(
  kandidaten: ContainerRuntime[],
  gemerkt: RuntimeArt | null,
  frueherGestartet = false,
): Promise<RuntimeWahl> {
  const geprueft: Kandidat[] = [];
  for (const rt of kandidaten) geprueft.push({ rt, probe: await pruefeRuntime(rt) });
  const bereite = geprueft.filter((k) => k.probe.status === 'bereit');
  if (!gemerkt && (bereite.length > 1 || frueherGestartet)) {
    for (const k of bereite) k.bestand = await hatBestand(k.rt);
  }
  return waehleRuntime(geprueft, gemerkt, frueherGestartet);
}
