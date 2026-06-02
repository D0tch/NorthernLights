import { Router } from 'express';
import { getPublicPlaylistByShareToken } from '../database';
import { createRateLimiter } from '../middleware/rateLimit';

// Unauthenticated, public-facing routes. Mounted BEFORE the global JWT
// middleware so anonymous visitors (e.g. a shared playlist link) can reach them.
// Everything here is read-only and must never expose filesystem paths, track
// ids, or anything that enables streaming.
const router = Router();

// Tokens are opaque high-entropy strings; cap lookups per IP to blunt enumeration.
const shareRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: 60,
  keyPrefix: 'public-share',
  message: 'Too many requests. Try again later.',
});

router.get('/playlists/:token', shareRateLimit, async (req, res) => {
  try {
    const token = String(req.params.token || '');
    // Basic shape guard before hitting the DB.
    if (!token || token.length < 16 || token.length > 128) {
      return res.status(404).json({ error: 'Not found' });
    }
    const playlist = await getPublicPlaylistByShareToken(token);
    if (!playlist) return res.status(404).json({ error: 'Not found' });
    res.json(playlist);
  } catch (error) {
    console.error('Public playlist fetch error:', error);
    res.status(500).json({ error: 'Failed to load shared playlist' });
  }
});

export default router;
