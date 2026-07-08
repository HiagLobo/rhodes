import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Accordion,
  Alert,
  Badge,
  Button,
  Container,
  Group,
  Loader,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import {
  FREQUENCIAS,
  SHIP_PHASES,
  TRIGGER_TYPES,
  type Area,
  type Frequencia,
  type Procedimento,
  type ShipPhase,
  type TriggerType,
} from '@rhodes/shared';
import { Link, useNavigate } from 'react-router';

import { api, ApiError } from '../../lib/api';

export const FREQ_LABEL: Record<Frequencia, string> = {
  DIARIO: 'Diário',
  SEMANAL: 'Semanal',
  QUINZENAL: 'Quinzenal',
  MENSAL: 'Mensal',
  BIMESTRAL: 'Bimestral',
  SEMESTRAL: 'Semestral',
};

export const TRIGGER_LABEL: Record<TriggerType, string> = {
  CALENDAR: 'Calendário',
  SHIP_EVENT: 'Só navio',
  HYBRID: 'Calendário + navio',
};

export const FASE_LABEL: Record<ShipPhase, string> = {
  PRE_ARRIVAL: 'Antes da atracação',
  POST_OPERATION: 'Após a operação',
};

export function BadgesProcedimento({ p }: { p: Procedimento }) {
  return (
    <Group gap="xs" wrap="nowrap">
      <Badge variant="light">{FREQ_LABEL[p.frequency]}</Badge>
      {p.triggerType !== 'CALENDAR' && (
        <Badge color="indigo" title={TRIGGER_LABEL[p.triggerType]}>
          ⚓ NAVIO
        </Badge>
      )}
      {!p.ativo && <Badge color="red">Inativo</Badge>}
    </Group>
  );
}

function mensagemDe(err: unknown): string {
  if (err instanceof ApiError && err.corpo?.erro) return err.corpo.erro;
  return 'Falha ao falar com o servidor.';
}

type Estado =
  | { fase: 'carregando' }
  | { fase: 'erro' }
  | { fase: 'ok'; areas: Area[]; procedimentos: Procedimento[] };

const NOVO_VAZIO = {
  areaId: null as string | null,
  atividade: '',
  frequency: 'QUINZENAL' as Frequencia,
  triggerType: 'CALENDAR' as TriggerType,
  shipPhase: 'POST_OPERATION' as ShipPhase,
  leadDays: 2,
  metodo: '',
  limitacoes: '',
};

/** Plano Mestre — lista agrupada por área. A API já garante papel; a tela é casca. */
export function Procedimentos() {
  const navigate = useNavigate();
  const [estado, setEstado] = useState<Estado>({ fase: 'carregando' });
  const [busca, setBusca] = useState('');

  const [criando, setCriando] = useState(false);
  const [novo, setNovo] = useState(NOVO_VAZIO);
  const [erroCriar, setErroCriar] = useState('');
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(() => {
    setEstado({ fase: 'carregando' });
    Promise.all([
      api<Area[]>('/api/areas'),
      api<Procedimento[]>('/api/procedimentos?inativos=1'),
    ])
      .then(([areas, procedimentos]) => setEstado({ fase: 'ok', areas, procedimentos }))
      .catch(() => setEstado({ fase: 'erro' }));
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const grupos = useMemo(() => {
    if (estado.fase !== 'ok') return [];
    const filtro = busca.trim().toLowerCase();
    const porArea = new Map<number, Procedimento[]>();
    for (const p of estado.procedimentos) {
      if (filtro && !p.atividade.toLowerCase().includes(filtro)) continue;
      porArea.set(p.areaId, [...(porArea.get(p.areaId) ?? []), p]);
    }
    return estado.areas
      .filter((a) => porArea.has(a.id) || (!filtro && estado.procedimentos.length === 0))
      .filter((a) => (filtro ? porArea.has(a.id) : true))
      .map((a) => ({ area: a, itens: porArea.get(a.id) ?? [] }))
      .filter((g) => g.itens.length > 0 || !filtro);
  }, [estado, busca]);

  function abrirCriar() {
    setNovo(NOVO_VAZIO);
    setErroCriar('');
    setCriando(true);
  }

  async function criar() {
    if (estado.fase !== 'ok') return;
    setSalvando(true);
    setErroCriar('');
    try {
      const criado = await api<Procedimento>('/api/procedimentos', {
        method: 'POST',
        body: {
          areaId: Number(novo.areaId),
          atividade: novo.atividade,
          frequency: novo.frequency,
          triggerType: novo.triggerType,
          ...(novo.triggerType !== 'CALENDAR'
            ? { shipPhase: novo.shipPhase, leadDays: novo.leadDays }
            : {}),
          metodo: novo.metodo,
          ...(novo.limitacoes.trim() ? { limitacoes: novo.limitacoes.trim() } : {}),
        },
      });
      setCriando(false);
      navigate(`/gestor/procedimentos/${criado.id}`);
    } catch (err) {
      setErroCriar(mensagemDe(err));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Container size="md" py="md">
      <Stack gap="lg">
        <Group justify="space-between">
          <Title order={2}>Plano Mestre de Limpeza</Title>
          <Button onClick={abrirCriar}>Novo procedimento</Button>
        </Group>

        <TextInput
          placeholder="Buscar por atividade…"
          value={busca}
          onChange={(e) => setBusca(e.currentTarget.value)}
        />

        {estado.fase === 'carregando' && (
          <Group gap="sm">
            <Loader size="sm" />
            <Text fw={600}>Carregando o plano mestre…</Text>
          </Group>
        )}

        {estado.fase === 'erro' && (
          <Alert color="red" title="Não foi possível carregar">
            <Button onClick={carregar}>Tentar novamente</Button>
          </Alert>
        )}

        {estado.fase === 'ok' && (
          <Accordion multiple variant="separated">
            {grupos.map(({ area, itens }) => (
              <Accordion.Item key={area.id} value={String(area.id)}>
                <Accordion.Control>
                  <Group gap="sm" wrap="nowrap">
                    <Text fw={700}>{area.nome}</Text>
                    <Badge variant="outline" color="gray">
                      peso {area.pesoCriticidade}
                    </Badge>
                    <Badge variant="light" color="gray">
                      {itens.length}
                    </Badge>
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack gap="xs">
                    {itens.map((p) => (
                      <Group
                        key={p.id}
                        justify="space-between"
                        wrap="nowrap"
                        component={Link}
                        // @ts-expect-error polimorfismo do Mantine com react-router
                        to={`/gestor/procedimentos/${p.id}`}
                        style={{ textDecoration: 'none', color: 'inherit' }}
                      >
                        <Text lineClamp={1}>{p.atividade}</Text>
                        <BadgesProcedimento p={p} />
                      </Group>
                    ))}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        )}
      </Stack>

      <Modal opened={criando} onClose={() => setCriando(false)} title="Novo procedimento" size="lg">
        <Stack gap="md">
          <Select
            label="Área"
            data={
              estado.fase === 'ok'
                ? estado.areas.map((a) => ({ value: String(a.id), label: a.nome }))
                : []
            }
            value={novo.areaId}
            onChange={(v) => setNovo({ ...novo, areaId: v })}
            searchable
          />
          <TextInput
            label="Atividade"
            value={novo.atividade}
            onChange={(e) => setNovo({ ...novo, atividade: e.currentTarget.value })}
          />
          <Group grow>
            <Select
              label="Frequência"
              data={FREQUENCIAS.map((f) => ({ value: f, label: FREQ_LABEL[f] }))}
              value={novo.frequency}
              onChange={(v) => setNovo({ ...novo, frequency: (v ?? 'QUINZENAL') as Frequencia })}
              allowDeselect={false}
            />
            <Select
              label="Gatilho"
              data={TRIGGER_TYPES.map((t) => ({ value: t, label: TRIGGER_LABEL[t] }))}
              value={novo.triggerType}
              onChange={(v) => setNovo({ ...novo, triggerType: (v ?? 'CALENDAR') as TriggerType })}
              allowDeselect={false}
            />
          </Group>
          {novo.triggerType !== 'CALENDAR' && (
            <Group grow>
              <Select
                label="Fase do navio"
                data={SHIP_PHASES.map((f) => ({ value: f, label: FASE_LABEL[f] }))}
                value={novo.shipPhase}
                onChange={(v) =>
                  setNovo({ ...novo, shipPhase: (v ?? 'POST_OPERATION') as ShipPhase })
                }
                allowDeselect={false}
              />
              <NumberInput
                label="Prazo após o evento (dias)"
                min={0}
                max={30}
                value={novo.leadDays}
                onChange={(v) => setNovo({ ...novo, leadDays: Number(v) || 0 })}
              />
            </Group>
          )}
          <Textarea
            label="Como será feito (método)"
            description="vira a versão 1 do método deste procedimento"
            minRows={4}
            autosize
            value={novo.metodo}
            onChange={(e) => setNovo({ ...novo, metodo: e.currentTarget.value })}
          />
          <Textarea
            label="Limitações (opcional)"
            minRows={2}
            autosize
            value={novo.limitacoes}
            onChange={(e) => setNovo({ ...novo, limitacoes: e.currentTarget.value })}
          />
          {erroCriar && <Alert color="red">{erroCriar}</Alert>}
          <Button loading={salvando} onClick={() => void criar()}>
            Criar procedimento
          </Button>
        </Stack>
      </Modal>
    </Container>
  );
}
