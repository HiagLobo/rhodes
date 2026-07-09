import type { InstanceStatus } from './agendamento.js';

/**
 * Dashboard "Agora" (Onda 07) — a grade espelha a PLANTA FÍSICA do terminal, na ordem do
 * fluxo do grão (recebimento → armazenagem → expedição). "Outras" é fallback para áreas
 * renomeadas pelo gestor depois do seed.
 */
export const GRUPOS_PLANTA = [
  'Moegas',
  'Cintas',
  'Redlers',
  'Elevadores',
  'Máquina de Limpeza',
  'MPL',
  'Silos',
  'Silos de Pó',
  'Túneis',
  'Expedição',
  'Externas',
  'Outras',
] as const;

export type GrupoPlanta = (typeof GRUPOS_PLANTA)[number];

/**
 * Classifica uma área física no grupo da planta pelas grafias REAIS do seed.
 * A ORDEM das regras importa (armadilhas auditadas na Onda 07):
 * - "Área externa predial (ADM e Máquina de Limpeza)" CONTÉM "Máquina de Limpeza" →
 *   Externas avalia ANTES;
 * - "Silos de Pó" ≠ /^silo \d/ (igualdade primeiro);
 * - "Máquina de Pré Limpeza" (MPL) avalia antes do grupo Máquina de Limpeza;
 * - comparação em minúsculas (o seed grafa "limpeza" E "Limpeza").
 */
export function grupoDaArea(nome: string): GrupoPlanta {
  const n = nome.trim().toLowerCase();
  if (n.startsWith('área externa') || n.startsWith('area externa')) return 'Externas';
  if (n === 'silos de pó' || n === 'silos de po') return 'Silos de Pó';
  if (/^silo \d/.test(n)) return 'Silos';
  if (n.startsWith('cinta transportadora')) return 'Cintas';
  if (n.startsWith('moega')) return 'Moegas';
  if (n.startsWith('redler')) return 'Redlers';
  if (n.startsWith('elevador')) return 'Elevadores';
  if (n.startsWith('túnel') || n.startsWith('tunel')) return 'Túneis';
  if (n.includes('pré limpeza') || n.includes('pre limpeza')) return 'MPL';
  if (n.includes('máquina de limpeza') || n.includes('maquina de limpeza')) {
    return 'Máquina de Limpeza';
  }
  if (n.startsWith('área expedição') || n.startsWith('área de expedição')) return 'Expedição';
  return 'Outras';
}

/**
 * Pior situação de um grupo — semântica no SERVIDOR, cor na UI (BANDAS do theme):
 * OVERDUE→crítico · HOJE (due ≤ hoje, inclui carência)→atenção · FUTURA→bom ·
 * NENHUMA (sem abertas)→excelente.
 */
export const SITUACOES_GRUPO = ['OVERDUE', 'HOJE', 'FUTURA', 'NENHUMA'] as const;

export type SituacaoGrupo = (typeof SITUACOES_GRUPO)[number];

export type GrupoGrade = {
  grupo: GrupoPlanta;
  situacao: SituacaoGrupo;
  atrasadas: number;
  hoje: number;
  abertas: number;
};

export type RodadaAtiva = {
  operacaoId: number;
  navio: string;
  status: string;
  etaDate: string;
  total: number;
  concluidas: number;
};

export type DashboardPayload = {
  cartoes: {
    atrasadas: number;
    /** Abertas (PENDING/IN_PROGRESS) com due ≤ hoje — inclui a carência da janela dos 10%. */
    hoje: number;
    aguardandoVistoria: number;
    /** Score oficial 30d (Onda 08); null quando ainda não há dado. */
    score30d: number | null;
    /** Gap score interno − nota externa mais recente (Onda 08); null sem nota registrada. */
    gap: number | null;
    notaExterna: number | null;
    orgaoExterno: string | null;
  };
  /** Sempre na ordem de GRUPOS_PLANTA; "Outras" só entra quando tem área classificada nela. */
  grade: GrupoGrade[];
  rodada: RodadaAtiva | null;
};

/** Situação de UMA instância aberta — insumo da agregação por grupo. */
export function situacaoDaInstancia(status: InstanceStatus, dueDate: string, hoje: string): SituacaoGrupo {
  if (status === 'OVERDUE') return 'OVERDUE';
  if (dueDate <= hoje) return 'HOJE';
  return 'FUTURA';
}

/**
 * Notificações in-app (Onda 07/S6) — payload POR PAPEL, derivado stateless de SELECT (sem
 * tabela nova, sem estado "lida"). Pool de tarefas: OVERDUE sem dono também é do executante.
 * `escalonadas` = OVERDUE com windowEnd anterior a ontem (filtro de apresentação sobre status
 * JÁ materializado — a leitura nunca promove PENDING→OVERDUE, imutável 4).
 */
export type Notificacoes = {
  overdue: number;
  escalonadas: number;
  retrabalhos: number;
  /** Executante: decisões de justificativa suas nas últimas 48 h. */
  decisoes: number;
  /** Gestor: justificativas aguardando decisão. */
  justificativasPendentes: number;
  /** Vistoriador: tamanho da fila de vistoria. */
  filaVistoria: number;
};
