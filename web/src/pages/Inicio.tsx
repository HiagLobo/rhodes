import { useCallback, useEffect, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { APP_NAME } from '@rhodes/shared';

type Health = { status: string; db: string; version: string };

type Estado = { fase: 'carregando' } | { fase: 'erro' } | { fase: 'ok'; health: Health };

/** Página inicial provisória — prova o shell e o padrão de 3 estados (vazio/carregando/erro). */
export function Inicio() {
  const [estado, setEstado] = useState<Estado>({ fase: 'carregando' });

  const verificarServidor = useCallback(() => {
    setEstado({ fase: 'carregando' });
    fetch('/api/health')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as Health;
      })
      .then((health) => setEstado({ fase: 'ok', health }))
      .catch(() => setEstado({ fase: 'erro' }));
  }, []);

  useEffect(() => {
    verificarServidor();
  }, [verificarServidor]);

  return (
    <Container size="sm" py="xl">
      <Stack gap="lg">
        <Title order={1}>{APP_NAME}</Title>
        <Text size="lg" fw={600} c="dimmed">
          Porto do Recife — plano mestre de limpeza
        </Text>

        {estado.fase === 'carregando' && (
          <Group gap="sm">
            <Loader size="sm" />
            <Text fw={600}>Conectando ao servidor…</Text>
          </Group>
        )}

        {estado.fase === 'erro' && (
          <Alert color="red" title="Servidor fora do ar">
            <Stack gap="sm">
              <Text>Não foi possível falar com o servidor da Rhodes na rede local.</Text>
              <Button onClick={verificarServidor}>Tentar novamente</Button>
            </Stack>
          </Alert>
        )}

        {estado.fase === 'ok' && (
          <Group gap="sm">
            <Badge color="green" size="lg">
              Servidor no ar
            </Badge>
            <Text fw={600}>versão {estado.health.version}</Text>
          </Group>
        )}
      </Stack>
    </Container>
  );
}
