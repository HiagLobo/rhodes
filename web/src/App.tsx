import { createContext, useContext, useEffect, useState } from 'react';

import {
  AppShell,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  MantineProvider,
  Text,
} from '@mantine/core';
import { APP_NAME, type Usuario } from '@rhodes/shared';
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router';

import { BannerNotificacoes } from './components/BannerNotificacoes';
import { api } from './lib/api';
import { Agora } from './pages/Agora';
import { Inicio } from './pages/Inicio';
import { Login } from './pages/Login';
import { Navios } from './pages/Navios';
import { Tv } from './pages/Tv';
import { Tarefa } from './pages/executante/Tarefa';
import { ProcedimentoDetalhe } from './pages/gestor/ProcedimentoDetalhe';
import { Calendario } from './pages/gestor/Calendario';
import { Demeritos } from './pages/gestor/Demeritos';
import { ExternalAudit } from './pages/gestor/ExternalAudit';
import { Score } from './pages/gestor/Score';
import { ScoreConfig } from './pages/gestor/ScoreConfig';
import { Justificativas } from './pages/gestor/Justificativas';
import { Relatorios } from './pages/gestor/Relatorios';
import { Fila } from './pages/vistoria/Fila';
import { Inspecao } from './pages/vistoria/Inspecao';
import { Procedimentos } from './pages/gestor/Procedimentos';
import { Usuarios } from './pages/gestor/Usuarios';
import { cssVariablesResolver, theme } from './theme';

const UsuarioContext = createContext<Usuario | null>(null);

/** Usuário logado — disponível em qualquer página dentro da área logada. */
export function useUsuario(): Usuario {
  const usuario = useContext(UsuarioContext);
  if (!usuario) throw new Error('useUsuario fora da área logada');
  return usuario;
}

/** Guarda de sessão: consulta /me; sem sessão → /login. A UI é cosmética — quem manda é a API. */
function AreaLogada() {
  const [estado, setEstado] = useState<'carregando' | 'anonimo' | Usuario>('carregando');

  useEffect(() => {
    api<Usuario>('/api/auth/me', { redirecionar401: false })
      .then(setEstado)
      .catch(() => setEstado('anonimo'));
  }, []);

  if (estado === 'carregando') {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (estado === 'anonimo') {
    return <Navigate to="/login" replace />;
  }
  // Guarda só provê o contexto e delega o layout ao Outlet — assim a /tv fica autenticada
  // porém FORA do Shell (tela cheia de andon, sem header).
  return (
    <UsuarioContext.Provider value={estado}>
      <Outlet />
    </UsuarioContext.Provider>
  );
}

/** Layout com header (todas as telas de operação menos a /tv). */
function Shell() {
  const usuario = useUsuario();
  const navigate = useNavigate();

  async function sair() {
    await api('/api/auth/logout', { method: 'POST', redirecionar401: false }).catch(() => undefined);
    navigate('/login', { replace: true });
  }

  return (
    <AppShell header={{ height: 72 }} padding="md">
      <AppShell.Header p="sm">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Text fw={800} size="lg" component={Link} to="/" style={{ textDecoration: 'none' }}>
              Rhodes · Limpeza
            </Text>
            <Button component={Link} to="/agora" variant="subtle" size="compact-md">
              Agora
            </Button>
            <Button component={Link} to="/score" variant="subtle" size="compact-md">
              Score
            </Button>
            {usuario.role !== 'VISTORIADOR' && (
              <Button component={Link} to="/navios" variant="subtle" size="compact-md">
                Navios
              </Button>
            )}
            {usuario.role !== 'EXECUTANTE' && (
              <Button component={Link} to="/vistoria" variant="subtle" size="compact-md">
                Vistoria
              </Button>
            )}
            {usuario.role === 'GESTOR' && (
              <>
                <Button
                  component={Link}
                  to="/gestor/procedimentos"
                  variant="subtle"
                  size="compact-md"
                >
                  Plano Mestre
                </Button>
                <Button component={Link} to="/gestor/calendario" variant="subtle" size="compact-md">
                  Calendário
                </Button>
                <Button component={Link} to="/gestor/justificativas" variant="subtle" size="compact-md">
                  Justificativas
                </Button>
                <Button component={Link} to="/gestor/demeritos" variant="subtle" size="compact-md">
                  Deméritos
                </Button>
                <Button component={Link} to="/gestor/score-config" variant="subtle" size="compact-md">
                  Pesos
                </Button>
                <Button component={Link} to="/gestor/external-audit" variant="subtle" size="compact-md">
                  Nota externa
                </Button>
                <Button component={Link} to="/gestor/relatorios" variant="subtle" size="compact-md">
                  Relatórios
                </Button>
                <Button component={Link} to="/gestor/usuarios" variant="subtle" size="compact-md">
                  Usuários
                </Button>
                <Button component={Link} to="/tv" variant="subtle" size="compact-md">
                  TV
                </Button>
              </>
            )}
          </Group>
          <Group gap="sm" wrap="nowrap">
            <Text fw={600} visibleFrom="sm">
              {usuario.nome}
            </Text>
            <Badge size="lg">{usuario.role}</Badge>
            <Button variant="default" onClick={() => void sair()}>
              Sair
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        <BannerNotificacoes usuario={usuario} />
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}

/** Rotas sem o BrowserRouter — testável com MemoryRouter. */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<AreaLogada />}>
        {/* /tv: autenticada, mas sem o Shell (fullscreen andon) */}
        <Route path="/tv" element={<Tv />} />
        <Route element={<Shell />}>
          <Route index element={<Inicio />} />
          <Route path="/agora" element={<Agora />} />
          <Route path="/score" element={<Score />} />
          <Route path="/tarefas/:id" element={<Tarefa />} />
          <Route path="/navios" element={<Navios />} />
          <Route path="/vistoria" element={<Fila />} />
          <Route path="/vistoria/:id" element={<Inspecao />} />
          <Route path="/gestor/usuarios" element={<Usuarios />} />
          <Route path="/gestor/procedimentos" element={<Procedimentos />} />
          <Route path="/gestor/procedimentos/:id" element={<ProcedimentoDetalhe />} />
          <Route path="/gestor/justificativas" element={<Justificativas />} />
          <Route path="/gestor/calendario" element={<Calendario />} />
          <Route path="/gestor/demeritos" element={<Demeritos />} />
          <Route path="/gestor/score-config" element={<ScoreConfig />} />
          <Route path="/gestor/external-audit" element={<ExternalAudit />} />
          <Route path="/gestor/relatorios" element={<Relatorios />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </MantineProvider>
  );
}

export { APP_NAME };
