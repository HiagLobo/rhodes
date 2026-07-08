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

import { api } from './lib/api';
import { Agora } from './pages/Agora';
import { Inicio } from './pages/Inicio';
import { Login } from './pages/Login';
import { ProcedimentoDetalhe } from './pages/gestor/ProcedimentoDetalhe';
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
  return (
    <UsuarioContext.Provider value={estado}>
      <Shell usuario={estado} />
    </UsuarioContext.Provider>
  );
}

function Shell({ usuario }: { usuario: Usuario }) {
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
                <Button component={Link} to="/gestor/usuarios" variant="subtle" size="compact-md">
                  Usuários
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
        <Route index element={<Inicio />} />
        <Route path="/agora" element={<Agora />} />
        <Route path="/gestor/usuarios" element={<Usuarios />} />
        <Route path="/gestor/procedimentos" element={<Procedimentos />} />
        <Route path="/gestor/procedimentos/:id" element={<ProcedimentoDetalhe />} />
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
