import { useCallback, useEffect, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Container,
  Group,
  Loader,
  NumberInput,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import {
  ORGAOS_EXTERNOS,
  SEVERIDADES,
  type ExternalAuditResumo,
  type Severidade,
} from '@rhodes/shared';

import { api, ApiError } from '../../lib/api';

function mensagemDe(err: unknown): string {
  if (err instanceof ApiError && err.corpo?.erro) return err.corpo.erro;
  return 'Falha ao falar com o servidor.';
}

type Achado = { severidade: Severidade; descricao: string };

type Estado = { fase: 'carregando' } | { fase: 'erro' } | { fase: 'ok'; lista: ExternalAuditResumo[] };

/** Registro das inspeções externas (Salso/Ambev) — a nota-mestre da calibração (Onda 08). */
export function ExternalAudit() {
  const [estado, setEstado] = useState<Estado>({ fase: 'carregando' });
  const [orgao, setOrgao] = useState<string>('SALSO');
  const [dataInspecao, setDataInspecao] = useState('');
  const [nota, setNota] = useState<number | ''>('');
  const [observacao, setObservacao] = useState('');
  const [achados, setAchados] = useState<Achado[]>([]);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(() => {
    setEstado({ fase: 'carregando' });
    api<ExternalAuditResumo[]>('/api/external-audit')
      .then((lista) => setEstado({ fase: 'ok', lista }))
      .catch(() => setEstado({ fase: 'erro' }));
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function registrar() {
    setFeedback(null);
    if (dataInspecao.trim() === '' || nota === '') {
      setFeedback({ tipo: 'erro', texto: 'Informe a data e a nota.' });
      return;
    }
    setSalvando(true);
    try {
      await api('/api/external-audit', {
        method: 'POST',
        body: { orgao, dataInspecao, nota: Number(nota), observacao: observacao.trim() || undefined, achados },
      });
      setFeedback({ tipo: 'ok', texto: 'Inspeção registrada.' });
      setDataInspecao('');
      setNota('');
      setObservacao('');
      setAchados([]);
      carregar();
    } catch (err) {
      setFeedback({ tipo: 'erro', texto: mensagemDe(err) });
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Container size="md" py="md">
      <Stack gap="lg">
        <Title order={2}>Inspeções externas (Salso / Ambev)</Title>
        <Text c="dimmed">
          A nota externa é a métrica-mestre — o dashboard mostra o gap entre o score interno e ela
          (defesa contra a Lei de Goodhart). O registro é imutável.
        </Text>

        <Paper withBorder p="md">
          <Stack gap="sm">
            <Group grow>
              <Select
                label="Órgão"
                data={[...ORGAOS_EXTERNOS]}
                value={orgao}
                onChange={(v) => setOrgao(v ?? 'SALSO')}
                allowDeselect={false}
              />
              <TextInput
                label="Data da inspeção"
                type="date"
                value={dataInspecao}
                onChange={(e) => setDataInspecao(e.currentTarget.value)}
              />
              <NumberInput label="Nota (0–100)" min={0} max={100} value={nota} onChange={(v) => setNota(v === '' ? '' : Number(v))} />
            </Group>
            <Textarea
              label="Observação (opcional)"
              value={observacao}
              onChange={(e) => setObservacao(e.currentTarget.value)}
              rows={2}
            />

            <Group justify="space-between">
              <Text fw={700}>Achados</Text>
              <Button
                variant="light"
                size="compact-sm"
                onClick={() => setAchados([...achados, { severidade: 'MAIOR', descricao: '' }])}
              >
                + achado
              </Button>
            </Group>
            {achados.map((a, i) => (
              <Group key={i} gap="xs" wrap="nowrap">
                <Select
                  data={[...SEVERIDADES]}
                  value={a.severidade}
                  onChange={(v) => setAchados(achados.map((x, j) => (j === i ? { ...x, severidade: (v ?? 'MAIOR') as Severidade } : x)))}
                  w={130}
                  allowDeselect={false}
                />
                <TextInput
                  placeholder="descrição do achado"
                  value={a.descricao}
                  onChange={(e) => setAchados(achados.map((x, j) => (j === i ? { ...x, descricao: e.currentTarget.value } : x)))}
                  style={{ flex: 1 }}
                />
                <Button variant="subtle" color="red" size="compact-sm" onClick={() => setAchados(achados.filter((_, j) => j !== i))}>
                  remover
                </Button>
              </Group>
            ))}

            {feedback && <Alert color={feedback.tipo === 'ok' ? 'green' : 'red'}>{feedback.texto}</Alert>}
            <Button size="lg" loading={salvando} onClick={() => void registrar()}>
              Registrar inspeção
            </Button>
          </Stack>
        </Paper>

        <Stack gap="xs">
          <Text fw={800}>Inspeções registradas</Text>
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
          {estado.fase === 'ok' && estado.lista.length === 0 && (
            <Text c="dimmed">Nenhuma inspeção externa registrada ainda.</Text>
          )}
          {estado.fase === 'ok' &&
            estado.lista.map((a) => (
              <Paper key={a.id} withBorder p="sm">
                <Group justify="space-between">
                  <Group gap="xs">
                    <Badge color="indigo">{a.orgao}</Badge>
                    <Text fw={700}>Nota {a.nota}</Text>
                    <Text size="sm" c="dimmed">
                      {a.dataInspecao}
                    </Text>
                  </Group>
                  {a.achados.length > 0 && <Text size="sm" c="dimmed">{a.achados.length} achado(s)</Text>}
                </Group>
                {a.observacao && (
                  <Text size="sm" c="dimmed" mt={4}>
                    {a.observacao}
                  </Text>
                )}
              </Paper>
            ))}
        </Stack>
      </Stack>
    </Container>
  );
}
