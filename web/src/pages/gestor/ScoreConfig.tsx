import { useCallback, useEffect, useState } from 'react';

import {
  Alert,
  Button,
  Container,
  Group,
  Loader,
  NumberInput,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import type { ScoreConfig } from '@rhodes/shared';

import { api, ApiError } from '../../lib/api';

function mensagemDe(err: unknown): string {
  if (err instanceof ApiError && err.corpo?.erro) return err.corpo.erro;
  return 'Falha ao falar com o servidor.';
}

type Estado = { fase: 'carregando' } | { fase: 'erro' } | { fase: 'ok'; cfg: ScoreConfig };

/** Calibração dos pesos do score — cada gravação cria uma NOVA versão (append-only). */
export function ScoreConfig() {
  const [estado, setEstado] = useState<Estado>({ fase: 'carregando' });
  const [form, setForm] = useState<ScoreConfig | null>(null);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(() => {
    setEstado({ fase: 'carregando' });
    api<ScoreConfig>('/api/score-config')
      .then((cfg) => {
        setEstado({ fase: 'ok', cfg });
        setForm(cfg);
      })
      .catch(() => setEstado({ fase: 'erro' }));
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function salvar() {
    if (!form) return;
    setSalvando(true);
    setFeedback(null);
    try {
      // vistoriaAmostralPct NÃO vai no body — o servidor mescla da linha vigente.
      const { vistoriaAmostralPct: _omit, ...input } = form;
      void _omit;
      await api('/api/score-config', { method: 'POST', body: input });
      setFeedback({ tipo: 'ok', texto: 'Nova versão criada. O cálculo passa a usar os novos pesos.' });
      carregar();
    } catch (err) {
      setFeedback({ tipo: 'erro', texto: mensagemDe(err) });
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Container size="sm" py="md">
      <Stack gap="lg">
        <Title order={2}>Pesos do score</Title>
        <Text c="dimmed">
          Ajustar aqui cria uma <b>nova versão</b> — o histórico é preservado (nada se reescreve).
          Vale a partir da gravação; a fórmula será recalibrada quando chegarem as notas da Ambev.
        </Text>

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

        {estado.fase === 'ok' && form && (
          <Paper withBorder p="md">
            <Stack gap="md">
              <Text fw={800}>Pesos dos componentes</Text>
              <Group grow>
                <NumberInput
                  label="Pontualidade"
                  min={0}
                  max={100}
                  value={form.pesos.pontualidade}
                  onChange={(v) => setForm({ ...form, pesos: { ...form.pesos, pontualidade: Number(v) || 0 } })}
                />
                <NumberInput
                  label="Aprovação"
                  min={0}
                  max={100}
                  value={form.pesos.aprovacao}
                  onChange={(v) => setForm({ ...form, pesos: { ...form.pesos, aprovacao: Number(v) || 0 } })}
                />
                <NumberInput
                  label="Cobertura"
                  min={0}
                  max={100}
                  value={form.pesos.cobertura}
                  onChange={(v) => setForm({ ...form, pesos: { ...form.pesos, cobertura: Number(v) || 0 } })}
                />
              </Group>

              <Text fw={800}>Deméritos</Text>
              <Group grow>
                <NumberInput
                  label="Crítico"
                  min={0}
                  max={100}
                  value={form.demerito.CRITICA}
                  onChange={(v) => setForm({ ...form, demerito: { ...form.demerito, CRITICA: Number(v) || 0 } })}
                />
                <NumberInput
                  label="Maior"
                  min={0}
                  max={100}
                  value={form.demerito.MAIOR}
                  onChange={(v) => setForm({ ...form, demerito: { ...form.demerito, MAIOR: Number(v) || 0 } })}
                />
                <NumberInput
                  label="Teto por janela"
                  min={0}
                  max={100}
                  value={form.tetoDemeritos}
                  onChange={(v) => setForm({ ...form, tetoDemeritos: Number(v) || 0 })}
                />
              </Group>

              <Group grow>
                <NumberInput
                  label="Graça de pontualidade (0–1)"
                  min={0}
                  max={1}
                  step={0.05}
                  decimalScale={2}
                  value={form.gracaPontualidade}
                  onChange={(v) => setForm({ ...form, gracaPontualidade: Number(v) || 0 })}
                />
                <NumberInput
                  label="Teto justificativas/executante (%)"
                  min={0}
                  max={100}
                  value={form.tetoJustificativasExecutantePct}
                  onChange={(v) => setForm({ ...form, tetoJustificativasExecutantePct: Number(v) || 0 })}
                />
              </Group>

              {feedback && (
                <Alert color={feedback.tipo === 'ok' ? 'green' : 'red'}>{feedback.texto}</Alert>
              )}

              <Button size="lg" loading={salvando} onClick={() => void salvar()}>
                Gravar nova versão
              </Button>
            </Stack>
          </Paper>
        )}
      </Stack>
    </Container>
  );
}
