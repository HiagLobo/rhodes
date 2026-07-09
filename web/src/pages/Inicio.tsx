import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Container,
  Group,
  Loader,
  Modal,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import {
  bandaDoScore,
  grupoDaArea,
  type BandaScore,
  type DashboardPayload,
  type GrupoGrade,
  type InstanciaResumo,
  type SituacaoGrupo,
} from '@rhodes/shared';
import { useNavigate } from 'react-router';

import { api } from '../lib/api';
import { BANDAS } from '../theme';

/** Situação da grade → cor da banda oficial (decisão da Onda 07). */
const COR_SITUACAO: Record<SituacaoGrupo, string> = {
  OVERDUE: BANDAS.critico,
  HOJE: BANDAS.atencao,
  FUTURA: BANDAS.bom,
  NENHUMA: BANDAS.excelente,
};

/** Banda do score → cor (Onda 08). */
export const COR_BANDA: Record<BandaScore, string> = {
  EXCELENTE: BANDAS.excelente,
  BOM: BANDAS.bom,
  ATENCAO: BANDAS.atencao,
  CRITICO: BANDAS.critico,
};

type Estado =
  | { fase: 'carregando' }
  | { fase: 'erro' }
  | { fase: 'ok'; dash: DashboardPayload; agora: InstanciaResumo[] };

/** Dashboard "Agora" (Onda 07): cartões + grade da planta + navio ativo. */
export function Inicio() {
  const navigate = useNavigate();
  const [estado, setEstado] = useState<Estado>({ fase: 'carregando' });
  const [grupoAberto, setGrupoAberto] = useState<GrupoGrade | null>(null);

  const carregar = useCallback(() => {
    setEstado({ fase: 'carregando' });
    // grade+cartões e a lista da AGORA (fonte única do drill-down) numa tacada
    Promise.all([api<DashboardPayload>('/api/dashboard'), api<InstanciaResumo[]>('/api/agora')])
      .then(([dash, agora]) => setEstado({ fase: 'ok', dash, agora }))
      .catch(() => setEstado({ fase: 'erro' }));
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const tarefasDoGrupo = useMemo(() => {
    if (estado.fase !== 'ok' || !grupoAberto) return [];
    return estado.agora.filter((i) => grupoDaArea(i.areaNome) === grupoAberto.grupo);
  }, [estado, grupoAberto]);

  return (
    <Container size="lg" py="md">
      <Stack gap="lg">
        <Group justify="space-between">
          <Title order={2}>Agora</Title>
          <Group gap="xs">
            <Button variant="filled" color="indigo" onClick={() => navigate('/navios')}>
              ⚓ Registrar navio
            </Button>
            <Button variant="default" onClick={carregar}>
              Atualizar
            </Button>
          </Group>
        </Group>

        {estado.fase === 'carregando' && (
          <Group gap="sm">
            <Loader size="sm" />
            <Text fw={600}>Carregando o painel…</Text>
          </Group>
        )}

        {estado.fase === 'erro' && (
          <Alert color="red" title="Não foi possível carregar">
            <Button onClick={carregar}>Tentar novamente</Button>
          </Alert>
        )}

        {estado.fase === 'ok' && (
          <>
            <SimpleGrid cols={{ base: 2, sm: 4 }}>
              <Cartao titulo="Atrasadas" valor={estado.dash.cartoes.atrasadas} cor={BANDAS.critico} />
              <Cartao titulo="Hoje" valor={estado.dash.cartoes.hoje} cor={BANDAS.atencao} />
              <Cartao
                titulo="Aguardando vistoria"
                valor={estado.dash.cartoes.aguardandoVistoria}
                cor={BANDAS.bom}
              />
              <Cartao
                titulo="Score 30d"
                valor={estado.dash.cartoes.score30d === null ? '—' : Math.round(estado.dash.cartoes.score30d)}
                cor={estado.dash.cartoes.score30d === null ? '#495057' : COR_BANDA[bandaDoScore(estado.dash.cartoes.score30d)]}
                nota={estado.dash.cartoes.score30d === null ? 'sem dado ainda' : 'ver detalhe'}
                onClick={() => navigate('/score')}
              />
            </SimpleGrid>

            {estado.dash.rodada && (
              <Paper withBorder p="sm" style={{ borderLeftColor: BANDAS.excelente, borderLeftWidth: 6 }}>
                <Group justify="space-between">
                  <Text fw={700}>
                    ⚓ {estado.dash.rodada.navio}
                    {estado.dash.rodada.status === 'ANUNCIADO'
                      ? ` — aguardando atracação · ETA ${estado.dash.rodada.etaDate}`
                      : ` — ${estado.dash.rodada.status}`}
                  </Text>
                  {estado.dash.rodada.total > 0 && (
                    <Badge size="lg" color="indigo">
                      rodada {estado.dash.rodada.concluidas} de {estado.dash.rodada.total}
                    </Badge>
                  )}
                </Group>
              </Paper>
            )}

            <Stack gap="xs">
              <Text fw={800}>Planta</Text>
              {estado.dash.grade.length === 0 ? (
                <Alert color="green" title="Tudo em dia">
                  Nenhuma tarefa aberta no momento.
                </Alert>
              ) : (
                <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }}>
                  {estado.dash.grade.map((g) => (
                    <Paper
                      key={g.grupo}
                      p="sm"
                      style={{
                        background: COR_SITUACAO[g.situacao],
                        color: '#fff',
                        cursor: 'pointer',
                        minHeight: 84,
                      }}
                      onClick={() => setGrupoAberto(g)}
                    >
                      <Text fw={800}>{g.grupo}</Text>
                      <Text size="sm">
                        {g.atrasadas > 0 && `${g.atrasadas} atrasada(s) · `}
                        {g.abertas} aberta(s)
                      </Text>
                    </Paper>
                  ))}
                </SimpleGrid>
              )}
            </Stack>
          </>
        )}
      </Stack>

      <Modal
        opened={grupoAberto !== null}
        onClose={() => setGrupoAberto(null)}
        title={grupoAberto?.grupo ?? ''}
        size="lg"
      >
        <Stack gap="xs">
          {tarefasDoGrupo.length === 0 && <Text c="dimmed">Nenhuma tarefa aberta neste grupo.</Text>}
          {tarefasDoGrupo.map((t) => (
            <Paper key={t.id} withBorder p="xs">
              <Group justify="space-between" wrap="nowrap">
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <Text fw={600} lineClamp={1}>
                    {t.atividade}
                  </Text>
                  <Text size="sm" c="dimmed">
                    {t.areaNome} · vence {t.dueDate}
                    {t.status === 'OVERDUE' && ' · ATRASADA'}
                  </Text>
                </Stack>
                <Button size="compact-md" onClick={() => navigate(`/tarefas/${t.id}`)}>
                  Abrir
                </Button>
              </Group>
            </Paper>
          ))}
        </Stack>
      </Modal>
    </Container>
  );
}

function Cartao({
  titulo,
  valor,
  cor,
  nota,
  onClick,
}: {
  titulo: string;
  valor: number | string;
  cor: string;
  nota?: string;
  onClick?: () => void;
}) {
  return (
    <Paper
      withBorder
      p="md"
      style={{ borderTopColor: cor, borderTopWidth: 6, cursor: onClick ? 'pointer' : undefined }}
      onClick={onClick}
    >
      <Text size="sm" fw={700} c="dimmed">
        {titulo}
      </Text>
      <Text fw={900} style={{ fontSize: 44, lineHeight: 1.1, color: cor }}>
        {valor}
      </Text>
      {nota && (
        <Text size="xs" c="dimmed">
          {nota}
        </Text>
      )}
    </Paper>
  );
}
