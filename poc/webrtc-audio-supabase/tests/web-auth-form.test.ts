// Autenticação Midnight V2: regras do formulário (sem regra de senha além das do Auth), telefone que não sai da página,
// botão Google só em revisão, e a estrutura acessível das abas, campos e erros.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatPhoneBR, isEmail, isPhoneBR, passwordChecks, phoneDigits, validateLogin, validateSignup } from '../src/web/auth-form.ts';
import { parseWebConfig } from '../src/web/config.ts';
import { NAME_ERROR } from '../src/web/identity.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const html = read('index.html');
const main = read('src/web/main.ts');
const fn = (name: string): string => new RegExp(`function ${name}[^]*?\n}\n`).exec(main)![0];

const OK = { name: 'Aurora Nova', email: 'aurora@exemplo.com', phone: '(11) 91234-5678', password: 'segredo123', confirmation: 'segredo123' };

describe('cadastro: validação por campo', () => {
  it('dados válidos: nenhum erro', () => {
    expect(validateSignup(OK)).toEqual({});
  });

  it('obrigatórios vazios: um erro em cada campo, com texto fixo', () => {
    expect(validateSignup({ name: '', email: '', phone: '', password: '', confirmation: '' })).toEqual({
      name: 'Informe um nome de exibição.', email: 'Informe seu e-mail.', phone: 'Informe seu telefone.', password: 'Crie uma senha.', confirmation: 'Confirme a senha.',
    });
  });

  it('nome: a mesma regra da migração de identidade (até 32, sem controle)', () => {
    expect(validateSignup({ ...OK, name: 'a'.repeat(33) }).name).toBe(NAME_ERROR);
    expect(validateSignup({ ...OK, name: '   ' }).name).toBe('Informe um nome de exibição.');
    expect(validateSignup({ ...OK, name: 'x\u0007' }).name).toBe(NAME_ERROR);
    expect(validateSignup({ ...OK, name: '  Ana   Lima  ' }).name).toBeUndefined();
  });

  it('e-mail: formato básico, sem espaços', () => {
    for (const ok of ['a@b.co', ' aurora@exemplo.com.br ']) expect(isEmail(ok), ok).toBe(true);
    for (const bad of ['a@b', 'a b@c.com', '@c.com', 'a@.com', 'semarroba.com']) expect(isEmail(bad), bad).toBe(false);
  });

  it('senha: só as regras do Auth (8 caracteres, até 72 bytes) e a confirmação; nada de exigir maiúscula ou símbolo', () => {
    expect(validateSignup({ ...OK, password: 'curta', confirmation: 'curta' }).password).toBe('Use pelo menos 8 caracteres.');
    expect(validateSignup({ ...OK, password: 'semmaiusculasnemnumero', confirmation: 'semmaiusculasnemnumero' })).toEqual({});
    const long = 'é'.repeat(37); // 37 caracteres, 74 bytes
    expect(validateSignup({ ...OK, password: long, confirmation: long }).password).toMatch(/72 bytes/);
    expect(validateSignup({ ...OK, confirmation: 'outra-coisa' }).confirmation).toBe('As senhas não conferem.');
  });

  it('requisitos da senha acompanham a digitação', () => {
    expect(passwordChecks('', '')).toEqual({ length: false, bytes: true, match: false });
    expect(passwordChecks('segredo1', '')).toEqual({ length: true, bytes: true, match: false });
    expect(passwordChecks('segredo1', 'segredo1')).toEqual({ length: true, bytes: true, match: true });
  });
});

describe('telefone brasileiro', () => {
  it('máscara enquanto se digita: celular e fixo', () => {
    expect(formatPhoneBR('1')).toBe('(1');
    expect(formatPhoneBR('11')).toBe('(11');
    expect(formatPhoneBR('119')).toBe('(11) 9');
    expect(formatPhoneBR('1191234')).toBe('(11) 9123-4');
    expect(formatPhoneBR('11912345678')).toBe('(11) 91234-5678');
    expect(formatPhoneBR('1132345678')).toBe('(11) 3234-5678');
    expect(formatPhoneBR('+55 (11) 91234-5678')).toBe('(11) 91234-5678');
    expect(formatPhoneBR('119123456789999')).toBe('(11) 91234-5678'); // sobra ignorada
  });

  it('válido: DDD sem zero, celular com 9 na frente ou fixo de 2 a 5', () => {
    expect(isPhoneBR('(11) 91234-5678')).toBe(true);
    expect(isPhoneBR('(21) 3234-5678')).toBe(true);
    expect(isPhoneBR('+55 11 91234-5678')).toBe(true);
    for (const bad of ['(11) 81234-5678', '(01) 91234-5678', '(10) 91234-5678', '(11) 9123-456', '(11) 1234-5678', '']) expect(isPhoneBR(bad), bad).toBe(false);
    expect(phoneDigits('(11) 91234-5678')).toBe('11912345678');
  });

  it('não sai da página: o cadastro envia só nome, e-mail e senha (persistência pendente de decisão)', () => {
    const submit = /ui\.signupForm\.addEventListener\('submit'[^]*?\n\}\);\n/.exec(main)![0];
    expect(submit).toContain('void registerAccount(client.auth, ui.signupEmail.value, password, ui.signupName.value)');
    expect(submit).not.toMatch(/signupPhone\.value[^]*registerAccount|phone:/);
    expect(read('src/web/identity.ts')).not.toMatch(/phone/i);
  });
});

describe('entrada', () => {
  it('confere preenchimento e formato do e-mail antes de ir ao Auth', () => {
    expect(validateLogin('', '')).toEqual({ email: 'Informe seu e-mail.', password: 'Informe sua senha.' });
    expect(validateLogin('x@', 'qualquer')).toEqual({ email: 'E-mail em formato inválido.' });
    expect(validateLogin('a@b.co', 'qualquer')).toEqual({});
  });

  it('recusa do Auth no próprio cartão, com texto fixo (nunca a mensagem do servidor)', () => {
    const login = /ui\.loginForm\.addEventListener\('submit'[^]*?\n\}\);\n/.exec(main)![0];
    expect(login).toContain("const text = code === 'invalid_credentials' ? 'E-mail ou senha incorretos.'");
    expect(login).toContain("setMessage(ui.signupStatus, { tone: 'error', text });");
    expect(login).not.toMatch(/\.message\b/);
  });
});

describe('Google', () => {
  const env = { VITE_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x' };

  it('desligado por padrão; preview só para revisão; outro valor é recusado', () => {
    expect(parseWebConfig(env).googleAuth).toBe('off');
    expect(parseWebConfig({ ...env, VITE_ORYN_AUTH_GOOGLE: 'preview' }).googleAuth).toBe('preview');
    expect(() => parseWebConfig({ ...env, VITE_ORYN_AUTH_GOOGLE: 'on' })).toThrow(/VITE_ORYN_AUTH_GOOGLE/);
  });

  it('nenhum fluxo OAuth é iniciado: o botão só avisa, e fica oculto fora da revisão', () => {
    const sources = ['src/web/main.ts', 'src/web/identity.ts', 'src/web/auth-session.ts', 'src/web/auth-form.ts'].map(read).join('\n');
    expect(sources).not.toMatch(/signInWithOAuth|signInWithIdToken|exchangeCodeForSession/);
    expect(main).toContain("ui.authGoogle.hidden = cfg.googleAuth !== 'preview';");
    expect(html).toMatch(/<div id="auth-google" class="auth-alt" hidden>/);
  });
});

describe('estrutura acessível', () => {
  it('abas Entrar e Criar conta (tablist), com a seleção no aria-selected', () => {
    const tabs = /<div id="auth-tabs"[^]*?<\/div>/.exec(html)![0];
    expect(tabs).toMatch(/role="tablist" aria-label="Acesso à conta"/);
    expect(tabs).toMatch(/<button id="auth-tab-login" class="auth-tab" type="button" role="tab" aria-selected="true" aria-controls="login-form">Entrar<\/button>/);
    expect(tabs).toMatch(/<button id="signup-open-btn" class="auth-tab" type="button" role="tab" aria-selected="false" aria-controls="signup-form" tabindex="-1">Criar conta<\/button>/);
    const mode = fn('loginMode');
    expect(mode).toContain("ui.authTabs.hidden = mode === 'forgot' || mode === 'reset';");
    expect(mode).toContain("tab.setAttribute('aria-selected', String(selected));");
  });

  it('cada campo do cadastro tem rótulo, erro associado e ícone; a senha tem mostrar/ocultar', () => {
    for (const id of ['signup-name', 'signup-email', 'signup-phone', 'signup-password', 'signup-confirm']) {
      expect(html, id).toContain(`<label for="${id}">`);
      expect(html, id).toMatch(new RegExp(`id="${id}"[^>]*aria-describedby="[^"]*${id}-error`));
      expect(html, id).toContain(`<p id="${id}-error" class="auth-error" hidden></p>`);
    }
    for (const id of ['password', 'signup-password', 'signup-confirm', 'reset-password', 'reset-confirm']) {
      expect(html, id).toMatch(new RegExp(`<button class="auth-reveal" type="button" data-reveal="${id}" aria-label="Mostrar [^"]+" aria-pressed="false"></button>`));
    }
    expect(fn('setPasswordVisible')).toContain("input.type = visible ? 'text' : 'password';");
    // Trocar de formulário oculta e limpa as senhas.
    expect(fn('loginMode')).toContain('hideAllPasswords();');
  });

  it('requisitos da senha com estado em texto (aria-label) e no ícone, não só na cor', () => {
    expect(html).toMatch(/<li data-rule="length" data-met="false">Pelo menos 8 caracteres<\/li>/);
    expect(html).toMatch(/<li data-rule="match" data-met="false">As duas senhas conferem<\/li>/);
    expect(fn('renderPasswordRules')).toContain("item.setAttribute('aria-label', `${item.textContent ?? ''}: ${met ? 'atendido' : 'pendente'}`);");
  });

  it('o cadastro valida antes de enviar e leva o foco ao primeiro campo com erro', () => {
    const submit = /ui\.signupForm\.addEventListener\('submit'[^]*?\n\}\);\n/.exec(main)![0];
    expect(submit.indexOf('validateSignup(signupInput())')).toBeLessThan(submit.indexOf('registerAccount('));
    expect(submit).toContain('if (first) return first.input().focus();');
  });
});
