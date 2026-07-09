import { useCallback, useEffect, useState } from 'react';

import { Group, Text, UnstyledButton } from '@mantine/core';
import type { Notificacoes, Usuario } from '@rhodes/shared';
import { useNavigate } from 'react-router';

import { api } from '../lib/api';
import { BANDAS } from '../theme';

const INTERVALO_MS = 30_000;
const CHAVE_DISPENSA = 'rhodes-banner-dispensa';

/** Texto + destino conforme o papel; null = nada a mostrar. */
function conteudo(usuario: Usuario, n: Notificacoes): { texto: string; para: string } | null {
  if (usuario.role === 'GESTOR') {
    const partes: string[] = [];
    if (n.escalonadas > 0) partes.push(`${n.escalonadas} atrasada(s) há +1 dia`);
    else if (n.overdue > 0) partes.push(`${n.overdue} tarefa(s) atrasada(s)`);
    if (n.justificativasPendentes > 0) partes.push(`${n.justificativasPendentes} justificativa(s) a decidir`);
    if (partes.length === 0) return null;
    return { texto: partes.join(' · '), para: n.justificativasPendentes > 0 ? '/gestor/justificativas' : '/' };
  }
  if (usuario.role === 'VISTORIADOR') {
    if (n.filaVistoria === 0) return null;
    return { texto: `${n.filaVistoria} execução(ões) aguardando vistoria`, para: '/vistoria' };
  }
  // EXECUTANTE
  const partes: string[] = [];
  if (n.escalonadas > 0) partes.push(`${n.escalonadas} atrasada(s) há +1 dia`);
  else if (n.overdue > 0) partes.push(`${n.overdue} tarefa(s) atrasada(s)`);
  if (n.retrabalhos > 0) partes.push(`${n.retrabalhos} retrabalho(s)`);
  if (n.decisoes > 0) partes.push(`${n.decisoes} justificativa(s) decidida(s)`);
  if (partes.length === 0) return null;
  return { texto: partes.join(' · '), para: '/agora' };
}

/** Banner vermelho no topo (gestor/executante/vistoriador) — polling leve, dispensável. */
export function BannerNotificacoes({ usuario }: { usuario: Usuario }) {
  const navigate = useNavigate();
  const [notif, setNotif] = useState<Notificacoes | null>(null);
  const [dispensadoEm, setDispensadoEm] = useState<string>(
    () => sessionStorage.getItem(CHAVE_DISPENSA) ?? '',
  );

  const atualizar = useCallback(async () => {
    try {
      const n = await api<Notificacoes>('/api/notificacoes', { redirecionar401: false });
      setNotif(n);
    } catch {
      // rede caiu ou 401 — mantém o estado; a guarda AreaLogada cuida do redirect
    }
  }, []);

  useEffect(() => {
    void atualizar();
    const t = setInterval(() => void atualizar(), INTERVALO_MS);
    return () => clearInterval(t);
  }, [atualizar]);

  if (!notif) return null;
  const c = conteudo(usuario, notif);
  // incidente novo (payload volta a ter algo) sempre reexibe: limpa a dispensa quando zera
  if (!c) {
    if (dispensadoEm !== '') {
      sessionStorage.removeItem(CHAVE_DISPENSA);
      setDispensadoEm('');
    }
    return null;
  }
  if (dispensadoEm === c.texto) return null; // dispensado exatamente este estado

  function dispensar(e: React.MouseEvent) {
    e.stopPropagation();
    sessionStorage.setItem(CHAVE_DISPENSA, c!.texto);
    setDispensadoEm(c!.texto);
  }

  return (
    <UnstyledButton
      onClick={() => navigate(c.para)}
      style={{
        display: 'block',
        width: '100%',
        background: BANDAS.critico,
        color: '#fff',
        padding: '8px 16px',
      }}
    >
      <Group justify="space-between" wrap="nowrap">
        <Text fw={700}>⚠ {c.texto}</Text>
        <Text component="span" size="sm" onClick={dispensar} style={{ cursor: 'pointer' }}>
          dispensar ✕
        </Text>
      </Group>
    </UnstyledButton>
  );
}
