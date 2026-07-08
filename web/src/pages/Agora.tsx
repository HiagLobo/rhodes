import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Container,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import type { InstanceStatus, InstanciaResumo } from '@rhodes/shared';

import { useUsuario } from '../App';
import { api, ApiError } from '../lib/api';
import { FREQ_LABEL } from './gestor/Procedimentos';

const STATUS_UI: Record<
  Extract<InstanceStatus, 'PENDING' | 'IN_PROGRESS' | 'OVERDUE'>,
  { rotulo: string; cor: string }
> = {
  OVERDUE: { rotulo: 'Atrasada', cor: 'red' },
  IN_PROGRESS: { rotulo: 'Em execução', cor: 'blue' },
  PENDING: { rotulo: 'Pendente', cor: 'gray' },
};

function mensagemDe(err: unknown): string {
  if (err instanceof ApiError && err.corpo?.erro) return err.corpo.erro;
  return 'Falha ao falar com o servidor.';
}

type Estado = { fase: 'carregando' } | { fase: 'erro' } | { fase: 'ok'; itens: InstanciaResumo[] };

/**
 * AGORA (versão provisória da Onda 03 — a andon com cartões/TV chega na Onda 07).
 * A API já devolve na ordem certa (atrasadas primeiro); aqui só agrupamos por área.
 */
export function Agora() {
  const usuario = useUsuario();
  const podeExecutar = usuario.role === 'EXECUTANTE' || usuario.role === 'GESTOR';
  const [estado, setEstado] = useState<Estado>({ fase: 'carregando' });
  const [erroAcao, setErroAcao] = useState('');

  const carregar = useCallback(() => {
    setEstado({ fase: 'carregando' });
    api<InstanciaResumo[]>('/api/agora')
      .then((itens) => setEstado({ fase: 'ok', itens }))
      .catch(() => setEstado({ fase: 'erro' }));
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const grupos = useMemo(() => {
    if (estado.fase !== 'ok') return [];
    const porArea = new Map<string, InstanciaResumo[]>();
    for (const item of estado.itens) {
      porArea.set(item.areaNome, [...(porArea.get(item.areaNome) ?? []), item]);
    }
    return [...porArea.entries()];
  }, [estado]);

  async function agir(item: InstanciaResumo, acao: 'iniciar' | 'concluir') {
    setErroAcao('');
    try {
      await api(`/api/instancias/${item.id}/${acao}`, { method: 'POST' });
      carregar();
    } catch (err) {
      setErroAcao(mensagemDe(err));
    }
  }

  return (
    <Container size="md" py="md">
      <Stack gap="lg">
        <Group justify="space-between">
          <Title order={2}>Agora</Title>
          <Button variant="default" onClick={carregar}>
            Atualizar
          </Button>
        </Group>

        {erroAcao && (
          <Alert color="red" withCloseButton onClose={() => setErroAcao('')}>
            {erroAcao}
          </Alert>
        )}

        {estado.fase === 'carregando' && (
          <Group gap="sm">
            <Loader size="sm" />
            <Text fw={600}>Carregando as tarefas…</Text>
          </Group>
        )}

        {estado.fase === 'erro' && (
          <Alert color="red" title="Não foi possível carregar">
            <Button onClick={carregar}>Tentar novamente</Button>
          </Alert>
        )}

        {estado.fase === 'ok' && estado.itens.length === 0 && (
          <Alert color="green" title="Tudo em dia">
            Nenhuma tarefa aberta no momento.
          </Alert>
        )}

        {estado.fase === 'ok' &&
          grupos.map(([areaNome, itens]) => (
            <Stack key={areaNome} gap="xs">
              <Text fw={800}>{areaNome}</Text>
              {itens.map((item) => {
                const ui = STATUS_UI[item.status as keyof typeof STATUS_UI] ?? {
                  rotulo: item.status,
                  cor: 'gray',
                };
                return (
                  <Paper key={item.id} withBorder p="sm">
                    <Group justify="space-between" wrap="nowrap">
                      <Stack gap={4} style={{ minWidth: 0 }}>
                        <Text fw={600} lineClamp={2}>
                          {item.atividade}
                        </Text>
                        <Group gap="xs">
                          <Badge color={ui.cor}>{ui.rotulo}</Badge>
                          <Badge variant="light">{FREQ_LABEL[item.frequency]}</Badge>
                          {item.origin === 'SHIP' && <Badge color="indigo">⚓ NAVIO</Badge>}
                          <Text size="sm" c="dimmed">
                            vence {item.dueDate} · janela até {item.windowEnd}
                          </Text>
                          {item.executanteLogin && (
                            <Text size="sm" c="dimmed">
                              com {item.executanteLogin}
                            </Text>
                          )}
                        </Group>
                      </Stack>
                      {podeExecutar && (
                        <Group gap="xs" wrap="nowrap">
                          {(item.status === 'PENDING' || item.status === 'OVERDUE') && (
                            <Button onClick={() => void agir(item, 'iniciar')}>Iniciar</Button>
                          )}
                          {item.status === 'IN_PROGRESS' && (
                            <Button color="green" onClick={() => void agir(item, 'concluir')}>
                              Concluir
                            </Button>
                          )}
                        </Group>
                      )}
                    </Group>
                  </Paper>
                );
              })}
            </Stack>
          ))}
      </Stack>
    </Container>
  );
}
