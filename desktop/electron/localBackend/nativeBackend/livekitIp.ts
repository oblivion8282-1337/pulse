/**
 * Öffentliche IP ↔ LiveKit im nativen Windows-Weg — Gegenstück zu
 * containerIpAbgleich.ts. Hier gibt es kein Skript im Container: die
 * livekit.yaml wird neu gerendert und NUR der LiveKit-Prozess neu gestartet.
 * Begründung: oeffentlicheIp.ts.
 */

import { writeFileSync } from 'node:fs';

import { discoverPublicIp } from '../stun.ts';
import { gleicheOeffentlicheIpAb, taugtAlsOeffentlicheIp, type IpAbgleichErgebnis } from '../oeffentlicheIp.ts';
import { renderLivekitYaml } from './configs.ts';
import type { SupervisedProcess } from './processes.ts';
import type { NativeSecrets } from './types.ts';

export async function oeffentlicheIpFuerStart(): Promise<string | undefined> {
  const ip = await discoverPublicIp().catch(() => null);
  return taugtAlsOeffentlicheIp(ip) ? ip : undefined;
}

export class NativeLivekitIp {
  private gesetzt: string;
  private readonly yamlPfad: string;
  private readonly secrets: NativeSecrets;
  private readonly voicePort: number;
  private readonly prozess: SupervisedProcess;

  constructor(opts: {
    yamlPfad: string; secrets: NativeSecrets; voicePort: number;
    prozess: SupervisedProcess; gesetzt: string | undefined;
  }) {
    this.yamlPfad = opts.yamlPfad;
    this.secrets = opts.secrets;
    this.voicePort = opts.voicePort;
    this.prozess = opts.prozess;
    this.gesetzt = opts.gesetzt ?? ''; // '' = STUN-Weg beim Start
  }

  abgleichen(): Promise<IpAbgleichErgebnis> {
    return gleicheOeffentlicheIpAb({
      ermittle: () => discoverPublicIp(),
      gesetzte: async () => this.gesetzt,
      setze: async (ip) => {
        writeFileSync(this.yamlPfad, renderLivekitYaml(this.secrets, this.voicePort, ip), { encoding: 'utf-8' });
        await this.prozess.stop();
        await this.prozess.start();
        this.gesetzt = ip;
      },
    });
  }
}
