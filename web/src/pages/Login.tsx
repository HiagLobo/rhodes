import { useState, type FormEvent } from 'react';

import { Alert, Button, Container, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { APP_NAME, type Usuario } from '@rhodes/shared';
import { useNavigate } from 'react-router';

import { api, ApiError } from '../lib/api';

/** Tela de login mobile-first: campos grandes, botão gigante (tema já garante ≥56px). */
export function Login() {
  const navigate = useNavigate();
  const [login, setLogin] = useState('');
  const [senha, setSenha] = useState('');
  const [estado, setEstado] = useState<'parado' | 'enviando' | 'erro'>('parado');
  const [mensagemErro, setMensagemErro] = useState('');

  async function entrar(e: FormEvent) {
    e.preventDefault();
    setEstado('enviando');
    try {
      await api<Usuario>('/api/auth/login', {
        method: 'POST',
        body: { login, senha },
        redirecionar401: false,
      });
      navigate('/', { replace: true });
    } catch (err) {
      setMensagemErro(
        err instanceof ApiError && err.corpo?.erro ? err.corpo.erro : 'Falha ao falar com o servidor.',
      );
      setEstado('erro');
    }
  }

  return (
    <Container size="xs" py="xl">
      <form onSubmit={(e) => void entrar(e)}>
        <Stack gap="lg">
          <Title order={1} size="h2">
            {APP_NAME}
          </Title>
          <Text fw={600} c="dimmed">
            Entre com o seu usuário e senha
          </Text>

          <TextInput
            size="lg"
            label="Login"
            placeholder="seu.login"
            autoComplete="username"
            value={login}
            onChange={(e) => setLogin(e.currentTarget.value)}
            required
          />
          <PasswordInput
            size="lg"
            label="Senha"
            placeholder="sua senha"
            autoComplete="current-password"
            value={senha}
            onChange={(e) => setSenha(e.currentTarget.value)}
            required
          />

          {estado === 'erro' && (
            <Alert color="red" title="Não foi possível entrar">
              {mensagemErro}
            </Alert>
          )}

          <Button type="submit" fullWidth loading={estado === 'enviando'}>
            ENTRAR
          </Button>
        </Stack>
      </form>
    </Container>
  );
}
