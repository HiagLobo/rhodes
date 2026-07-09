import { PassThrough } from 'node:stream';

import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginCallback } from 'fastify';
import { relatorioFiltrosSchema, type RelatorioHistoricoItem } from '@rhodes/shared';

import type { Db } from '../db/index.js';
import { auditLog, photos } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { requireRole } from '../lib/auth.js';
import { placeholderIndisponivel, resolverImagemExibicao } from '../services/report/imagem-exibicao.js';
import { montarDossieDados } from '../services/report/montar-dados.js';
import { gerarCsvInstancias } from '../services/report/csv.js';
import { gerarDossiePdf, type CarregarImagem } from '../services/report/pdf.js';

/**
 * Rotas do dossiê de auditoria (Onda 09/S3) — TODAS só GESTOR (imutável 1). O PDF é gerado em
 * streaming (a S2 escreve num `PassThrough` que o Fastify consome); cada geração é registrada no
 * `audit_log` (`RELATORIO_GERADO`) ANTES de emitir qualquer byte (fail-closed: sem trilha não gera).
 * O `path` da foto é resolvido SÓ aqui, no servidor — nunca sai no `DossieDados`/hash/resposta.
 */
export const relatorioRoutes: FastifyPluginCallback<{ db: Db; dataDir: string }> = (app, opts, done) => {
  const { db, dataDir } = opts;
  const somenteGestor = requireRole(db, 'GESTOR');

  // Localiza o binário da foto por id (o `path` vive só no banco) e devolve a cópia de exibição.
  const carregarImagem: CarregarImagem = async (foto) => {
    const row = db.select({ path: photos.path }).from(photos).where(eq(photos.id, foto.id)).get();
    if (!row) return { buffer: await placeholderIndisponivel(), presente: false };
    return resolverImagemExibicao(dataDir, row.path);
  };

  app.get('/api/relatorios/dossie', { preHandler: somenteGestor }, (req, reply) => {
    const q = relatorioFiltrosSchema.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ erro: q.error.issues[0]?.message ?? 'Filtros inválidos.' });

    const filtros = q.data;
    const dados = montarDossieDados(db, filtros, new Date());
    audit(db, {
      ator: { id: req.user!.id, login: req.user!.login },
      acao: 'RELATORIO_GERADO',
      entidade: 'relatorios',
      depois: { filtros, nInstancias: dados.paginas.length, hash: dados.hash, formato: 'PDF' },
      ip: req.ip,
    });

    const ator = { id: req.user!.id, login: req.user!.login };
    const pass = new PassThrough();
    reply
      .header('content-disposition', `attachment; filename="dossie-${filtros.inicio}-a-${filtros.fim}.pdf"`)
      .type('application/pdf')
      .send(pass);
    // Dispara a geração DEPOIS de anexar o leitor (Fastify), escrevendo no pass em streaming.
    void gerarDossiePdf(dados, carregarImagem, pass)
      .then((resumo) => {
        // Manifesto honesto (ALCOA+ Exato): quantas fotos entraram de fato e quantas faltaram.
        audit(db, {
          ator,
          acao: 'RELATORIO_MANIFESTO',
          entidade: 'relatorios',
          depois: {
            hash: dados.hash,
            fotosEmbutidas: resumo.sha256Usados.length,
            fotosAusentes: resumo.sha256Ausentes.length,
          },
          ip: req.ip,
        });
      })
      .catch((err: unknown) => {
        req.log.error({ err }, 'falha ao gerar o dossiê PDF');
        // Encerra a resposta em qualquer rejeição (inclusive erro no setup do PDF) — sem isto o
        // `pass` já enviado pelo `reply.send` ficaria sem receber bytes e penduraria a request.
        if (!pass.destroyed) pass.destroy(err as Error);
      });
    return reply;
  });

  app.get('/api/relatorios/csv', { preHandler: somenteGestor }, (req, reply) => {
    const q = relatorioFiltrosSchema.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ erro: q.error.issues[0]?.message ?? 'Filtros inválidos.' });

    // CSV = TODAS as instâncias do período (ignora "só reprovadas", que estreita só as páginas do PDF).
    const filtros = { ...q.data, somenteReprovadasOuCriticas: false };
    const dados = montarDossieDados(db, filtros, new Date());
    audit(db, {
      ator: { id: req.user!.id, login: req.user!.login },
      acao: 'RELATORIO_GERADO',
      entidade: 'relatorios',
      depois: { filtros, nInstancias: dados.paginas.length, hash: dados.hash, formato: 'CSV' },
      ip: req.ip,
    });
    return reply
      .header('content-disposition', `attachment; filename="dossie-${filtros.inicio}-a-${filtros.fim}.csv"`)
      .type('text/csv; charset=utf-8')
      .send(gerarCsvInstancias(dados));
  });

  app.get('/api/relatorios/historico', { preHandler: somenteGestor }, (_req, reply) => {
    const rows = db
      .select({ atorLogin: auditLog.atorLogin, criadoEm: auditLog.criadoEm, depois: auditLog.depois })
      .from(auditLog)
      .where(eq(auditLog.acao, 'RELATORIO_GERADO'))
      .orderBy(desc(auditLog.id))
      .limit(50)
      .all();

    const itens: RelatorioHistoricoItem[] = [];
    for (const r of rows) {
      try {
        const d = (r.depois ? JSON.parse(r.depois) : {}) as Partial<RelatorioHistoricoItem>;
        if (!d.filtros) continue; // linha sem filtros não honra o contrato — pula
        itens.push({
          ator: r.atorLogin,
          criadoEm: r.criadoEm.toISOString(),
          filtros: d.filtros,
          nInstancias: d.nInstancias ?? 0,
          hash: d.hash ?? '',
          formato: d.formato ?? '',
        });
      } catch {
        // linha do audit_log malformada — ignora (não derruba o histórico)
      }
    }
    return reply.send(itens);
  });

  done();
};
