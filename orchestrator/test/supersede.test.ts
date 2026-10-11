import { Test } from '@nestjs/testing';
import request from 'supertest';
import { makePr } from '../../agents/__tests__/fixtures';
import { ScriptedProvider } from '../../agents/llm';
import { AppModule } from '../src/app.module';
import { MemoryBus } from '../src/bus/memory_bus';
import { MemoryStore } from '../src/store/memory_store';

describe('debates obsoletos', () => {
  it('un push nuevo cancela el debate en curso del mismo PR', async () => {
    // El LLM simulado añade latencia para que el primer debate siga en curso al llegar el segundo commit.
    const llm = new ScriptedProvider(async () => {
      await new Promise((r) => setTimeout(r, 250));
      return JSON.stringify({ findings: [] });
    });
    const mod = await Test.createTestingModule({
      imports: [AppModule.register({ busBackend: 'memory', busSecret: 's' }, { bus: new MemoryBus(), store: new MemoryStore(), llm })],
    }).compile();
    const app = mod.createNestApplication();
    await app.init();
    const http = request(app.getHttpServer());

    const base = makePr([{ path: 'src/db.ts', added: ['const q = `SELECT * FROM users WHERE id = ${req.params.id}`;'] }, { path: 'src/db.test.ts', added: ['t'] }]);
    const send = (sha: string) => ({ pr: { provider: 'github', repo: base.repo, number: base.number, title: 't', headSha: sha, diff: base.diff } });

    const a = await http.post('/v1/debates').send(send('aaaaaaa')).expect(202);
    const b = await http.post('/v1/debates').send(send('bbbbbbb')).expect(202);
    expect(b.body.id).not.toBe(a.body.id);

    const da = await http.get(`/v1/debates/${a.body.id}?waitMs=15000`).expect(200);
    expect(da.body).toMatchObject({ status: 'superseded', verdict: 'SUPERSEDED' });
    const db = await http.get(`/v1/debates/${b.body.id}?waitMs=15000`).expect(200);
    expect(db.body.status).toBe('escalated');

    // el mismo commit obsoleto no queda "cacheado" como válido: un reenvío crea un debate nuevo
    const again = await http.post('/v1/debates').send(send('aaaaaaa')).expect(202);
    expect(again.body.id).not.toBe(a.body.id);

    const events = (await http.get(`/v1/debates/${a.body.id}/events`)).body.map((e: { type: string }) => e.type);
    expect(events).toContain('debate.superseded');
    expect((await http.get('/metrics')).text).toMatch(/consensus_debates_total\{decision="SUPERSEDED"\} [1-9]/);
    await http.get(`/v1/debates/${again.body.id}?waitMs=15000`);
    await app.close();
  }, 30000);
});
