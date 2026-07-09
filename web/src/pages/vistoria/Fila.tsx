import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Container,
  Group,
  Loader,
  Paper,
  Select,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useNavigate } from 'react-router';

import { api } from '../../lib/api';
import { formatarTempo } from '../executante/Tarefa';

export type ItemFila = {
  id: number;
  areaId: number;
  areaNome: string;
  atividade: string;
  executanteLogin: string | null;
  status: string;
  finishedAt: string | null;
  roundId: number | null;
  origin: string;
  reworkOfInstanceId: number | null;
  tempoExecucaoSeg: number | null;
  amostral: boolean;
};

type Estado = { fase: 'carregando' } | { fase: 'erro' } | { fase: 'ok'; itens: ItemFila[] };

/** Fila de vistoria — mais antigas primeiro (a API já ordena; amostrais destacadas). */
export function Fila() {
  const navigate = useNavigate();
  const [estado, setEstado] = useState<Estado>({ fase: 'carregando' });
  const [areaFiltro, setAreaFiltro] = useState<string | null>(null);

  const carregar = useCallback(() => {
    setEstado({ fase: 'carregando' });
    api<ItemFila[]>('/api/vistoria/fila')
      .then((itens) => setEstado({ fase: 'ok', itens }))
      .catch(() => setEstado({ fase: 'erro' }));
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const areas = useMemo(() => {
    if (estado.fase !== 'ok') return [];
    return [...new Set(estado.itens.map((i) => i.areaNome))].map((nome) => ({
      value: nome,
      label: nome,
    }));
  }, [estado]);

  const itens = useMemo(() => {
    if (estado.fase !== 'ok') return [];
    return areaFiltro ? estado.itens.filter((i) => i.areaNome === areaFiltro) : estado.itens;
  }, [estado, areaFiltro]);

  return (
    <Container size="md" py="md">
      <Stack gap="md">
        <Group justify="space-between">
          <Title order={2}>Vistoria</Title>
          <Group gap="xs">
            <Select
              placeholder="Todas as áreas"
              data={areas}
              value={areaFiltro}
              onChange={setAreaFiltro}
              clearable
              w={260}
            />
            <Button variant="default" onClick={carregar}>
              Atualizar
            </Button>
          </Group>
        </Group>

        {estado.fase === 'carregando' && (
          <Group gap="sm">
            <Loader size="sm" />
            <Text fw={600}>Carregando a fila…</Text>
          </Group>
        )}

        {estado.fase === 'erro' && (
          <Alert color="red" title="Não foi possível carregar">
            <Button onClick={carregar}>Tentar novamente</Button>
          </Alert>
        )}

        {estado.fase === 'ok' && itens.length === 0 && (
          <Alert color="green" title="Fila vazia">
            Nenhuma execução aguardando vistoria.
          </Alert>
        )}

        {itens.map((item) => (
          <Paper key={item.id} withBorder p="sm">
            <Group justify="space-between" wrap="nowrap">
              <Stack gap={4} style={{ minWidth: 0 }}>
                <Text fw={600} lineClamp={2}>
                  {item.atividade}
                </Text>
                <Group gap="xs">
                  <Text size="sm" fw={600}>
                    {item.areaNome}
                  </Text>
                  {item.amostral && <Badge color="grape">⭐ AMOSTRAL</Badge>}
                  {item.roundId !== null && <Badge color="indigo">⚓ rodada #{item.roundId}</Badge>}
                  {item.reworkOfInstanceId !== null && <Badge color="orange">RETRABALHO</Badge>}
                  {item.status === 'DONE_LATE' && <Badge color="yellow">concluída atrasada</Badge>}
                  <Text size="sm" c="dimmed">
                    por {item.executanteLogin ?? '—'}
                    {item.tempoExecucaoSeg !== null &&
                      ` · ⏱ ${formatarTempo(item.tempoExecucaoSeg)}`}
                  </Text>
                </Group>
              </Stack>
              <Button size="lg" onClick={() => navigate(`/vistoria/${item.id}`)}>
                Inspecionar
              </Button>
            </Group>
          </Paper>
        ))}
      </Stack>
    </Container>
  );
}
