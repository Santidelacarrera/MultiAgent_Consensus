import { execFileSync, spawn } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { freePort } from './redis_helper';

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/15/bin', '/usr/lib/postgresql/14/bin'].find((d) => existsSync(join(d, 'initdb')));

export interface PgHandle {
  url: string;
  stop(): Promise<void>;
}

/** Arranca un PostgreSQL real y efímero (initdb en un directorio temporal). Devuelve null si no hay binarios. */
export async function startPostgres(): Promise<PgHandle | null> {
  if (!BIN) return null;
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const dir = mkdtempSync(join(tmpdir(), 'pgtest-'));
  chmodSync(dir, 0o777);
  const wrap = (cmd: string, args: string[]): [string, string[]] => (asRoot ? ['runuser', ['-u', 'postgres', '--', cmd, ...args]] : [cmd, args]);
  const data = join(dir, 'data');
  const port = await freePort();
  try {
    const [c, a] = wrap(join(BIN, 'initdb'), ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-sync']);
    execFileSync(c, a, { stdio: 'ignore' });
    const [c2, a2] = wrap(join(BIN, 'postgres'), ['-D', data, '-p', String(port), '-k', dir, '-c', 'listen_addresses=127.0.0.1', '-c', 'fsync=off']);
    const proc = spawn(c2, a2, { stdio: 'ignore' });
    const deadline = Date.now() + 15000;
    const { Client } = await import('pg');
    while (Date.now() < deadline) {
      const cl = new Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' });
      try {
        await cl.connect();
        await cl.end();
        return {
          url: `postgres://postgres@127.0.0.1:${port}/postgres`,
          stop: async () => {
            try {
              const [pc, pa] = wrap(join(BIN, 'pg_ctl'), ['stop', '-D', data, '-m', 'immediate']);
              execFileSync(pc, pa, { stdio: 'ignore', timeout: 10000 });
            } catch {
              proc.kill('SIGKILL');
            }
            await Promise.race([new Promise((r) => proc.once('exit', r)), new Promise((r) => setTimeout(r, 5000))]);
            rmSync(dir, { recursive: true, force: true });
          },
        };
      } catch {
        await cl.end().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    proc.kill('SIGKILL');
  } catch {
    /* sin postgres utilizable */
  }
  rmSync(dir, { recursive: true, force: true });
  return null;
}
