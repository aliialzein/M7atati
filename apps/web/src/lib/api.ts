export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let refreshPromise: Promise<void> | null = null;
let refreshGeneration = 0;

function apiUrl(path: string) {
  const base = process.env.NEXT_PUBLIC_API_URL;
  if (!base) throw new Error('API URL is not configured');
  return `${base.replace(/\/$/, '')}${path}`;
}

async function send(path: string, init: RequestInit) {
  const headers = new Headers(init.headers);
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes((init.method ?? 'GET').toUpperCase())
  ) {
    headers.set('X-CSRF-Protection', '1');
    if (init.body) headers.set('Content-Type', 'application/json');
  }
  return fetch(apiUrl(path), {
    ...init,
    credentials: 'include',
    headers,
    cache: 'no-store',
  });
}

async function check(response: Response) {
  if (response.ok) return;
  const body = await response.json().catch(() => null);
  throw new ApiError(response.status, body?.message ?? 'Request failed');
}

async function refresh() {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const response = await send('/api/auth/refresh', { method: 'POST' });
      await check(response);
      refreshGeneration++;
    })().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const generation = refreshGeneration;
  let response = await send(path, init);
  if (
    response.status === 401 &&
    !['/api/auth/login', '/api/auth/refresh', '/api/auth/logout'].includes(path)
  ) {
    if (generation === refreshGeneration) await refresh();
    // Retry once only, preserving body, UUID, and abort signal.
    response = await send(path, init);
  }
  await check(response);
  return response.status === 204 ? (undefined as T) : response.json();
}
