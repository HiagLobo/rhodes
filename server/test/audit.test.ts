import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDb, runMigrations } from '../src/db/index.js';
import { seedDev } from '../src/db/seed.js';
import { audit } from '../src/lib/audit.js';

function novoBanco() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-audit-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  return { db, sqlite };
}

describe('audit_log — imutabilidade imposta pelo banco', () => {
  it('UPDATE direto falha com o erro do trigger', () => {
    const { db, sqlite } = novoBanco();
    audit(db, { acao: 'TESTE' });
    expect(() => sqlite.prepare("UPDATE audit_log SET acao = 'ADULTERADO'").run()).toThrow(
      /append-only/,
    );
    sqlite.close();
  });

  it('DELETE direto falha com o erro do trigger', () => {
    const { db, sqlite } = novoBanco();
    audit(db, { acao: 'TESTE' });
    expect(() => sqlite.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
    sqlite.close();
  });

  it('ids são monotônicos crescentes', () => {
    const { db, sqlite } = novoBanco();
    audit(db, { acao: 'A' });
    audit(db, { acao: 'B' });
    audit(db, { acao: 'C' });
    const ids = (sqlite.prepare('SELECT id FROM audit_log ORDER BY rowid').all() as Array<{
      id: number;
    }>).map((r) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(3);
    sqlite.close();
  });
});

describe('audit() — helper', () => {
  it('grava ator/ação/entidade/antes/depois/ip e criado_em vem do servidor', async () => {
    const { db, sqlite } = novoBanco();
    await seedDev(db);
    const gestor = sqlite
      .prepare("SELECT id, login FROM users WHERE login = 'gestor.teste'")
      .get() as { id: number; login: string };

    audit(db, {
      ator: gestor,
      acao: 'USUARIO_CRIADO',
      entidade: 'users',
      entidadeId: 42,
      antes: null,
      depois: { nome: 'Novo', ativo: true },
      ip: '192.168.1.10',
    });

    const row = sqlite.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1').get() as {
      ator_id: number;
      ator_login: string;
      acao: string;
      entidade_id: string;
      depois: string;
      criado_em: number;
    };
    expect(row.ator_id).toBe(gestor.id);
    expect(row.ator_login).toBe('gestor.teste');
    expect(row.acao).toBe('USUARIO_CRIADO');
    expect(row.entidade_id).toBe('42');
    expect(JSON.parse(row.depois)).toEqual({ nome: 'Novo', ativo: true });
    expect(Math.abs(Math.floor(Date.now() / 1000) - row.criado_em)).toBeLessThan(60);
    sqlite.close();
  });

  it('redige password_hash/senha em qualquer profundidade', () => {
    const { db, sqlite } = novoBanco();
    audit(db, {
      acao: 'TESTE_REDACAO',
      depois: {
        login: 'fulano',
        password_hash: '$argon2id$segredo',
        aninhado: { senha: 'outra', lista: [{ passwordHash: 'x' }] },
      },
    });
    const { depois } = sqlite
      .prepare('SELECT depois FROM audit_log ORDER BY id DESC LIMIT 1')
      .get() as { depois: string };
    expect(depois).not.toContain('segredo');
    expect(depois).not.toContain('outra');
    const obj = JSON.parse(depois) as {
      login: string;
      password_hash: string;
      aninhado: { senha: string; lista: Array<{ passwordHash: string }> };
    };
    expect(obj.login).toBe('fulano');
    expect(obj.password_hash).toBe('[redigido]');
    expect(obj.aninhado.senha).toBe('[redigido]');
    expect(obj.aninhado.lista[0]!.passwordHash).toBe('[redigido]');
    sqlite.close();
  });

  it('ator omitido = evento de sistema (ator_id e ator_login nulos)', () => {
    const { db, sqlite } = novoBanco();
    audit(db, { acao: 'JOB_DIARIO' });
    const row = sqlite.prepare('SELECT ator_id, ator_login FROM audit_log LIMIT 1').get() as {
      ator_id: number | null;
      ator_login: string | null;
    };
    expect(row.ator_id).toBeNull();
    expect(row.ator_login).toBeNull();
    sqlite.close();
  });

  it('ator_id inexistente é rejeitado pela FK (foreign_keys=ON de verdade)', () => {
    const { db, sqlite } = novoBanco();
    expect(() => audit(db, { ator: { id: 9999, login: 'fantasma' }, acao: 'X' })).toThrow();
    sqlite.close();
  });
});
