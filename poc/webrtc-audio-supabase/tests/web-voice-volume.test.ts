// Volume individual de cada participante (só neste aparelho): preferências por conta e participant_ref, composição com o
// áudio recebido silenciado, isolamento entre pessoas, reconexão, troca de conta, posição do menu, cartão do palco e
// acessibilidade do menu (mouse, teclado e toque). Sem navegador: elementos de áudio falsos e leitura do código da página.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderParticipants, volumeButtonLabel } from '../src/web/members-view.ts';
import { VoiceMix, placeMenu, type Output } from '../src/web/voice-mix.ts';
import { VOICE_PREF_DEFAULT, VoicePrefs, clampPercent, voicePrefLabel, type PrefStorage } from '../src/web/voice-prefs.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const ACC_A = '0a000000-0000-4000-8000-00000000000a';
const ACC_B = '0b000000-0000-4000-8000-00000000000b';
const REF = (n: number) => String(n).repeat(32).slice(0, 32).replace(/[^0-9a-f]/g, 'a');
const [ANA, BIA, CAIO] = [REF(1), REF(2), REF(3)];

class MemoryStorage implements PrefStorage {
  readonly map = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes += 1;
    this.map.set(key, value);
  }
}
const audio = (): Output => ({ muted: false, volume: 1 });

function mixFor(account: string | null = ACC_A, storage = new MemoryStorage()) {
  const prefs = new VoicePrefs(storage);
  const mix = new VoiceMix<Output>(prefs);
  mix.setAccount(account);
  return { mix, storage };
}

describe('preferências (voice-prefs)', () => {
  it('padrão: 100% e ouvindo, para qualquer pessoa', () => {
    const prefs = new VoicePrefs(new MemoryStorage());
    prefs.setAccount(ACC_A);
    expect(prefs.get(ANA)).toEqual({ volume: 1, muted: false });
    expect(VOICE_PREF_DEFAULT).toEqual({ volume: 1, muted: false });
    expect(voicePrefLabel(prefs.get(ANA))).toBeNull();
  });

  it('volume de 0 a 100%, sem amplificação; valores inválidos viram 100', () => {
    expect([clampPercent(-5), clampPercent(0), clampPercent(40.4), clampPercent(100), clampPercent(250)]).toEqual([0, 0, 40, 100, 100]);
    expect([clampPercent('35'), clampPercent(NaN), clampPercent(''), clampPercent(null), clampPercent(Infinity)]).toEqual([35, 100, 100, 100, 100]);
    const prefs = new VoicePrefs(new MemoryStorage());
    prefs.setAccount(ACC_A);
    expect(prefs.setVolume(ANA, 180).volume).toBe(1);
    expect(prefs.setVolume(ANA, 0).volume).toBe(0);
  });

  it('persiste por conta e por pessoa, e sobrevive a uma página nova (reconexão ou recarga)', () => {
    const storage = new MemoryStorage();
    const first = new VoicePrefs(storage);
    first.setAccount(ACC_A);
    first.setVolume(ANA, 40);
    first.setMuted(BIA, true);
    const reloaded = new VoicePrefs(storage);
    reloaded.setAccount(ACC_A);
    expect(reloaded.get(ANA)).toEqual({ volume: 0.4, muted: false });
    expect(reloaded.get(BIA)).toEqual({ volume: 1, muted: true });
    expect(reloaded.get(CAIO)).toEqual({ volume: 1, muted: false });
    // Outra conta no mesmo aparelho não herda nada.
    reloaded.setAccount(ACC_B);
    expect(reloaded.get(ANA)).toEqual({ volume: 1, muted: false });
    // Sem login: só o padrão, e nada é gravado.
    const before = storage.writes;
    reloaded.setAccount(null);
    reloaded.setVolume(ANA, 10);
    expect(reloaded.get(ANA)).toEqual({ volume: 1, muted: false });
    expect(storage.writes).toBe(before);
  });

  it('guarda só a chave fixa, o id da conta, a referência e dois números; voltar ao padrão apaga a entrada', () => {
    const storage = new MemoryStorage();
    const prefs = new VoicePrefs(storage);
    prefs.setAccount(ACC_A);
    prefs.setVolume(ANA, 55);
    expect([...storage.map.keys()]).toEqual(['oryn.voice.v1']);
    expect(JSON.parse(storage.map.get('oryn.voice.v1')!)).toEqual({ [ACC_A]: { [ANA]: [55, 0] } });
    prefs.setVolume(ANA, 100);
    expect(JSON.parse(storage.map.get('oryn.voice.v1')!)).toEqual({});
  });

  it('conteúdo estranho no armazenamento é descartado, campo a campo; armazenamento indisponível vale o padrão', () => {
    const storage = new MemoryStorage();
    storage.map.set('oryn.voice.v1', JSON.stringify({
      [ACC_A]: { [ANA]: [30, 1], [BIA]: [101, 0], [CAIO]: ['50', 0], nome: [10, 0], [REF(4)]: [20, 0, 'x'] },
      'nao-e-uuid': { [ANA]: [10, 0] },
      access_token: 'segredo',
    }));
    const prefs = new VoicePrefs(storage);
    prefs.setAccount(ACC_A);
    expect(prefs.get(ANA)).toEqual({ volume: 0.3, muted: true });
    expect([prefs.get(BIA), prefs.get(CAIO), prefs.get(REF(4))]).toEqual([{ volume: 1, muted: false }, { volume: 1, muted: false }, { volume: 1, muted: false }]);
    prefs.setVolume(BIA, 20);
    expect(storage.map.get('oryn.voice.v1')).not.toMatch(/segredo|nao-e-uuid|nome/);
    for (const broken of ['{', 'null', '[]', '"x"', '42']) {
      storage.map.set('oryn.voice.v1', broken);
      const p = new VoicePrefs(storage);
      p.setAccount(ACC_A);
      expect(p.get(ANA)).toEqual({ volume: 1, muted: false });
    }
    const failing: PrefStorage = { getItem: () => { throw new Error('bloqueado'); }, setItem: () => { throw new Error('cheio'); } };
    const p = new VoicePrefs(failing);
    p.setAccount(ACC_A);
    expect(p.setVolume(ANA, 30)).toEqual({ volume: 0.3, muted: false }); // vale até fechar a página
    expect(new VoicePrefs(null).get(ANA)).toEqual({ volume: 1, muted: false });
  });

  it('uma aba não desfaz o que outra gravou para outra pessoa', () => {
    const storage = new MemoryStorage();
    const tab1 = new VoicePrefs(storage);
    const tab2 = new VoicePrefs(storage);
    tab1.setAccount(ACC_A);
    tab2.setAccount(ACC_A);
    tab1.setVolume(ANA, 20);
    tab2.setVolume(BIA, 70);
    const fresh = new VoicePrefs(storage);
    fresh.setAccount(ACC_A);
    expect([fresh.get(ANA).volume, fresh.get(BIA).volume]).toEqual([0.2, 0.7]);
  });

  it('o armazenamento é limitado: no máximo 200 pessoas por conta, saindo primeiro as mais antigas', () => {
    const storage = new MemoryStorage();
    const prefs = new VoicePrefs(storage);
    prefs.setAccount(ACC_A);
    const refs = Array.from({ length: 205 }, (_, i) => i.toString(16).padStart(32, '0'));
    for (const r of refs) prefs.setVolume(r, 10);
    const saved = JSON.parse(storage.map.get('oryn.voice.v1')!)[ACC_A] as Record<string, unknown>;
    expect(Object.keys(saved)).toHaveLength(200);
    expect(saved[refs[0]!]).toBeUndefined();
    expect(saved[refs[204]!]).toEqual([10, 0]);
  });
});

describe('saída de áudio (voice-mix): volume individual composto com o áudio recebido silenciado', () => {
  it('cada pessoa no próprio volume; mudar uma não altera as outras', () => {
    const { mix } = mixFor();
    const [a, b, c] = [audio(), audio(), audio()];
    mix.setParticipants([{ session: 's-ana', ref: ANA }, { session: 's-bia', ref: BIA }, { session: 's-caio', ref: CAIO }]);
    mix.attach('s-ana', a);
    mix.attach('s-bia', b);
    mix.attach('s-caio', c);
    mix.setVolume(BIA, 25);
    expect([a.volume, b.volume, c.volume]).toEqual([1, 0.25, 1]);
    mix.setMuted(CAIO, true);
    expect([a.muted, b.muted, c.muted]).toEqual([false, false, true]);
    expect([a.volume, b.volume, c.volume]).toEqual([1, 0.25, 1]);
  });

  it('silenciar individual e silenciar tudo se compõem: restaurar um não desfaz o outro', () => {
    const { mix } = mixFor();
    const [a, b] = [audio(), audio()];
    mix.setParticipants([{ session: 's-ana', ref: ANA }, { session: 's-bia', ref: BIA }]);
    mix.attach('s-ana', a);
    mix.attach('s-bia', b);
    mix.setMuted(ANA, true);
    mix.incoming.set(true, mix.values());
    expect([a.muted, b.muted]).toEqual([true, true]);
    mix.incoming.set(false, mix.values()); // restaurar o áudio geral
    expect([a.muted, b.muted]).toEqual([true, false]); // a Ana continua silenciada para mim
    mix.incoming.set(true, mix.values());
    mix.setMuted(ANA, false); // tirar o silenciamento individual com o geral ligado
    expect([a.muted, b.muted]).toEqual([true, true]);
    mix.incoming.reset(mix.values()); // fim da chamada
    expect([a.muted, b.muted]).toEqual([false, false]);
    // Com a página silenciada, quem entra já chega mudo, mesmo no volume certo.
    mix.incoming.set(true, mix.values());
    mix.setVolume(CAIO, 60);
    mix.setParticipants([{ session: 's-ana', ref: ANA }, { session: 's-bia', ref: BIA }, { session: 's-caio', ref: CAIO }]);
    const c = audio();
    mix.attach('s-caio', c);
    expect(c).toEqual({ muted: true, volume: 0.6 });
  });

  it('reconexão: a sessão nova da mesma pessoa recebe o volume e o silenciamento antes de tocar', () => {
    const { mix } = mixFor();
    mix.setParticipants([{ session: 's1', ref: ANA }]);
    mix.attach('s1', audio());
    mix.setVolume(ANA, 30);
    mix.setMuted(ANA, true);
    expect(mix.detach('s1')).toBeDefined();
    mix.setParticipants([{ session: 's2', ref: ANA }]);
    const again = audio();
    mix.attach('s2', again);
    expect(again).toEqual({ muted: true, volume: 0.3 });
  });

  it('áudio que chega antes da lista toca no padrão e recebe a preferência assim que a lista chega', () => {
    const { mix } = mixFor();
    mix.setVolume(BIA, 45);
    const early = audio();
    mix.attach('s-bia', early);
    expect(early.volume).toBe(1);
    mix.setParticipants([{ session: 's-bia', ref: BIA }]);
    expect(early.volume).toBe(0.45);
  });

  it('a mesma pessoa em duas sessões (outra aba dela) recebe a mesma preferência nas duas', () => {
    const { mix } = mixFor();
    const [x, y] = [audio(), audio()];
    mix.setParticipants([{ session: 's1', ref: ANA }, { session: 's2', ref: ANA }]);
    mix.attach('s1', x);
    mix.attach('s2', y);
    mix.setVolume(ANA, 10);
    expect([x.volume, y.volume]).toEqual([0.1, 0.1]);
  });

  it('troca de conta neste aparelho: as preferências da anterior deixam de valer na hora', () => {
    const { mix } = mixFor(ACC_A);
    const a = audio();
    mix.setParticipants([{ session: 's-ana', ref: ANA }]);
    mix.attach('s-ana', a);
    mix.setVolume(ANA, 20);
    mix.setMuted(ANA, true);
    mix.setAccount(ACC_B);
    expect(a).toEqual({ muted: false, volume: 1 });
    mix.setAccount(ACC_A);
    expect(a).toEqual({ muted: true, volume: 0.2 });
  });

  it('nada aqui toca microfone, conexão ou o que os outros ouvem: só volume e muted do elemento local', () => {
    const code = read('src/web/voice-mix.ts') + read('src/web/voice-prefs.ts');
    expect(code).not.toMatch(/getUserMedia|RTCPeerConnection|track\.enabled|sendTo|replaceTrack|AudioContext|GainNode|createGain/);
  });
});

describe('posição do menu', () => {
  const viewport = { width: 1280, height: 800 };
  const size = { width: 272, height: 220 };
  it('no ponto do clique, quando cabe', () => {
    expect(placeMenu({ x: 300, y: 200 }, size, viewport)).toEqual({ left: 300, top: 200 });
  });
  it('perto da borda direita ou de baixo: dentro da janela, abrindo para cima', () => {
    expect(placeMenu({ x: 1270, y: 700 }, size, viewport)).toEqual({ left: 1280 - 272 - 8, top: 700 - 220 });
    expect(placeMenu({ x: -20, y: -5 }, size, viewport)).toEqual({ left: 8, top: 8 });
  });
  it('janela menor que o menu: encostado na margem, nunca com posição negativa', () => {
    const p = placeMenu({ x: 100, y: 100 }, size, { width: 200, height: 150 });
    expect(p.left).toBe(8);
    expect(p.top).toBe(8);
  });
});

/** Documento mínimo: só createElement + textContent + atributos, como os outros testes de renderização. */
class El {
  textContent: string | null = null;
  className = '';
  type = '';
  title = '';
  readonly tag: string;
  readonly children: El[] = [];
  readonly attrs = new Map<string, string>();
  constructor(tag: string) {
    this.tag = tag;
  }
  append(...nodes: El[]): void {
    this.children.push(...nodes);
  }
  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  addEventListener(): void {}
  get allText(): string {
    return [this.textContent ?? '', ...this.children.map((c) => c.allText)].join(' ');
  }
  all(): El[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}
const doc = { createElement: (tag: string) => new El(tag) as unknown as HTMLElement };

describe('palco: botão de volume em cada cartão remoto', () => {
  const list = [
    { session: 's-ana', ref: ANA, displayName: 'Ana', state: 'connected' as const },
    { session: 's-bia', ref: BIA, displayName: '<b>Bia</b>', state: 'connected' as const },
    { session: 's-caio', ref: CAIO, displayName: 'Caio', state: 'reconnecting' as const },
    { session: 's-duda', ref: REF(4), displayName: 'Duda', state: 'connected' as const },
  ];
  const prefs = new Map([[BIA, { volume: 0.4, muted: false }], [CAIO, { volume: 1, muted: true }]]);
  const voice = (ref: string) => prefs.get(ref) ?? { volume: 1, muted: false };

  it('cada remoto: botão com nome acessível, ligado à sessão, e o estado em texto fora do padrão', () => {
    const root = renderParticipants(doc, list, false, { owner: true, muted: false, freeSlots: 0, voice }) as unknown as El;
    const buttons = root.all().filter((e) => e.tag === 'button');
    expect(buttons.map((b) => b.attrs.get('aria-label'))).toEqual(['Volume de Ana', 'Volume de <b>Bia</b>', 'Volume de Caio', 'Volume de Duda']);
    expect(buttons.map((b) => b.attrs.get('data-session'))).toEqual(['s-ana', 's-bia', 's-caio', 's-duda']);
    expect(buttons.every((b) => b.type === 'button' && b.attrs.get('aria-haspopup') === 'dialog')).toBe(true);
    const cards = root.all().filter((e) => e.tag === 'li' && e.attrs.has('data-session'));
    expect(cards.map((c) => c.attrs.get('data-voice-muted'))).toEqual(['false', 'false', 'true', 'false']);
    expect(root.allText).toContain('Volume 40%');
    expect(root.allText).toContain('Silenciado para você');
    // O próprio cartão não tem volume: o meu microfone não é regulado aqui.
    const self = root.all().find((e) => e.className === 'participant-self')!;
    expect(self.all().some((e) => e.tag === 'button')).toBe(false);
    // Cinco cartões (você + 4): a grade conta até 6.
    expect(root.all().find((e) => e.tag === 'ul')!.attrs.get('data-count')).toBe('5');
    expect(volumeButtonLabel('Ana')).toBe('Volume de Ana');
  });

  it('em espera (outra aba da conta na chamada) não há áudio recebido: sem botões; fora do palco, também não', () => {
    const waiting = renderParticipants(doc, list, true, { owner: false, muted: false, freeSlots: 0, voice }) as unknown as El;
    expect(waiting.all().some((e) => e.tag === 'button')).toBe(false);
    const plain = renderParticipants(doc, list, false) as unknown as El;
    expect(plain.all().some((e) => e.tag === 'button')).toBe(false);
  });
});

describe('menu de volume na página: mouse, teclado e toque', () => {
  const html = read('index.html');
  const main = read('src/web/main.ts');
  const css = read('src/web/styles/call-controls.css');
  const menu = /<div id="voice-menu"[^]*?\n {8}<\/div>/.exec(html)![0];

  it('é um diálogo nomeado, fora do palco redesenhado, com barra de 0 a 100% e silenciar com estado', () => {
    expect(menu).toMatch(/role="dialog"/);
    expect(menu).toMatch(/aria-labelledby="voice-menu-title"/);
    expect(menu).toMatch(/<input id="voice-menu-volume" type="range" min="0" max="100" step="1" value="100"/);
    expect(menu).toMatch(/<label for="voice-menu-volume">/);
    expect(menu).toMatch(/<output id="voice-menu-value" for="voice-menu-volume">100%<\/output>/);
    expect(menu).toMatch(/id="voice-menu-mute" type="button" aria-pressed="false"/);
    expect(menu).toMatch(/id="voice-menu-close"/);
    expect(menu).toMatch(/hidden>/);
    expect(menu).not.toMatch(/style=/);
    expect(html.indexOf('id="voice-menu"')).toBeGreaterThan(html.indexOf('id="participants"'));
    expect(html.indexOf('id="voice-menu"')).toBeLessThan(html.indexOf('id="rooms-block"'));
  });

  it('clique direito no cartão abre o menu no ponto; a tecla de menu (sem ponteiro) abre junto ao botão', () => {
    expect(main).toMatch(/ui\.participants\.addEventListener\('contextmenu'[^]*?event\.preventDefault\(\);[^]*?openVoiceMenu\(session, event\.clientX === 0 && event\.clientY === 0 \? undefined : \{ x: event\.clientX, y: event\.clientY \}\)/);
  });

  it('o botão do cartão (teclado e toque) abre e fecha; Escape e Fechar devolvem o foco ao botão da mesma pessoa', () => {
    expect(main).toMatch(/ui\.participants\.addEventListener\('click'[^]*?button\.participant-volume[^]*?closeVoiceMenu\(true\)[^]*?openVoiceMenu\(session\)/);
    expect(main).toMatch(/if \(voiceMenu !== null\) return closeVoiceMenu\(true\);/);
    expect(main).toMatch(/ui\.voiceMenuClose\.addEventListener\('click', \(\) => closeVoiceMenu\(true\)\)/);
    const close = /function closeVoiceMenu[^]*?\n}\n/.exec(main)![0];
    expect(close).toMatch(/\(button \?\? ui\.contextTitle\)\.focus\(\)/);
    const open = /function openVoiceMenu[^]*?\n}\n/.exec(main)![0];
    expect(open).toMatch(/ui\.voiceMenuVolume\.focus\(\)/);
    expect(open).toMatch(/aria-expanded', 'true'/);
  });

  it('o redesenho do palco devolve o foco ao botão da mesma pessoa, não à mesma posição', () => {
    const draw = /function drawParticipants[^]*?\n}\n/.exec(main)![0];
    expect(draw).toMatch(/active\.dataset\['session'\]/);
    expect(draw).toMatch(/\(volumeButton\(focused\) \?\? ui\.contextTitle\)\.focus\(\)/);
  });

  it('o estado vai em texto: porcentagem, aria-valuetext e aria-pressed; quem sai da chamada fecha o menu', () => {
    const render = /function renderVoiceMenu[^]*?\n}\n/.exec(main)![0];
    expect(render).toMatch(/aria-valuetext/);
    expect(render).toMatch(/aria-pressed/);
    expect(render).toMatch(/Silenciar para mim/);
    const sync = /function syncVoiceMenu[^]*?\n}\n/.exec(main)![0];
    expect(sync).toMatch(/find\(\(x\) => x\.ref === ref\)/); // reconexão: segue a pessoa, não a sessão
    expect(sync).toMatch(/closeVoiceMenu\(false\)/);
    expect(main).toMatch(/incoming\.reset\(voiceMix\.values\(\)\);[^\n]*\n\s+closeVoiceMenu\(false\);/);
  });

  it('posição por propriedades CSS (a CSP não aceita estilo em linha) e folha presa embaixo no celular', () => {
    expect(main).toMatch(/style\.setProperty\('--voice-menu-x'/);
    expect(main).not.toMatch(/setAttribute\('style'/);
    expect(css).toMatch(/\.voice-menu \{[^}]*position: fixed;[^}]*top: var\(--voice-menu-y/);
    expect(css).toMatch(/@media \(max-width: 560px\) \{\s*\.voice-menu \{[^}]*bottom:/);
    // Alvo de toque: 40 px no desktop, 44 px no celular.
    expect(css).toMatch(/\.participant-volume \{[^}]*width: 40px;[^}]*min-height: 40px;/);
    expect(css).toMatch(/@media \(max-width: 560px\) \{[^]*\.participant-volume \{\s*width: 44px;\s*min-height: 44px;/);
  });

  it('a conta logada escolhe as preferências; sair da conta volta ao padrão', () => {
    expect(main).toMatch(/selfUserId = session\.user\.id;\n\s+voiceMix\.setAccount\(selfUserId\);/);
    expect(main).toMatch(/selfUserId = null;\n\s+voiceMix\.setAccount\(null\);/);
  });
});
