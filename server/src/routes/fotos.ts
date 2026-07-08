import fs from 'node:fs';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { uploadFotoCamposSchema, STATUS_ABERTOS, type FotoResumo } from '@rhodes/shared';
import { z } from 'zod';

import type { Db } from '../db/index.js';
import { photos, taskInstances } from '../db/schema.js';
import { requireRole, requireUser } from '../lib/auth.js';
import {
  armazenarFoto,
  FotoDuplicadaError,
  FotoInvalidaError,
  type FotoRow,
} from '../services/photos/armazenar.js';
import { agendarThumbnail, caminhoThumb } from '../services/photos/thumbnails.js';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

function paraResumo(row: FotoRow, enviadoPor: string | null): FotoResumo {
  return {
    id: row.id,
    instanceId: row.instanceId,
    tipo: row.tipo as FotoResumo['tipo'],
    parte: row.parte,
    capturedAt: row.capturedAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    skewMs: row.skewMs,
    exifDatetime: row.exifDatetime,
    exifModel: row.exifModel,
    tamanhoBytes: row.tamanhoBytes,
    enviadoPor,
  };
}

export const fotosRoutes: FastifyPluginCallback<{ db: Db; dataDir: string }> = (
  app,
  opts,
  done,
) => {
  const { db, dataDir } = opts;
  const logado = requireUser(db);
  const executa = requireRole(db, 'EXECUTANTE', 'GESTOR');

  app.post('/api/instancias/:id/fotos', { preHandler: executa }, async (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ erro: 'Dados inválidos.' });

    // req.file() numa requisição não-multipart lança — vira 415 legível, não 500.
    if (!req.isMultipart()) {
      return reply.status(415).send({ erro: 'Envie a foto como multipart/form-data.' });
    }
    const arquivo = await req.file();
    if (!arquivo) {
      return reply.status(400).send({ erro: 'Envie a foto como multipart (campo "arquivo").' });
    }

    // Campos de texto vêm junto no multipart — só o que for field entra no Zod.
    const camposRaw = Object.fromEntries(
      Object.entries(arquivo.fields).flatMap(([nome, valor]) => {
        const campo = Array.isArray(valor) ? valor[0] : valor;
        return campo && campo.type === 'field' ? [[nome, campo.value]] : [];
      }),
    );
    const campos = uploadFotoCamposSchema.safeParse(camposRaw);
    if (!campos.success) return reply.status(400).send({ erro: 'Dados inválidos.' });

    const inst = db.select().from(taskInstances).where(eq(taskInstances.id, params.data.id)).get();
    if (!inst) return reply.status(404).send({ erro: 'Tarefa não encontrada.' });

    if (campos.data.tipo === 'IMPEDIMENTO') {
      // Evidência de impedimento não exige iniciar: fotografa-se o bloqueio (navio na moega,
      // chuva) para justificar sem começar a tarefa (S3). Basta a tarefa estar aberta.
      if (!(STATUS_ABERTOS as readonly string[]).includes(inst.status)) {
        return reply.status(409).send({ erro: 'Tarefa já fechada.' });
      }
    } else {
      if (inst.status !== 'IN_PROGRESS') {
        return reply.status(409).send({ erro: 'Inicie a tarefa antes de fotografar.' });
      }
      if (inst.executanteId !== req.user!.id) {
        return reply.status(403).send({ erro: 'Só quem iniciou a tarefa anexa evidência.' });
      }
    }

    let binario: Buffer;
    try {
      binario = await arquivo.toBuffer();
    } catch {
      // limite do @fastify/multipart estourado no meio do stream
      return reply.status(413).send({ erro: 'Foto acima do limite de 10 MB.' });
    }

    try {
      const row = armazenarFoto(
        db,
        dataDir,
        {
          instanciaId: inst.id,
          parte: 1, // ordinal fixo até a S2 (execucao_partes) — multi-dia ainda não existe
          campos: campos.data,
          contentType: arquivo.mimetype,
          binario,
          ator: { id: req.user!.id, login: req.user!.login },
          ip: req.ip,
        },
        new Date(),
      );
      agendarThumbnail(path.join(dataDir, row.path), (err) =>
        req.log.warn({ err }, 'thumbnail falhou (upload segue válido)'),
      );
      return await reply.status(201).send(paraResumo(row, req.user!.login));
    } catch (err) {
      if (err instanceof FotoDuplicadaError) return reply.status(409).send({ erro: err.message });
      if (err instanceof FotoInvalidaError) return reply.status(415).send({ erro: err.message });
      throw err;
    }
  });

  /** Serve o binário — SEMPRE atrás de sessão (evidência pode conter pessoas — LGPD). */
  function servirFoto(thumb: boolean) {
    return (req: FastifyRequest, reply: FastifyReply) => {
      const params = idParamSchema.safeParse(req.params);
      if (!params.success) return reply.status(400).send({ erro: 'Dados inválidos.' });
      const row = db.select().from(photos).where(eq(photos.id, params.data.id)).get();
      if (!row) return reply.status(404).send({ erro: 'Foto não encontrada.' });

      const original = path.join(dataDir, row.path);
      const candidato = thumb ? caminhoThumb(original) : original;
      // Thumbnail é best-effort (worker fire-and-forget): ausente → cai para o original.
      const alvo = fs.existsSync(candidato) ? candidato : original;
      if (!fs.existsSync(alvo)) return reply.status(404).send({ erro: 'Arquivo indisponível.' });

      return reply
        .header('content-type', 'image/jpeg')
        .header('cache-control', 'private, max-age=31536000, immutable') // hash = conteúdo fixo
        .send(fs.createReadStream(alvo));
    };
  }

  app.get('/api/fotos/:id/arquivo', { preHandler: logado }, servirFoto(false));
  app.get('/api/fotos/:id/thumb', { preHandler: logado }, servirFoto(true));

  done();
};
