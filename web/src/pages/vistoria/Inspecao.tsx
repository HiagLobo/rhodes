import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  Image,
  Loader,
  Modal,
  PasswordInput,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import {
  MOTIVOS_REPROVACAO,
  SEVERIDADES,
  type InspecaoResumo,
  type InstanciaDetalhe,
  type MotivoReprovacao,
  type Severidade,
} from '@rhodes/shared';
import { useNavigate, useParams } from 'react-router';

import { useUsuario } from '../../App';
import { api, ApiError } from '../../lib/api';
import { formatarTempo } from '../executante/Tarefa';

function mensagemDe(err: unknown): string {
  if (err instanceof ApiError && err.corpo?.erro) return err.corpo.erro;
  return 'Falha ao falar com o servidor.';
}

const MOTIVO_LABEL: Record<MotivoReprovacao, string> = {
  PO_RESIDUAL: 'Pó residual (>3 mm)',
  MOFO: 'Mofo',
  INFESTACAO: 'Infestação / praga',
  RESIDUO_VISIVEL: 'Resíduo visível',
  METODO_NAO_SEGUIDO: 'Método não seguido',
  OUTRO: 'Outro problema',
};

const SEVERIDADE_LABEL: Record<Severidade, string> = {
  MENOR: 'Menor — refazer em 48 h',
  MAIOR: 'Maior — refazer em 24 h',
  CRITICA: 'Crítica — refazer em 24 h',
};

type Estado = { fase: 'carregando' } | { fase: 'erro' } | { fase: 'ok'; detalhe: InstanciaDetalhe };

/** Comparador ANTES | DEPOIS + decisão assinada com a senha (a API valida tudo). */
export function Inspecao() {
  const { id } = useParams();
  const usuario = useUsuario();
  const navigate = useNavigate();
  const [estado, setEstado] = useState<Estado>({ fase: 'carregando' });
  const [modal, setModal] = useState<'APROVAR' | 'REPROVAR' | null>(null);
  const [senha, setSenha] = useState('');
  const [motivo, setMotivo] = useState<MotivoReprovacao | null>(null);
  const [severidade, setSeveridade] = useState<Severidade | null>(null);
  const [texto, setTexto] = useState('');
  const [erroAcao, setErroAcao] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [decisao, setDecisao] = useState<InspecaoResumo | null>(null);

  const carregar = useCallback(() => {
    api<InstanciaDetalhe>(`/api/instancias/${id}`)
      .then((detalhe) => setEstado({ fase: 'ok', detalhe }))
      .catch(() => setEstado({ fase: 'erro' }));
  }, [id]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const detalhe = estado.fase === 'ok' ? estado.detalhe : null;
  const podeDecidir =
    (usuario.role === 'VISTORIADOR' || usuario.role === 'GESTOR') &&
    detalhe !== null &&
    detalhe.inspecao === null &&
    decisao === null &&
    (detalhe.status === 'DONE_ON_TIME' || detalhe.status === 'DONE_LATE');

  const partes = useMemo(() => {
    if (!detalhe) return [];
    return [...new Set(detalhe.fotos.map((f) => f.parte))].sort((a, b) => a - b);
  }, [detalhe]);

  async function decidir() {
    setErroAcao('');
    setEnviando(true);
    try {
      const r =
        modal === 'APROVAR'
          ? await api<InspecaoResumo>(`/api/instancias/${id}/aprovar`, {
              method: 'POST',
              body: { senha },
            })
          : await api<InspecaoResumo>(`/api/instancias/${id}/reprovar`, {
              method: 'POST',
              body: {
                senha,
                motivo,
                severidade,
                texto: texto.trim() === '' ? undefined : texto.trim(),
              },
            });
      setModal(null);
      setSenha('');
      setDecisao(r);
    } catch (err) {
      setErroAcao(mensagemDe(err));
    } finally {
      setEnviando(false);
    }
  }

  if (decisao) {
    return (
      <Container size="xs" py="xl">
        <Alert
          color={decisao.resultado === 'APROVADA' ? 'green' : 'orange'}
          title={decisao.resultado === 'APROVADA' ? '✅ Execução aprovada' : 'Execução reprovada'}
        >
          <Stack gap="xs">
            {decisao.resultado === 'REPROVADA' && decisao.retrabalhoDue && (
              <Text fw={700}>Retrabalho gerado para {decisao.retrabalhoDue}.</Text>
            )}
            <Text size="sm">Decisão assinada e registrada na trilha de auditoria.</Text>
            <Button size="lg" onClick={() => navigate('/vistoria')}>
              Próxima da fila
            </Button>
          </Stack>
        </Alert>
      </Container>
    );
  }

  return (
    <Container size="md" py="md">
      <Stack gap="md">
        {estado.fase === 'carregando' && (
          <Group gap="sm">
            <Loader size="sm" />
            <Text fw={600}>Carregando a execução…</Text>
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
                <Badge>{detalhe.status}</Badge>
                {detalhe.origin === 'SHIP' && <Badge color="indigo">⚓ NAVIO</Badge>}
                <Text size="sm" c="dimmed">
                  executada por {detalhe.executanteLogin ?? '—'}
                  {detalhe.tempoExecucaoSeg !== null &&
                    ` · ⏱ ${formatarTempo(detalhe.tempoExecucaoSeg)}`}
                </Text>
              </Group>
            </Stack>

            {detalhe.metodo && (
              <Accordion variant="contained">
                <Accordion.Item value="metodo">
                  <Accordion.Control>Como deveria ser feito</Accordion.Control>
                  <Accordion.Panel style={{ whiteSpace: 'pre-wrap' }}>
                    {detalhe.metodo}
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            )}

            {partes.map((parte) => {
              const antes = detalhe.fotos.filter((f) => f.parte === parte && f.tipo === 'ANTES');
              const depois = detalhe.fotos.filter((f) => f.parte === parte && f.tipo === 'DEPOIS');
              return (
                <Stack key={parte} gap="xs">
                  {partes.length > 1 && <Text fw={700}>Parte {parte}</Text>}
                  <Group align="flex-start" grow>
                    <Stack gap={4}>
                      <Badge variant="light" color="gray">
                        ANTES
                      </Badge>
                      {antes.map((f) => (
                        <Anchor key={f.id} href={`/api/fotos/${f.id}/arquivo`} target="_blank">
                          <Image src={`/api/fotos/${f.id}/thumb`} radius="sm" />
                        </Anchor>
                      ))}
                      {antes.length === 0 && <Text c="dimmed">sem foto</Text>}
                    </Stack>
                    <Stack gap={4}>
                      <Badge variant="light" color="green">
                        DEPOIS
                      </Badge>
                      {depois.map((f) => (
                        <Anchor key={f.id} href={`/api/fotos/${f.id}/arquivo`} target="_blank">
                          <Image src={`/api/fotos/${f.id}/thumb`} radius="sm" />
                        </Anchor>
                      ))}
                      {depois.length === 0 && <Text c="dimmed">sem foto</Text>}
                    </Stack>
                  </Group>
                </Stack>
              );
            })}

            {detalhe.justificativa && (
              <Alert color="yellow">
                Justificada ({detalhe.justificativa.motivo}) — {detalhe.justificativa.status}.
              </Alert>
            )}
            {detalhe.inspecao && (
              <Alert color={detalhe.inspecao.resultado === 'APROVADA' ? 'green' : 'orange'}>
                Vistoriada por {detalhe.inspecao.vistoriador}: {detalhe.inspecao.resultado}
                {detalhe.inspecao.motivo ? ` (${MOTIVO_LABEL[detalhe.inspecao.motivo]})` : ''}.
              </Alert>
            )}

            {erroAcao && (
              <Alert color="red" withCloseButton onClose={() => setErroAcao('')}>
                {erroAcao}
              </Alert>
            )}

            {podeDecidir && (
              <Group grow>
                <Button
                  size="xl"
                  style={{ height: 72 }}
                  fw={800}
                  color="green"
                  onClick={() => setModal('APROVAR')}
                >
                  ✔ APROVAR
                </Button>
                <Button
                  size="xl"
                  style={{ height: 72 }}
                  fw={800}
                  color="red"
                  onClick={() => setModal('REPROVAR')}
                >
                  ✖ REPROVAR
                </Button>
              </Group>
            )}
          </>
        )}
      </Stack>

      <Modal
        opened={modal === 'APROVAR'}
        onClose={() => setModal(null)}
        title="Aprovar execução"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Sua senha é a assinatura eletrônica desta aprovação.
          </Text>
          <PasswordInput
            label="Senha"
            value={senha}
            onChange={(e) => setSenha(e.currentTarget.value)}
          />
          {erroAcao && <Alert color="red">{erroAcao}</Alert>}
          <Button
            size="xl"
            style={{ height: 64 }}
            fw={800}
            color="green"
            disabled={senha === ''}
            loading={enviando}
            onClick={() => void decidir()}
          >
            Assinar e aprovar
          </Button>
        </Stack>
      </Modal>

      <Modal
        opened={modal === 'REPROVAR'}
        onClose={() => setModal(null)}
        title="Reprovar execução"
      >
        <Stack gap="sm">
          <Text size="sm" fw={600}>
            O que foi encontrado?
          </Text>
          {MOTIVOS_REPROVACAO.map((m) => (
            <Button
              key={m}
              size="lg"
              fullWidth
              variant={motivo === m ? 'filled' : 'default'}
              onClick={() => setMotivo(m)}
            >
              {MOTIVO_LABEL[m]}
            </Button>
          ))}
          <Text size="sm" fw={600}>
            Severidade
          </Text>
          <Group grow>
            {SEVERIDADES.map((s) => (
              <Button
                key={s}
                variant={severidade === s ? 'filled' : 'default'}
                color="red"
                onClick={() => setSeveridade(s)}
              >
                {SEVERIDADE_LABEL[s]}
              </Button>
            ))}
          </Group>
          <Textarea
            label="Detalhes"
            description={motivo === 'OUTRO' ? 'Obrigatório para "Outro problema".' : 'Opcional.'}
            value={texto}
            onChange={(e) => setTexto(e.currentTarget.value)}
            rows={2}
          />
          <PasswordInput
            label="Senha (assinatura)"
            value={senha}
            onChange={(e) => setSenha(e.currentTarget.value)}
          />
          {erroAcao && <Alert color="red">{erroAcao}</Alert>}
          <Button
            size="xl"
            style={{ height: 64 }}
            fw={800}
            color="red"
            disabled={senha === '' || motivo === null || severidade === null}
            loading={enviando}
            onClick={() => void decidir()}
          >
            Assinar e reprovar
          </Button>
        </Stack>
      </Modal>
    </Container>
  );
}
