import { fetchWithTimeout } from './fetchWithTimeout';

const SERVER_HEALTH_TIMEOUT_MS = 8_000;

interface HealthResponse {
  dbConnected?: unknown;
}

export async function isServerDatabaseConnected(): Promise<boolean> {
  try {
    const response = await fetchWithTimeout('/api/health', {
      cache: 'no-store',
      credentials: 'same-origin',
    }, SERVER_HEALTH_TIMEOUT_MS);
    if (!response.ok) return false;

    const data: unknown = await response.json();
    return Boolean(data && typeof data === 'object' && (data as HealthResponse).dbConnected === true);
  } catch {
    return false;
  }
}
