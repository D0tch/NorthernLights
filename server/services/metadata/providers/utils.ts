export function cleanHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/**
 * Enhanced fetch with primitive retry for network resets.
 */
export async function fetchWithRetry(url: string, options?: RequestInit, retries = 1): Promise<Response> {
  try {
    const res = await fetch(url, options);
    if (res.status === 429 && retries > 0) {
      const retryAfter = res.headers.get('Retry-After');
      const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;
      await new Promise(r => setTimeout(r, Math.min(delay, 5000)));
      return fetchWithRetry(url, options, retries - 1);
    }
    return res;
  } catch (err: any) {
    if (retries > 0) {
      // Retry on network errors like ECONNRESET or fetch failed
      await new Promise(r => setTimeout(r, 1500));
      return fetchWithRetry(url, options, retries - 1);
    }
    throw err;
  }
}
