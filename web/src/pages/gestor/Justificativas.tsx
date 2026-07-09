import { useCallback, useEffect, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Container,
  Group,
  Loader,
  Modal,
  Paper,
  Progress,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import {
  type Classificacao,
  type JustificativaFilaItem,
  type ParetoMotivo,
} from '@rhodes/shared';

import { api, ApiError } from '../../lib/api';
import { MOTIVO_LABEL } from '../executante/Tarefa';
import { BANDAS } from '../../theme';

function mensagemDe(err: unknown): string {
  if (err instanceof ApiError && err.corpo?.erro) return err.corpo.erro;
  return 'Falha ao falar com o servidor.';
}

type Estado =
  | { fase: 'carregando' }
  | { fase: 'erro' }
  | { fase: 'ok'; fila: JustificativaFilaItem[]; pareto: ParetoMotivo[] };

/** Fila de aprovação de justificativas + Pareto por motivo (Onda 07). */
export function Justificativas() {
  const [estado, setEstado] = useState<Estado>({ fase: 'carregando' });
  const [alvo, setAlvo] = useState<{ item: JustificativaFilaItem; decisao: 'APROVADA' | 'REPROVADA' } | null>(null);
  const [classificacao, setClassificacao] = useState<Classificacao | null>(null);
  const [obs, setObs] = useState('');
  const [erroAcao, setErroAcao] = useState('');
  const [enviando, setEnviando] = useState(false);

  const carregar = useCallback(() => {
    setEstado({ fase: 'carregando' });
    Promise.all([
      api<JustificativaFilaItem[]>('/api/justificativas?status=PENDENTE'),
      api<{ total: number; pareto: ParetoMotivo[] }>('/api/justificativas/pareto?dias=30'),
    ])
      .then(([fila, p]) => setEstado({ fase: 'ok', fila, pareto: p.pareto }))
      .catch(() => setEstado({ fase: 'erro' }));
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  function abrir(item: JustificativaFilaItem, decisao: 'APROVADA' | 'REPROVADA') {
    setAlvo({ item, decisao });
    setClassificacao(null);
    setObs('');
    setErroAcao('');
  }

  async function decidir() {
    if (!alvo) return;
    const precisaClassificar = alvo.decisao === 'APROVADA' && alvo.item.motivo === 'OUTRO';
    if (precisaClassificar && classificacao === null) {
      setErroAcao('Escolha EXTERNA ou INTERNA.');
      return;
    }
    setEnviando(true);
    setErroAcao('');
    try {
      await api(`/api/justificativas/${alvo.item.id}/decisao`, {
        method: 'PATCH',
        body: {
          decisao: alvo.decisao,
          classificacao: precisaClassificar ? classificacao : undefined,
          obs: obs.trim() === '' ? undefined : obs.trim(),
        },
      });
      setAlvo(null);
      carregar();
    } catch (err) {
      setErroAcao(mensagemDe(err));
    } finally {
      setEnviando(false);
    }
  }

  const maxPareto = estado.fase === 'ok' ? Math.max(1, ...estado.pareto.map((p) => p.total)) : 1;

  return (
    <Container size="md" py="md">
      <Stack gap="lg">
        <Group justify="space-between">
          <Title order={2}>Justificativas</Title>
          <Button variant="default" onClick={carregar}>
            Atualizar
          </Button>
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
            <Stack gap="xs">
              <Text fw={800}>Pendentes ({estado.fila.length})</Text>
              {estado.fila.length === 0 && (
                <Alert color="green">Nenhuma justificativa aguardando decisão.</Alert>
              )}
              {estado.fila.map((j) => (
                <Paper key={j.id} withBorder p="sm">
                  <Group justify="space-between" wrap="nowrap" align="flex-start">
                    <Stack gap={2} style={{ minWidth: 0 }}>
                      <Text fw={600} lineClamp={1}>
                        {j.atividade}
                      </Text>
                      <Group gap="xs">
                        <Badge color="grape">{MOTIVO_LABEL[j.motivo]}</Badge>
                        <Text size="sm" c="dimmed">
                          {j.areaNome} · por {j.criadoPor}
                        </Text>
                      </Group>
                      {j.texto && (
                        <Text size="sm" c="dimmed">
                          “{j.texto}”
                        </Text>
                      )}
                    </Stack>
                    <Group gap="xs" wrap="nowrap">
                      <Button color="green" onClick={() => abrir(j, 'APROVADA')}>
                        Aprovar
                      </Button>
                      <Button color="red" variant="light" onClick={() => abrir(j, 'REPROVADA')}>
                        Reprovar
                      </Button>
                    </Group>
                  </Group>
                </Paper>
              ))}
            </Stack>

            <Stack gap="xs">
              <Text fw={800}>Pareto por motivo (30 dias)</Text>
              {estado.pareto.every((p) => p.total === 0) ? (
                <Text c="dimmed">Nenhuma justificativa nos últimos 30 dias.</Text>
              ) : (
                estado.pareto.map((p) => (
                  <Group key={p.motivo} gap="sm" wrap="nowrap">
                    <Text size="sm" w={200} style={{ flexShrink: 0 }}>
                      {MOTIVO_LABEL[p.motivo]}
                    </Text>
                    <Progress
                      value={(p.total / maxPareto) * 100}
                      color={BANDAS.atencao}
                      size="lg"
                      style={{ flex: 1 }}
                    />
                    <Text size="sm" fw={700} w={64} ta="right">
                      {p.total} ({p.pct}%)
                    </Text>
                  </Group>
                ))
              )}
            </Stack>
          </>
        )}
      </Stack>

      <Modal
        opened={alvo !== null}
        onClose={() => setAlvo(null)}
        title={alvo?.decisao === 'APROVADA' ? 'Aprovar justificativa' : 'Reprovar justificativa'}
      >
        <Stack gap="sm">
          {alvo && (
            <Text size="sm" c="dimmed">
              {MOTIVO_LABEL[alvo.item.motivo]} · {alvo.item.areaNome}
            </Text>
          )}
          {alvo?.decisao === 'APROVADA' && alvo.item.motivo === 'OUTRO' && (
            <Stack gap={4}>
              <Text size="sm" fw={600}>
                Classificar a causa:
              </Text>
              <Group grow>
                <Button
                  variant={classificacao === 'EXTERNA' ? 'filled' : 'default'}
                  onClick={() => setClassificacao('EXTERNA')}
                >
                  Externa (fora do denominador)
                </Button>
                <Button
                  variant={classificacao === 'INTERNA' ? 'filled' : 'default'}
                  onClick={() => setClassificacao('INTERNA')}
                >
                  Interna (crédito 0,5)
                </Button>
              </Group>
            </Stack>
          )}
          <Textarea
            label="Observação (opcional)"
            value={obs}
            onChange={(e) => setObs(e.currentTarget.value)}
            rows={2}
          />
          {erroAcao && <Alert color="red">{erroAcao}</Alert>}
          <Button
            size="xl"
            style={{ height: 64 }}
            fw={800}
            color={alvo?.decisao === 'APROVADA' ? 'green' : 'red'}
            loading={enviando}
            onClick={() => void decidir()}
          >
            Confirmar {alvo?.decisao === 'APROVADA' ? 'aprovação' : 'reprovação'}
          </Button>
        </Stack>
      </Modal>
    </Container>
  );
}
