import { Capacitor, CapacitorHttp } from '@capacitor/core';

export const nativePlatform = () => Capacitor.isNativePlatform();

export function nativeApiUrl(
  origin: string,
  path: string,
  development: boolean,
) {
  const url = new URL(origin);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        development &&
        url.protocol === 'http:' &&
        url.hostname === '127.0.0.1'
      )) ||
    !/^\/api\/[a-zA-Z0-9/?=&%_.:-]+$/.test(path) ||
    decodeURIComponent(path.split('?')[0]!).includes('..')
  )
    throw new Error('Invalid Android server configuration.');
  return `${url.origin}${path}`;
}

// Browser callers keep relative /api paths. Native HTTP owns the HttpOnly cookie
// jar; cookie values are never copied into application state or local storage.
export async function apiFetch(
  path: string,
  options: RequestInit,
): Promise<Response> {
  if (!nativePlatform()) return fetch(path, options);
  const url = nativeApiUrl(
    import.meta.env.VITE_HUB_API_ORIGIN ?? '',
    path,
    import.meta.env.VITE_HUB_ANDROID_TEST === 'true',
  );
  options.signal?.throwIfAborted();
  try {
    const response = await CapacitorHttp.request({
      url,
      method: options.method ?? 'GET',
      headers: {
        ...(options.headers as Record<string, string>),
        Origin: 'https://localhost',
      },
      ...(options.body
        ? { data: JSON.parse(options.body as string) as unknown }
        : {}),
      connectTimeout: 8000,
      readTimeout: 8000,
      disableRedirects: true,
      responseType: 'json',
    });
    options.signal?.throwIfAborted();
    return new Response(JSON.stringify(response.data), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    // Native network errors may contain private URLs or request information.
    throw new TypeError('Server unavailable.', { cause: error });
  }
}
