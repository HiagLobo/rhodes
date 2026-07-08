import { z } from 'zod';
/** Os 3 papéis do sistema (arquitetura §5). */
export const ROLES = ['GESTOR', 'EXECUTANTE', 'VISTORIADOR'];
export const roleSchema = z.enum(ROLES);
/** Payload do POST /api/auth/login (limites alinhados à política de senha do server). */
export const loginPayloadSchema = z.object({
    login: z.string().trim().min(1).max(100),
    senha: z.string().min(1).max(64),
});
//# sourceMappingURL=usuarios.js.map