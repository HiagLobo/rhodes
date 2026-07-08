import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

/**
 * Tabela técnica chave/valor — prova o pipeline de migração na S2 da Onda 00.
 * As tabelas de domínio chegam nas Ondas 01+ (sempre por migração aditiva).
 */
export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/**
 * Usuários do sistema (Onda 01/S1). `role` ∈ ROLES (@rhodes/shared).
 * `criado_em` tem default do SERVIDOR (unixepoch) — timestamp de negócio nunca é digitável (ALCOA+).
 * Exclusão é lógica via `ativo` — usuário nunca é apagado (a trilha de auditoria referencia ele).
 */
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nome: text('nome').notNull(),
  login: text('login').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull(),
  ativo: integer('ativo', { mode: 'boolean' }).notNull().default(true),
  criadoEm: integer('criado_em', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * Áreas físicas do terminal (Onda 02) — 1 linha por string distinta da coluna "Área" do
 * checklist validado. `peso_criticidade` entra no score (mudança é auditada pela API).
 */
export const areas = sqliteTable('areas', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nome: text('nome').notNull().unique(),
  pesoCriticidade: real('peso_criticidade').notNull().default(1),
  ativo: integer('ativo', { mode: 'boolean' }).notNull().default(true),
  criadoEm: integer('criado_em', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * Procedimentos do Plano Mestre (Onda 02) — os 39 do checklist + os que o gestor criar.
 * `interval_days`/`grace_days` são sempre derivados da frequência NO SERVIDOR.
 * O método ("como será feito") vive em `metodo_versoes` — este registro só aponta a versão
 * atual (FK circular nullable: template → versão → template).
 */
export const taskTemplates = sqliteTable('task_templates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  areaId: integer('area_id')
    .notNull()
    .references(() => areas.id),
  atividade: text('atividade').notNull(),
  frequency: text('frequency').notNull(),
  intervalDays: integer('interval_days').notNull(),
  scheduleMode: text('schedule_mode').notNull(),
  graceDays: integer('grace_days').notNull(),
  triggerType: text('trigger_type').notNull().default('CALENDAR'),
  shipPhase: text('ship_phase'),
  leadDays: integer('lead_days'),
  limitacoes: text('limitacoes'),
  dependsOnTemplateId: integer('depends_on_template_id').references(
    (): AnySQLiteColumn => taskTemplates.id,
  ),
  metodoVersaoAtualId: integer('metodo_versao_atual_id').references(
    (): AnySQLiteColumn => metodoVersoes.id,
  ),
  // Âncora semanal do modo FIXED (0=domingo…6=sábado); NULL = segunda para SEMANAL (Onda 03).
  fixedDow: integer('fixed_dow'),
  // Anti-fraude básico (Onda 05): DEPOIS − ANTES precisa de pelo menos N minutos.
  minFotosIntervaloMin: integer('min_fotos_intervalo_min').notNull().default(5),
  ativo: integer('ativo', { mode: 'boolean' }).notNull().default(true),
  criadoEm: integer('criado_em', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * Ocorrências de tarefa (Onda 03) — materializadas pelos 3 pontos do motor; a leitura é
 * SELECT puro. Datas de agendamento como 'YYYY-MM-DD' (dia operacional America/Recife);
 * started/finished são timestamps do SERVIDOR. `round_id` ainda SEM FK — ship_operations
 * nasce na Onda 04 (SQLite não adiciona FK depois; integridade via código na 04).
 * TRAVA física: no máximo 1 instância ABERTA por template (índice único parcial).
 */
export const taskInstances = sqliteTable(
  'task_instances',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    templateId: integer('template_id')
      .notNull()
      .references(() => taskTemplates.id),
    dueDate: text('due_date').notNull(),
    windowEnd: text('window_end').notNull(),
    status: text('status').notNull().default('PENDING'),
    origin: text('origin').notNull().default('CALENDAR'),
    roundId: integer('round_id'),
    executanteId: integer('executante_id').references(() => users.id),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    criadoEm: integer('criado_em', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('task_instances_aberta_por_template_uq')
      .on(t.templateId)
      .where(sql`status IN ('PENDING','IN_PROGRESS','OVERDUE')`),
    index('task_instances_status_idx').on(t.status),
    index('task_instances_due_idx').on(t.dueDate),
  ],
);

/**
 * Versões do método (POP) — linhas IMUTÁVEIS: editar método = inserir versão nova (ALCOA+).
 * O registro de conclusão das ondas futuras aponta para a versão vigente na data.
 */
export const metodoVersoes = sqliteTable(
  'metodo_versoes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    templateId: integer('template_id')
      .notNull()
      .references(() => taskTemplates.id),
    versao: integer('versao').notNull(),
    texto: text('texto').notNull(),
    criadoEm: integer('criado_em', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    criadoPorId: integer('criado_por_id').references(() => users.id),
  },
  (t) => [unique('metodo_versoes_template_versao_uq').on(t.templateId, t.versao)],
);

/**
 * Parâmetros do score (Onda 02) — VERSIONADA e append-only (triggers na migração 0004):
 * mudar peso = nova linha; a vigente é a de maior id (imutável 7). Engine chega na Onda 08.
 */
export const scoreConfig = sqliteTable('score_config', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  valores: text('valores').notNull(),
  motivo: text('motivo'),
  criadoEm: integer('criado_em', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  criadoPorId: integer('criado_por_id').references(() => users.id),
});

/**
 * Operação de navio (Onda 04) — estado MATERIALIZADO para leitura burra; o histórico vive em
 * ship_events. `task_instances.round_id` referencia esta tabela POR CÓDIGO (sem FK — decisão
 * da Onda 03).
 */
export const shipOperations = sqliteTable('ship_operations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  navio: text('navio').notNull(),
  produto: text('produto'),
  tonelagem: real('tonelagem'),
  etaDate: text('eta_date').notNull(),
  status: text('status').notNull().default('ANUNCIADO'),
  criadoPorId: integer('criado_por_id').references(() => users.id),
  criadoEm: integer('criado_em', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * Eventos da operação — histórico IMUTÁVEL (correção = novo evento). `event_at` é a hora REAL
 * do fato (informada; única exceção documentada ao "nunca digitável" — validada na API:
 * ≤ agora e ≥ evento anterior). `registered_at` é sempre do servidor (ALCOA).
 */
export const shipEvents = sqliteTable(
  'ship_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    operationId: integer('operation_id')
      .notNull()
      .references(() => shipOperations.id),
    transicao: text('transicao').notNull(),
    eventAt: integer('event_at', { mode: 'timestamp' }).notNull(),
    registeredAt: integer('registered_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    registradoPorId: integer('registrado_por_id')
      .notNull()
      .references(() => users.id),
    confirmadoPorId: integer('confirmado_por_id').references(() => users.id),
  },
  (t) => [index('ship_events_operation_idx').on(t.operationId)],
);

/**
 * Evidência fotográfica (Onda 05/S1) — o binário vive no filesystem
 * (`RHODES_DATA_DIR/fotos/AAAA/MM/<sha256>.jpg`, NUNCA BLOB); aqui ficam os metadados.
 * `sha256` UNIQUE é a trava anti-reuso (foto bit-idêntica em outra tarefa = rejeitada).
 * `captured_at`/`skew_ms` vêm do dispositivo; `received_at` é a âncora temporal do SERVIDOR.
 * `parte` é o ordinal de execução multi-dia (sem FK — `execucao_partes` chega na S2, mesmo
 * padrão do `round_id`). Foto nunca se apaga.
 */
export const photos = sqliteTable(
  'photos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    instanceId: integer('instance_id')
      .notNull()
      .references(() => taskInstances.id),
    tipo: text('tipo').notNull(),
    parte: integer('parte').notNull().default(1),
    sha256: text('sha256').notNull(),
    path: text('path').notNull(),
    tamanhoBytes: integer('tamanho_bytes').notNull(),
    capturedAt: integer('captured_at', { mode: 'timestamp' }).notNull(),
    receivedAt: integer('received_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    skewMs: integer('skew_ms').notNull(),
    exifDatetime: text('exif_datetime'),
    exifModel: text('exif_model'),
    enviadoPorId: integer('enviado_por_id')
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    uniqueIndex('photos_sha256_uq').on(t.sha256),
    index('photos_instance_idx').on(t.instanceId),
  ],
);

/**
 * Partes de execução multi-dia (Onda 05/S2) — "MPL de paredes leva dias". Cada linha é um
 * fechamento parcial COM evidência própria (fotos da mesma `parte`). Append-only por
 * convenção: não existe rota de update/delete; corrigir = registrar a parte seguinte.
 * A conclusão final NÃO gera linha aqui — é a própria instância fechando.
 */
export const execucaoPartes = sqliteTable(
  'execucao_partes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    instanceId: integer('instance_id')
      .notNull()
      .references(() => taskInstances.id),
    parte: integer('parte').notNull(),
    percentualAcumulado: integer('percentual_acumulado').notNull(),
    observacao: text('observacao'),
    executanteId: integer('executante_id')
      .notNull()
      .references(() => users.id),
    criadoEm: integer('criado_em', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [unique('execucao_partes_instance_parte_uq').on(t.instanceId, t.parte)],
);

/**
 * Justificativas estruturadas (Onda 05/S3) — "não foi possível realizar" com motivo por
 * código. 1 por instância (UNIQUE); nasce PENDENTE e NUNCA se reescreve — a decisão do
 * gestor (Onda 07) preenche decidido_* via UPDATE auditado de status, não edição do registro.
 */
export const justificativas = sqliteTable('justificativas', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  instanceId: integer('instance_id')
    .notNull()
    .unique()
    .references(() => taskInstances.id),
  motivo: text('motivo').notNull(),
  texto: text('texto'),
  fotoId: integer('foto_id').references(() => photos.id),
  status: text('status').notNull().default('PENDENTE'),
  criadoPorId: integer('criado_por_id')
    .notNull()
    .references(() => users.id),
  criadoEm: integer('criado_em', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  decididoPorId: integer('decidido_por_id').references(() => users.id),
  decididoEm: integer('decidido_em', { mode: 'timestamp' }),
  decisaoObs: text('decisao_obs'),
});

/**
 * Trilha de auditoria (Onda 01/S2) — APPEND-ONLY, imposto por triggers na migração 0002
 * (UPDATE/DELETE → RAISE(ABORT)). Toda ação significativa entra aqui via o helper audit().
 * `ator_login` é cópia textual: o registro continua atribuível mesmo se o usuário mudar (ALCOA "A").
 * id autoincrement = ordem monotônica dos eventos.
 */
/**
 * Sessões (Onda 01/S3). `id` é o SHA-256 do token — o token em claro só existe no cookie
 * do cliente (vazamento do banco não vira sessão válida). Expiração deslizante de ~1 turno:
 * `expira_em` é renovado a cada request autenticado (validarSessao).
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    criadoEm: integer('criado_em', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    expiraEm: integer('expira_em', { mode: 'timestamp' }).notNull(),
    ip: text('ip'),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  atorId: integer('ator_id').references(() => users.id),
  atorLogin: text('ator_login'),
  acao: text('acao').notNull(),
  entidade: text('entidade'),
  entidadeId: text('entidade_id'),
  antes: text('antes'),
  depois: text('depois'),
  ip: text('ip'),
  criadoEm: integer('criado_em', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});
