import { useCallback, useEffect, useState } from 'react';

import { Badge, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import type { DashboardPayload, SituacaoGrupo } from '@rhodes/shared';

import { api, ApiError } from '../lib/api';
import { BANDAS } from '../theme';

const COR_SITUACAO: Record<SituacaoGrupo, string> = {
  OVERDUE: BANDAS.critico,
  HOJE: BANDAS.atencao,
  FUTURA: BANDAS.bom,
  NENHUMA: BANDAS.excelente,
};

const INTERVALO_MS = 30_000;

type Falha = 'rede' | 'sessao' | null;

/**
 * TV andon (Onda 07) — fullscreen SEM Shell, repolla a cada 30s. Canal primário de alerta
 * na LAN isolada (push não existe aqui). Trata falha de rede ≠ 401 (cookie de 12h vence e a
 * TV precisa dizer a verdade: "sessão expirada", não "sem conexão").
 */
export function Tv() {
  const [dash, setDash] = useState<DashboardPayload | null>(null);
  const [falha, setFalha] = useState<Falha>(null);
  const [ultimoOk, setUltimoOk] = useState<number>(0);
  const [agora, setAgora] = useState<number>(0);

  const atualizar = useCallback(async () => {
    try {
      const d = await api<DashboardPayload>('/api/dashboard', { redirecionar401: false });
      setDash(d);
      setFalha(null);
      setUltimoOk(Date.now());
    } catch (err) {
      // mantém o último dado na tela; só troca o selo
      setFalha(err instanceof ApiError && err.status === 401 ? 'sessao' : 'rede');
    }
  }, []);

  useEffect(() => {
    void atualizar();
    setAgora(Date.now());
    const poll = setInterval(() => void atualizar(), INTERVALO_MS);
    const relogio = setInterval(() => setAgora(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(relogio);
    };
  }, [atualizar]);

  const segSemDados = ultimoOk ? Math.floor((agora - ultimoOk) / 1000) : 0;

  return (
    <Stack gap="md" p="lg" style={{ minHeight: '100vh', background: '#0b0b0b', color: '#fff' }}>
      <Group justify="space-between">
        <Text fw={900} style={{ fontSize: 40 }}>
          Rhodes · Limpeza — Agora
        </Text>
        <Group gap="md">
          {falha === 'rede' && (
            <Badge size="xl" color="orange">
              sem conexão há {segSemDados}s
            </Badge>
          )}
          {falha === 'sessao' && (
            <Badge size="xl" color="red">
              sessão expirada — entre novamente
            </Badge>
          )}
          <Text style={{ fontSize: 32 }} fw={800}>
            {new Date(agora).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </Group>
      </Group>

      {dash && (
        <>
          <SimpleGrid cols={4}>
            <CartaoTv titulo="ATRASADAS" valor={dash.cartoes.atrasadas} cor={BANDAS.critico} />
            <CartaoTv titulo="HOJE" valor={dash.cartoes.hoje} cor={BANDAS.atencao} />
            <CartaoTv titulo="AGUARDANDO VISTORIA" valor={dash.cartoes.aguardandoVistoria} cor={BANDAS.bom} />
            <CartaoTv titulo="NAVIO" valor={dash.rodada ? `${dash.rodada.concluidas}/${dash.rodada.total}` : '—'} cor="#364fc7" />
          </SimpleGrid>

          <SimpleGrid cols={{ base: 3, md: 4 }} style={{ flex: 1 }}>
            {dash.grade.map((g) => (
              <Stack
                key={g.grupo}
                justify="center"
                align="center"
                gap={4}
                style={{ background: COR_SITUACAO[g.situacao], borderRadius: 8, minHeight: 120, padding: 12 }}
              >
                <Text fw={900} style={{ fontSize: 26, textAlign: 'center' }}>
                  {g.grupo}
                </Text>
                <Text style={{ fontSize: 20 }}>
                  {g.atrasadas > 0 ? `${g.atrasadas} atrasada(s)` : `${g.abertas} aberta(s)`}
                </Text>
              </Stack>
            ))}
          </SimpleGrid>
        </>
      )}
    </Stack>
  );
}

function CartaoTv({ titulo, valor, cor }: { titulo: string; valor: number | string; cor: string }) {
  return (
    <Stack gap={0} align="center" style={{ background: '#1a1a1a', borderTop: `6px solid ${cor}`, borderRadius: 8, padding: 16 }}>
      <Text fw={700} c="#adb5bd" style={{ fontSize: 18 }}>
        {titulo}
      </Text>
      <Text fw={900} style={{ fontSize: 56, color: cor }}>
        {valor}
      </Text>
    </Stack>
  );
}
