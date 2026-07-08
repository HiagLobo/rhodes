export class ApiError extends Error {
  constructor(
    public status: number,
    public corpo: { erro?: string; problemas?: string[] } | null,
  ) {
    super(corpo?.erro ?? `Erro ${status}`);
    this.name = 'ApiError';
  }
}

type ApiOptions = {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  /**
   * Sessão morta no meio do uso → volta para /login. Desligue em chamadas de auth
   * (login com senha errada é 401 e NÃO pode redirecionar; a guarda trata o /me).
   */
  redirecionar401?: boolean;
};

/** Wrapper padrão de chamadas à API: JSON, cookies de sessão e erro tipado. */
export async function api<T>(url: string, options: ApiOptions = {}): Promise<T> {
  const { method = 'GET', body, redirecionar401 = true } = options;

  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const corpo = (await res.json().catch(() => null)) as ApiError['corpo'];
    if (res.status === 401 && redirecionar401 && window.location.pathname !== '/login') {
      window.location.assign('/login');
    }
    throw new ApiError(res.status, corpo);
  }

  return (await res.json()) as T;
}
