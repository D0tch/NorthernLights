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

export const prefetchAlbumDetail = (): void => {
  if (!albumPromise) albumPromise = importAlbumDetail().catch((err) => { albumPromise = null; throw err; });
};

export const prefetchArtistDetail = (): void => {
  if (!artistPromise) artistPromise = importArtistDetail().catch((err) => { artistPromise = null; throw err; });
};

export const prefetchPlaylistDetail = (): void => {
  if (!playlistPromise) playlistPromise = importPlaylistDetail().catch((err) => { playlistPromise = null; throw err; });
};

export const AlbumDetail = React.lazy(() => importAlbumDetail().then(m => ({ default: m.AlbumDetail })));
export const ArtistDetail = React.lazy(() => importArtistDetail().then(m => ({ default: m.ArtistDetail })));
export const PlaylistDetail = React.lazy(() => importPlaylistDetail().then(m => ({ default: m.PlaylistDetail })));
