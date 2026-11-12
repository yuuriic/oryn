// Central de controles da chamada: áudio recebido silenciado só neste aparelho (transições e quem entra/sai), sons da
// sala em painel flutuante (abrir, fechar, Escape, clique fora, tocar sem fechar, sair da chamada), tela indisponível.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IncomingAudio, incomingLabel, type Mutable } from '../src/web/incoming-audio.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const html = read('index.html');
const main = read('src/web/main.ts');
const css = read('src/web/styles/call-controls.css');
const fn = (name: string): string => new RegExp(`function ${name}[^]*?\n}\n`).exec(main)![0];
const el = (): Mutable => ({ muted: false });

describe('áudio recebido (só neste aparelho)', () => {
  it('silenciar e restaurar todos os participantes atuais', () => {
    const a = el(), b = el();
    const audio = new IncomingAudio();
    expect(audio.toggle([a, b])).toBe(true);
    expect([a.muted, b.muted]).toEqual([true, true]);
    expect(audio.toggle([a, b])).toBe(false);
    expect([a.muted, b.muted]).toEqual([false, false]);
  });

  it('quem entra com o áudio silenciado já chega silenciado; quem sai não muda o estado', () => {
    const a = el();
    const audio = new IncomingAudio();
    audio.set(true, [a]);
    const novo = el();
    audio.adopt(novo);
    expect(novo.muted).toBe(true);
    // Saída: o elemento some do mapa; o estado continua, e o próximo também entra silenciado.
    expect(audio.muted).toBe(true);
    const outro = el();
    audio.adopt(outro);
    expect(outro.muted).toBe(true);
    audio.set(false, [a, novo, outro]);
    const depois = el();
    audio.adopt(depois);
    expect([a.muted, novo.muted, outro.muted, depois.muted]).toEqual([false, false, false, false]);
  });

  it('fim da chamada: volta a ouvir', () => {
    const a = el();
    const audio = new IncomingAudio();
    audio.set(true, [a]);
    audio.reset([a]);
    expect([audio.muted, a.muted]).toEqual([false, false]);
  });

  it('nome do botão diz a ação e acompanha o estado', () => {
    expect(incomingLabel(false)).toBe('Silenciar áudio da chamada');
    expect(incomingLabel(true)).toBe('Ativar áudio da chamada');
  });

  it('na página: não mexe no microfone nem na conexão; novo áudio remoto adota o estado; a chamada encerrada reseta', () => {
    const click = /ui\.incomingBtn\.addEventListener\('click'[^]*?\n\}\);\n/.exec(main)![0];
    expect(click).toContain('incoming.toggle(remoteAudio.values());');
    expect(click).not.toMatch(/setMuted|\.end\(|signaling|setField\('mic'/);
    expect(fn('setRemote')).toMatch(/audio\.srcObject = stream;\n\s*incoming\.adopt\(audio\);/);
    const phase = fn('renderPhase');
    expect(phase).toContain('incoming.reset(remoteAudio.values());');
    expect(phase).toContain('ui.incomingBtn.disabled = !active;');
    expect(fn('renderIncoming')).toContain("ui.incomingBtn.setAttribute('aria-pressed', String(incoming.muted));");
    // Os sons da sala têm caminho e desativação próprios: o controle não toca neles.
    expect(click).not.toMatch(/soundboard|sound/);
  });
});

describe('sons da sala em painel flutuante', () => {
  it('o botão abre e fecha; o X e o Escape fecham devolvendo o foco ao botão', () => {
    expect(main).toContain("ui.soundToggleBtn.addEventListener('click', () => setSoundsOpen(!soundsOpen));");
    expect(main).toContain("ui.soundCloseBtn.addEventListener('click', () => setSoundsOpen(false));");
    expect(main).toContain('if (soundsOpen && !shell.state.drawerOpen) return setSoundsOpen(false);');
    const open = fn('setSoundsOpen');
    expect(open).toContain('if (open) ui.soundCloseBtn.focus();');
    expect(open).toContain('else if (restoreFocus && !ui.soundToggleBtn.disabled) ui.soundToggleBtn.focus();');
  });

  it('clique fora fecha; clique dentro (tocar um som) não fecha', () => {
    const outside = /document\.addEventListener\('pointerdown', \(event\) => \{\n\s*if \(!soundsOpen\) return;[^]*?\n\}\);\n/.exec(main)![0];
    expect(outside).toContain('if (ui.soundboard.contains(target) || ui.soundToggleBtn.contains(target)) return;');
    expect(outside).toContain('setSoundsOpen(false, false);');
  });

  it('sair da chamada (ou a chamada cair) fecha o painel; o volume e a desativação continuam no controlador', () => {
    expect(fn('renderPhase')).toContain('if (soundsOpen) setSoundsOpen(false, false);');
    const render = fn('renderSoundboardPanel');
    expect(render).toContain('if (!available) soundsOpen = false;');
    expect(render).toContain('ui.soundVolume.value = String(Math.round(state.volume * 100));');
    expect(render).toContain('ui.soundDisabled.checked = state.disabled;');
  });

  it('acima da barra, dentro da janela, com rolagem interna; fechado não ocupa a área principal', () => {
    expect(css).toMatch(/\.sound-flyout \{\n\s*position: absolute;\n\s*bottom: calc\(100% \+ var\(--space-3\)\);/);
    expect(css).toMatch(/max-height: calc\(100dvh - var\(--flyout-reserve\) - var\(--space-4\)\);/);
    expect(css).toMatch(/\.sound-flyout-body \{[^}]*overflow-y: auto;/);
    expect(css).toMatch(/width: min\(560px, calc\(100% - var\(--space-4\)\)\);/);
    expect(html.indexOf('id="soundboard"')).toBeGreaterThan(html.indexOf('<section id="call-bar"'));
  });
});

describe('barra responsiva e acessível', () => {
  it('identificação, controles no centro e Sair; no celular, os controles numa linha própria', () => {
    expect(css).toMatch(/\.call-bar \{\n\s*grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\);/);
    expect(css).toMatch(/@media \(max-width: 768px\) \{[^]*?\.call-bar-actions \{\n\s*grid-column: 1 \/ -1;\n\s*grid-row: 2;/);
    expect(css).toContain('padding-bottom: max(var(--space-3), env(safe-area-inset-bottom));');
  });

  it('regressão: controles em grupo centralizado com espaço fixo (sem space-evenly) e a mesma proporção em cada faixa', () => {
    // space-evenly espalhava a sobra da linha (20,4 / 23,2 / 98,8 px) e punha os botões em posições fracionárias.
    const actionRules = [...css.matchAll(/\.call-bar-actions \{([^}]*)\}/g)].map((m) => m[1]!);
    expect(actionRules.length).toBeGreaterThan(1);
    for (const body of actionRules) expect(body).not.toMatch(/space-evenly|space-around|space-between/);
    const mobile = /@media \(max-width: 768px\) \{[^]*?\n\}\n/.exec(css)![0];
    expect(mobile).toMatch(/\.call-bar-actions \{[^}]*justify-content: center;[^}]*gap: var\(--space-4\);/);
    expect(mobile).toMatch(/\.call-bar-actions \.round-btn \{\n\s*flex: none;\n\s*width: 48px;\n\s*height: 48px;/);
    const narrow = /@media \(max-width: 380px\) \{[^]*?\n\}\n/.exec(css)![0];
    expect(narrow).toMatch(/\.call-bar-actions \{\n\s*gap: var\(--space-3\);/);
    expect(narrow).toMatch(/width: 44px;\n\s*height: 44px;/);
  });

  it('regressão: a identificação encolhe e trunca, sem passar por baixo dos controles nem do Sair', () => {
    expect(css).toMatch(/\.call-bar-id \.call-bar-info \{\n\s*flex: 1 1 auto;\n\s*min-width: 0;/);
    expect(css).toMatch(/\.call-bar-id #call-room,\n\.call-bar-id \.call-bar-status \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  });

  it('compartilhar tela: indisponível pela borda tracejada e pelo nome, não só por opacidade', () => {
    const rule = /\.call-bar-actions #screen-btn\[aria-disabled='true'\],\n\.call-bar-actions #screen-btn\[aria-disabled='true'\]:hover \{([^}]*)\}/.exec(css)![1]!;
    expect(rule).toMatch(/border: 1px dashed var\(--color-border-control\)/);
    expect(rule).toMatch(/cursor: not-allowed/);
    expect(rule).not.toMatch(/opacity/);
  });

  it('estado de cada controle também no texto: aria-pressed (áudio) e aria-expanded (sons)', () => {
    expect(html).toMatch(/<button id="incoming-btn" class="round-btn" type="button" aria-pressed="false" disabled>Silenciar áudio da chamada<\/button>/);
    expect(css).toMatch(/#incoming-btn\[aria-pressed='true'\] \{\n\s*--i: var\(--icon-headphones-off\);/);
    expect(css).toMatch(/#sound-toggle-btn\[aria-expanded='true'\] \{/);
  });
});
