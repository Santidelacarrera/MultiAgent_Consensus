import { ChildProcess, spawn } from 'child_process';
import { createServer } from 'net';

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export interface RedisHandle {
  url: string;
  stop(): Promise<void>;
}

/** Arranca un redis-server efímero; devuelve null si el binario no está disponible. */
export async function startRedis(): Promise<RedisHandle | null> {
  const port = await freePort();
  let proc: ChildProcess;
  try {
    proc = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no', '--bind', '127.0.0.1'], { stdio: 'ignore' });
  } catch {
    return null;
  }
  const failed = new Promise<boolean>((res) => proc.on('error', () => res(true)));
  const deadline = Date.now() + 5000;
  const Redis = (await import('ioredis')).default;
  while (Date.now() < deadline) {
    if (await Promise.race([failed, Promise.resolve(false)])) return null;
    const probe = new Redis(port, '127.0.0.1', { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    probe.on('error', () => undefined);
    try {
      await probe.connect();
      await probe.ping();
      probe.disconnect();
      return {
        url: `redis://127.0.0.1:${port}`,
        stop: async () => {
          proc.kill('SIGTERM');
          await new Promise((r) => proc.once('exit', r));
        },
      };
    } catch {
      probe.disconnect();
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  proc.kill('SIGKILL');
  return null;
}
