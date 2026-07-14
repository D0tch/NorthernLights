import React from 'react';
import { render } from '@testing-library/react';
import { TextDecoder, TextEncoder } from 'util';

Object.assign(globalThis, { TextDecoder, TextEncoder });

const { MemoryRouter } = require('react-router-dom') as typeof import('react-router-dom');

var mockStoreState: Record<string, unknown>;

jest.mock('../store/index', () => ({
  usePlayerStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mockStoreState),
}));

jest.mock('../hooks/usePlayerPlacement', () => ({
  usePlayerPlacement: () => ['dock'],
}));

jest.mock('../hooks/useScrollRestoration', () => ({
  useScrollRestoration: jest.fn(),
}));

jest.mock('../utils/routePrefetch', () => {
  const ReactModule = require('react') as typeof React;
  const Stub = () => ReactModule.createElement('div', null, 'route');

  return {
    AlbumDetail: Stub,
    ArtistDetail: Stub,
    PlaylistDetail: Stub,
    LibraryHome: Stub,
    Hub: Stub,
    Playlists: Stub,
  };
});

const { MainContent } = require('./MainContent') as typeof import('./MainContent');

describe('MainContent scroll viewport', () => {
  it('applies the shared overlay-scroll class to the single routed viewport', () => {
    mockStoreState = {
      library: [{ id: 'track-1' }],
      albums: [],
      artists: [],
      isLibraryLoading: false,
      isScanning: false,
      playlist: [],
    };

    const { container } = render(
      <MemoryRouter initialEntries={['/library']}>
        <MainContent />
      </MemoryRouter>,
    );
    const viewport = container.firstElementChild?.firstElementChild as HTMLElement;

    expect(viewport.className.split(' ')).toContain('app-scroll-viewport');
  });
});
