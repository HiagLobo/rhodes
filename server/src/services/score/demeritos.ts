import { eq } from 'drizzle-orm';
import { dataRecife, type DemeritoInput } from '@rhodes/shared';

import type { Db } from '../../db/index.js';
import { demeritos, inspections } from '../../db/schema.js';

// REGRA DO MÓDULO: sem Date.now()/new Date() — a janela chega de fora.

/**
 * Deméritos confirmados cuja data do EVENTO cai na janela [inicio, fim] (YYYY-MM-DD).
 * EIXO DE JANELA = `dataRecife(inspection.criadoEm)` da reprovação (o evento), NUNCA o
 * `demeritos.criadoEm` da confirmação do gestor: um demérito de reprovação antiga confirmado
 * hoje pertence à janela da reprovação (evento é a verdade).
 */
export function demeritosConfirmadosNaJanela(db: Db, inicio: string, fim: string): DemeritoInput[] {
  const rows = db
    .select({ areaId: demeritos.areaId, severidade: demeritos.severidade, inspecaoEm: inspections.criadoEm })
    .from(demeritos)
    .innerJoin(inspections, eq(demeritos.inspectionId, inspections.id))
    .all();

  return rows
    .map((r) => ({
      areaId: r.areaId,
      severidade: r.severidade as DemeritoInput['severidade'],
      dataRecife: dataRecife(r.inspecaoEm),
    }))
    .filter((d) => d.dataRecife >= inicio && d.dataRecife <= fim);
}
