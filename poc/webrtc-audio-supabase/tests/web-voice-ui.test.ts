// Painel de voz, barra da chamada e diagnóstico: textos a partir de estados reais e posição estável do áudio remoto.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderMembers, renderParticipants } from '../src/web/members-view.ts';
import { micLabel, otherRoomNote, voiceSummary } from '../src/web/voice-view.ts';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const html = read('index.html');
const main = read('src/web/main.ts');

/** Trecho do HTML de um elemento até o fechamento dele, contando aberturas da mesma tag. */
function element(id: string): string {
  const match = new RegExp(`<([a-z0-9]+)\\b[^>]*\\sid="${id}"`).exec(html);
  if (!match) throw new Error(`#${id} ausente`);
  const tag = match[1]!;
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
  re.lastIndex = match.index;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(match.index, m.index + m[0].length);
  }
  throw new Error(`#${id} sem fechamento`);
}

describe('áudio remoto', () => {
  it('o contêiner fica fora do diagnóstico, do status, da conta e de todo painel recolhível', () => {
    for (const parent of ['diagnostics', 'status', 'account', 'call-panel', 'call-bar', 'shell-main']) {
      expect(element(parent), parent).not.toContain('id="audio-container"');
    }
    expect(element('app')).toContain('id="audio-container"');
  });

  it('o contêiner é filho direto de <main>, logo depois do aviso da página', () => {
    expect(html).toMatch(/<p id="error"[^>]*><\/p>\s*(?:<!--[^]*?-->\s*)?<div id="audio-container" hidden><\/div>\s*<\/main>/);
  });

  it('nenhuma renderização de tela mexe nos elementos de áudio: só setRemote', () => {
    const uses = main.split('\n').filter((line) => /ui\.audioContainer|remoteAudio\.(set|delete)/.test(line));
    expect(uses).toHaveLength(3);
    const setRemote = /function setRemote[^]*?\n}\n/.exec(main)![0];
    for (const line of uses) expect(setRemote).toContain(line.trim());
  });
});

describe('barra da chamada', () => {
  const bar = element('call-bar');

  it('começa oculta, com sala, estado e os três controles existentes', () => {
    expect(bar).toMatch(/^<section id="call-bar"[^>]*\shidden/);
    expect(bar).toMatch(/aria-label="Chamada em curso"/);
    for (const id of ['call-room', 'call-phase', 'call-mic', 'mute-btn', 'leave-btn', 'listen-btn']) expect(bar).toContain(`id="${id}"`);
    expect(bar).toMatch(/id="call-phase" role="status"/);
    expect(bar).toMatch(/<button id="listen-btn" class="round-btn" type="button" hidden>Ouvir<\/button>/);
  });

  it('só ganhou o botão Sons, que abre o painel existente: nenhuma função de áudio nova', () => {
    // Os 4 controles que funcionam e, ao lado deles, os 2 futuros, que são só apresentação (aria-disabled, sem id).
    expect(bar.match(/<button\b/g)).toHaveLength(6);
    expect(bar.match(/<button\b(?![^>]*aria-disabled="true")/g)).toHaveLength(4);
    expect(bar.match(/<button class="future-btn[^"]*" type="button" aria-disabled="true"/g)).toHaveLength(2);
    expect(bar).toMatch(/<button id="sound-toggle-btn" type="button" aria-expanded="false" aria-controls="soundboard" hidden>Sons<\/button>/);
    expect(html).not.toMatch(/deafen|ensurdecer|enumerateDevices|setSinkId/i);
    expect(main).not.toMatch(/enumerateDevices|setSinkId/);
  });

  it('a visibilidade segue a chamada, não a sala selecionada', () => {
    const render = /function renderVoice[^]*?\n}\n/.exec(main)![0];
    expect(render).toContain('ui.callBar.hidden = !callActive');
    expect(render).not.toMatch(/ui\.callBar\.hidden[^\n]*selected/i);
  });

  it('não abre nem encerra chamada ao navegar', () => {
    const shell = read('src/web/shell.ts');
    expect(shell).not.toMatch(/startCall|endCall|beginCall/);
    const navigate = /function navigate[^]*?\n}\n/.exec(main)![0];
    expect(navigate).not.toMatch(/startCall|endCall|beginCall|setMuted/);
  });
});

describe('diagnóstico', () => {
  it('fechado por padrão e com os mesmos dados dentro', () => {
    const box = element('diagnostics');
    expect(box).toMatch(/^<details id="diagnostics">/);
    for (const field of ['phase', 'mic', 'peer', 'ice', 'path', 'codec', 'rate', 'quality']) expect(box).toContain(`data-field="${field}"`);
    for (const id of ['status', 'log', 'room', 'join-btn']) expect(box).toContain(`id="${id}"`);
  });

  it('o aviso de erro fica fora dele', () => {
    expect(element('diagnostics')).not.toContain('id="error"');
    expect(element('account')).not.toContain('id="error"');
  });
});

describe('textos a partir dos estados reais', () => {
  it('chamada ativa: a sala e a fase, sem inventar estado', () => {
    expect(voiceSummary({ active: true, phase: 'conectada', room: 'Sala A' })).toEqual({ title: 'Chamada em Sala A', state: 'Conectada' });
    expect(voiceSummary({ active: true, phase: 'pedindo o microfone', room: 'Sala A' }).state).toBe('Pedindo o microfone');
  });

  it.each([
    ['—', /Nenhuma chamada em curso/],
    ['parada', /Nenhuma chamada em curso/],
    ['encerrada', /^Chamada encerrada\.$/],
    ['falhou', /^A chamada falhou\.$/],
    ['verificando o motivo', /^Verificando o motivo/],
  ])('sem chamada, fase %s', (phase, expected) => {
    const out = voiceSummary({ active: false, phase, room: 'Sala A' });
    expect(out.title).toBe('Chamada');
    expect(out.state).toMatch(expected);
  });

  it('microfone: só o que a captura informa', () => {
    expect(micLabel('capturando')).toBe('Microfone ligado');
    expect(micLabel('capturando (mutado)')).toBe('Microfone desligado');
    expect(micLabel('liberado')).toBe('');
    expect(micLabel('—')).toBe('');
  });

  it('a nota de outra sala distingue seleção e chamada', () => {
    expect(otherRoomNote(true, 'b', 'a', 'Sala A')).toContain('A chamada continua em Sala A');
    expect(otherRoomNote(true, 'a', 'a', 'Sala A')).toBeNull();
    expect(otherRoomNote(true, null, 'a', 'Sala A')).toBeNull();
    expect(otherRoomNote(false, 'b', 'a', 'Sala A')).toBeNull();
  });
});

describe('participantes', () => {
  const nodes: { attrs: Record<string, string>; text: string; children: unknown[] }[] = [];
  const doc = {
    createElement: () => {
      const node = {
        attrs: {} as Record<string, string>,
        text: '',
        children: [] as unknown[],
        className: '',
        set textContent(v: string) {
          this.text = v;
        },
        get textContent(): string {
          return this.text;
        },
        append(...c: unknown[]) {
          this.children.push(...c);
        },
        setAttribute(k: string, v: string) {
          this.attrs[k] = v;
        },
      };
      nodes.push(node);
      return node as unknown as HTMLElement;
    },
  };

  it('mantém nome e estado em texto, e a inicial só como atributo', () => {
    renderParticipants(doc, [{ session: 's', displayName: 'Bia Souza', state: 'failed' }] as never, false);
    const item = nodes.find((n) => n.attrs['data-initial']);
    expect(item?.attrs).toEqual({ 'data-initial': 'BS', 'data-state': 'failed' });
    expect(nodes.map((n) => n.text).join('|')).toContain('Bia Souza');
    expect(nodes.map((n) => n.text).join('|')).toContain('sem conexão');
    expect(nodes.map((n) => n.text).join('|')).not.toContain('BS');
  });
});

describe('painéis', () => {
  it('publicar som fica recolhido dentro do formulário, que segue escondido para quem não é dono', () => {
    const form = element('sound-form');
    expect(form).toMatch(/^<form id="sound-form"[^>]*\shidden>\s*<details>\s*<summary>Publicar som<\/summary>/);
    for (const id of ['sound-name', 'sound-file', 'sound-publish-btn']) expect(form).toContain(`id="${id}"`);
  });

  it('os controles de volume e desativação ficam fora do recolhido, para qualquer membro', () => {
    const board = element('soundboard');
    expect(element('sound-form')).not.toContain('id="sound-volume"');
    for (const id of ['sound-volume', 'sound-disabled']) expect(board).toContain(`id="${id}"`);
  });

  it('sons: painel flutuante fora do painel de voz e da área central, logo depois da barra da chamada', () => {
    expect(element('call-panel')).not.toContain('id="soundboard"');
    expect(element('shell-main')).not.toContain('id="soundboard"');
    expect(html.indexOf('id="soundboard"')).toBeGreaterThan(html.indexOf('id="sound-toggle-btn"'));
    expect(element('soundboard')).toMatch(/^<section id="soundboard" class="sound-popover" aria-labelledby="soundboard-title" hidden>/);
    expect(element('soundboard').indexOf('id="sound-close-btn"')).toBeLessThan(element('soundboard').indexOf('id="soundboard-list"'));
  });

  it('sons: o botão só existe com o soundboard da chamada, e abrir ou fechar é só apresentação', () => {
    const render = /function renderSoundboardPanel[^]*?\n}\n/.exec(main)![0];
    expect(render).toContain("const available = state.status !== 'closed'");
    expect(render).toContain('ui.soundboard.hidden = !available || !soundsOpen');
    expect(render).toContain('ui.soundToggleBtn.hidden = !available');
    expect(render).toContain("setAttribute('aria-expanded', String(available && soundsOpen))");
    const toggle = /function setSoundsOpen[^]*?\n}\n/.exec(main)![0];
    expect(toggle).not.toMatch(/soundboard\.(enter|leave|trigger|publish|remove|setVolume|setDisabled|unlock)/);
  });

  it('fechar vem antes do conteúdo também na ordem do teclado', () => {
    for (const [panel, close, content] of [['chat', 'chat-close-btn', 'chat-messages'], ['members', 'members-close-btn', 'members-list']] as const) {
      const box = element(panel);
      expect(box.indexOf(`id="${close}"`), panel).toBeGreaterThan(-1);
      expect(box.indexOf(`id="${close}"`), panel).toBeLessThan(box.indexOf(`id="${content}"`));
    }
  });

  it('membro tem inicial só como atributo: nome e papel seguem em texto', () => {
    const items: { attrs: Record<string, string>; text: string }[] = [];
    const doc = {
      createElement: () => {
        const node = { attrs: {} as Record<string, string>, text: '', className: '', disabled: false, type: '', set textContent(v: string) { this.text = v; }, get textContent(): string { return this.text; }, append() {}, addEventListener() {}, setAttribute(k: string, v: string) { this.attrs[k] = v; } };
        items.push(node);
        return node as unknown as HTMLElement;
      },
    };
    renderMembers(doc, { status: 'ready', members: [{ member_ref: 'r', display_name: 'Bia Souza', role: 'member', is_self: false, in_call: true }], busy: null } as never, { canManage: true, onRemove() {}, onLeave() {} } as never);
    expect(items.find((n) => n.attrs['data-initial'])?.attrs['data-initial']).toBe('BS');
    expect(items.map((n) => n.text).join('|')).toContain('Bia Souza');
    expect(items.map((n) => n.text).join('|')).toContain('na chamada');
    expect(items.map((n) => n.text).join('|')).not.toContain('BS');
  });
});

describe('ordem da sala e da voz', () => {
  const render = /function renderRooms[^]*?\n}\n/.exec(main)![0];

  it('sala aberta: ações no cabeçalho, antes da voz; visão geral: voz antes da lista', () => {
    expect(render).toMatch(/roomFirst && ui\.roomsBlock\.parentElement !== ui\.contextActions\) ui\.contextActions\.prepend\(ui\.roomsBlock\)/);
    expect(render).toMatch(/!roomFirst && ui\.callPanel\.nextElementSibling !== ui\.roomsBlock\) ui\.callPanel\.after\(ui\.roomsBlock\)/);
    // O cabeçalho vem antes do painel de voz no DOM: a ordem do teclado segue a da tela.
    expect(html.indexOf('id="context-actions"')).toBeGreaterThan(html.indexOf('class="context-header"'));
    expect(html.indexOf('id="context-actions"')).toBeLessThan(html.indexOf('id="call-panel"'));
  });

  it('a troca move no DOM, sem CSS order, e o bloco não contém mídia nem o painel de voz', () => {
    const block = element('rooms-block');
    for (const id of ['rooms', 'rooms-error']) expect(block).toContain(`id="${id}"`);
    for (const id of ['audio-container', 'call-panel', 'call-bar', 'soundboard']) expect(block).not.toContain(`id="${id}"`);
    for (const css of ['shell', 'rooms', 'voice', 'panels']) expect(read(`src/web/styles/${css}.css`), css).not.toMatch(/(^|[\s;{])order\s*:/);
  });
});

describe('estilo', () => {
  it('esconder o título repetido vale só para a lista de salas: participantes e membros usam a mesma classe', () => {
    const rooms = read('src/web/styles/rooms.css');
    expect(rooms).not.toMatch(/main\[data-view='room'\] \.rooms li/);
    expect(rooms).toMatch(/main\[data-view='room'\] #rooms \.rooms li > strong/);
  });
});
