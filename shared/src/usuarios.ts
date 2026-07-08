import { z } from 'zod';

/** Os 3 papéis do sistema (arquitetura §5). */
export const ROLES = ['GESTOR', 'EXECUTANTE', 'VISTORIADOR'] as const;

export const roleSchema = z.enum(ROLES);

export type Role = z.infer<typeof roleSchema>;

/**
 * Representação PÚBLICA de usuário — é o que as rotas devolvem.
 * Nunca inclui password_hash (contrato de PII do imutável 12).
 */
export type Usuario = {
  id: number;
  nome: string;
  login: string;
  role: Role;
  ativo: boolean;
};
