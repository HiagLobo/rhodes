import type DatabaseType from 'better-sqlite3';

let seq = 0;

/**
 * Planta um par ANTES/DEPOIS válido direto no banco (recuado `minutos` — vence o
 * min_fotos_intervalo_min default de 5). Para testes que precisam CONCLUIR sem passar
 * pelo upload multipart (o upload tem suíte própria em fotos-api.test.ts).
 */
export function plantarEvidencia(
  sqlite: DatabaseType.Database,
  instanciaId: number,
  executanteLogin: string,
  opts: { minutos?: number; parte?: number } = {},
): void {
  const { minutos = 10, parte = 1 } = opts;
  const user = sqlite.prepare('SELECT id FROM users WHERE login = ?').get(executanteLogin) as
    | { id: number }
    | undefined;
  if (!user) throw new Error(`login desconhecido no seed: ${executanteLogin}`);

  const agora = Math.floor(Date.now() / 1000);
  const inicio = agora - minutos * 60;
  const inserir = sqlite.prepare(
    `INSERT INTO photos (instance_id, tipo, parte, sha256, path, tamanho_bytes,
       captured_at, received_at, skew_ms, enviado_por_id)
     VALUES (?, ?, ?, ?, ?, 100, ?, ?, 0, ?)`,
  );
  const sha = () => `teste-${instanciaId}-${parte}-${++seq}`;
  inserir.run(instanciaId, 'ANTES', parte, sha(), `fotos/teste/${seq}.jpg`, inicio, inicio, user.id);
  inserir.run(instanciaId, 'DEPOIS', parte, sha(), `fotos/teste/${seq}.jpg`, agora, agora, user.id);
}
