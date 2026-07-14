import { FetchTimeoutError, fetchWithTimeout } from '../fetchWithTimeout';

describe('fetchWithTimeout', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  it('returns a response and clears its deadline when the request finishes', async () => {
    const response = { ok: true } as Response;
    fetchMock.mockResolvedValue(response);

    await expect(fetchWithTimeout('/api/test', {}, 3_000)).resolves.toBe(response);
    expect(jest.getTimerCount()).toBe(0);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('settles at the deadline even when fetch ignores the abort signal', async () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    const result = fetchWithTimeout('/api/test', {}, 3_000).catch((error: unknown) => error);

    await jest.advanceTimersByTimeAsync(3_000);

    const error = await result;
    expect(error).toBeInstanceOf(FetchTimeoutError);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('preserves an immediate network failure and clears its deadline', async () => {
    const networkError = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValue(networkError);

    await expect(fetchWithTimeout('/api/test', {}, 3_000)).rejects.toBe(networkError);
    expect(jest.getTimerCount()).toBe(0);
  });
});
