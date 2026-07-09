import { useCallback, useEffect, useState } from 'react';

import {
  Alert,
  Button,
  Container,
  Group,
  Loader,
  MultiSelect,
  Paper,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import type { Area, OperacaoNavio, RelatorioHistoricoItem } from '@rhodes/shared';

import { api, ApiError } from '../../lib/api';
import { baixarCsv, baixarDossiePdf, listarHistorico, periodoInvalido } from '../../lib/relatorios';

function mensagemDe(err: unknown): string {
  if (err instanceof ApiError && err.corpo?.erro) return err.corpo.erro;
  return 'Falha ao falar com o servidor.';
}

function dataHora(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

function resumoFiltros(f: RelatorioHistoricoItem['filtros']): string {
  const areas = f.areaIds && f.areaIds.length > 0 ? `${f.areaIds.length} área(s)` : 'todas as áreas';
  const so = f.somenteReprovadasOuCriticas ? ' · só reprovadas' : '';
  const nav = f.roundId ? ` · navio #${f.roundId}` : '';
  return `${f.inicio} a ${f.fim} · ${areas}${nav}${so}`;
}

type Deps = { fase: 'carregando' } | { fase: 'erro' } | { fase: 'ok'; areas: Area[] };

/**
 * Relatórios de auditoria (Onda 09/S4) — o gestor escolhe área(s)/período/rodada/só-reprovadas e
 * baixa o dossiê PDF (e o CSV) para a Salso/Ambev; embaixo, o histórico das gerações (audit_log). A
 * barreira real é `requireRole(GESTOR)` no backend — a tela apenas dispara.
 */
export function Relatorios() {
  const [deps, setDeps] = useState<Deps>({ fase: 'carregando' });
  const [navios, setNavios] = useState<OperacaoNavio[]>([]);
  const [historico, setHistorico] = useState<RelatorioHistoricoItem[]>([]);

  const [inicio, setInicio] = useState('');
  const [fim, setFim] = useState('');
  const [areaIds, setAreaIds] = useState<string[]>([]);
  const [roundId, setRoundId] = useState<string | null>(null);
  const [soReprovadas, setSoReprovadas] = useState(false);

  const [baixando, setBaixando] = useState<'pdf' | 'csv' | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregarHistorico = useCallback(() => {
    listarHistorico()
      .then(setHistorico)
      .catch(() => setHistorico([]));
  }, []);

  const carregarDeps = useCallback(() => {
    setDeps({ fase: 'carregando' });
    // Áreas são essenciais para o formulário; a lista de navios é best-effort (a rodada é opcional —
    // se falhar, o gestor ainda gera o relatório por período/área).
    api<Area[]>('/api/areas')
      .then((areas) => setDeps({ fase: 'ok', areas }))
      .catch(() => setDeps({ fase: 'erro' }));
    api<OperacaoNavio[]>('/api/navios')
      .then(setNavios)
      .catch(() => setNavios([]));
  }, []);

  useEffect(() => {
    carregarDeps();
    carregarHistorico();
  }, [carregarDeps, carregarHistorico]);

  async function baixar(formato: 'pdf' | 'csv') {
    const invalido = periodoInvalido(inicio, fim);
    if (invalido) {
      setErro(invalido);
      return;
    }
    setErro(null);
    setBaixando(formato);
    const filtros = {
      inicio,
      fim,
      areaIds: areaIds.map(Number),
      roundId: roundId ? Number(roundId) : null,
      somenteReprovadasOuCriticas: soReprovadas,
    };
    try {
      await (formato === 'pdf' ? baixarDossiePdf(filtros) : baixarCsv(filtros));
      carregarHistorico(); // a geração acabou de entrar no audit_log
    } catch (err) {
      setErro(mensagemDe(err));
    } finally {
      setBaixando(null);
    }
  }

  return (
    <Container size="lg" py="md">
      <Stack gap="lg">
        <Title order={2}>Relatórios de auditoria</Title>
        <Text c="dimmed">
          Escolha a área e o período e baixe o dossiê (fotos antes/depois, horários, executante,
          vistoria e vínculo ao navio) — a prova para a Salso/Ambev. O CSV traz as instâncias do
          período para planilha.
        </Text>

        {deps.fase === 'carregando' && (
          <Group gap="sm">
            <Loader size="sm" />
            <Text fw={600}>Carregando…</Text>
          </Group>
        )}
        {deps.fase === 'erro' && (
          <Alert color="red" title="Não foi possível carregar">
            <Button onClick={carregarDeps}>Tentar novamente</Button>
          </Alert>
        )}

        {deps.fase === 'ok' && (
          <Paper withBorder p="md">
            <Stack gap="sm">
              <MultiSelect
                label="Áreas (vazio = todas)"
                placeholder="Todas as áreas"
                data={deps.areas.map((a) => ({ value: String(a.id), label: a.nome }))}
                value={areaIds}
                onChange={setAreaIds}
                clearable
                searchable
              />
              <Group grow>
                <TextInput
                  label="Início"
                  type="date"
                  value={inicio}
                  onChange={(e) => setInicio(e.currentTarget.value)}
                />
                <TextInput
                  label="Fim"
                  type="date"
                  value={fim}
                  onChange={(e) => setFim(e.currentTarget.value)}
                />
              </Group>
              <Select
                label="Rodada de navio (opcional)"
                placeholder="Qualquer / calendário"
                data={navios.map((n) => ({
                  value: String(n.id),
                  label: `${n.navio} · ${n.produto ?? '—'} · ETA ${n.etaDate}`,
                }))}
                value={roundId}
                onChange={setRoundId}
                clearable
                searchable
              />
              <Switch
                label="Só reprovadas / críticas"
                checked={soReprovadas}
                onChange={(e) => setSoReprovadas(e.currentTarget.checked)}
              />

              {erro && <Alert color="red">{erro}</Alert>}

              <Group>
                <Button
                  size="lg"
                  loading={baixando === 'pdf'}
                  disabled={baixando === 'csv'}
                  onClick={() => void baixar('pdf')}
                >
                  Baixar PDF
                </Button>
                <Button
                  size="lg"
                  variant="light"
                  loading={baixando === 'csv'}
                  disabled={baixando === 'pdf'}
                  onClick={() => void baixar('csv')}
                >
                  Baixar CSV
                </Button>
              </Group>
            </Stack>
          </Paper>
        )}

        <Stack gap="xs">
          <Text fw={800}>Histórico de relatórios gerados</Text>
          {historico.length === 0 ? (
            <Text c="dimmed">Nenhum relatório gerado ainda.</Text>
          ) : (
            <Table.ScrollContainer minWidth={640}>
              <Table striped>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Quando</Table.Th>
                    <Table.Th>Quem</Table.Th>
                    <Table.Th>Filtros</Table.Th>
                    <Table.Th>Instâncias</Table.Th>
                    <Table.Th>Formato</Table.Th>
                    <Table.Th>Hash</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {historico.map((h, i) => (
                    <Table.Tr key={i}>
                      <Table.Td>{dataHora(h.criadoEm)}</Table.Td>
                      <Table.Td>{h.ator ?? '—'}</Table.Td>
                      <Table.Td>{resumoFiltros(h.filtros)}</Table.Td>
                      <Table.Td>{h.nInstancias}</Table.Td>
                      <Table.Td>{h.formato}</Table.Td>
                      <Table.Td>
                        <Text ff="monospace" size="xs">
                          {h.hash.slice(0, 12)}…
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Stack>
      </Stack>
    </Container>
  );
}
