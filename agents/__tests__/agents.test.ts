import { ArchitectAgent } from '../architect';
import { BusinessOpsAgent, instanceMonthlyUsd } from '../business_ops';
import { RedTeamAgent } from '../red_team';
import { Finding } from '../protocol';
import { CLEAN_PR, FAKE_AWS_KEY, makePr } from './fixtures';

const cats = (fs: Finding[]) => fs.map((f) => f.category);
const ids = (fs: Finding[]) => fs.map((f) => f.id.split(':')[1]);

describe('RedTeamAgent', () => {
  const agent = new RedTeamAgent();

  it('aprueba un PR limpio', async () => {
    const r = await agent.position(CLEAN_PR());
    expect(r.findings).toHaveLength(0);
    expect(r.vote).toBe('approve');
    expect(r.stance).toBe(0);
  });

  it('detecta una clave AWS como crítica y vota reject', async () => {
    const pr = makePr([{ path: 'src/config.ts', added: [`const key = "${FAKE_AWS_KEY}";`] }]);
    const r = await agent.position(pr);
    const f = r.findings.find((x) => x.id.includes('aws-key'))!;
    expect(f.severity).toBe('critical');
    expect(f.evidence[0]).toMatchObject({ file: 'src/config.ts', line: 1, side: 'added' });
    expect(r.vote).toBe('reject');
  });

  it('no marca referencias a variables de entorno como credenciales', async () => {
    const pr = makePr([{ path: 'src/a.ts', added: ['const password = process.env.DB_PASSWORD_VALUE_X;', 'const password2 = "<your-password-here>";'] }]);
    expect((await agent.position(pr)).findings).toHaveLength(0);
  });

  it('detecta SQL por concatenación, eval, TLS off, 0.0.0.0/0 y deserialización', async () => {
    const pr = makePr([
      { path: 'src/db.ts', added: ['const q = `SELECT * FROM users WHERE id = ${req.params.id}`;', 'eval(userInput);', 'const agent = { rejectUnauthorized: false };'] },
      { path: 'infra/sg.tf', added: ['  cidr_blocks = ["0.0.0.0/0"]'] },
      { path: 'svc/load.py', added: ['data = pickle.loads(blob)'] },
    ]);
    const r = await agent.position(pr);
    expect(ids(r.findings).sort()).toEqual(['eval', 'open-ingress', 'sql-concat', 'tls-verify-off', 'unsafe-deserialization'].sort());
    expect(r.vote).toBe('reject');
  });

  it('SQL parametrizado no dispara el hallazgo', async () => {
    const pr = makePr([{ path: 'src/db.ts', added: ["db.query('SELECT * FROM users WHERE id = $1', [id]);"] }]);
    expect((await agent.position(pr)).findings).toHaveLength(0);
  });

  it('reduce la confianza en ficheros de test', async () => {
    const pr = makePr([{ path: 'tests/a.test.ts', added: ['eval("1+1");'] }]);
    const f = (await agent.position(pr)).findings[0];
    expect(f.confidence).toBeLessThan(0.5);
    expect(f.description).toMatch(/test/);
  });

  it('ignora comentarios', async () => {
    const pr = makePr([{ path: 'src/a.ts', added: ['// eval(x) was removed'] }]);
    expect((await agent.position(pr)).findings).toHaveLength(0);
  });
});

describe('ArchitectAgent', () => {
  const agent = new ArchitectAgent();

  const longFn = (n: number) => ['export function big(x: number) {', ...Array.from({ length: n }, (_, i) => `  const v${i} = x + ${i};`), '  return x;', '}'];

  it('aprueba un PR limpio con tests', async () => {
    const r = await agent.position(CLEAN_PR());
    expect(r.findings).toHaveLength(0);
    expect(r.vote).toBe('approve');
  });

  it('detecta función larga y falta de tests', async () => {
    const pr = makePr([{ path: 'src/big.ts', isNew: true, added: longFn(80) }]);
    const r = await agent.position(pr);
    expect(ids(r.findings)).toEqual(expect.arrayContaining(['long-function', 'no-tests']));
    const lf = r.findings.find((f) => f.id.includes('long-function'))!;
    expect(lf.title).toMatch(/big/);
    expect(lf.severity).toBe('medium');
  });

  it('función muy larga es high', async () => {
    const r = await agent.position(makePr([{ path: 'src/big.ts', isNew: true, added: longFn(170) }, { path: 'src/big.test.ts', added: ['x'] }]));
    expect(r.findings.find((f) => f.id.includes('long-function'))!.severity).toBe('high');
  });

  it('detecta complejidad ciclomática alta', async () => {
    const body = Array.from({ length: 16 }, (_, i) => `  if (x === ${i}) { return ${i}; }`);
    const pr = makePr([
      { path: 'src/c.ts', isNew: true, added: ['export function pick(x: number) {', ...body, '  return -1;', '}'] },
      { path: 'src/c.test.ts', added: ['t'] },
    ]);
    expect(ids((await agent.position(pr)).findings)).toContain('complexity');
  });

  it('detecta funciones largas en Python por indentación', async () => {
    const lines = ['def process(items):', ...Array.from({ length: 70 }, (_, i) => `    x${i} = ${i}`), '', 'def other():', '    pass'];
    const pr = makePr([{ path: 'app/p.py', isNew: true, added: lines }, { path: 'tests/test_p.py', added: ['x'] }]);
    const f = (await agent.position(pr)).findings.find((x) => x.id.includes('long-function'))!;
    expect(f.title).toMatch(/process/);
  });

  it('detecta dominio acoplado a infraestructura (DIP)', async () => {
    const pr = makePr([
      { path: 'src/domain/order.ts', added: ["import { Pool } from 'pg';"] },
      { path: 'src/domain/order.test.ts', added: ['x'] },
    ]);
    const r = await agent.position(pr);
    expect(cats(r.findings)).toContain('layering');
  });

  it('detecta código duplicado entre ficheros', async () => {
    const block = ['const total = items.reduce((a, b) => a + b.price, 0);', 'const tax = total * 0.21;', 'const fee = total > 100 ? 0 : 5;', 'const grand = total + tax + fee;', 'logger.info("grand total computed", grand);', 'return { total, tax, fee, grand };'];
    const pr = makePr([
      { path: 'src/a.ts', isNew: true, added: block },
      { path: 'src/b.ts', isNew: true, added: block },
      { path: 'src/a.test.ts', added: ['t'] },
    ]);
    const r = await agent.position(pr);
    expect(ids(r.findings)).toContain('duplication');
  });

  it('detecta eliminación de API pública pero no si se redeclara', async () => {
    const gone = makePr([{ path: 'src/api.ts', removed: ['export function legacy() {}'], added: [] }, { path: 'src/api.test.ts', added: ['t'] }]);
    expect(ids((await agent.position(gone)).findings)).toContain('api-removal');
    const kept = makePr([{ path: 'src/api.ts', removed: ['export function legacy() {}'], added: ['export function legacy(x?: number) {}'] }, { path: 'src/api.test.ts', added: ['t'] }]);
    expect(ids((await agent.position(kept)).findings)).not.toContain('api-removal');
  });

  it('agrega TODOs y supresiones sólo por encima del umbral', async () => {
    const few = makePr([{ path: 'src/a.ts', added: ['// TODO a', '// TODO b'] }, { path: 'src/a.test.ts', added: ['t'] }]);
    expect((await agent.position(few)).findings).toHaveLength(0);
    const many = makePr([{ path: 'src/a.ts', added: ['// TODO a', '// FIXME b', '// HACK c', '// @ts-ignore', '// eslint-disable-next-line', '// @ts-nocheck'] }, { path: 'src/a.test.ts', added: ['t'] }]);
    const r = await agent.position(many);
    expect(ids(r.findings)).toEqual(expect.arrayContaining(['debt-markers', 'suppression']));
  });

  it('PR enorme se marca a nivel de PR y no supera severidad medium', async () => {
    const pr = makePr([{ path: 'data/blob.json', isNew: true, added: Array.from({ length: 1600 }, (_, i) => `"k${i}": ${i},`) }]);
    const f = (await agent.position(pr)).findings.find((x) => x.id.includes('oversized-pr'))!;
    expect(f.scope).toBe('pr');
    expect(f.evidence).toEqual([]);
  });
});

describe('BusinessOpsAgent', () => {
  const agent = new BusinessOpsAgent({ monthlyBudgetUsd: 1000 });

  it('estima precios de instancias', () => {
    expect(instanceMonthlyUsd('m5.large')).toBe(70);
    expect(instanceMonthlyUsd('m5.4xlarge')).toBe(560);
    expect(instanceMonthlyUsd('db.r5.xlarge')).toBe(Math.round(92 * 2 * 1.9));
    expect(instanceMonthlyUsd('weird.type')).toBeNull();
  });

  it('aprueba un PR limpio', async () => {
    expect((await agent.position(CLEAN_PR())).vote).toBe('approve');
  });

  it('calcula el delta de coste entre líneas eliminadas y añadidas', async () => {
    const small = makePr([{ path: 'infra/main.tf', removed: ['  instance_type = "m5.large"'], added: ['  instance_type = "m5.xlarge"'] }]);
    const f = (await agent.position(small)).findings;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ category: 'cost', severity: 'low' });
    expect(f[0].title).toContain('+$70');
  });

  it('ignora deltas por debajo de 1/20 del presupuesto', async () => {
    const tiny = makePr([{ path: 'infra/main.tf', removed: ['  instance_type = "t3.micro"'], added: ['  instance_type = "t3.small"'] }]);
    expect((await agent.position(tiny)).findings).toHaveLength(0);
  });

  it('marca como high un incremento por encima del presupuesto', async () => {
    const pr = makePr([{ path: 'infra/main.tf', removed: ['  instance_type = "m5.large"', '  desired_capacity = 2'], added: ['  instance_type = "m5.4xlarge"', '  desired_capacity = 6'] }]);
    const r = await agent.position(pr);
    const f = r.findings.find((x) => x.category === 'cost')!;
    expect(f.severity).toBe('high');
    expect(f.title).toMatch(/\+\$/);
    // 6*560 - 2*70 = 3220
    expect(f.title).toContain('3220');
  });

  it('un recorte de coste no genera hallazgo', async () => {
    const pr = makePr([{ path: 'infra/main.tf', removed: ['  instance_type = "m5.4xlarge"'], added: ['  instance_type = "m5.large"'] }]);
    expect((await agent.position(pr)).findings).toHaveLength(0);
  });

  it('detecta migraciones destructivas e índices bloqueantes', async () => {
    const pr = makePr([{ path: 'db/migrations/002.sql', isNew: true, added: ['DROP TABLE legacy_orders;', 'CREATE INDEX idx_o ON orders(created_at);', 'ALTER TABLE orders ADD COLUMN flag boolean NOT NULL;'] }]);
    const r = await agent.position(pr);
    expect(ids(r.findings).sort()).toEqual(['destructive-sql', 'index-blocking', 'not-null-no-default']);
    expect(r.findings.find((f) => f.id.includes('destructive-sql'))!.severity).toBe('high');
  });

  it('CREATE INDEX CONCURRENTLY es aceptable', async () => {
    const pr = makePr([{ path: 'db/migrations/003.sql', isNew: true, added: ['CREATE INDEX CONCURRENTLY idx_o ON orders(created_at);'] }]);
    expect((await agent.position(pr)).findings).toHaveLength(0);
  });

  it('detecta eliminación de probes y tag latest', async () => {
    const pr = makePr([{ path: 'k8s/prod/deploy.yaml', removed: ['        readinessProbe:'], added: ['        image: acme/api:latest'] }]);
    expect(ids((await agent.position(pr)).findings).sort()).toEqual(['image-latest', 'probe-removed']);
  });

  it('el probe movido (eliminado y añadido) no se marca', async () => {
    const pr = makePr([{ path: 'k8s/deploy.yaml', removed: ['  readinessProbe:'], added: ['  readinessProbe:'] }]);
    expect((await agent.position(pr)).findings).toHaveLength(0);
  });
});

describe('protocolo de debate por agente', () => {
  const pr = makePr([{ path: 'src/a.ts', added: ['eval(x);'] }]);

  it('critique: contesta hallazgos de baja confianza y corrobora los graves con impacto cruzado', async () => {
    const red = new RedTeamAgent();
    const biz = new BusinessOpsAgent();
    const redReview = await red.position(pr);
    const lowConf = { ...redReview.findings[0], id: 'red_team:low', confidence: 0.3, severity: 'medium' as const };
    const peers = [{ ...redReview, findings: [...redReview.findings, lowConf] }];
    const rebuttals = await biz.critique(pr, peers);
    expect(rebuttals.find((r) => r.findingId === 'red_team:low')!.stance).toBe('contest');
    expect(rebuttals.find((r) => r.findingId === redReview.findings[0].id)!.stance).toBe('corroborate');
  });

  it('revise: rebaja/retira hallazgos contestados y no toca los firmes', async () => {
    const red = new RedTeamAgent();
    const base = await red.position(pr);
    const weak: Finding = { ...base.findings[0], id: 'red_team:weak', confidence: 0.3, severity: 'medium' };
    const prev = [{ ...base, findings: [...base.findings, weak] }];
    const incoming = [
      { from: 'architect' as const, to: 'red_team' as const, findingId: 'red_team:weak', stance: 'contest' as const, argument: 'x' },
      { from: 'architect' as const, to: 'red_team' as const, findingId: base.findings[0].id, stance: 'contest' as const, argument: 'x' },
    ];
    const rev = await red.revise(pr, 2, prev, incoming, []);
    expect(rev.findings.find((f) => f.id === 'red_team:weak')!.severity).toBe('low');
    expect(rev.defenses.find((d) => d.findingId === base.findings[0].id)!.decision).toBe('maintain');
    // segunda ronda: low → info → retirado
    const rev2 = await red.revise(pr, 3, [rev], incoming, []);
    expect(rev2.withdrawnFindingIds).toContain('red_team:weak');
  });

  it('revise: la corroboración genera un hallazgo derivado acotado a medium', async () => {
    const red = new RedTeamAgent();
    const biz = new BusinessOpsAgent();
    const redReview = await red.position(pr);
    const bizReview = await biz.position(pr);
    const outgoing = await biz.critique(pr, [redReview, bizReview]);
    const rev = await biz.revise(pr, 2, [redReview, bizReview], [], outgoing);
    const x = rev.findings.find((f) => f.id.startsWith('xref:'))!;
    expect(x).toBeDefined();
    expect(['low', 'medium']).toContain(x.severity);
    expect(rev.stance).toBeGreaterThan(bizReview.stance);
  });
});

describe('RedTeamAgent — CI/CD y cadena de suministro', () => {
  const agent = new RedTeamAgent();
  const wf = '.github/workflows/ci.yml';

  it('detecta pull_request_target, inyección de script y acciones sin fijar', async () => {
    const pr = makePr([{ path: wf, isNew: true, added: ['on:', '  pull_request_target:', 'jobs:', '  b:', '    steps:', '      - uses: some-org/action@main', '      - run: echo "${{ github.event.pull_request.title }}"'] }]);
    expect(ids((await agent.position(pr)).findings).sort()).toEqual(['ci-pr-target', 'ci-script-injection', 'ci-unpinned-action']);
  });

  it('no marca el patrón seguro (valor vía env) ni acciones fijadas por SHA o versión', async () => {
    const pr = makePr([{ path: wf, isNew: true, added: ['on: pull_request', '    steps:', `      - uses: actions/checkout@${'a'.repeat(40)}`, '      - uses: actions/setup-node@v4', '        env:', '          TITLE: ${{ github.event.pull_request.title }}', '      - run: echo "$TITLE"'] }]);
    expect((await agent.position(pr)).findings).toHaveLength(0);
  });

  it('detecta curl | sh y ADD remoto', async () => {
    const pr = makePr([{ path: 'Dockerfile', isNew: true, added: ['FROM node:22', 'RUN curl -fsSL https://x.sh/install | sudo bash', 'ADD https://example.com/app.tar.gz /opt/'] }]);
    expect(ids((await agent.position(pr)).findings).sort()).toEqual(['docker-add-remote', 'pipe-to-shell']);
  });
});
