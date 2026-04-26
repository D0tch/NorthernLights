import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import {
  getSystemSetting,
  getArtistById,
  getArtistSubscriptions,
  countArtistSubscriptions,
  isSubscribedToArtist,
  addArtistSubscription,
  removeArtistSubscription,
  searchLibraryArtists,
  getUserTopArtists,
  getUpcomingEventsForArtist,
  getHubEventsForUser,
  getArtistConcertsCache,
  getUserSetting,
} from '../database';
import {
  isJambaseEnabled,
  testJambaseConnection,
  getCurrentMonthUsage,
  refreshArtistConcertsIfStale,
  JambaseBudgetError,
  JambaseConfigError,
} from '../services/jambase.service';

const router = Router();

// ─── Admin: connection / status / usage ──────────────────────────────

router.get('/providers/jambase/status', requireAdmin, async (_req, res) => {
  try {
    const enabled = (await getSystemSetting('jambaseEnabled')) === true;
    const hasKey = !!(process.env.JAMBASE_API_KEY || '').trim();
    const usage = await getCurrentMonthUsage();
    res.json({
      enabled,
      hasKey,
      usage,
      maxSubscriptionsPerUser: (await getSystemSetting('jambaseMaxSubscriptionsPerUser')) ?? 10,
      cacheTtlDays: (await getSystemSetting('jambaseCacheTtlDays')) ?? 7,
      hardStop: (await getSystemSetting('jambaseHardStop')) ?? true,
      monthlyCap: (await getSystemSetting('jambaseMonthlyCap')) ?? 1000,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/providers/jambase/test', requireAdmin, async (_req, res) => {
  try {
    const result = await testJambaseConnection();
    if (result.ok) {
      res.json({ status: 'ok', sample: result.sample });
    } else {
      res.status(400).json({ status: 'error', error: result.error });
    }
  } catch (err: any) {
    res.status(502).json({ status: 'error', error: err.message || 'Network error' });
  }
});

router.get('/providers/jambase/usage', requireAdmin, async (_req, res) => {
  try {
    const usage = await getCurrentMonthUsage();
    res.json(usage);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── User: subscriptions ─────────────────────────────────────────────

router.get('/concerts/subscriptions', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const subs = await getArtistSubscriptions(userId);
    const max = ((await getSystemSetting('jambaseMaxSubscriptionsPerUser')) as number | null) ?? 10;
    res.json({ subscriptions: subs, max });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/concerts/subscriptions/:artistId', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const artistId = String(req.params.artistId);

    const artist = await getArtistById(artistId);
    if (!artist) return res.status(404).json({ error: 'Artist not found' });

    const already = await isSubscribedToArtist(userId, artistId);
    if (already) return res.json({ status: 'ok', alreadySubscribed: true });

    const max = ((await getSystemSetting('jambaseMaxSubscriptionsPerUser')) as number | null) ?? 10;
    const current = await countArtistSubscriptions(userId);
    if (current >= max) {
      return res.status(400).json({ error: `Subscription limit reached (${max}). Remove an artist to add another.` });
    }

    await addArtistSubscription(userId, artistId);

    // Best-effort warm-up of the cache for the newly subscribed artist so the
    // Hub card has something to show immediately. Failures are silent — the
    // user can still see other artists' events while this one resolves.
    refreshArtistConcertsIfStale(artistId).catch(() => {});

    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/concerts/subscriptions/:artistId', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const artistId = String(req.params.artistId);
    await removeArtistSubscription(userId, artistId);
    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── User: library-only artist lookup ────────────────────────────────

router.get('/concerts/library/artist-search', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const q = (req.query.q as string) || '';
    if (!q.trim()) return res.json({ artists: [] });
    const limit = Math.min(parseInt((req.query.limit as string) || '20', 10) || 20, 50);
    const artists = await searchLibraryArtists(userId, q, limit);
    res.json({ artists });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/concerts/library/top-artists', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const limit = Math.min(parseInt((req.query.limit as string) || '10', 10) || 10, 50);
    const artists = await getUserTopArtists(userId, limit);
    res.json({ artists });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── User: read events ───────────────────────────────────────────────

// Hub feed — events for subscribed artists, optionally filtered to a radius
// around the user's saved location. Reads from cache only; never triggers a
// fetch (refresh happens lazily on subscribe / artist-detail visit).
router.get('/concerts/hub', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const concertsEnabled = await getUserSetting(userId, 'concertsEnabled');
    if (concertsEnabled !== true) {
      return res.json({ events: [], disabled: true });
    }

    const lat = (await getUserSetting(userId, 'concertsLat')) as number | null;
    const lng = (await getUserSetting(userId, 'concertsLng')) as number | null;
    const radius = ((await getUserSetting(userId, 'concertsRadiusKm')) as number | null) ?? 50;

    const events = await getHubEventsForUser(userId, {
      lat: typeof lat === 'number' ? lat : null,
      lng: typeof lng === 'number' ? lng : null,
      radiusKm: radius,
      limit: 20,
    });

    const usage = await getCurrentMonthUsage();
    res.json({ events, stale: usage.stopped, usage: { stopped: usage.stopped } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Single artist's upcoming events. Visiting this endpoint triggers a stale-
// check refresh. This is the "explicit" budget tier — bounded by the cache TTL
// and the global hard stop.
router.get('/concerts/artist/:artistId', requireAuth, async (req, res) => {
  try {
    const artistId = String(req.params.artistId);

    if (!(await isJambaseEnabled())) {
      // Even if disabled at the system level, we'll still return whatever's
      // in cache — the sticker/ section just won't be live.
      const events = await getUpcomingEventsForArtist(artistId, 5);
      return res.json({ events, refreshed: false, disabled: true });
    }

    let refreshed = false;
    let stale = false;
    try {
      const r = await refreshArtistConcertsIfStale(artistId);
      refreshed = r.refreshed;
    } catch (err) {
      if (err instanceof JambaseBudgetError) {
        stale = true;
      } else if (err instanceof JambaseConfigError) {
        // No key — fall back to whatever cache exists.
      } else {
        // Don't fail the request; show cached results and signal staleness.
        stale = true;
      }
    }

    const events = await getUpcomingEventsForArtist(artistId, 5);
    const cache = await getArtistConcertsCache(artistId);
    res.json({
      events,
      refreshed,
      stale,
      onTour: events.length > 0,
      lastFetchedAt: cache?.fetched_at || null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
