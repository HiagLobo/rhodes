import type { Db } from '../../db/index.js';
import type { InstanciaRow } from './instancias.js';

// 3º ponto do motor (arquitetura §4.3) — implementação chega na Onda 04.
// Nota da revisão adversarial da S2 (respeitar na implementação): ao concluir instância de
// origem SHIP em template HYBRID, a próxima âncora FIXED não deve derivar do due da instância
// de navio — derivar da série de calendário.

export type TransicaoNavio =
  | 'ANUNCIADO'
  | 'ATRACADO'
  | 'DESCARGA_INICIADA'
  | 'DESCARGA_CONCLUIDA'
  | 'DESATRACADO';

export type ResultadoShipEvent = {
  criadas: InstanciaRow[];
  antecipadas: InstanciaRow[];
};

/* eslint-disable @typescript-eslint/no-unused-vars -- stub tipado; params entram em uso na Onda 04 */
export function onShipEvent(
  _db: Db,
  _operacaoId: number,
  _transicao: TransicaoNavio,
  _agora: Date,
): ResultadoShipEvent {
  throw new Error('onShipEvent chega na Onda 04 (evento de navio).');
}
