import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import type { InstanciaResumo } from '@rhodes/shared';

import { buildApp } from '../src/app.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { seedDev, SENHA_DEV } from '../src/db/seed.js';
import { resetRateLimit } from '../src/lib/auth.js';
import { dailyJob } from '../src/services/scheduler/daily-job.js';

async function novoApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-inst-api-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  await seedDev(db);
  seedCatalogo(db);
  dailyJob(db, new Date()); // materializa as 39 de hoje
  return { app: buildApp({ db, sqlite }), db, sqlite };
}

function extrairCookie(setCookie: string | string[] | undefined): string {
  if (setCookie === undefined) return '';
  const linha = Array.isArray(setCookie) ? setCookie[0]! : setCookie;
  return linha.split(';')[0]!;
}

async function loginDe(app: Awaited<ReturnType<typeof novoApp>>['app'], login: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login, senha: SENHA_DEV },
  });
  return extrairCookie(res.headers['set-cookie']);
}

beforeEach(() => {
  resetRateLimit();
});

describe('GET /api/agora', () => {
  it('lista as 39 abertas com área/atividade; OVERDUE forjada vem PRIMEIRO', async () => {
    const { app, sqlite } = await novoApp();
    const cookie = await loginDe(app, 'vistoriador.teste');

    // forja uma atrasada: janela no passado + status OVERDUE (como o dailyJob faria)
    const alvo = sqlite.prepare('SELECT id FROM task_instances LIMIT 1').get() as { id: number };
    sqlite
      .prepare(
        "UPDATE task_instances SET status = 'OVERDUE', due_date = '2026-01-01', window_end = '2026-01-02' WHERE id = ?",
      )
      .run(alvo.id);

    const res = await app.inject({ method: 'GET', url: '/api/agora', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const itens = res.json() as InstanciaResumo[];
    expect(itens.length).toBe(39);
    expect(itens[0]!.id).toBe(alvo.id);
    expect(itens[0]!.status).toBe('OVERDUE');
    expect(itens[0]!.areaNome).toBeTruthy();
    await app.close();
    sqlite.close();
  });

  it('sem sessão → 401', async () => {
    const { app, sqlite } = await novoApp();
    expect((await app.inject({ method: 'GET', url: '/api/agora' })).statusCode).toBe(401);
    await app.close();
    sqlite.close();
  });
});

describe('iniciar / concluir', () => {
  it('fluxo completo: iniciar → concluir gera a próxima (aparece na lista)', async () => {
    const { app, sqlite } = await novoApp();
    const cookie = await loginDe(app, 'executante.teste');

    const antes = (
      await app.inject({ method: 'GET', url: '/api/agora', headers: { cookie } })
    ).json() as InstanciaResumo[];
    const alvo = antes[0]!;

    const ini = await app.inject({
      method: 'POST',
      url: `/api/instancias/${alvo.id}/iniciar`,
      headers: { cookie },
    });
    expect(ini.statusCode).toBe(200);

    const meio = (
      await app.inject({ method: 'GET', url: '/api/agora', headers: { cookie } })
    ).json() as InstanciaResumo[];
    const emExecucao = meio.find((i) => i.id === alvo.id)!;
    expect(emExecucao.status).toBe('IN_PROGRESS');
    expect(emExecucao.executanteLogin).toBe('executante.teste');

    const fim = await app.inject({
      method: 'POST',
      url: `/api/instancias/${alvo.id}/concluir`,
      headers: { cookie },
    });
    expect(fim.statusCode).toBe(200);
    const corpo = fim.json() as { statusFinal: string; proximaDue: string | null };
    expect(corpo.statusFinal).toBe('DONE_ON_TIME');
    expect(corpo.proximaDue).not.toBeNull();

    const depois = (
      await app.inject({ method: 'GET', url: '/api/agora', headers: { cookie } })
    ).json() as InstanciaResumo[];
    expect(depois.length).toBe(39); // a nova entrou no lugar da concluída
    expect(depois.some((i) => i.id === alvo.id)).toBe(false);
    expect(
      depois.some((i) => i.templateId === alvo.templateId && i.dueDate === corpo.proximaDue),
    ).toBe(true);
    await app.close();
    sqlite.close();
  });

  it('iniciar tarefa ocupada → 409 com quem está tocando; concluir 2× → 409', async () => {
    const { app, sqlite } = await novoApp();
    const exec = await loginDe(app, 'executante.teste');
    const gestor = await loginDe(app, 'gestor.teste');

    const [alvo] = (
      await app.inject({ method: 'GET', url: '/api/agora', headers: { cookie: exec } })
    ).json() as InstanciaResumo[];
    await app.inject({
      method: 'POST',
      url: `/api/instancias/${alvo!.id}/iniciar`,
      headers: { cookie: exec },
    });

    const denovo = await app.inject({
      method: 'POST',
      url: `/api/instancias/${alvo!.id}/iniciar`,
      headers: { cookie: gestor },
    });
    expect(denovo.statusCode).toBe(409);
    expect(denovo.body).toContain('executante.teste');

    await app.inject({
      method: 'POST',
      url: `/api/instancias/${alvo!.id}/concluir`,
      headers: { cookie: exec },
    });
    const duplo = await app.inject({
      method: 'POST',
      url: `/api/instancias/${alvo!.id}/concluir`,
      headers: { cookie: exec },
    });
    expect(duplo.statusCode).toBe(409);
    await app.close();
    sqlite.close();
  });

  it('VISTORIADOR: lê a lista (200) mas iniciar/concluir → 403', async () => {
    const { app, sqlite } = await novoApp();
    const cookie = await loginDe(app, 'vistoriador.teste');
    const [alvo] = (
      await app.inject({ method: 'GET', url: '/api/agora', headers: { cookie } })
    ).json() as InstanciaResumo[];
    for (const acao of ['iniciar', 'concluir']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/instancias/${alvo!.id}/${acao}`,
        headers: { cookie },
      });
      expect(res.statusCode, acao).toBe(403);
    }
    await app.close();
    sqlite.close();
  });
});

describe('override de data (gestor)', () => {
  it('muda due+window (janela re-derivada), audita antes/depois; fechada → 409; executante → 403', async () => {
    const { app, sqlite } = await novoApp();
    const gestor = await loginDe(app, 'gestor.teste');
    const exec = await loginDe(app, 'executante.teste');

    const [alvo] = (
      await app.inject({ method: 'GET', url: '/api/agora', headers: { cookie: gestor } })
    ).json() as InstanciaResumo[];

    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/instancias/${alvo!.id}/due-date`,
          headers: { cookie: exec },
          payload: { dueDate: '2026-12-01' },
        })
      ).statusCode,
    ).toBe(403);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/instancias/${alvo!.id}/due-date`,
      headers: { cookie: gestor },
      payload: { dueDate: '2026-12-01' },
    });
    expect(res.statusCode).toBe(200);
    const corpo = res.json() as { dueDate: string; windowEnd: string };
    expect(corpo.dueDate).toBe('2026-12-01');
    expect(corpo.windowEnd > corpo.dueDate || corpo.windowEnd === corpo.dueDate).toBe(true);

    const auditoria = sqlite
      .prepare("SELECT antes, depois FROM audit_log WHERE acao = 'INSTANCIA_DUE_ALTERADA'")
      .get() as { antes: string; depois: string };
    expect(JSON.parse(auditoria.depois)).toMatchObject({ dueDate: '2026-12-01' });

    // fechada → 409
    await app.inject({
      method: 'POST',
      url: `/api/instancias/${alvo!.id}/iniciar`,
      headers: { cookie: exec },
    });
    await app.inject({
      method: 'POST',
      url: `/api/instancias/${alvo!.id}/concluir`,
      headers: { cookie: exec },
    });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/instancias/${alvo!.id}/due-date`,
          headers: { cookie: gestor },
          payload: { dueDate: '2026-12-02' },
        })
      ).statusCode,
    ).toBe(409);
    await app.close();
    sqlite.close();
  });
});

describe('integrações com usuários e catálogo', () => {
  it('desativar usuário libera as IN_PROGRESS dele (voltam PENDING sem executante)', async () => {
    const { app, sqlite } = await novoApp();
    const gestor = await loginDe(app, 'gestor.teste');
    const exec = await loginDe(app, 'executante.teste');

    const [alvo] = (
      await app.inject({ method: 'GET', url: '/api/agora', headers: { cookie: exec } })
    ).json() as InstanciaResumo[];
    await app.inject({
      method: 'POST',
      url: `/api/instancias/${alvo!.id}/iniciar`,
      headers: { cookie: exec },
    });

    const idExec = (
      sqlite.prepare("SELECT id FROM users WHERE login = 'executante.teste'").get() as {
        id: number;
      }
    ).id;
    await app.inject({
      method: 'POST',
      url: `/api/usuarios/${idExec}/desativar`,
      headers: { cookie: gestor },
    });

    const row = sqlite
      .prepare('SELECT status, executante_id FROM task_instances WHERE id = ?')
      .get(alvo!.id) as { status: string; executante_id: number | null };
    expect(row).toEqual({ status: 'PENDING', executante_id: null });

    const { n } = sqlite
      .prepare("SELECT COUNT(*) as n FROM audit_log WHERE acao = 'INSTANCIA_LIBERADA'")
      .get() as { n: number };
    expect(n).toBe(1);
    await app.close();
    sqlite.close();
  });

  it('reativar procedimento órfão (todas fechadas) materializa instância nova', async () => {
    const { app, sqlite } = await novoApp();
    const gestor = await loginDe(app, 'gestor.teste');

    // fecha "na marra" a única aberta do template 1 e desativa o procedimento
    sqlite
      .prepare("UPDATE task_instances SET status = 'MISSED' WHERE template_id = 1")
      .run();
    await app.inject({
      method: 'POST',
      url: '/api/procedimentos/1/desativar',
      headers: { cookie: gestor },
    });

    await app.inject({
      method: 'POST',
      url: '/api/procedimentos/1/reativar',
      headers: { cookie: gestor },
    });
    const { n } = sqlite
      .prepare(
        "SELECT COUNT(*) as n FROM task_instances WHERE template_id = 1 AND status = 'PENDING'",
      )
      .get() as { n: number };
    expect(n).toBe(1); // não ficou órfão (achado da revisão da S2)
    await app.close();
    sqlite.close();
  });
});
