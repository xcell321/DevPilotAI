export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function localToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="devpilot-token"]');
  return meta?.content ?? '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function apiGet<T>(pathname: string, attempt = 0): Promise<T> {
  const token = localToken();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers['x-devpilot-token'] = token;

  let response: Response;
  try {
    response = await fetch(pathname, { headers });
  } catch (error) {
    if (attempt === 0) {
      await sleep(350);
      return apiGet<T>(pathname, 1);
    }
    throw new ApiError(
      error instanceof Error ? error.message : 'Could not reach the local backend.',
      0,
    );
  }

  if (response.status === 401 && attempt === 0) {
    await sleep(350);
    return apiGet<T>(pathname, 1);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new ApiError(
      body.error?.message ?? `Request failed with status ${response.status}.`,
      response.status,
    );
  }

  return (await response.json()) as T;
}

async function apiSend<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  pathname: string,
  body?: unknown,
): Promise<T> {
  const token = localToken();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers['x-devpilot-token'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiError(
      error instanceof Error ? error.message : 'Could not reach the local backend.',
      0,
    );
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new ApiError(
      payload.error?.message ?? `Request failed with status ${response.status}.`,
      response.status,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function apiPost<T>(pathname: string, body?: unknown): Promise<T> {
  return apiSend<T>('POST', pathname, body);
}

export function apiPatch<T>(pathname: string, body: unknown): Promise<T> {
  return apiSend<T>('PATCH', pathname, body);
}

export function apiDelete<T>(pathname: string): Promise<T> {
  return apiSend<T>('DELETE', pathname);
}
