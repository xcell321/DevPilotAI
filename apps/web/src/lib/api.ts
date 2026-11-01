import protocol from '../../../../shared/protocol.json';
import { errorMessage } from './errors';

const { TOKEN_HEADER, TOKEN_META_NAME } = protocol;
const NETWORK_FALLBACK = 'Could not reach the local backend.';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function localToken(): string {
  const meta = document.querySelector<HTMLMetaElement>(`meta[name="${TOKEN_META_NAME}"]`);
  return meta?.content ?? '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function responseError(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  return new ApiError(
    body.error?.message ?? `Request failed with status ${response.status}.`,
    response.status,
  );
}

async function apiRequest<T>(
  method: HttpMethod,
  pathname: string,
  body?: unknown,
  attempt = 0,
): Promise<T> {
  const token = localToken();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers[TOKEN_HEADER] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (method === 'GET' && attempt === 0) {
      await sleep(350);
      return apiRequest<T>(method, pathname, body, attempt + 1);
    }
    throw new ApiError(errorMessage(error, NETWORK_FALLBACK), 0);
  }

  if (method === 'GET' && response.status === 401 && attempt === 0) {
    await sleep(350);
    return apiRequest<T>(method, pathname, body, attempt + 1);
  }

  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function apiGet<T>(pathname: string, attempt = 0): Promise<T> {
  return apiRequest<T>('GET', pathname, undefined, attempt);
}

export function apiPost<T>(pathname: string, body?: unknown): Promise<T> {
  return apiRequest<T>('POST', pathname, body);
}

export function apiPut<T>(pathname: string, body: unknown): Promise<T> {
  return apiRequest<T>('PUT', pathname, body);
}

export function apiPatch<T>(pathname: string, body: unknown): Promise<T> {
  return apiRequest<T>('PATCH', pathname, body);
}

export function apiDelete<T>(pathname: string): Promise<T> {
  return apiRequest<T>('DELETE', pathname);
}
