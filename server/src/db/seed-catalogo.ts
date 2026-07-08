import { pathToFileURL } from 'node:url';

import { and, eq } from 'drizzle-orm';
import { graceDefault, INTERVALO_DIAS, type Frequencia } from '@rhodes/shared';

import { loadEnv } from '../lib/env.js';
import { createDb, runMigrations, type Db } from './index.js';
import { areas, metodoVersoes, taskTemplates } from './schema.js';

/**
 * CHECKLIST VALIDADO COM A AMBEV — fonte: "Cópia de Checklist de Limpeza - Porto do Recife -
 * Validado.xlsx", linhas 5–43, conferido linha a linha em 08/07/2026 (Onda 02/S2).
 *
 * Regras de transcrição:
 * - Textos de atividade e método VERBATIM (inclusive grafias originais como "coreias",
 *   "resiual", "chapas lateriais", "Ar comprido" — o texto é o validado; correções são do
 *   gestor via nova versão auditada). Espaços finais de célula aparados.
 * - Única normalização: área "Cinta Transporadora (TRMT4)" → "Cinta Transportadora (TRMT4)"
 *   (erro evidente de digitação no nome da área; T5/T6/T7 grafam "Transportadora").
 * - `navio: true` = "… e após o recebimento do navio" (gatilho híbrido pós-operação).
 */
type Linha = {
  area: string;
  atividade: string;
  frequencia: Frequencia;
  navio?: true;
  metodo: string;
  limitacoes?: string;
};

export const CHECKLIST_VALIDADO: readonly Linha[] = [
  // A5
  {
    area: 'Cinta Transportadora (TRMT4)',
    atividade: 'Realizar a lavagem de todo o equipamento com lava-jato.',
    frequencia: 'QUINZENAL',
    navio: true,
    metodo:
      'Remover 100% das tampas, retirar todo o residual de grãos presentes na cinta, limpeza dos roletes, coreias, cintas (cima e baixo), piso e paredes com máquina lava-jato.',
  },
  // A6
  {
    area: 'Moega de Recebimento (superior)',
    atividade: 'Utilização de lava-jato para limpeza de paredes, teto e telas.',
    frequencia: 'QUINZENAL',
    navio: true,
    metodo:
      'Uso de lava-jato em 100% da limpeza. Atenção para remover residual de água após a lavagem. Fazer inspeção/substituição de telas oxidadas e/ou furadas.',
  },
  // A7
  {
    area: 'Moega de Recebimento (inferior)',
    atividade: 'Realizar lavagem interna da moega: Utilização de lava-jato para lavagem do piso.',
    frequencia: 'QUINZENAL',
    navio: true,
    metodo:
      'Uso de lava-jato em 100% da limpeza. Atenção para remover residual de água após a lavagem.',
  },
  // A8
  {
    area: 'Redler da moega',
    atividade: 'Realizar lavagem interna do redler e na base do equipamento.',
    frequencia: 'QUINZENAL',
    navio: true,
    metodo:
      'Remover o chapéu chinês do equipamento, uso de lava-jato em todo sistema e posteriormente ar comprimido para remoção de água resiual. Deve-se utilizar máquina lava-jato na base do redler, removendo 100% das sujidades.',
  },
  // A9
  {
    area: 'Elevador de recebimento (1B)',
    atividade:
      'Realizar limpeza do pé do elevador e profilaxia do equipamento, assim como a parte externa do elevador (no que se alcança).',
    frequencia: 'QUINZENAL',
    navio: true,
    metodo:
      'Realizar  abertura do elevador, uso de vassouras para remoção de resíduos e posteriormente limpeza com máquina lava-jato.',
    limitacoes:
      'Lavar o pé e a cabeça — não há acesso seguro ao corpo do elevador (limitação registrada e validada com a Ambev).',
  },
  // A10
  {
    area: 'Cinta Transportadora (T5)',
    atividade: 'Lavagem interna e externa do equipamento.',
    frequencia: 'QUINZENAL',
    navio: true,
    metodo:
      'Utilizar mangueira lava-jato localizada na parte superior dos silos, aplicando nas paredes lisas (interna e externa), teto interno, cinta (interna e externa), roletes, correias e na passarela (tela).',
  },
  // A11
  {
    area: 'Cinta Transportadora (T6)',
    atividade: 'Lavagem interna e externa do equipamento.',
    frequencia: 'QUINZENAL',
    navio: true,
    metodo:
      'Utilizar mangueira lava-jato localizada na parte superior dos silos, aplicando nas paredes lisas (interna e externa), teto interno, cinta (interna e externa), roletes, correias e na passarela (tela).',
  },
  // A12
  {
    area: 'Cinta Transportadora (T7)',
    atividade: 'Lavagem interna e externa do equipamento.',
    frequencia: 'QUINZENAL',
    navio: true,
    metodo:
      'Utilizar mangueira lava jato localizada na parte superior dos silos, aplicando nas paredes lisas (interna e externa), teto interno, cinta (interna e externa), roletes, correias e na passarela (tela).',
  },
  // A13–A20 (Silos 01–08)
  ...(['01', '02', '03', '04', '05', '06', '07', '08'] as const).map(
    (n): Linha => ({
      area: `Silo ${n}`,
      atividade: 'Inspeção e limpeza com lava-jato / Tratamento para insetos',
      frequencia: 'SEMESTRAL',
      metodo:
        'Realizar a abertura de chapas lateriais para entrada da girafa e uso de lava-jato em 100% da limpeza de teto, paredes e piso. Realizar inspeção na estrutura do chapéu, inspecionar sistema de aeração.',
    }),
  ),
  // A21
  {
    area: 'Túnel Recebimento',
    atividade: 'Realizar a lavagem de todo o equipamento (interno e externo)',
    frequencia: 'MENSAL',
    navio: true,
    metodo:
      'Remover residual com vassoura ou ar comprimido, uso de lava-jato em toda a extensão (interna e externa). Aplicar limpeza com uso de lava-jato nas paredes, piso e teto do ambiente.',
  },
  // A22
  {
    area: 'Túnel TRMT08A (bateria silo 1 ao 4)',
    atividade: 'Realizar a lavagem de todo o equipamento (interno e externo)',
    frequencia: 'QUINZENAL',
    metodo:
      'Realizar abertura de 100% das tampas, remover residual com vassoura ou ar comprimido, uso de lava-jato em toda a extensão (interna e externa). Além disso, avaliar condição da borracha das tampas, garantindo vedação 100%. Aplicar limpeza com uso de lava-jato nas paredes, piso e teto do ambiente. Avaliar calhas de fiação elétrica e sistema de aspiração.',
  },
  // A23
  {
    area: 'Túnel TRMT08A (bateria silo 5 ao 8)',
    atividade: 'Realizar a lavagem de todo o equipamento (interno e externo)',
    frequencia: 'QUINZENAL',
    metodo:
      'Realizar abertura de 100% das tampas, remover residual com vassoura ou ar comprimido, uso de lava-jato em toda a extensão (interna e externa). Além disso, avaliar condição da borracha das tampas, garantindo vedação 100%. Aplicar limpeza com uso de lava-jato nas paredes, piso e teto do ambiente. Avaliar calhas de fiação elétrica e sistema de aspiração.',
  },
  // A24
  {
    area: 'Elevadores de expedição',
    atividade: 'Realizar limpeza do pé do elevador',
    frequencia: 'DIARIO',
    metodo:
      'Realizar  abertura do elevador (cinzeiro), uso de vassouras para remoção de resíduos e posteriormente limpeza com máquina lava-jato. Na parte externa, utilizar mangueira próxima à parte superior do elevador. Realizar abertura do amortecedor do elevador.',
  },
  // A25
  {
    area: 'Redlers de expedição',
    atividade: 'Realizar limpeza dos redlers',
    frequencia: 'SEMANAL',
    metodo:
      'Fazer a limpeza a seco, com ar comprimido, removendo pó e sujeira remanescentes. Avaliar necessidade de limpeza profunda.',
  },
  // A26
  {
    area: 'Redlers de expedição',
    atividade: 'Realizar limpeza dos redlers,  profilaxia dos equipamentos.',
    frequencia: 'MENSAL',
    metodo:
      'Remover o chapéu chinês do equipamento, uso de lava-jato em todo sistema e posteriormente ar comprimido para remoção de água resiual. Deve-se utilizar máquina lava-jato na base do redler, removendo 100% das sujidades.',
  },
  // A27
  {
    area: 'Prédio da Máquina de limpeza (paredes)',
    atividade: 'Realizar lavagem das paredes do prédio da MPL.',
    frequencia: 'MENSAL',
    metodo:
      'Realizar lavagem das paredes com lava-jato. Garantir que seja limpo todas as conexões e pontos de difícil acesso. Atentar para que nenhuma  área fique sem limpeza.',
    limitacoes:
      'A limpeza completa leva alguns dias; Ambev manteve mensal exigindo 100% da área, incluindo saídas de subproduto, paredes e equipamentos nos arredores.',
  },
  // A28
  {
    area: 'Prédio da Máquina de limpeza (piso)',
    atividade: 'Realizar lavagem do piso do prédio da MPL.',
    frequencia: 'DIARIO',
    metodo: 'Realizar limpeza completa do piso para iniciar expedição',
  },
  // A29
  {
    area: 'Prédio da Máquina de limpeza (piso)',
    atividade: 'Realizar lavagem do piso do prédio da MPL.',
    frequencia: 'SEMANAL',
    metodo: 'Lavagem do piso deve ser feita com e uso de lava-jato em 100% de sua extensão.',
  },
  // A30
  {
    area: 'Silos de Pó',
    atividade: 'Realizar zeramento do silo, limpeza e profilaxia.',
    frequencia: 'QUINZENAL',
    metodo:
      'Após realizar o zeramento de 100% do pó, utilizar lava-jato para cobertura de 100% da limpeza na estrutura interna e externa, aplicando profilaxia posteriormente.',
  },
  // A31
  {
    area: 'Máquina de Pré Limpeza',
    atividade:
      'Realizar limpeza com ar comprimido na estrutura dos maquinários de limpeza, Inspeção e limpeza das telas das peneiras (verificar necessidade para tratamento interno).',
    frequencia: 'SEMANAL',
    metodo:
      'Ar comprido deve ser aplicado em 100% da estrutura da máquina para remoção de sujidades.',
  },
  // A32
  {
    area: 'Elevadores das máquinas',
    atividade: 'Realizar limpeza com lava-jato em toda estrutura.',
    frequencia: 'QUINZENAL',
    metodo:
      'Remover a abertura do elevador (cinzeiro), uso de vassouras para remoção de resíduos e posteriormente limpeza com máquina lava-jato.',
  },
  // A33
  {
    area: 'Prédio da Máquina de limpeza (tubulações)',
    atividade: 'Realizar limpeza com lava-jato em toda estrutura.',
    frequencia: 'MENSAL',
    metodo:
      'Realizar abertura de 100% das tampas, remover residual com vassoura ou ar comprimido. Além disso, avaliar condição da borracha das tampas, garantindo vedação 100%.',
  },
  // A34
  {
    area: 'Prédio Máquina de Limpeza (Filtros de Manga)',
    atividade: 'Realizar limpeza de 100% dos filtros.',
    frequencia: 'MENSAL',
    metodo:
      'Atenção com as válvulas pneumáticas. Garantir limpeza superior do teto. Incluso todos os filtros do porto.',
    limitacoes:
      'Difícil acesso — não é possível concluir em um só dia; Ambev manteve mensal e pediu avaliação de adequação de acesso.',
  },
  // A35
  {
    area: 'Área expedição de malte',
    atividade: 'Realizar lavagem da área de expedição.',
    frequencia: 'QUINZENAL',
    metodo:
      'Utilizar máquina lava-jato para abrangência total da área, teto, paredes, piso, inferior balança, tubulações, janelas da área de balança, plataformas, bicas de expedição, escadas de acesso às salas de balança e portas.',
  },
  // A36
  {
    area: 'Área expedição de malte',
    atividade: 'Realizar limpeza da área de expedição.',
    frequencia: 'QUINZENAL',
    metodo:
      'Utilizar vassoura com extensor para alcance de 100% da estrutura ou utilizar lava-jato para remoção das sujidades.',
  },
  // A37
  {
    area: 'Área de expedição de subproduto',
    atividade: 'Limpeza completa da área (paredes, teto, piso)',
    frequencia: 'SEMANAL',
    metodo:
      'Utilizar vassoura com extensor para alcance de 100% da estrutura, após limpeza realizar tratamento ambiental.',
  },
  // A38
  {
    area: 'Área de expedição de subproduto',
    atividade: 'Realizar lavagem da área de expedição.',
    frequencia: 'QUINZENAL',
    metodo:
      'Utilizar máquina lava-jato para limpeza do teto, paredes, luminárias, plataformas, escadas, piso e bicas de expedição.',
  },
  // A39
  {
    area: 'Área externa predial (ADM e Máquina de Limpeza)',
    atividade: 'Limpeza estrutural civil.',
    frequencia: 'BIMESTRAL',
    metodo: 'Usar lava-jato nas paredes dos prédios. Realizar repintura nos pontos de falta.',
  },
  // A40
  {
    area: 'Área externa dos silos',
    atividade: 'Limpeza das bases e piso.',
    frequencia: 'BIMESTRAL',
    metodo:
      'Utilizar lava-jato para remoção das sujidades. Aplicar tinta na base dos silos para proteção.',
  },
  // A41
  {
    area: 'Área externa - caçambas (entulho)',
    atividade: 'Seleção, Organização e Limpeza da área',
    frequencia: 'SEMANAL',
    metodo: 'Manter cata entulho 100% fechamento.',
  },
  // A42
  {
    area: 'Área externa - acesso ao terminal (portões)',
    atividade: 'Organização e Limpeza da área',
    frequencia: 'SEMANAL',
    metodo:
      'Utilizar lava-jato para limpeza do solo e portões. Garantir que não haja presença de resíduos.',
  },
  // A43 — mesma área/atividade/frequência da A37, método diferente (duplicidade INTENCIONAL)
  {
    area: 'Área de expedição de subproduto',
    atividade: 'Limpeza completa da área (paredes, teto, piso)',
    frequencia: 'SEMANAL',
    metodo: 'Utilizar vassoura com extensor para alcance de 100% da estrutura.',
  },
];

/** Pesos default de criticidade (arquitetura §7) — editáveis/auditados pela API da S3. */
function pesoDaArea(nome: string): number {
  if (nome.startsWith('Silo ') || nome === 'Silos de Pó' || nome.startsWith('Prédio')) {
    return 1.5;
  }
  if (nome.startsWith('Túnel') || nome.includes('Moega')) {
    return 1.25;
  }
  return 1.0;
}

/**
 * Idempotente. A chave (área, atividade, frequência) NÃO é única no checklist (A37 × A43) —
 * a idempotência é por CONTAGEM por chave: insere apenas o que faltar de cada grupo.
 * Dados oficiais do Plano Mestre: seguro rodar também em produção.
 */
export function seedCatalogo(db: Db): void {
  const nomes = [...new Set(CHECKLIST_VALIDADO.map((l) => l.area))];
  for (const nome of nomes) {
    db.insert(areas)
      .values({ nome, pesoCriticidade: pesoDaArea(nome) })
      .onConflictDoNothing({ target: areas.nome })
      .run();
  }
  const mapaAreas = new Map(db.select().from(areas).all().map((a) => [a.nome, a.id]));

  const grupos = new Map<string, Linha[]>();
  for (const linha of CHECKLIST_VALIDADO) {
    const chave = `${linha.area}|${linha.atividade}|${linha.frequencia}`;
    grupos.set(chave, [...(grupos.get(chave) ?? []), linha]);
  }

  for (const grupo of grupos.values()) {
    const exemplo = grupo[0]!;
    const areaId = mapaAreas.get(exemplo.area);
    if (areaId === undefined) throw new Error(`Área não semeada: ${exemplo.area}`);

    const existentes = db
      .select({ id: taskTemplates.id })
      .from(taskTemplates)
      .where(
        and(
          eq(taskTemplates.areaId, areaId),
          eq(taskTemplates.atividade, exemplo.atividade),
          eq(taskTemplates.frequency, exemplo.frequencia),
        ),
      )
      .all().length;

    for (const linha of grupo.slice(existentes)) {
      const template = db
        .insert(taskTemplates)
        .values({
          areaId,
          atividade: linha.atividade,
          frequency: linha.frequencia,
          intervalDays: INTERVALO_DIAS[linha.frequencia],
          scheduleMode:
            linha.frequencia === 'DIARIO' || linha.frequencia === 'SEMANAL' ? 'FIXED' : 'FLOATING',
          graceDays: graceDefault(linha.frequencia),
          triggerType: linha.navio ? 'HYBRID' : 'CALENDAR',
          shipPhase: linha.navio ? 'POST_OPERATION' : null,
          leadDays: linha.navio ? 2 : null,
          limitacoes: linha.limitacoes ?? null,
        })
        .returning()
        .get();
      const versao = db
        .insert(metodoVersoes)
        .values({ templateId: template.id, versao: 1, texto: linha.metodo })
        .returning()
        .get();
      db.update(taskTemplates)
        .set({ metodoVersaoAtualId: versao.id })
        .where(eq(taskTemplates.id, template.id))
        .run();
    }
  }
}

const executadoDiretamente =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (executadoDiretamente) {
  const env = loadEnv();
  const { db, sqlite } = createDb(env.RHODES_DATA_DIR);
  runMigrations(db);
  seedCatalogo(db);
  const a = sqlite.prepare('SELECT COUNT(*) as n FROM areas').get() as { n: number };
  const t = sqlite.prepare('SELECT COUNT(*) as n FROM task_templates').get() as { n: number };
  console.log(`seed:catalogo ok — ${a.n} áreas, ${t.n} procedimentos`);
  sqlite.close();
}
