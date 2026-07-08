import { useCallback, useEffect, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Container,
  Group,
  Loader,
  Modal,
  PasswordInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { ROLES, type Role, type Usuario } from '@rhodes/shared';

import { api, ApiError } from '../../lib/api';
import { useUsuario } from '../../App';

type EstadoLista = { fase: 'carregando' } | { fase: 'erro' } | { fase: 'ok'; usuarios: Usuario[] };

function mensagemDe(err: unknown): string {
  if (err instanceof ApiError && err.corpo?.erro) {
    const detalhes = err.corpo.problemas?.length ? ` ${err.corpo.problemas.join(' ')}` : '';
    return `${err.corpo.erro}${detalhes}`;
  }
  return 'Falha ao falar com o servidor.';
}

/** Tela do GESTOR — a API já exige o papel; aqui é só a casca (imutável 1). */
export function Usuarios() {
  const eu = useUsuario();
  const [estado, setEstado] = useState<EstadoLista>({ fase: 'carregando' });
  const [erroAcao, setErroAcao] = useState('');

  // modal de criação
  const [criando, setCriando] = useState(false);
  const [novo, setNovo] = useState({ nome: '', login: '', senha: '', role: 'EXECUTANTE' as Role });
  const [erroCriar, setErroCriar] = useState('');
  const [salvando, setSalvando] = useState(false);

  // modal de reset de senha
  const [resetAlvo, setResetAlvo] = useState<Usuario | null>(null);
  const [novaSenha, setNovaSenha] = useState('');
  const [erroReset, setErroReset] = useState('');

  const carregar = useCallback(() => {
    setEstado({ fase: 'carregando' });
    api<Usuario[]>('/api/usuarios')
      .then((usuarios) => setEstado({ fase: 'ok', usuarios }))
      .catch(() => setEstado({ fase: 'erro' }));
  }, []);

  // Modais sempre abrem LIMPOS — senha residual de uma tentativa anterior jamais
  // pode sobrar no campo (risco real: salvar senha errada no usuário errado).
  function abrirCriar() {
    setNovo({ nome: '', login: '', senha: '', role: 'EXECUTANTE' });
    setErroCriar('');
    setCriando(true);
  }

  function abrirReset(u: Usuario) {
    setNovaSenha('');
    setErroReset('');
    setResetAlvo(u);
  }

  function fecharReset() {
    setResetAlvo(null);
    setNovaSenha('');
    setErroReset('');
  }

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function criar() {
    setSalvando(true);
    setErroCriar('');
    try {
      await api<Usuario>('/api/usuarios', { method: 'POST', body: novo });
      setCriando(false);
      setNovo({ nome: '', login: '', senha: '', role: 'EXECUTANTE' });
      carregar();
    } catch (err) {
      setErroCriar(mensagemDe(err));
    } finally {
      setSalvando(false);
    }
  }

  async function resetarSenha() {
    if (!resetAlvo) return;
    setSalvando(true);
    setErroReset('');
    try {
      await api(`/api/usuarios/${resetAlvo.id}/reset-senha`, {
        method: 'POST',
        body: { senha: novaSenha },
      });
      fecharReset();
    } catch (err) {
      setErroReset(mensagemDe(err));
    } finally {
      setSalvando(false);
    }
  }

  async function alternarAtivo(u: Usuario) {
    setErroAcao('');
    const acao = u.ativo ? 'desativar' : 'reativar';
    if (u.ativo && !window.confirm(`Desativar ${u.nome}? A sessão dele cai na hora.`)) return;
    try {
      await api(`/api/usuarios/${u.id}/${acao}`, { method: 'POST' });
      carregar();
    } catch (err) {
      setErroAcao(mensagemDe(err));
    }
  }

  return (
    <Container size="md" py="md">
      <Stack gap="lg">
        <Group justify="space-between">
          <Title order={2}>Usuários</Title>
          <Button onClick={abrirCriar}>Novo usuário</Button>
        </Group>

        {erroAcao && (
          <Alert color="red" withCloseButton onClose={() => setErroAcao('')}>
            {erroAcao}
          </Alert>
        )}

        {estado.fase === 'carregando' && (
          <Group gap="sm">
            <Loader size="sm" />
            <Text fw={600}>Carregando usuários…</Text>
          </Group>
        )}

        {estado.fase === 'erro' && (
          <Alert color="red" title="Não foi possível carregar">
            <Button onClick={carregar}>Tentar novamente</Button>
          </Alert>
        )}

        {estado.fase === 'ok' && (
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Nome</Table.Th>
                <Table.Th>Login</Table.Th>
                <Table.Th>Papel</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Ações</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {estado.usuarios.map((u) => (
                <Table.Tr key={u.id}>
                  <Table.Td fw={600}>{u.nome}</Table.Td>
                  <Table.Td>{u.login}</Table.Td>
                  <Table.Td>
                    <Badge variant="light">{u.role}</Badge>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={u.ativo ? 'green' : 'red'}>{u.ativo ? 'Ativo' : 'Inativo'}</Badge>
                  </Table.Td>
                  <Table.Td>
                    <Group gap="xs">
                      <Button size="compact-md" variant="default" onClick={() => abrirReset(u)}>
                        Reset senha
                      </Button>
                      <Button
                        size="compact-md"
                        variant="default"
                        color={u.ativo ? 'red' : 'green'}
                        disabled={u.id === eu.id}
                        onClick={() => void alternarAtivo(u)}
                      >
                        {u.ativo ? 'Desativar' : 'Reativar'}
                      </Button>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Stack>

      <Modal opened={criando} onClose={() => setCriando(false)} title="Novo usuário">
        <Stack gap="md">
          <TextInput
            label="Nome"
            value={novo.nome}
            onChange={(e) => setNovo({ ...novo, nome: e.currentTarget.value })}
          />
          <TextInput
            label="Login"
            description="letras minúsculas, números, ponto, hífen e _"
            value={novo.login}
            onChange={(e) => setNovo({ ...novo, login: e.currentTarget.value })}
          />
          <PasswordInput
            label="Senha inicial"
            description="mínimo 8 caracteres; frases longas valem mais que símbolos"
            value={novo.senha}
            onChange={(e) => setNovo({ ...novo, senha: e.currentTarget.value })}
          />
          <Select
            label="Papel"
            data={[...ROLES]}
            value={novo.role}
            onChange={(v) => setNovo({ ...novo, role: (v ?? 'EXECUTANTE') as Role })}
            allowDeselect={false}
          />
          {erroCriar && <Alert color="red">{erroCriar}</Alert>}
          <Button loading={salvando} onClick={() => void criar()}>
            Criar usuário
          </Button>
        </Stack>
      </Modal>

      <Modal
        opened={resetAlvo !== null}
        onClose={fecharReset}
        title={`Reset de senha — ${resetAlvo?.nome ?? ''}`}
      >
        <Stack gap="md">
          <PasswordInput
            label="Nova senha"
            description="o usuário será desconectado e entra com a nova senha"
            value={novaSenha}
            onChange={(e) => setNovaSenha(e.currentTarget.value)}
          />
          {erroReset && <Alert color="red">{erroReset}</Alert>}
          <Button loading={salvando} onClick={() => void resetarSenha()}>
            Salvar nova senha
          </Button>
        </Stack>
      </Modal>
    </Container>
  );
}
