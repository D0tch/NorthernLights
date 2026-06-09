import { Router } from 'express';
import crypto from 'crypto';
import {
  getPlaylistTracks,
  createPlaylist,
  addTracksToPlaylist,
  deletePlaylist,
  getPlaylistMeta,
  togglePlaylistPin,
  getPlaylistByIdForUser,
  getPlaylistsForUserWithTracks,
  setPlaylistShare,
  getPlaylistSuggestionPool,
} from '../database';

const router = Router();

// Get all playlists for current user. Backed by a two-query helper that
// avoids the previous N+1 (one `getPlaylistTracks` per playlist).
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const playlists = await getPlaylistsForUserWithTracks(userId);
    res.json({ playlists });
  } catch (error) {
    console.error('Playlist fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

// Get a single playlist with its tracks. Cheap path for the detail view —
// no need to load every other playlist's tracks just to open one.
router.get('/:id', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { id } = req.params;
    const meta = await getPlaylistByIdForUser(id as string, userId);
    if (!meta) return res.status(404).json({ error: 'Playlist not found' });

    const tracks = await getPlaylistTracks(id as string, userId);
    res.json({ playlist: { ...meta, tracks } });
  } catch (error) {
    console.error('Single playlist fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch playlist' });
  }
});

// Candidate pool for "suggested tracks" — tracks related to this playlist by
// artist/genre/album-artist. The client scores/ranks these (same overlap
// algorithm as before) instead of scanning the whole library.
router.get('/:id/suggestions', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const meta = await getPlaylistByIdForUser(req.params.id, userId);
    if (!meta) return res.status(404).json({ error: 'Playlist not found' });
    const tracks = await getPlaylistSuggestionPool(req.params.id, userId);
    res.json({ tracks });
  } catch (error) {
    console.error('Playlist suggestions fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

// Create new playlist
router.post('/', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { title, description } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });

    const id = `user_${Date.now()}`;
    await createPlaylist(id, title, description, false, userId);

    res.json({ id, title, description, isLlmGenerated: false, tracks: [] });
  } catch (error) {
    console.error('Playlist create error:', error);
    res.status(500).json({ error: 'Failed to create playlist' });
  }
});

// Add tracks to playlist (owner check)
router.post('/:id/tracks', async (req, res) => {
  try {
    const { id } = req.params;
    const { trackIds } = req.body;
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    if (!Array.isArray(trackIds)) return res.status(400).json({ error: 'trackIds must be an array' });

    const meta = await getPlaylistMeta(id as string);
    if (meta?.isSystem) {
      return res.status(403).json({ error: 'System playlists are read-only' });
    }
    if (meta?.userId && meta.userId !== userId && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Not your playlist' });
    }

    await addTracksToPlaylist(id as string, trackIds);
    res.json({ status: 'success' });
  } catch (error) {
    console.error('Playlist track update error:', error);
    res.status(500).json({ error: 'Failed to update playlist tracks' });
  }
});

// Delete a playlist (owner or admin)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const meta = await getPlaylistMeta(id as string);
    if (meta?.isSystem) {
      return res.status(403).json({ error: 'System playlists are read-only' });
    }

    if (req.user?.role === 'admin') {
      await deletePlaylist(id as string);
    } else {
      await deletePlaylist(id as string, userId);
    }

    res.json({ status: 'deleted' });
  } catch (error) {
    console.error('Playlist delete error:', error);
    res.status(500).json({ error: 'Failed to delete playlist' });
  }
});

// Pin/unpin a playlist
router.patch('/:id/pin', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { pinned } = req.body;
    if (typeof pinned !== 'boolean') {
      return res.status(400).json({ error: 'pinned must be a boolean' });
    }

    const ok = await togglePlaylistPin(id, userId, pinned);
    if (!ok) return res.status(404).json({ error: 'Playlist not found' });
    res.json({ status: 'ok', pinned });
  } catch (error) {
    console.error('Playlist pin error:', error);
    res.status(500).json({ error: 'Failed to update pin status' });
  }
});

// Enable/disable a public share link for an owned playlist. Returns the share
// token (minted once, stable across re-enables) and the public URL when enabled.
router.post('/:id/share', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { enable } = req.body;
    if (typeof enable !== 'boolean') {
      return res.status(400).json({ error: 'enable must be a boolean' });
    }

    const candidateToken = crypto.randomBytes(18).toString('base64url'); // 24-char URL-safe
    const result = await setPlaylistShare(id as string, userId, enable, candidateToken);
    if (!result) return res.status(404).json({ error: 'Playlist not found' });

    res.json({
      isPublic: result.isPublic,
      shareToken: result.isPublic ? result.shareToken : null,
      sharePath: result.isPublic && result.shareToken ? `/share/${result.shareToken}` : null,
    });
  } catch (error) {
    console.error('Playlist share error:', error);
    res.status(500).json({ error: 'Failed to update share status' });
  }
});

export default router;
