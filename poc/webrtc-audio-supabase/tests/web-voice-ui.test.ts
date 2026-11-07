// Painel de voz, barra da chamada e diagnóstico: textos a partir de estados reais e posição estável do áudio remoto.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderParticipants } from '../src/web/members-view.ts';
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
    expect(bar).toMatch(/<button id="listen-btn" type="button" hidden>Ouvir<\/button>/);
  });

  it('não ganhou comandos novos', () => {
    expect(bar.match(/<button\b/g)).toHaveLength(3);
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

describe('estilo', () => {
  it('esconder o título repetido vale só para a lista de salas: participantes e membros usam a mesma classe', () => {
    const rooms = read('src/web/styles/rooms.css');
    expect(rooms).not.toMatch(/main\[data-view='room'\] \.rooms li/);
    expect(rooms).toMatch(/main\[data-view='room'\] #rooms \.rooms li > strong/);
  });
});
