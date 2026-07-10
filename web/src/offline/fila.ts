import { db, type AcaoOffline, type EstadoSubmissao, type Submissao } from './db';

export type NovaSubmissao = Omit<Submissao, 'id' | 'ordem' | 'criadoEm' | 'tentativas' | 'estado'>;

/**
 * Enfileira uma ação. A `ordem` é atribuída aqui, monotônica POR INSTÂNCIA — o backend exige
 * iniciar → foto → concluir, e a fila preserva essa cadeia mesmo com dias de offline no meio.
 * Numa transação `rw` para dois enfileiramentos simultâneos não pegarem a mesma ordem.
 */
export async function enfileirar(entrada: NovaSubmissao): Promise<number> {
  return db.transaction('rw', db.submissoes, async () => {
    const irmas = await db.submissoes.where({ instanciaId: entrada.instanciaId }).toArray();
    const maiorOrdem = irmas.reduce((max, s) => Math.max(max, s.ordem), 0);
    return db.submissoes.add({
      ...entrada,
      ordem: maiorOrdem + 1,
      criadoEm: new Date().toISOString(),
      tentativas: 0,
      estado: 'PENDENTE',
    });
  });
}

/** Todas as submissões de uma instância, em ordem (inclui as travadas em ERRO/CONFLITO). */
export async function daInstancia(instanciaId: number): Promise<Submissao[]> {
  const lista = await db.submissoes.where({ instanciaId }).toArray();
  return lista.sort((a, b) => a.ordem - b.ordem);
}

/** Pendentes agrupadas por instância, cada grupo em ordem — é assim que o worker consome. */
export async function pendentesPorInstancia(): Promise<Map<number, Submissao[]>> {
  const lista = await db.submissoes.where('estado').equals('PENDENTE').toArray();
  const grupos = new Map<number, Submissao[]>();
  for (const s of lista) {
    const g = grupos.get(s.instanciaId) ?? [];
    g.push(s);
    grupos.set(s.instanciaId, g);
  }
  for (const g of grupos.values()) g.sort((a, b) => a.ordem - b.ordem);
  return grupos;
}

export async function contarPendentes(): Promise<number> {
  return db.submissoes.where('estado').equals('PENDENTE').count();
}

/** O que o indicador de sync (S3) mostra. */
export async function contarPorEstado(): Promise<Record<EstadoSubmissao, number>> {
  const [pendentes, erros, conflitos] = await Promise.all([
    db.submissoes.where('estado').equals('PENDENTE').count(),
    db.submissoes.where('estado').equals('ERRO').count(),
    db.submissoes.where('estado').equals('CONFLITO').count(),
  ]);
  return { PENDENTE: pendentes, ERRO: erros, CONFLITO: conflitos };
}

export async function remover(id: number): Promise<void> {
  await db.submissoes.delete(id);
}

export async function marcar(id: number, estado: EstadoSubmissao, ultimoErro?: string): Promise<void> {
  await db.submissoes.update(id, { estado, ultimoErro });
}

/**
 * Backoff exponencial com teto de 60 s — a fila não martela o servidor no túnel. Guarda a última
 * mensagem: erro que nunca passa precisa ficar VISÍVEL, não virar retry eterno em silêncio.
 */
export async function registrarTentativa(
  id: number,
  tentativas: number,
  agora: Date,
  ultimoErro?: string,
): Promise<void> {
  const espera = Math.min(60_000, 2 ** tentativas * 1000);
  await db.submissoes.update(id, {
    tentativas: tentativas + 1,
    proximaTentativaEm: agora.getTime() + espera,
    ...(ultimoErro !== undefined ? { ultimoErro } : {}),
  });
}

/** Submissões em CONFLITO — a S5 as envia como registro anexo ao gestor. */
export async function conflitos(): Promise<Submissao[]> {
  return db.submissoes.where('estado').equals('CONFLITO').toArray();
}

export async function limpar(): Promise<void> {
  await db.submissoes.clear();
}

export type { AcaoOffline, EstadoSubmissao, Submissao };
