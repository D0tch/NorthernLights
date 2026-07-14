import { isServerDatabaseConnected, SERVER_HEALTH_TIMEOUT_MS } from '../serverHealth';

describe('server health deadline', () => {
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

  it('reports a connected database from a healthy response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ dbConnected: true }),
    } as unknown as Response);

    await expect(isServerDatabaseConnected()).resolves.toBe(true);
  });

  it('reports disconnected after the deadline when the health request never settles', async () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    const result = isServerDatabaseConnected();

    await jest.advanceTimersByTimeAsync(SERVER_HEALTH_TIMEOUT_MS);

    await expect(result).resolves.toBe(false);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
