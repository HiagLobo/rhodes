import { useCallback, useEffect, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Container,
  Divider,
  Group,
  Loader,
  Modal,
  NumberInput,
  Paper,
  Select,
  Spoiler,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import {
  FREQUENCIAS,
  SCHEDULE_MODES,
  SHIP_PHASES,
  TRIGGER_TYPES,
  type Area,
  type Frequencia,
  type ProcedimentoDetalhe as Detalhe,
  type ScheduleMode,
  type ShipPhase,
  type TriggerType,
} from '@rhodes/shared';
import { Link, useParams } from 'react-router';

import { api, ApiError } from '../../lib/api';
import { BadgesProcedimento, FASE_LABEL, FREQ_LABEL, TRIGGER_LABEL } from './Procedimentos';

function mensagemDe(err: unknown): string {
  if (err instanceof ApiError && err.corpo?.erro) return err.corpo.erro;
  return 'Falha ao falar com o servidor.';
}

type Estado =
  | { fase: 'carregando' }
  | { fase: 'erro' }
  | { fase: 'ok'; proc: Detalhe; areas: Area[] };

/** Detalhe do procedimento: campos operacionais, método vigente e histórico de versões. */
export function ProcedimentoDetalhe() {
  const { id } = useParams();
  const [estado, setEstado] = useState<Estado>({ fase: 'carregando' });
  const [form, setForm] = useState({
    frequency: 'QUINZENAL' as Frequencia,
    scheduleMode: 'FLOATING' as ScheduleMode,
    graceDays: 1,
    triggerType: 'CALENDAR' as TriggerType,
    shipPhase: 'POST_OPERATION' as ShipPhase,
    leadDays: 2,
    limitacoes: '',
    minFotosIntervaloMin: 5,
  });
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);
  const [salvando, setSalvando] = useState(false);

  const [novaVersao, setNovaVersao] = useState<string | null>(null);

  const carregar = useCallback(() => {
    setEstado({ fase: 'carregando' });
    Promise.all([api<Detalhe>(`/api/procedimentos/${id}`), api<Area[]>('/api/areas')])
      .then(([proc, areas]) => {
        setEstado({ fase: 'ok', proc, areas });
        setForm({
          frequency: proc.frequency,
          scheduleMode: proc.scheduleMode,
          graceDays: proc.graceDays,
          triggerType: proc.triggerType,
          shipPhase: proc.shipPhase ?? 'POST_OPERATION',
          leadDays: proc.leadDays ?? 2,
          limitacoes: proc.limitacoes ?? '',
          minFotosIntervaloMin: proc.minFotosIntervaloMin,
        });
      })
      .catch(() => setEstado({ fase: 'erro' }));
  }, [id]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  if (estado.fase === 'carregando') {
    return (
      <Container size="md" py="md">
        <Group gap="sm">
          <Loader size="sm" />
          <Text fw={600}>Carregando procedimento…</Text>
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

  const { proc, areas } = estado;
  const area = areas.find((a) => a.id === proc.areaId);

  async function salvar() {
    setSalvando(true);
    setFeedback(null);
    try {
      await api(`/api/procedimentos/${proc.id}`, {
        method: 'PATCH',
        body: {
          frequency: form.frequency,
          scheduleMode: form.scheduleMode,
          graceDays: form.graceDays,
          minFotosIntervaloMin: form.minFotosIntervaloMin,
          triggerType: form.triggerType,
          ...(form.triggerType !== 'CALENDAR'
            ? { shipPhase: form.shipPhase, leadDays: form.leadDays }
            : {}),
          limitacoes: form.limitacoes.trim() ? form.limitacoes.trim() : null,
        },
      });
      setFeedback({ tipo: 'ok', texto: 'Alterações salvas (registradas na trilha de auditoria).' });
      carregar();
    } catch (err) {
      setFeedback({ tipo: 'erro', texto: mensagemDe(err) });
    } finally {
      setSalvando(false);
    }
  }

  async function salvarNovaVersao() {
    if (novaVersao === null) return;
    setSalvando(true);
    try {
      await api(`/api/procedimentos/${proc.id}/metodo`, {
        method: 'POST',
        body: { texto: novaVersao },
      });
      setNovaVersao(null);
      carregar();
    } catch (err) {
      setFeedback({ tipo: 'erro', texto: mensagemDe(err) });
      setSalvando(false);
      return;
    }
    setSalvando(false);
  }

  async function alternarAtivo() {
    const acao = proc.ativo ? 'desativar' : 'reativar';
    if (proc.ativo && !window.confirm('Desativar este procedimento do plano mestre?')) return;
    try {
      await api(`/api/procedimentos/${proc.id}/${acao}`, { method: 'POST' });
      carregar();
    } catch (err) {
      setFeedback({ tipo: 'erro', texto: mensagemDe(err) });
    }
  }

  return (
    <Container size="md" py="md">
      <Stack gap="lg">
        <Group justify="space-between" align="flex-start">
          <Stack gap={4}>
            <Text c="dimmed" fw={600}>
              <Link to="/gestor/procedimentos">Plano Mestre</Link> · {area?.nome ?? '—'}
            </Text>
            <Title order={3}>{proc.atividade}</Title>
            <BadgesProcedimento p={proc} />
          </Stack>
          <Button variant="default" color={proc.ativo ? 'red' : 'green'} onClick={() => void alternarAtivo()}>
            {proc.ativo ? 'Desativar' : 'Reativar'}
          </Button>
        </Group>

        {feedback && (
          <Alert color={feedback.tipo === 'ok' ? 'green' : 'red'} withCloseButton onClose={() => setFeedback(null)}>
            {feedback.texto}
          </Alert>
        )}

        <Paper withBorder p="md">
          <Group justify="space-between" mb="xs">
            <Text fw={700}>Como será feito (método vigente — v{proc.metodoAtual?.versao})</Text>
            <Button
              size="compact-md"
              variant="default"
              onClick={() => setNovaVersao(proc.metodoAtual?.texto ?? '')}
            >
              Nova versão do método
            </Button>
          </Group>
          <Text style={{ whiteSpace: 'pre-wrap' }}>{proc.metodoAtual?.texto}</Text>
        </Paper>

        <Paper withBorder p="md">
          <Text fw={700} mb="sm">
            Agendamento e regras
          </Text>
          <Stack gap="md">
            <Group grow>
              <Select
                label="Frequência"
                description="mudar re-deriva intervalo e tolerância (regra dos 10%)"
                data={FREQUENCIAS.map((f) => ({ value: f, label: FREQ_LABEL[f] }))}
                value={form.frequency}
                onChange={(v) => setForm({ ...form, frequency: (v ?? form.frequency) as Frequencia })}
                allowDeselect={false}
              />
              <Select
                label="Modo"
                description="FIXED ancora no calendário; FLOATING conta da conclusão"
                data={[...SCHEDULE_MODES]}
                value={form.scheduleMode}
                onChange={(v) => setForm({ ...form, scheduleMode: (v ?? form.scheduleMode) as ScheduleMode })}
                allowDeselect={false}
              />
              <NumberInput
                label="Tolerância (dias)"
                min={0}
                max={60}
                value={form.graceDays}
                onChange={(v) => setForm({ ...form, graceDays: Number(v) || 0 })}
              />
              <NumberInput
                label="Mín. entre fotos (min)"
                description="Intervalo mínimo entre ANTES e DEPOIS"
                min={1}
                max={240}
                value={form.minFotosIntervaloMin}
                onChange={(v) => setForm({ ...form, minFotosIntervaloMin: Number(v) || 1 })}
              />
            </Group>
            <Group grow>
              <Select
                label="Gatilho"
                data={TRIGGER_TYPES.map((t) => ({ value: t, label: TRIGGER_LABEL[t] }))}
                value={form.triggerType}
                onChange={(v) => setForm({ ...form, triggerType: (v ?? form.triggerType) as TriggerType })}
                allowDeselect={false}
              />
              {form.triggerType !== 'CALENDAR' && (
                <>
                  <Select
                    label="Fase do navio"
                    data={SHIP_PHASES.map((f) => ({ value: f, label: FASE_LABEL[f] }))}
                    value={form.shipPhase}
                    onChange={(v) => setForm({ ...form, shipPhase: (v ?? form.shipPhase) as ShipPhase })}
                    allowDeselect={false}
                  />
                  <NumberInput
                    label="Prazo após o evento (dias)"
                    min={0}
                    max={30}
                    value={form.leadDays}
                    onChange={(v) => setForm({ ...form, leadDays: Number(v) || 0 })}
                  />
                </>
              )}
            </Group>
            <Textarea
              label="Limitações registradas"
              minRows={2}
              autosize
              value={form.limitacoes}
              onChange={(e) => setForm({ ...form, limitacoes: e.currentTarget.value })}
            />
            <Group justify="flex-end">
              <Button loading={salvando} onClick={() => void salvar()}>
                Salvar alterações
              </Button>
            </Group>
          </Stack>
        </Paper>

        <Paper withBorder p="md">
          <Text fw={700} mb="sm">
            Histórico de versões do método
          </Text>
          <Stack gap="sm">
            {proc.historico.map((v) => (
              <Stack key={v.id} gap={4}>
                <Group gap="sm">
                  <Badge variant={v.versao === proc.metodoAtual?.versao ? 'filled' : 'outline'}>
                    v{v.versao}
                  </Badge>
                  <Text size="sm" c="dimmed">
                    {new Date(v.criadoEm).toLocaleString('pt-BR')} ·{' '}
                    {v.criadoPor ?? 'carga inicial do checklist'}
                  </Text>
                </Group>
                <Spoiler maxHeight={48} showLabel="ver texto completo" hideLabel="esconder">
                  <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                    {v.texto}
                  </Text>
                </Spoiler>
                <Divider />
              </Stack>
            ))}
          </Stack>
        </Paper>
      </Stack>

      <Modal
        opened={novaVersao !== null}
        onClose={() => setNovaVersao(null)}
        title="Nova versão do método"
        size="lg"
      >
        <Stack gap="md">
          <Alert color="blue">
            A versão atual (v{proc.metodoAtual?.versao}) fica preservada no histórico — registros
            antigos continuam apontando para ela.
          </Alert>
          <Textarea
            minRows={6}
            autosize
            value={novaVersao ?? ''}
            onChange={(e) => setNovaVersao(e.currentTarget.value)}
          />
          <Button loading={salvando} onClick={() => void salvarNovaVersao()}>
            Salvar como v{(proc.metodoAtual?.versao ?? 0) + 1}
          </Button>
        </Stack>
      </Modal>
    </Container>
  );
}
