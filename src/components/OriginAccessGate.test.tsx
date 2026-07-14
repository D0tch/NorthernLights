import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OriginAccessGate } from './OriginAccessGate';

const responseWith = (data: unknown): Response => ({
  json: jest.fn().mockResolvedValue(data),
} as unknown as Response);

describe('OriginAccessGate', () => {
  const originalFetch = global.fetch;
  const originalOnlineStatus = navigator.onLine;
  let fetchMock: jest.Mock;

  const setOnlineStatus = (online: boolean) => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: online,
    });
  };

  beforeEach(() => {
    setOnlineStatus(true);
    fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    setOnlineStatus(originalOnlineStatus);
    global.fetch = originalFetch;
  });

  it('stops app startup and explains how to allow a rejected origin', async () => {
    fetchMock.mockResolvedValue(responseWith({
      allowed: false,
      origin: 'https://music-unlisted.example.com',
      code: 'ORIGIN_NOT_ALLOWED',
    }));

    render(
      <OriginAccessGate>
        <div>App content</div>
      </OriginAccessGate>,
    );

    expect(screen.queryByText('App content')).toBeNull();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This address is not allowed');
    expect(alert.textContent).toContain('https://music-unlisted.example.com');
    expect(alert.textContent).toContain('ALLOWED_ORIGINS');
    expect(screen.queryByText('App content')).toBeNull();
  });

  it('mounts the app after the server confirms the origin', async () => {
    fetchMock.mockResolvedValue(responseWith({
      allowed: true,
      origin: window.location.origin,
      code: 'ORIGIN_ALLOWED',
    }));

    render(
      <OriginAccessGate>
        <div>App content</div>
      </OriginAccessGate>,
    );

    expect(await screen.findByText('App content')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/origin-status?origin=${encodeURIComponent(window.location.origin)}`,
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }),
    );
  });

  it('keeps older servers and genuine network outages on the existing recovery path', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    render(
      <OriginAccessGate>
        <div>App content</div>
      </OriginAccessGate>,
    );

    expect(await screen.findByText('App content')).toBeTruthy();
  });

  it('bounds a silently hanging origin probe and continues startup', async () => {
    jest.useFakeTimers();
    fetchMock.mockReturnValue(new Promise(() => undefined));

    render(
      <OriginAccessGate>
        <div>App content</div>
      </OriginAccessGate>,
    );

    expect(screen.queryByText('App content')).toBeNull();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });

    expect(screen.queryByText('App content')).toBeTruthy();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('starts a cached app immediately while offline and validates on reconnect', async () => {
    setOnlineStatus(false);
    fetchMock.mockResolvedValue(responseWith({
      allowed: false,
      origin: 'https://music-unlisted.example.com',
    }));

    render(
      <OriginAccessGate>
        <div>App content</div>
      </OriginAccessGate>,
    );

    expect(await screen.findByText('App content')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    setOnlineStatus(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a confirmed blocked state when a retry times out', async () => {
    jest.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(responseWith({ allowed: false, origin: window.location.origin }))
      .mockReturnValueOnce(new Promise(() => undefined));

    render(
      <OriginAccessGate>
        <div>App content</div>
      </OriginAccessGate>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });

    expect(screen.queryByRole('alert')).toBeTruthy();
    expect(screen.queryByText('App content')).toBeNull();
  });

  it('rechecks the configuration without reloading the page', async () => {
    fetchMock
      .mockResolvedValueOnce(responseWith({ allowed: false, origin: window.location.origin }))
      .mockResolvedValueOnce(responseWith({ allowed: true, origin: window.location.origin }));

    render(
      <OriginAccessGate>
        <div>App content</div>
      </OriginAccessGate>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText('App content')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
