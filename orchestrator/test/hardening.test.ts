import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CLEAN_PR, FAKE_AWS_KEY, makePr } from '../../agents/__tests__/fixtures';
import { AppModule } from '../src/app.module';
import { MemoryBus } from '../src/bus/memory_bus';
import { redactSecrets } from '../src/debate/redact';
import { renderMinutes } from '../src/debate/minutes';
import { MemoryStore } from '../src/store/memory_store';
import { makeHarness } from './helpers';

describe('redacción de secretos en la minuta', () => {
  it('enmascara patrones conocidos', () => {
    expect(redactSecrets(`k=${FAKE_AWS_KEY}`)).not.toContain(FAKE_AWS_KEY);
    expect(redactSecrets('token ghp_' + 'a'.repeat(36))).toContain('[REDACTADO]');
    expect(redactSecrets('password = "hunter2hunter2"')).toBe('password = "[REDACTADO]"');
    expect(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----')).not.toContain('MIIabc');
    expect(redactSecrets('texto normal')).toBe('texto normal');
  });

  it('la minuta de un PR con clave AWS no republica la clave', async () => {
    const h = await makeHarness();
    const pr = makePr([{ path: 'src/cfg.ts', added: [`export const KEY = "${FAKE_AWS_KEY}";`] }]);
    const md = renderMinutes(await h.engine.run('r1', pr));
    await h.stop();
    expect(md).toContain('Clave de acceso AWS');
    expect(md).not.toContain(FAKE_AWS_KEY);
    expect(md).toContain('[REDACTADO]');
  });
});

describe('concurrencia y métricas', () => {
  it('limita los debates simultáneos y expone /metrics', async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule.register({ busBackend: 'memory', busSecret: 's', maxConcurrentDebates: 1, apiKey: 'k' }, { bus: new MemoryBus(), store: new MemoryStore() })],
    }).compile();
    const app = mod.createNestApplication();
    await app.init();
    const http = request(app.getHttpServer());
    const ids: string[] = [];
    for (let n = 1; n <= 3; n++) {
      const pr = { ...CLEAN_PR(), number: n };
      const r = await http.post('/v1/debates').set('x-api-key', 'k').send({ pr: { provider: 'github', repo: pr.repo, number: n, title: 't', headSha: pr.headSha, diff: pr.diff } }).expect(202);
      ids.push(r.body.id);
    }
    for (const id of ids) {
      const d = await http.get(`/v1/debates/${id}?waitMs=5000`).set('x-api-key', 'k').expect(200);
      expect(d.body.status).toBe('approved');
    }
    await http.get('/metrics').expect(401);
    const m = await http.get('/metrics').set('x-api-key', 'k').expect(200);
    expect(m.text).toContain('consensus_debates_total{decision="APPROVED"} 3');
    expect(m.text).toContain('consensus_debates_active 0');
    expect(m.text).toContain('consensus_debates_queued 0');
    await app.close();
  });
});
