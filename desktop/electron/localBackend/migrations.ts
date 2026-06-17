/**
 * Alembic-Migrationen für den lokalen Self-Host-Stack.
 * Portiert von infra/self-host/s6/etc/s6-overlay/scripts/06-run-migrations.sh.
 *
 * Führt sequenziell `uv run --package dcc-auth alembic upgrade head` (cwd services/auth)
 * und `uv run --package dcc-chat-gateway alembic upgrade head` (cwd services/chat-gateway) aus.
 * Schlägt auth fehl, wird chat-gateway NICHT migriert (kein halb-migrierter Start).
 *
 * Exports:
 *   runMigrations(repoRoot, env): Promise<void>
 *     - repoRoot: absoluter Pfad zum Repository-Root (enthält services/)
 *     - env: vollständige Env-Map aus renderEnv() — enthält DATABASE_URL + JWT-Key-Pfade etc.
 *
 * Regel: Niemals Secret-Werte loggen.
 */

import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { resolveUv } from './paths.ts';

/**
 * Führt `uv run --package <pkg> alembic upgrade head` aus.
 * Wirft bei Exit != 0.
 */
function runAlembic(
  pkg: string,
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const uv = resolveUv();
    const args = ['run', '--package', pkg, 'alembic', 'upgrade', 'head'];

    console.log(`[migrations] alembic upgrade head — ${pkg} (${cwd})`);

    const proc = spawn(uv, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const out: string[] = [];
    proc.stdout?.on('data', (d: Buffer) => out.push(d.toString()));
    proc.stderr?.on('data', (d: Buffer) => out.push(d.toString()));

    proc.on('error', (err) => {
      reject(new Error(`[migrations] uv spawn fehlgeschlagen (${pkg}): ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        // Ausgabe enthält keine Secret-Werte (alembic loggt nur SQL + Schema-Info)
        const output = out.join('').slice(0, 4000);
        reject(new Error(
          `[migrations] alembic upgrade head fehlgeschlagen (${pkg}, exit ${code}):\n${output}`,
        ));
      }
    });
  });
}

/**
 * Führt Alembic-Migrationen sequenziell durch: erst auth, dann chat-gateway.
 * Bei einem Fehler in auth wird chat-gateway nicht ausgeführt.
 *
 * @param repoRoot Absoluter Pfad zum Repository-Root (enthält services/).
 * @param env      Vollständige Env-Map aus renderEnv() — muss DATABASE_URL enthalten.
 */
export async function runMigrations(
  repoRoot: string,
  env: Record<string, string>,
): Promise<void> {
  const authCwd = join(repoRoot, 'services', 'auth');
  const chatCwd = join(repoRoot, 'services', 'chat-gateway');

  await runAlembic('dcc-auth', authCwd, env);
  await runAlembic('dcc-chat-gateway', chatCwd, env);

  console.log('[migrations] Alle Migrationen abgeschlossen.');
}
