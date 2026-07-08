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

/** Payload do POST /api/auth/login (limites alinhados à política de senha do server). */
export const loginPayloadSchema = z.object({
  login: z.string().trim().min(1).max(100),
  senha: z.string().min(1).max(64),
});

export type LoginPayload = z.infer<typeof loginPayloadSchema>;

/** Payload do POST /api/usuarios (gestor cria usuário). */
export const criarUsuarioSchema = z.object({
  nome: z.string().trim().min(1).max(120),
  login: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(100)
    .regex(/^[a-z0-9._-]+$/, 'Login pode ter só letras minúsculas, números, ponto, hífen e _'),
  senha: z.string().min(1).max(64),
  role: roleSchema,
});

export type CriarUsuarioPayload = z.infer<typeof criarUsuarioSchema>;

/** Payload do POST /api/usuarios/:id/reset-senha. */
export const resetSenhaSchema = z.object({
  senha: z.string().min(1).max(64),
});

export type ResetSenhaPayload = z.infer<typeof resetSenhaSchema>;
