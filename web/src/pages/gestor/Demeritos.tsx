import { useCallback, useEffect, useState } from 'react';

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
import type { DemeritoConfirmado, DemeritoPendente } from '@rhodes/shared';

import { api, ApiError } from '../../lib/api';
import { BANDAS } from '../../theme';

function mensagemDe(err: unknown): string {
  if (err instanceof ApiError && err.corpo?.erro) return err.corpo.erro;
  return 'Falha ao falar com o servidor.';
}

const COR_SEV: Record<string, string> = { CRITICA: BANDAS.critico, MAIOR: BANDAS.atencao };

type Estado =
  | { fase: 'carregando' }
  | { fase: 'erro' }
  | { fase: 'ok'; pendentes: DemeritoPendente[]; confirmados: DemeritoConfirmado[] };

/** Fila de confirmação de deméritos (2º gate da dupla confirmação — Onda 08). */
export function Demeritos() {
  const [estado, setEstado] = useState<Estado>({ fase: 'carregando' });
  const [erroAcao, setErroAcao] = useState('');
  const [enviando, setEnviando] = useState<number | null>(null);

  const carregar = useCallback(() => {
    setEstado({ fase: 'carregando' });
    Promise.all([
      api<DemeritoPendente[]>('/api/demeritos/pendentes'),
      api<DemeritoConfirmado[]>('/api/demeritos'),
    ])
      .then(([pendentes, confirmados]) => setEstado({ fase: 'ok', pendentes, confirmados }))
      .catch(() => setEstado({ fase: 'erro' }));
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function confirmar(inspectionId: number) {
    setErroAcao('');
    setEnviando(inspectionId);
    try {
      await api('/api/demeritos', { method: 'POST', body: { inspectionId } });
      carregar();
    } catch (err) {
      setErroAcao(mensagemDe(err));
    } finally {
      setEnviando(null);
    }
  }

  return (
    <Container size="md" py="md">
      <Stack gap="lg">
        <Group justify="space-between">
          <Title order={2}>Deméritos</Title>
          <Button variant="default" onClick={carregar}>
            Atualizar
          </Button>
        </Group>

        <Text c="dimmed">
          A reprovação do vistoriador é a 1ª confirmação; confirmar aqui é o 2º par de olhos —
          só então o demérito pesa no score. Crítico −8, maior −3 (teto −20 por janela).
        </Text>

        {erroAcao && (
          <Alert color="red" withCloseButton onClose={() => setErroAcao('')}>
            {erroAcao}
          </Alert>
        )}

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
              <Text fw={800}>Aguardando confirmação ({estado.pendentes.length})</Text>
              {estado.pendentes.length === 0 && (
                <Alert color="green">Nenhuma reprovação grave aguardando confirmação.</Alert>
              )}
              {estado.pendentes.map((d) => (
                <Paper key={d.inspectionId} withBorder p="sm">
                  <Group justify="space-between" wrap="nowrap">
                    <Stack gap={2} style={{ minWidth: 0 }}>
                      <Text fw={600} lineClamp={1}>
                        {d.atividade}
                      </Text>
                      <Group gap="xs">
                        <Badge color={COR_SEV[d.severidade] ? undefined : 'gray'} style={{ background: COR_SEV[d.severidade] }}>
                          {d.severidade}
                        </Badge>
                        <Text size="sm" c="dimmed">
                          {d.areaNome} · reprovada por {d.vistoriador ?? '—'}
                        </Text>
                      </Group>
                    </Stack>
                    <Button
                      color="red"
                      loading={enviando === d.inspectionId}
                      onClick={() => void confirmar(d.inspectionId)}
                    >
                      Confirmar demérito
                    </Button>
                  </Group>
                </Paper>
              ))}
            </Stack>

            <Stack gap="xs">
              <Text fw={800}>Confirmados ({estado.confirmados.length})</Text>
              {estado.confirmados.length === 0 && <Text c="dimmed">Nenhum demérito confirmado.</Text>}
              {estado.confirmados.map((d) => (
                <Group key={d.id} gap="sm" wrap="nowrap">
                  <Badge style={{ background: COR_SEV[d.severidade] }}>{d.severidade}</Badge>
                  <Text size="sm">
                    {d.areaNome} · confirmado por {d.confirmadoPor ?? '—'}
                  </Text>
                </Group>
              ))}
            </Stack>
          </>
        )}
      </Stack>
    </Container>
  );
}
