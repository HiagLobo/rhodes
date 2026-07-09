import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Accordion,
  Alert,
  Badge,
  Button,
  Container,
  Group,
  Image,
  Loader,
  Modal,
  Paper,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import {
  justificarSchema,
  MOTIVOS_JUSTIFICATIVA,
  STATUS_ABERTOS,
  type FotoResumo,
  type InstanciaDetalhe,
  type MotivoJustificativa,
  type TipoFoto,
} from '@rhodes/shared';
import { useNavigate, useParams } from 'react-router';

import { useUsuario } from '../../App';
import { CameraCapture } from '../../components/CameraCapture';
import { api, ApiError } from '../../lib/api';
import { enviarFoto } from '../../lib/foto';

function mensagemDe(err: unknown): string {
  if (err instanceof ApiError && err.corpo?.erro) return err.corpo.erro;
  return 'Falha ao falar com o servidor.';
}

/** Rótulos no vocabulário do pátio (o código é o contrato; o rótulo é conversa). */
export const MOTIVO_LABEL: Record<MotivoJustificativa, string> = {
  NAVIO_OPERANDO: 'Navio operando na área',
  CHUVA: 'Chuva',
  AREA_INTERDITADA: 'Área interditada',
  EQUIP_TERCEIRO: 'Equipamento de terceiro no local',
  FALTA_PESSOAL: 'Falta de pessoal',
  FALTA_MATERIAL: 'Falta de material',
  OUTRO: 'Outro motivo',
};

export function formatarTempo(seg: number): string {
  const h = Math.floor(seg / 3600);
  const m = Math.floor((seg % 3600) / 60);
  const s = seg % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

type Estado = { fase: 'carregando' } | { fase: 'erro' } | { fase: 'ok'; detalhe: InstanciaDetalhe };

type Sucesso = { tempoSeg: number | null; proximaDue: string | null };

/**
 * 1 tarefa = 1 tela = 1 botão gigante (imutável 9): ANTES abre o cronômetro,
 * DEPOIS fecha, CONCLUIR entrega. A UI é casca — o backend valida a evidência.
 */
export function Tarefa() {
  const { id } = useParams();
  const usuario = useUsuario();
  const navigate = useNavigate();
  const [estado, setEstado] = useState<Estado>({ fase: 'carregando' });
  const [capturando, setCapturando] = useState<TipoFoto | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [erroAcao, setErroAcao] = useState('');
  const [sucesso, setSucesso] = useState<Sucesso | null>(null);
  const [, setTick] = useState(0);

  // justificativa ("não foi possível realizar")
  const [justificando, setJustificando] = useState(false);
  const [motivoSel, setMotivoSel] = useState<MotivoJustificativa | null>(null);
  const [textoJust, setTextoJust] = useState('');
  const [fotoImpedimento, setFotoImpedimento] = useState<FotoResumo | null>(null);
  const [erroJust, setErroJust] = useState('');
  const [justificada, setJustificada] = useState<{ proximaDue: string | null } | null>(null);

  // partes ("terminar outro dia")
  const [registrandoParte, setRegistrandoParte] = useState(false);
  const [percentual, setPercentual] = useState<number | null>(null);
  const [obsParte, setObsParte] = useState('');

  const carregar = useCallback(() => {
    api<InstanciaDetalhe>(`/api/instancias/${id}`)
      .then((detalhe) => setEstado({ fase: 'ok', detalhe }))
      .catch(() => setEstado({ fase: 'erro' }));
  }, [id]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const detalhe = estado.fase === 'ok' ? estado.detalhe : null;
  const fotosParte = useMemo(
    () => detalhe?.fotos.filter((f) => f.parte === detalhe.parteCorrente) ?? [],
    [detalhe],
  );
  const temAntes = fotosParte.some((f) => f.tipo === 'ANTES');
  const temDepois = fotosParte.some((f) => f.tipo === 'DEPOIS');
  const aberta =
    detalhe !== null && (STATUS_ABERTOS as readonly string[]).includes(detalhe.status);
  const podeExecutar = usuario.role !== 'VISTORIADOR';

  const inicioMs = useMemo(() => {
    const antes = fotosParte.filter((f) => f.tipo === 'ANTES').map((f) => Date.parse(f.receivedAt));
    return antes.length > 0 ? Math.min(...antes) : null;
  }, [fotosParte]);

  // cronômetro visível enquanto a parte está "aberta" (tem ANTES, falta DEPOIS)
  useEffect(() => {
    if (!aberta || !temAntes || temDepois) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [aberta, temAntes, temDepois]);

  async function aoCapturar(foto: Blob) {
    const tipo = capturando!;
    setCapturando(null);
    setEnviando(true);
    setErroAcao('');
    try {
      // 1 toque a menos: fotografar o ANTES já inicia a tarefa
      // (IMPEDIMENTO não inicia nada — justifica-se sem começar)
      if (
        tipo !== 'IMPEDIMENTO' &&
        detalhe &&
        (detalhe.status === 'PENDING' || detalhe.status === 'OVERDUE')
      ) {
        await api(`/api/instancias/${id}/iniciar`, { method: 'POST' });
      }
      const enviada = await enviarFoto(Number(id), tipo, foto);
      if (tipo === 'IMPEDIMENTO') {
        setFotoImpedimento(enviada);
      } else {
        carregar();
      }
    } catch (err) {
      if (tipo === 'IMPEDIMENTO') {
        setErroJust(mensagemDe(err));
      } else {
        setErroAcao(mensagemDe(err));
        carregar(); // o iniciar pode ter passado — sincroniza o estado real
      }
    } finally {
      setEnviando(false);
    }
  }

  async function justificar() {
    setErroJust('');
    const payload = {
      motivo: motivoSel as MotivoJustificativa,
      texto: textoJust.trim() === '' ? undefined : textoJust.trim(),
      fotoImpedimentoId: fotoImpedimento?.id,
    };
    // mesma validação do backend (contrato em shared) — feedback antes da viagem
    const valido = justificarSchema.safeParse(payload);
    if (!valido.success) {
      setErroJust(valido.error.issues[0]?.message ?? 'Preencha o motivo.');
      return;
    }
    setEnviando(true);
    try {
      const r = await api<{ proximaDue: string | null }>(`/api/instancias/${id}/justificar`, {
        method: 'POST',
        body: valido.data,
      });
      setJustificando(false);
      setJustificada({ proximaDue: r.proximaDue });
    } catch (err) {
      setErroJust(mensagemDe(err));
    } finally {
      setEnviando(false);
    }
  }

  async function registrarParte() {
    if (percentual === null) return;
    setEnviando(true);
    setErroAcao('');
    try {
      await api(`/api/instancias/${id}/partes`, {
        method: 'POST',
        body: {
          percentualAcumulado: percentual,
          observacao: obsParte.trim() === '' ? undefined : obsParte.trim(),
        },
      });
      setRegistrandoParte(false);
      setPercentual(null);
      setObsParte('');
      carregar(); // parte nova: o ciclo de fotos recomeça
    } catch (err) {
      setErroAcao(mensagemDe(err));
      setRegistrandoParte(false);
    } finally {
      setEnviando(false);
    }
  }

  async function concluir() {
    setEnviando(true);
    setErroAcao('');
    try {
      const r = await api<{ proximaDue: string | null; tempoExecucaoSeg: number | null }>(
        `/api/instancias/${id}/concluir`,
        { method: 'POST' },
      );
      setSucesso({ tempoSeg: r.tempoExecucaoSeg, proximaDue: r.proximaDue });
    } catch (err) {
      setErroAcao(mensagemDe(err));
    } finally {
      setEnviando(false);
    }
  }

  if (justificada) {
    return (
      <Container size="xs" py="xl">
        <Paper withBorder p="xl">
          <Stack align="center" gap="sm">
            <Title order={2}>Tarefa reagendada</Title>
            {justificada.proximaDue && (
              <Text size="xl" fw={800}>
                Nova data: {justificada.proximaDue}
              </Text>
            )}
            <Badge size="lg" color="yellow">
              aguardando aprovação do gestor
            </Badge>
            <Button size="xl" fullWidth style={{ height: 64 }} onClick={() => navigate('/agora')}>
              Voltar para as tarefas
            </Button>
          </Stack>
        </Paper>
      </Container>
    );
  }

  if (sucesso) {
    return (
      <Container size="xs" py="xl">
        <Paper withBorder p="xl">
          <Stack align="center" gap="sm">
            <Title order={2}>✅ Tarefa concluída</Title>
            {sucesso.tempoSeg !== null && (
              <Text size="xl" fw={800}>
                Tempo de execução: {formatarTempo(sucesso.tempoSeg)}
              </Text>
            )}
            {sucesso.proximaDue && <Text c="dimmed">Próxima vez: {sucesso.proximaDue}</Text>}
            <Button size="xl" fullWidth style={{ height: 64 }} onClick={() => navigate('/agora')}>
              Voltar para as tarefas
            </Button>
          </Stack>
        </Paper>
      </Container>
    );
  }

  return (
    <Container size="xs" py="md">
      <Stack gap="md">
        {estado.fase === 'carregando' && (
          <Group gap="sm">
            <Loader size="sm" />
            <Text fw={600}>Carregando a tarefa…</Text>
          </Group>
        )}

        {estado.fase === 'erro' && (
          <Alert color="red" title="Não foi possível carregar">
            <Button onClick={carregar}>Tentar novamente</Button>
          </Alert>
        )}

        {detalhe && (
          <>
            <Stack gap={4}>
              <Text c="dimmed" fw={600}>
                {detalhe.areaNome}
              </Text>
              <Title order={3}>{detalhe.atividade}</Title>
              <Group gap="xs">
                <Badge color={detalhe.status === 'OVERDUE' ? 'red' : 'blue'}>{detalhe.status}</Badge>
                {detalhe.origin === 'SHIP' && <Badge color="indigo">⚓ NAVIO</Badge>}
                <Text size="sm" c="dimmed">
                  vence {detalhe.dueDate} · janela até {detalhe.windowEnd}
                </Text>
              </Group>
              {detalhe.limitacoes && (
                <Text size="sm" c="orange">
                  ⚠ {detalhe.limitacoes}
                </Text>
              )}
            </Stack>

            {detalhe.metodo && (
              <Accordion variant="contained">
                <Accordion.Item value="metodo">
                  <Accordion.Control>Como será feito</Accordion.Control>
                  <Accordion.Panel style={{ whiteSpace: 'pre-wrap' }}>
                    {detalhe.metodo}
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            )}

            {erroAcao && (
              <Alert color="red" withCloseButton onClose={() => setErroAcao('')}>
                {erroAcao}
              </Alert>
            )}

            {detalhe.partes.length > 0 && (
              <Alert color="blue" p="xs">
                Executada em partes — última: {detalhe.partes.at(-1)!.percentualAcumulado}% (parte{' '}
                {detalhe.partes.at(-1)!.parte}).
              </Alert>
            )}

            {fotosParte.length > 0 && (
              <Group gap="xs">
                {fotosParte.map((f) => (
                  <Stack key={f.id} gap={2} align="center">
                    <Image src={`/api/fotos/${f.id}/thumb`} w={72} h={72} radius="sm" />
                    <Badge size="xs" variant="light">
                      {f.tipo}
                    </Badge>
                  </Stack>
                ))}
              </Group>
            )}

            {aberta && podeExecutar && (
              <Stack gap="xs">
                {temAntes && !temDepois && inicioMs !== null && (
                  <Text size="xl" fw={800} ta="center">
                    ⏱ {formatarTempo(Math.max(0, Math.floor((Date.now() - inicioMs) / 1000)))}
                  </Text>
                )}

                {!temAntes && (
                  <Button
                    size="xl"
                    fullWidth
                    style={{ height: 72 }}
                    fw={800}
                    loading={enviando}
                    onClick={() => setCapturando('ANTES')}
                  >
                    📷 FOTOGRAFAR O ANTES
                  </Button>
                )}
                {temAntes && !temDepois && (
                  <Button
                    size="xl"
                    fullWidth
                    style={{ height: 72 }}
                    fw={800}
                    loading={enviando}
                    onClick={() => setCapturando('DEPOIS')}
                  >
                    📷 FOTOGRAFAR O DEPOIS
                  </Button>
                )}
                {temAntes && temDepois && (
                  <Button
                    size="xl"
                    fullWidth
                    style={{ height: 72 }}
                    fw={800}
                    color="green"
                    loading={enviando}
                    onClick={() => void concluir()}
                  >
                    ✔ CONCLUIR TAREFA
                  </Button>
                )}

                <Group gap="xs" justify="center">
                  {temAntes && !temDepois && (
                    <Button variant="subtle" size="compact-sm" onClick={() => setCapturando('ANTES')}>
                      + foto do antes
                    </Button>
                  )}
                  {temDepois && (
                    <Button variant="subtle" size="compact-sm" onClick={() => setCapturando('DEPOIS')}>
                      + foto do depois
                    </Button>
                  )}
                </Group>

                <Group gap="xs" grow>
                  {temAntes && temDepois && (
                    <Button variant="default" onClick={() => setRegistrandoParte(true)}>
                      Terminar outro dia
                    </Button>
                  )}
                  <Button color="red" variant="light" onClick={() => setJustificando(true)}>
                    Não foi possível realizar
                  </Button>
                </Group>
              </Stack>
            )}

            {!aberta && (
              <Alert color={detalhe.status.startsWith('DONE') ? 'green' : 'yellow'}>
                <Stack gap={4}>
                  <Text fw={700}>Tarefa fechada ({detalhe.status}).</Text>
                  {detalhe.tempoExecucaoSeg !== null && (
                    <Text>Tempo de execução: {formatarTempo(detalhe.tempoExecucaoSeg)}</Text>
                  )}
                  {detalhe.justificativa && (
                    <Text>
                      Justificada ({detalhe.justificativa.motivo}) — {detalhe.justificativa.status}.
                    </Text>
                  )}
                </Stack>
              </Alert>
            )}
          </>
        )}
      </Stack>

      <Modal
        opened={justificando}
        onClose={() => setJustificando(false)}
        title="Não foi possível realizar"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Escolha o motivo — a tarefa será reagendada e o gestor avisado.
          </Text>
          {MOTIVOS_JUSTIFICATIVA.map((motivo) => (
            <Button
              key={motivo}
              size="lg"
              fullWidth
              variant={motivoSel === motivo ? 'filled' : 'default'}
              onClick={() => setMotivoSel(motivo)}
            >
              {MOTIVO_LABEL[motivo]}
            </Button>
          ))}
          <Textarea
            label="O que aconteceu"
            description={motivoSel === 'OUTRO' ? 'Obrigatório para "Outro motivo".' : 'Opcional.'}
            value={textoJust}
            onChange={(e) => setTextoJust(e.currentTarget.value)}
            rows={2}
          />
          {fotoImpedimento ? (
            <Group gap="xs">
              <Image src={`/api/fotos/${fotoImpedimento.id}/thumb`} w={72} h={72} radius="sm" />
              <Text size="sm">✔ Foto do impedimento anexada</Text>
            </Group>
          ) : (
            <Button variant="default" onClick={() => setCapturando('IMPEDIMENTO')}>
              📷 Foto do impedimento (opcional)
            </Button>
          )}
          {erroJust && <Alert color="red">{erroJust}</Alert>}
          <Button
            size="xl"
            style={{ height: 64 }}
            fw={800}
            color="red"
            disabled={motivoSel === null}
            loading={enviando}
            onClick={() => void justificar()}
          >
            Confirmar
          </Button>
        </Stack>
      </Modal>

      <Modal
        opened={registrandoParte}
        onClose={() => setRegistrandoParte(false)}
        title="Terminar outro dia"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Quanto da tarefa já está feito? As fotos de hoje ficam guardadas nesta parte; amanhã o
            ciclo recomeça (novo antes e depois).
          </Text>
          <Group grow>
            {[25, 50, 75].map((pct) => {
              const ultimo = detalhe?.partes.at(-1)?.percentualAcumulado ?? 0;
              return (
                <Button
                  key={pct}
                  size="lg"
                  variant={percentual === pct ? 'filled' : 'default'}
                  disabled={pct <= ultimo}
                  onClick={() => setPercentual(pct)}
                >
                  {pct}%
                </Button>
              );
            })}
          </Group>
          <Textarea
            label="Observação (opcional)"
            value={obsParte}
            onChange={(e) => setObsParte(e.currentTarget.value)}
            rows={2}
          />
          <Button
            size="xl"
            style={{ height: 64 }}
            fw={800}
            disabled={percentual === null}
            loading={enviando}
            onClick={() => void registrarParte()}
          >
            Registrar parte
          </Button>
        </Stack>
      </Modal>

      {capturando && (
        <CameraCapture
          titulo={
            capturando === 'IMPEDIMENTO'
              ? 'Foto do impedimento'
              : capturando === 'ANTES'
                ? 'Foto do ANTES'
                : 'Foto do DEPOIS'
          }
          onFoto={(foto) => void aoCapturar(foto)}
          onCancelar={() => setCapturando(null)}
        />
      )}
    </Container>
  );
}
