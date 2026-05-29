import React from 'react';

// Centralised dynamic imports for the heavy detail routes. Exporting both the
// React.lazy components and the prefetch fns from here means hover/pointerdown
// warm-up and the actual route render hit the exact same module specifier, so
// the bundler returns the cached chunk on the second call.

const importAlbumDetail = () => import('../components/library/AlbumDetail');
const importArtistDetail = () => import('../components/library/ArtistDetail');
const importPlaylistDetail = () => import('../components/library/PlaylistDetail');

let albumPromise: ReturnType<typeof importAlbumDetail> | null = null;
let artistPromise: ReturnType<typeof importArtistDetail> | null = null;
let playlistPromise: ReturnType<typeof importPlaylistDetail> | null = null;

// Each prefetch fn both warms the chunk and returns the in-flight import
// promise. Callers that are about to navigate with a view transition await
// this promise first, so the lazy route component is already resolved when the
// (synchronous, flushSync) navigation commits — otherwise the synchronous
// render would suspend mid-transition and strand the old-page snapshot overlay.
export const prefetchAlbumDetail = (): Promise<unknown> => {
  if (!albumPromise) albumPromise = importAlbumDetail().catch((err) => { albumPromise = null; throw err; });
  return albumPromise;
};

export const prefetchArtistDetail = (): Promise<unknown> => {
  if (!artistPromise) artistPromise = importArtistDetail().catch((err) => { artistPromise = null; throw err; });
  return artistPromise;
};

export const prefetchPlaylistDetail = (): Promise<unknown> => {
  if (!playlistPromise) playlistPromise = importPlaylistDetail().catch((err) => { playlistPromise = null; throw err; });
  return playlistPromise;
};

export const AlbumDetail = React.lazy(() => importAlbumDetail().then(m => ({ default: m.AlbumDetail })));
export const ArtistDetail = React.lazy(() => importArtistDetail().then(m => ({ default: m.ArtistDetail })));
export const PlaylistDetail = React.lazy(() => importPlaylistDetail().then(m => ({ default: m.PlaylistDetail })));
