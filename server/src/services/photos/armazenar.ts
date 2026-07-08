import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { FOTO_MAX_BYTES, type UploadFotoCampos } from '@rhodes/shared';

import type { Db } from '../../db/index.js';
import { photos } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';

export class FotoInvalidaError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'FotoInvalidaError';
  }
}

export class FotoDuplicadaError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'FotoDuplicadaError';
  }
}

export type DadosFoto = {
  instanciaId: number;
  /** Ordinal da execução multi-dia — fixo em 1 até a S2 (tabela de partes). */
  parte: number;
  campos: UploadFotoCampos;
  contentType: string;
  binario: Buffer;
  ator: { id: number; login: string };
  ip?: string;
};

export type FotoRow = typeof photos.$inferSelect;

/** Assinatura JPEG (SOI) — o content-type é controlado pelo cliente; os bytes não mentem. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * Recebe e persiste uma foto de evidência (arquitetura §6):
 * hash SHA-256 RECALCULADO no servidor (nunca confiar no cliente) → arquivo
 * content-addressable em `fotos/AAAA/MM/<hash>.jpg` (path RELATIVO no banco) → linha +
 * auditoria na MESMA transação. `received_at` = `agora` do servidor; `skew_ms` =
 * servidor − deviceNow (drift do relógio do aparelho, insumo antifraude da Onda 11).
 */
export function armazenarFoto(db: Db, dataDir: string, dados: DadosFoto, agora: Date): FotoRow {
  if (dados.contentType !== 'image/jpeg') {
    throw new FotoInvalidaError('Apenas JPEG é aceito (o app comprime a foto para JPEG).');
  }
  if (!dados.binario.subarray(0, 3).equals(JPEG_MAGIC)) {
    throw new FotoInvalidaError('O arquivo enviado não é um JPEG válido.');
  }
  if (dados.binario.byteLength === 0 || dados.binario.byteLength > FOTO_MAX_BYTES) {
    throw new FotoInvalidaError('Tamanho de arquivo inválido.');
  }

  const sha256 = crypto.createHash('sha256').update(dados.binario).digest('hex');
  const existente = db.select().from(photos).where(eq(photos.sha256, sha256)).get();
  if (existente) {
    throw new FotoDuplicadaError(
      `Esta foto já foi usada como evidência (tarefa #${existente.instanceId}). Tire uma foto nova.`,
    );
  }

  const ano = String(agora.getFullYear());
  const mes = String(agora.getMonth() + 1).padStart(2, '0');
  const relativo = path.posix.join('fotos', ano, mes, `${sha256}.jpg`);
  const absoluto = path.join(dataDir, relativo);

  // Arquivo antes da linha: storage é content-addressable — se a transação falhar, o
  // arquivo órfão de mesmo hash é inofensivo (bytes idênticos) e reaproveitável.
  fs.mkdirSync(path.dirname(absoluto), { recursive: true });
  fs.writeFileSync(absoluto, dados.binario);

  return db.transaction((tx) => {
    const t = tx as unknown as Db;
    const row = t
      .insert(photos)
      .values({
        instanceId: dados.instanciaId,
        tipo: dados.campos.tipo,
        parte: dados.parte,
        sha256,
        path: relativo,
        tamanhoBytes: dados.binario.byteLength,
        capturedAt: new Date(dados.campos.capturedAt),
        receivedAt: agora,
        skewMs: agora.getTime() - Date.parse(dados.campos.deviceNow),
        exifDatetime: dados.campos.exifDatetime ?? null,
        exifModel: dados.campos.exifModel ?? null,
        enviadoPorId: dados.ator.id,
      })
      .returning()
      .get()!;

    audit(t, {
      ator: dados.ator,
      acao: 'FOTO_RECEBIDA',
      entidade: 'photos',
      entidadeId: row.id,
      depois: {
        instanceId: dados.instanciaId,
        tipo: dados.campos.tipo,
        parte: dados.parte,
        sha256,
        tamanhoBytes: dados.binario.byteLength,
        skewMs: row.skewMs,
      },
      ip: dados.ip,
    });

    return row;
  });
}
