// Evidência ESTÁTICA (02C.7P-A, sem rede) de que o executor da C2 password (integration/scripts/oryn-c2.lib.ps1)
// espera exatamente os testes, os motivos de recusa e as variáveis que o harness e o portão definem. Lê o
// código-fonte dos dois lados; não executa nada remoto.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { remoteGate } from './remote/remote-env.ts';

const source = readFileSync(new URL('./remote/integration.remote.test.ts', import.meta.url), 'utf8');
const lib = readFileSync(new URL('../integration/scripts/oryn-c2.lib.ps1', import.meta.url), 'utf8');
const c2 = source.slice(source.indexOf('// --- C2'), source.indexOf("describe('Supabase real — fora do harness"));

/** Testes do bloco C2: nome e corpo (até o próximo `rit(`). */
const tests = [...c2.matchAll(/rit\(\s*'([^']+)'/g)].map((m, i, all) => ({
  name: m[1]!,
  body: c2.slice(m.index, all[i + 1]?.index ?? c2.length),
}));
/** Especificação do executor: Id, Kind e Expected. */
const spec = [...lib.matchAll(/Id = '([^']+)'; Kind = '(\w+)'; Expected = @\(([^)]*)\)/g)].map((m) => ({
  id: m[1]!,
  kind: m[2]!,
  expected: [...m[3]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!),
}));
const psString = (name: string) => new RegExp(`\\$script:${name} = '([^']+)'`).exec(lib)?.[1];
const testOf = (id: string) => tests.filter((t) => t.name.startsWith(`${id} `) || t.name.startsWith(`${id}:`));

/** Recusas que o corpo faz: chamadas de expectRefused, e o laço do S7 conta cada variação. */
function refusals(body: string): string[] {
  const calls = [...body.matchAll(/expectRefused\([\s\S]*?\);/g)].map((m) => (/'private-only'\)/.test(m[0]) ? 'private-only' : 'authorization'));
  if (/for \(const \[label, topic\] of Object\.entries\(variants\)\)/.test(body)) {
    const variants = body.slice(body.indexOf('const variants = {'), body.indexOf('};', body.indexOf('const variants = {')));
    const n = [...variants.matchAll(/^\s*'[^']+': /gm)].length;
    return Array(n).fill(calls[0]);
  }
  return calls;
}

describe('executor da C2 password × harness (02C.7P-A)', () => {
  it('o bloco C2 tem 17 testes e a especificação do executor tem os mesmos 17, um a um', () => {
    expect(tests).toHaveLength(17);
    expect(spec).toHaveLength(17);
    for (const s of spec) expect(testOf(s.id).map((t) => t.name), s.id).toHaveLength(1);
  });

  it('o tipo de cada teste bate com o corpo: recusa (expectRefused), Presence, pulado (#15) ou positivo', () => {
    for (const s of spec) {
      const body = testOf(s.id)[0]!.body;
      const kind = /ctx\.skip\(/.test(body) ? 'skip' : /presence: true/.test(body) ? 'presence' : /expectRefused\(/.test(body) ? 'refusal' : 'positive';
      expect(kind, s.id).toBe(s.kind);
    }
  });

  it('cada teste de recusa: mesmo número de recusas e o mesmo motivo, na mesma ordem (PrivateOnly só no #7/S5)', () => {
    for (const s of spec.filter((x) => x.kind === 'refusal')) expect(refusals(testOf(s.id)[0]!.body), s.id).toEqual(s.expected);
    expect(spec.filter((s) => s.expected.includes('private-only')).map((s) => s.id)).toEqual(['#7/S5']);
    expect(tests.filter((t) => /'private-only'/.test(t.body)).map((t) => t.name.split(' ')[0])).toEqual(['#7/S5']);
  });

  it('S8/P5: o executor espera as anotações observador e rastreador, e o harness só aceita recusa por autorização', () => {
    const body = testOf('S8/P5')[0]!.body;
    expect(spec.find((s) => s.id === 'S8/P5')!.expected).toEqual(['observador', 'rastreador']);
    expect(body).toMatch(/\[\['observador', observer\], \['rastreador', tracker\]\]/);
    expect(body).toMatch(/expect\(sub\.outcome, `\$\{label\}: motivo da recusa`\)\.toBe\('authorization'\)/);
  });

  it('#15: a nota de pulo do executor é exatamente a do harness, e só pula fora do modo signup', () => {
    const note = psString('C2SkipNote');
    expect(note).toBe('modo password: sem cadastro de identidades novas');
    expect(testOf('#15 HTTP')[0]!.body).toContain(`ctx.skip(!signsUp, '${note}')`);
  });

  it('bloco e filtro (-t) do executor pegam só o describe da C2', () => {
    const block = psString('C2Block')!;
    const filter = psString('C2Filter')!;
    expect(c2).toContain(`describe.skipIf(!hasRoomSetup)('${block}`);
    expect(block).toContain(filter);
    const describes = [...source.matchAll(/describe(?:\.skipIf\([^)]*\))?\('([^']+)'/g)].map((m) => m[1]!);
    expect(describes.filter((d) => d.includes(filter))).toEqual([expect.stringContaining(block)]);
  });

  it('o conjunto de variáveis do executor é aceito pelo portão como C2 password; tirar qualquer uma recusa', () => {
    const names = [...lib.slice(lib.indexOf('$script:C2EnvNames = @('), lib.indexOf(')', lib.indexOf('$script:C2EnvNames = @('))).matchAll(/'(ORYN_[A-Z_]+)'/g)].map((m) => m[1]!);
    expect(names).toHaveLength(14);
    const ref = 'abcdefghijklmnopqrst';
    const value: Record<string, string> = {
      ORYN_REMOTE: '1', ORYN_REMOTE_REF: ref, ORYN_SUPABASE_URL: `https://${ref}.supabase.co`, ORYN_PUBLISHABLE_KEY: 'sb_publishable_x',
      ORYN_IT_PHASE: 'C2', ORYN_IT_IDENTITY: 'password', ORYN_IT_PARTITIONS_CONFIRMED: '1', ORYN_IT_CREATOR_INVITE: 'A'.repeat(43),
      ORYN_IT_USER_OWNER_EMAIL: 'o@t.example', ORYN_IT_USER_MEMBER_EMAIL: 'm@t.example', ORYN_IT_USER_STRANGER_EMAIL: 's@t.example',
      ORYN_IT_USER_OWNER_PASSWORD: 'p1', ORYN_IT_USER_MEMBER_PASSWORD: 'p2', ORYN_IT_USER_STRANGER_PASSWORD: 'p3',
    };
    expect(Object.keys(value).sort()).toEqual([...names].sort());
    expect(remoteGate(value)).toMatchObject({ enabled: true, env: { phase: 'C2', identityMode: 'password', identityBudget: 0, loginBudget: 3, partitionsConfirmed: true } });
    for (const n of names.filter((x) => x !== 'ORYN_REMOTE')) {
      const { [n]: _drop, ...rest } = value;
      expect(() => remoteGate(rest), n).toThrow();
    }
  });
});

// 02C.7P-C: o runbook descreve o MESMO executor (ordem das entradas, evidências) e cobre a recuperação (M1–M3).
describe('runbook §12.3/§12.4 × executor da C2 password (02C.7P-C)', () => {
  const runbook = readFileSync(new URL('../integration/RUNBOOK-02C.1B.md', import.meta.url), 'utf8');
  const executor = readFileSync(new URL('../integration/scripts/oryn-c2.ps1', import.meta.url), 'utf8');
  const s123 = runbook.slice(runbook.indexOf('### 12.3'), runbook.indexOf('### 12.4'));
  const s124 = runbook.slice(runbook.indexOf('### 12.4'));
  const inOrder = (text: string, keys: string[]) => keys.map((k) => text.indexOf(k));

  it('B4: a ordem das entradas no runbook é a ordem dos prompts do executor', () => {
    const prompts = ['C2-PASSWORD para confirmar', 'data UTC da partição', 'ref do projeto', 'chave publicável (sb_', 'e-mail $role', 'senha $role', 'convite de criador (uso', 'emitido_em do convite'];
    const at = inOrder(executor, prompts);
    expect(at.every((i) => i > 0), prompts.join(' | ')).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const list = s123.slice(s123.indexOf('pede, nesta ordem'), s123.indexOf('- valida tudo'));
    const doc = inOrder(list, ['`C2-PASSWORD`', 'data UTC do D0', 'o ref', 'chave publicável', 'o e-mail', 'a senha', 'convite de criador', '`emitido_em`']);
    expect(doc.every((i) => i > 0)).toBe(true);
    expect([...doc].sort((a, b) => a - b)).toEqual(doc);
  });

  it('M1/M2: bruto com nome de não compartilhar, interrupção sem resultado=, recuperação offline, T1 ausente e pacote só com a lista', () => {
    for (const s of ['c2pw.BRUTO-NAO-COMPARTILHAR.txt', 'não são garantidos', 'sem** `resultado=`', 'Invoke-C2Recovery', 'fim_utc_estimado', 'T0 + 29 min',
      'Get-C2ShareableEvidence', 'Nunca compactar ou copiar a pasta', 'node.exe']) expect(s123, s).toContain(s);
    expect(s124).toContain('não garante eliminação forense');
    expect(s124).toMatch(/\*\*senha:\*\* trocar/);
    expect(s123 + s124).not.toMatch(/quarentena/i); // na C2 o bruto sensível não é preservado (a C0 mantém o seu)
  });

  it('M3: recuperação de sessões — interrupção antes do afterAll, falha do signOut, Auth e sala, conferência pelo 12, autorização separada, nada automático', () => {
    const m3 = s124.slice(s124.indexOf('**Recuperação de sessões (M3).**'), s124.indexOf('- **Uma execução por autorização.**'));
    for (const s of ['antes do `afterAll`', 'falha do `signOut`', 'sessões de Auth ainda válidas', 'sessões de sala não encerradas', 'INFO sessões de Auth ativas por conta',
      'autorização administrativa SEPARADA', 'não** revoga nada automaticamente', 'delete from auth.sessions', 'A7 e D4 PASS']) expect(m3, s).toContain(s);
    expect(executor).not.toMatch(/auth\.sessions|signOut|admin_issue_creator_invite/); // o executor não revoga nem emite nada
  });

  it('B2, B8, B9 e B11 registrados como riscos residuais', () => {
    const residual = s124.slice(s124.indexOf('**Riscos residuais aceitos'));
    for (const id of ['**B2:**', '**B8:**', '**B9:**', '**B11:**']) expect(residual, id).toContain(id);
  });
});
