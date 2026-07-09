import { useCallback, useEffect, useMemo, useState } from 'react';

import { Alert, Badge, Button, Container, Group, Loader, Paper, Stack, Text, Title, Tooltip } from '@mantine/core';
import type { CalendarioPayload, InstanceStatus, OcorrenciaCalendario } from '@rhodes/shared';

import { api } from '../../lib/api';
import { BANDAS } from '../../theme';

/** Cor da banda por status materializado; projetada = cinza tracejado. */
function corDoDia(oc: OcorrenciaCalendario): string {
  if (oc.projetado) return '#adb5bd';
  const mapa: Record<InstanceStatus, string> = {
    OVERDUE: BANDAS.critico,
    MISSED: BANDAS.critico,
    DONE_LATE: BANDAS.atencao,
    IN_PROGRESS: BANDAS.atencao,
    PENDING: BANDAS.bom,
    DONE_ON_TIME: BANDAS.bom,
  };
  return oc.status ? mapa[oc.status] : BANDAS.bom;
}

type Estado = { fase: 'carregando' } | { fase: 'erro' } | { fase: 'ok'; dados: CalendarioPayload };

/** Calendário mensal SOMENTE LEITURA: materializadas + projeção (nunca escreve). */
export function Calendario() {
  const [mes, setMes] = useState<string | null>(null); // null = mês corrente (servidor decide)
  const [estado, setEstado] = useState<Estado>({ fase: 'carregando' });

  const carregar = useCallback(() => {
    setEstado({ fase: 'carregando' });
    api<CalendarioPayload>(`/api/calendario${mes ? `?mes=${mes}` : ''}`)
      .then((dados) => setEstado({ fase: 'ok', dados }))
      .catch(() => setEstado({ fase: 'erro' }));
  }, [mes]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const mesAtual = estado.fase === 'ok' ? estado.dados.mes : mes;

  const porDia = useMemo(() => {
    if (estado.fase !== 'ok') return new Map<string, OcorrenciaCalendario[]>();
    const m = new Map<string, OcorrenciaCalendario[]>();
    for (const oc of estado.dados.ocorrencias) {
      m.set(oc.dia, [...(m.get(oc.dia) ?? []), oc]);
    }
    return m;
  }, [estado]);

  function navegar(delta: number) {
    const base = mesAtual ?? new Date().toISOString().slice(0, 7);
    const [y, mm] = base.split('-').map(Number);
    const total = y! * 12 + (mm! - 1) + delta;
    setMes(`${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`);
  }

  const dias = mesAtual ? diasDoMes(mesAtual) : [];

  return (
    <Container size="lg" py="md">
      <Stack gap="md">
        <Group justify="space-between">
          <Title order={2}>Calendário</Title>
          <Group gap="xs">
            <Button variant="default" onClick={() => navegar(-1)}>
              ← Mês anterior
            </Button>
            <Text fw={700} w={100} ta="center">
              {mesAtual}
            </Text>
            <Button variant="default" onClick={() => navegar(1)}>
              Próximo mês →
            </Button>
          </Group>
        </Group>

        <Group gap="md">
          <Badge color="green">agendada</Badge>
          <Badge color="orange">atrasada/atenção</Badge>
          <Badge color="red">perdida</Badge>
          <Badge color="gray">projetada (assume conclusão no prazo)</Badge>
        </Group>

        {estado.fase === 'carregando' && (
          <Group gap="sm">
            <Loader size="sm" />
            <Text fw={600}>Carregando…</Text>
          </Group>
        )}

        {estado.fase === 'erro' && (
          <Alert color="red" title="Não foi possível carregar">
            <Button onClick={carregar}>Tentar novamente</Button>
          </Alert>
        )}

        {estado.fase === 'ok' && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
              {dias.map((dia) => {
                const ocs = porDia.get(dia) ?? [];
                return (
                  <Paper key={dia} withBorder p={4} style={{ minHeight: 84 }}>
                    <Text size="xs" c="dimmed">
                      {Number(dia.slice(-2))}
                    </Text>
                    <Stack gap={2}>
                      {ocs.map((oc, i) => (
                        <Tooltip
                          key={`${oc.templateId}-${i}`}
                          label={`${oc.atividade} · ${oc.areaNome}${oc.projetado ? ' (projetada)' : ` · ${oc.status}`}`}
                        >
                          <div
                            style={{
                              background: corDoDia(oc),
                              color: '#fff',
                              borderRadius: 4,
                              padding: '1px 4px',
                              fontSize: 11,
                              border: oc.projetado ? '1px dashed #6c757d' : undefined,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {oc.areaNome}
                          </div>
                        </Tooltip>
                      ))}
                    </Stack>
                  </Paper>
                );
              })}
            </div>

            {estado.dados.dependeDeNavio.length > 0 && (
              <Alert color="indigo" title="⚓ Dependem de navio (sem data fixa)">
                <Text size="sm">
                  {estado.dados.dependeDeNavio.map((d) => `${d.atividade} (${d.areaNome})`).join(' · ')}
                </Text>
              </Alert>
            )}
          </>
        )}
      </Stack>
    </Container>
  );
}

/** Todos os dias YYYY-MM-DD de um mês YYYY-MM. */
function diasDoMes(mes: string): string[] {
  const [y, m] = mes.split('-').map(Number);
  const ultimo = new Date(Date.UTC(y!, m!, 0, 12)).getUTCDate();
  return Array.from({ length: ultimo }, (_, i) => `${mes}-${String(i + 1).padStart(2, '0')}`);
}
