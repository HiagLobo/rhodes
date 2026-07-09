import { useCallback, useEffect, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Container,
  Group,
  Loader,
  Paper,
  Progress,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { bandaDoScore, type BandaScore, type ScoreEscopo, type ScoreResultado } from '@rhodes/shared';

import { api } from '../../lib/api';
import { BANDAS } from '../../theme';

const COR_BANDA: Record<BandaScore, string> = {
  EXCELENTE: BANDAS.excelente,
  BOM: BANDAS.bom,
  ATENCAO: BANDAS.atencao,
  CRITICO: BANDAS.critico,
};

type Estado = { fase: 'carregando' } | { fase: 'erro' } | { fase: 'ok'; score: ScoreResultado };

/** Painel de score (Onda 08): geral, por área, incerteza, componentes, taxa de justificadas. */
export function Score() {
  const [janela, setJanela] = useState('30');
  const [estado, setEstado] = useState<Estado>({ fase: 'carregando' });

  const carregar = useCallback(() => {
    setEstado({ fase: 'carregando' });
    api<ScoreResultado>(`/api/score?janela=${janela}`)
      .then((score) => setEstado({ fase: 'ok', score }))
      .catch(() => setEstado({ fase: 'erro' }));
  }, [janela]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  return (
    <Container size="md" py="md">
      <Stack gap="lg">
        <Group justify="space-between">
          <Title order={2}>Score</Title>
          <SegmentedControl
            value={janela}
            onChange={setJanela}
            data={[
              { label: '7 dias', value: '7' },
              { label: '30 dias', value: '30' },
              { label: '90 dias', value: '90' },
            ]}
          />
        </Group>

        {estado.fase === 'carregando' && (
          <Group gap="sm">
            <Loader size="sm" />
            <Text fw={600}>Calculando…</Text>
          </Group>
        )}

        {estado.fase === 'erro' && (
          <Alert color="red" title="Não foi possível carregar">
            <Button onClick={carregar}>Tentar novamente</Button>
          </Alert>
        )}

        {estado.fase === 'ok' && (
          <>
            <Geral escopo={estado.score} />

            <Stack gap="xs">
              <Text fw={800}>Por área</Text>
              <Table striped withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Área</Table.Th>
                    <Table.Th>Score</Table.Th>
                    <Table.Th>Banda</Table.Th>
                    <Table.Th>n</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {estado.score.areas.map((a) => (
                    <Table.Tr key={a.areaId}>
                      <Table.Td>{a.nome}</Table.Td>
                      <Table.Td fw={700} c={a.score === null ? 'dimmed' : undefined}>
                        {a.score === null ? 'sem dado' : Math.round(a.score)}
                      </Table.Td>
                      <Table.Td>
                        {a.banda && <Badge style={{ background: COR_BANDA[a.banda] }}>{a.banda}</Badge>}
                      </Table.Td>
                      <Table.Td>{a.n}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Stack>
          </>
        )}
      </Stack>
    </Container>
  );
}

function Geral({ escopo }: { escopo: ScoreEscopo }) {
  const cor = escopo.score === null ? '#495057' : COR_BANDA[bandaDoScore(escopo.score)];
  return (
    <Paper withBorder p="lg" style={{ borderTopColor: cor, borderTopWidth: 8 }}>
      <Group justify="space-between" align="flex-start">
        <Stack gap={0}>
          <Text size="sm" fw={700} c="dimmed">
            Score geral
          </Text>
          <Text fw={900} style={{ fontSize: 64, lineHeight: 1, color: cor }}>
            {escopo.score === null ? '—' : Math.round(escopo.score)}
          </Text>
          {escopo.score !== null && escopo.incertezaMenos !== null && escopo.incertezaMais !== null && (
            <Text size="sm" c="dimmed">
              faixa {Math.round(escopo.incertezaMenos)}–{Math.round(escopo.incertezaMais)} · {escopo.n} instâncias
            </Text>
          )}
        </Stack>
        {escopo.score !== null && escopo.banda && (
          <Badge size="xl" style={{ background: cor }}>
            {escopo.banda}
          </Badge>
        )}
      </Group>

      <Stack gap="xs" mt="md">
        <Componente rotulo="Pontualidade" c={escopo.componentes.pontualidade} />
        <Componente rotulo="Aprovação (1ª vistoria)" c={escopo.componentes.aprovacao} />
        <Componente rotulo="Cobertura" c={escopo.componentes.cobertura} />
      </Stack>

      <Group justify="space-between" mt="md">
        <Text size="sm" c={escopo.taxaJustificadas > 0.2 ? 'red' : 'dimmed'} fw={escopo.taxaJustificadas > 0.2 ? 700 : 400}>
          Taxa de justificadas: {Math.round(escopo.taxaJustificadas * 100)}%
          {escopo.taxaJustificadas > 0.2 && ' ⚠ acima de 20%'}
        </Text>
        {escopo.demeritos > 0 && (
          <Text size="sm" c="red" fw={700}>
            Deméritos: −{escopo.demeritos}
          </Text>
        )}
      </Group>
    </Paper>
  );
}

function Componente({ rotulo, c }: { rotulo: string; c: ScoreEscopo['componentes']['pontualidade'] }) {
  return (
    <Group gap="sm" wrap="nowrap">
      <Text size="sm" w={200} style={{ flexShrink: 0 }}>
        {rotulo}
      </Text>
      {c.valor === null ? (
        <Text size="sm" c="dimmed" style={{ flex: 1 }}>
          sem dado
        </Text>
      ) : (
        <Progress value={c.valor * 100} color={BANDAS.bom} size="lg" style={{ flex: 1 }} />
      )}
      <Text size="sm" fw={600} w={90} ta="right">
        {c.valor === null ? '—' : `${Math.round(c.valor * 100)}%`} (n={c.n})
      </Text>
    </Group>
  );
}
