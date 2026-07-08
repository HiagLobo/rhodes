import { useCallback, useEffect, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Container,
  Group,
  Loader,
  Modal,
  NumberInput,
  Paper,
  Progress,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import {
  proximaTransicao,
  type NavioStatus,
  type OperacaoNavio,
  type RodadaResumo,
} from '@rhodes/shared';

import { useUsuario } from '../App';
import { api, ApiError } from '../lib/api';

const STATUS_LABEL: Record<NavioStatus, string> = {
  ANUNCIADO: 'Anunciado',
  ATRACADO: 'Atracado',
  DESCARGA_INICIADA: 'Descarga iniciada',
  DESCARGA_CONCLUIDA: 'Descarga concluída',
  DESATRACADO: 'Desatracado',
};

function mensagemDe(err: unknown): string {
  if (err instanceof ApiError && err.corpo?.erro) return err.corpo.erro;
  return 'Falha ao falar com o servidor.';
}

/** datetime-local sem segundos, no relógio local do aparelho (registro retroativo). */
function agoraLocal(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

type Rodada = { resumo: RodadaResumo; itens: Array<{ id: number; areaNome: string; atividade: string; status: string }> };

type Estado =
  | { fase: 'carregando' }
  | { fase: 'erro' }
  | { fase: 'ok'; operacoes: OperacaoNavio[]; rodada: Rodada | null };

export function Navios() {
  const usuario = useUsuario();
  const podeRegistrar = usuario.role === 'GESTOR' || usuario.role === 'EXECUTANTE';
  const [estado, setEstado] = useState<Estado>({ fase: 'carregando' });
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  const [anunciando, setAnunciando] = useState(false);
  const [novo, setNovo] = useState({ navio: '', produto: '', tonelagem: 0, etaDate: '' });

  const [transicaoAlvo, setTransicaoAlvo] = useState<{ op: OperacaoNavio; para: NavioStatus } | null>(null);
  const [eventAtLocal, setEventAtLocal] = useState(agoraLocal());

  const carregar = useCallback(() => {
    setEstado({ fase: 'carregando' });
    api<OperacaoNavio[]>('/api/navios')
      .then(async (operacoes) => {
        const ativa = operacoes.find((o) => o.status !== 'DESATRACADO') ?? null;
        const rodada = ativa ? await api<Rodada>(`/api/navios/${ativa.id}/rodada`) : null;
        setEstado({ fase: 'ok', operacoes, rodada });
      })
      .catch(() => setEstado({ fase: 'erro' }));
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function anunciar() {
    setSalvando(true);
    setErro('');
    try {
      await api('/api/navios', {
        method: 'POST',
        body: {
          navio: novo.navio,
          ...(novo.produto.trim() ? { produto: novo.produto.trim() } : {}),
          ...(novo.tonelagem > 0 ? { tonelagem: novo.tonelagem } : {}),
          etaDate: novo.etaDate,
        },
      });
      setAnunciando(false);
      carregar();
    } catch (err) {
      setErro(mensagemDe(err));
    } finally {
      setSalvando(false);
    }
  }

  async function transicionar() {
    if (!transicaoAlvo) return;
    setSalvando(true);
    setErro('');
    try {
      await api(`/api/navios/${transicaoAlvo.op.id}/transicao`, {
        method: 'POST',
        body: { para: transicaoAlvo.para, eventAt: new Date(eventAtLocal).toISOString() },
      });
      setTransicaoAlvo(null);
      carregar();
    } catch (err) {
      setErro(mensagemDe(err));
    } finally {
      setSalvando(false);
    }
  }

  if (estado.fase === 'carregando') {
    return (
      <Container size="md" py="md">
        <Group gap="sm">
          <Loader size="sm" />
          <Text fw={600}>Carregando operações…</Text>
        </Group>
      </Container>
    );
  }
  if (estado.fase === 'erro') {
    return (
      <Container size="md" py="md">
        <Alert color="red" title="Não foi possível carregar">
          <Button onClick={carregar}>Tentar novamente</Button>
        </Alert>
      </Container>
    );
  }

  const ativa = estado.operacoes.find((o) => o.status !== 'DESATRACADO') ?? null;
  const proxima = ativa ? proximaTransicao(ativa.status) : null;

  return (
    <Container size="md" py="md">
      <Stack gap="lg">
        <Group justify="space-between">
          <Title order={2}>Navios</Title>
          {!ativa && podeRegistrar && (
            <Button
              onClick={() => {
                setNovo({ navio: '', produto: '', tonelagem: 0, etaDate: '' });
                setErro('');
                setAnunciando(true);
              }}
            >
              ⚓ Anunciar navio
            </Button>
          )}
        </Group>

        {erro && (
          <Alert color="red" withCloseButton onClose={() => setErro('')}>
            {erro}
          </Alert>
        )}

        {!ativa && (
          <Alert color="blue" title="Nenhuma operação em andamento">
            Quando a Ambev avisar da chegada, anuncie o navio — as limpezas de pré-atracação
            entram sozinhas na fila.
          </Alert>
        )}

        {ativa && (
          <Paper withBorder p="md">
            <Stack gap="md">
              <Group justify="space-between" wrap="nowrap">
                <Stack gap={2}>
                  <Title order={3}>⚓ {ativa.navio}</Title>
                  <Text c="dimmed">
                    {ativa.produto ?? 'produto n/d'} · ETA {ativa.etaDate}
                  </Text>
                </Stack>
                <Badge size="xl">{STATUS_LABEL[ativa.status]}</Badge>
              </Group>

              {proxima && podeRegistrar && (
                <Button
                  size="lg"
                  onClick={() => {
                    setEventAtLocal(agoraLocal());
                    setErro('');
                    setTransicaoAlvo({ op: ativa, para: proxima });
                  }}
                >
                  Registrar: {STATUS_LABEL[proxima]}
                </Button>
              )}

              <Stack gap={4}>
                <Text fw={700}>Linha do tempo</Text>
                {ativa.eventos.map((ev) => (
                  <Group key={ev.id} gap="xs">
                    <Badge variant="light">{STATUS_LABEL[ev.transicao]}</Badge>
                    <Text size="sm">{new Date(ev.eventAt).toLocaleString('pt-BR')}</Text>
                    <Text size="sm" c="dimmed">
                      registrado por {ev.registradoPor}
                      {new Date(ev.registeredAt).getTime() - new Date(ev.eventAt).getTime() >
                        5 * 60_000 && ' (retroativo)'}
                    </Text>
                    {!ev.confirmado && <Badge color="yellow">aguarda confirmação do gestor</Badge>}
                  </Group>
                ))}
              </Stack>

              {estado.rodada && estado.rodada.resumo.total > 0 && (
                <Stack gap={4}>
                  <Text fw={700}>
                    Rodada do navio: {estado.rodada.resumo.concluidas} de{' '}
                    {estado.rodada.resumo.total} concluídas
                  </Text>
                  <Progress
                    value={(estado.rodada.resumo.concluidas / estado.rodada.resumo.total) * 100}
                    size="lg"
                  />
                  {estado.rodada.itens.map((i) => (
                    <Group key={i.id} gap="xs">
                      <Badge
                        color={i.status.startsWith('DONE') ? 'green' : 'gray'}
                        variant="light"
                      >
                        {i.status.startsWith('DONE') ? 'feita' : 'pendente'}
                      </Badge>
                      <Text size="sm">
                        {i.areaNome} — {i.atividade}
                      </Text>
                    </Group>
                  ))}
                </Stack>
              )}
            </Stack>
          </Paper>
        )}
      </Stack>

      <Modal opened={anunciando} onClose={() => setAnunciando(false)} title="Anunciar navio">
        <Stack gap="md">
          <TextInput
            label="Navio"
            value={novo.navio}
            onChange={(e) => setNovo({ ...novo, navio: e.currentTarget.value })}
          />
          <TextInput
            label="Produto (opcional)"
            value={novo.produto}
            onChange={(e) => setNovo({ ...novo, produto: e.currentTarget.value })}
          />
          <NumberInput
            label="Tonelagem (opcional)"
            min={0}
            value={novo.tonelagem}
            onChange={(v) => setNovo({ ...novo, tonelagem: Number(v) || 0 })}
          />
          <TextInput
            label="ETA (chegada prevista)"
            placeholder="AAAA-MM-DD"
            value={novo.etaDate}
            onChange={(e) => setNovo({ ...novo, etaDate: e.currentTarget.value })}
          />
          {erro && <Alert color="red">{erro}</Alert>}
          <Button loading={salvando} onClick={() => void anunciar()}>
            Anunciar
          </Button>
        </Stack>
      </Modal>

      <Modal
        opened={transicaoAlvo !== null}
        onClose={() => setTransicaoAlvo(null)}
        title={transicaoAlvo ? `Registrar: ${STATUS_LABEL[transicaoAlvo.para]}` : ''}
      >
        <Stack gap="md">
          <TextInput
            type="datetime-local"
            label="Hora real do fato"
            description="ajuste para trás se aconteceu de madrugada — o registro fica com as duas horas"
            value={eventAtLocal}
            onChange={(e) => setEventAtLocal(e.currentTarget.value)}
          />
          {erro && <Alert color="red">{erro}</Alert>}
          <Button loading={salvando} onClick={() => void transicionar()}>
            Confirmar registro
          </Button>
        </Stack>
      </Modal>
    </Container>
  );
}
