import {
  getSystemSetting,
  incrementConcertsApiUsage,
  getConcertsApiUsage,
  setArtistJambaseId,
  upsertArtistConcertsCache,
  replaceArtistEvents,
  getArtistConcertsCache,
  getArtistById,
  type ConcertEventRow,
} from '../database';

const JAMBASE_BASE = 'https://api.data.jambase.com/v3';
const USER_AGENT = 'AuroraMediaServer/1.0';

// 1 second between calls — comfortable headroom under Jambase's published rate
// limits and shares the budget across concurrent users without piling up.
const RATE_LIMIT_MS = 1000;

// Distinct error class so route handlers can serve stale cache instead of
// surfacing a 502.
export class JambaseBudgetError extends Error {
  constructor(message = 'Monthly Jambase API budget exhausted') {
    super(message);
    this.name = 'JambaseBudgetError';
  }
}

export class JambaseConfigError extends Error {
  constructor(message = 'Jambase API key not configured') {
    super(message);
    this.name = 'JambaseConfigError';
  }
}

let lastRequestAt = 0;
let queueRunning = false;
type QueueItem = { fn: () => Promise<any>; resolve: (v: any) => void; reject: (e: any) => void };
const queue: QueueItem[] = [];

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  while (queue.length > 0) {
    const wait = Math.max(0, RATE_LIMIT_MS - (Date.now() - lastRequestAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const item = queue.shift()!;
    lastRequestAt = Date.now();
    try {
      item.resolve(await item.fn());
    } catch (err) {
      item.reject(err);
    }
  }
  queueRunning = false;
}

function getApiKey(): string {
  // Read at call time, never at module-load time. The .env may not be parsed
  // when this module is first imported.
  return (process.env.JAMBASE_API_KEY || '').trim();
}

async function getCap(): Promise<number | null> {
  const hardStop = await getSystemSetting('jambaseHardStop');
  // Default ON — opt-in to spend money, not opt-out.
  const enforce = hardStop === null ? true : !!hardStop;
  if (!enforce) return null;
  const raw = await getSystemSetting('jambaseMonthlyCap');
  const cap = typeof raw === 'number' && raw > 0 ? raw : 1000;
  return cap;
}

export async function isJambaseEnabled(): Promise<boolean> {
  const enabled = await getSystemSetting('jambaseEnabled');
  if (!enabled) return false;
  if (!getApiKey()) return false;
  return true;
}

// One central fetch wrapper: queue + rate limit + budget check + Bearer auth.
// Budget counter increments on the way in (pre-flight) so we never overshoot
// by counting after a successful network call. Cost: failed calls also tick
// the counter — acceptable for a 1000/mo budget.
async function jambaseFetch<T = any>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const apiKey = getApiKey();
  if (!apiKey) throw new JambaseConfigError();

  const cap = await getCap();
  const newCount = await incrementConcertsApiUsage({ cap });
  if (newCount === null) {
    throw new JambaseBudgetError();
  }

  const url = new URL(`${JAMBASE_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }

  return new Promise<T>((resolve, reject) => {
    queue.push({
      fn: async () => {
        const res = await fetch(url.toString(), {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'User-Agent': USER_AGENT,
          },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`Jambase HTTP ${res.status}: ${body.slice(0, 300)}`);
        }
        return res.json() as Promise<T>;
      },
      resolve,
      reject,
    });
    processQueue();
  });
}

// ─── Public service API ──────────────────────────────────────────────

export async function testJambaseConnection(): Promise<{ ok: boolean; error?: string; sample?: string }> {
  if (!getApiKey()) {
    return { ok: false, error: 'JAMBASE_API_KEY not set in environment' };
  }
  try {
    const data: any = await jambaseFetch('/artists', { artistName: 'radiohead', perPage: 1 });
    if (!data?.success) {
      return { ok: false, error: 'Jambase response missing success flag' };
    }
    const sample = data?.artists?.[0]?.name || 'OK';
    return { ok: true, sample: String(sample) };
  } catch (err: any) {
    if (err instanceof JambaseBudgetError) {
      return { ok: false, error: 'Monthly API budget exhausted — cannot test' };
    }
    return { ok: false, error: err.message || 'Network error' };
  }
}

// Strip the "jambase:" prefix Jambase wraps around their numeric IDs. We store
// the bare numeric form so it round-trips cleanly through URL-encoded query
// params and matches what "jambase:" + jambase_id reconstructs.
function stripJambasePrefix(id: string | null | undefined): string | null {
  if (!id) return null;
  return id.startsWith('jambase:') ? id.slice('jambase:'.length) : id;
}

// Resolve an artist to a Jambase ID. Tries MBID first (exact match — handles
// "John Williams" composer-vs-guitarist ambiguity), falls back to name search.
export async function resolveArtistJambaseId(opts: { name: string; mbid?: string | null }): Promise<string | null> {
  const trimmedName = opts.name.trim();
  if (!trimmedName) return null;

  if (opts.mbid) {
    try {
      const data: any = await jambaseFetch(`/artists/id/musicbrainz:${encodeURIComponent(opts.mbid)}`);
      const ident = data?.artist?.identifier;
      if (ident) return stripJambasePrefix(ident);
    } catch (err: any) {
      if (err instanceof JambaseBudgetError) throw err;
      // 404 means MBID isn't in their DB — fall through to name search.
    }
  }

  try {
    const data: any = await jambaseFetch('/artists', { artistName: trimmedName, perPage: 5 });
    const artists: any[] = data?.artists || [];
    if (artists.length === 0) return null;
    const exact = artists.find((a: any) => (a.name || '').toLowerCase() === trimmedName.toLowerCase());
    const chosen = exact || artists[0];
    return stripJambasePrefix(chosen.identifier);
  } catch (err) {
    if (err instanceof JambaseBudgetError) throw err;
    throw err;
  }
}

// Map a Jambase v3 event onto our concert_events row shape.
function normalizeEvent(raw: any, artistId: string): Omit<ConcertEventRow, 'fetched_at'> | null {
  const id = stripJambasePrefix(raw?.identifier);
  if (!id) return null;
  const startRaw: string | undefined = raw?.startDate;
  if (!startRaw) return null;

  // event_date is the calendar date (truncated). event_datetime keeps the full
  // local timestamp Jambase returns — they don't include a timezone offset, so
  // treat as local-to-venue wall clock rather than forcing UTC.
  const eventDate = startRaw.slice(0, 10);
  const eventDatetime = startRaw.length > 10 ? startRaw : null;

  const location = raw?.location || {};
  const address = location?.address || {};
  const country = address?.addressCountry;
  const region = address?.addressRegion;
  const geo = location?.geo || {};

  const offers: any[] = Array.isArray(raw?.offers) ? raw.offers : [];
  const ticketingOffer = offers.find((o) => o?.category === 'ticketingLinkPrimary') || offers[0] || {};

  // Jambase's priceSpecification is often {} on Developer-tier; pull what we
  // can but expect most rows to have null prices. Don't fabricate values.
  const priceSpec = ticketingOffer?.priceSpecification || {};
  const minP = parseFloat(priceSpec.minPrice);
  const maxP = parseFloat(priceSpec.maxPrice);
  const flatP = parseFloat(priceSpec.price);

  return {
    jambase_event_id: String(id),
    artist_id: artistId,
    event_date: eventDate,
    event_datetime: eventDatetime,
    venue_name: location?.name || null,
    venue_city: address?.addressLocality || null,
    venue_region: typeof region === 'string' ? region : (region?.name || null),
    venue_country: typeof country === 'string' ? country : (country?.name || country?.identifier || null),
    venue_lat: typeof geo?.latitude === 'number' ? geo.latitude : null,
    venue_lng: typeof geo?.longitude === 'number' ? geo.longitude : null,
    ticket_url: ticketingOffer?.url || raw?.url || null,
    price_min: Number.isFinite(minP) ? minP : (Number.isFinite(flatP) ? flatP : null),
    price_max: Number.isFinite(maxP) ? maxP : (Number.isFinite(flatP) ? flatP : null),
    price_currency: priceSpec?.priceCurrency || null,
    status: raw?.eventStatus || null,
    raw_json: raw,
  };
}

// Resolve + fetch + write cache for a single artist. Idempotent — safe to call
// repeatedly; the freshness check upstream decides whether to invoke this.
export async function refreshArtistConcerts(artistId: string): Promise<{ count: number; jambaseId: string | null }> {
  const artist: any = await getArtistById(artistId);
  if (!artist) throw new Error(`Artist ${artistId} not found`);

  let jambaseId: string | null = artist.jambase_id || null;
  if (!jambaseId) {
    jambaseId = await resolveArtistJambaseId({ name: artist.name, mbid: artist.mbid });
    if (jambaseId) {
      await setArtistJambaseId(artistId, jambaseId);
    }
  }

  if (!jambaseId) {
    await upsertArtistConcertsCache(artistId, {
      jambaseId: null,
      eventsCount: 0,
      lastError: 'No Jambase artist match',
    });
    return { count: 0, jambaseId: null };
  }

  try {
    // Single page of up to 40 events keeps API spend bounded. Anyone with
    // more than 40 upcoming dates is exceptionally rare; we'd rather miss a
    // tail-end stadium tour than burn 5 calls per artist on every refresh.
    const data: any = await jambaseFetch('/events', {
      artistId: `jambase:${jambaseId}`,
      perPage: 40,
    });
    const rawEvents: any[] = data?.events || [];
    const today = new Date().toISOString().slice(0, 10);

    const normalized = rawEvents
      .map((e) => normalizeEvent(e, artistId))
      .filter((e): e is Omit<ConcertEventRow, 'fetched_at'> => e !== null)
      // Discard past events at write time so the cache only stores what we'll
      // ever query for. Saves storage and avoids stale-row scans.
      .filter((e) => e.event_date >= today);

    await replaceArtistEvents(artistId, normalized);
    await upsertArtistConcertsCache(artistId, {
      jambaseId,
      eventsCount: normalized.length,
      lastError: null,
    });
    return { count: normalized.length, jambaseId };
  } catch (err: any) {
    if (err instanceof JambaseBudgetError) throw err;
    await upsertArtistConcertsCache(artistId, {
      jambaseId,
      eventsCount: 0,
      lastError: err.message || 'Fetch failed',
    });
    throw err;
  }
}

// Fetch only if the cache is stale (or missing). Returns a flag so callers can
// know whether they got fresh data or are being served from cache.
export async function refreshArtistConcertsIfStale(artistId: string, ttlDays?: number): Promise<{ refreshed: boolean; reason: string }> {
  const ttl = typeof ttlDays === 'number' && ttlDays > 0
    ? ttlDays
    : (await getSystemSetting('jambaseCacheTtlDays')) as number | null ?? 7;
  const cache = await getArtistConcertsCache(artistId);
  if (!cache) {
    await refreshArtistConcerts(artistId);
    return { refreshed: true, reason: 'no-cache' };
  }
  const ageMs = Date.now() - new Date(cache.fetched_at).getTime();
  const ttlMs = ttl * 24 * 60 * 60 * 1000;
  if (ageMs >= ttlMs) {
    await refreshArtistConcerts(artistId);
    return { refreshed: true, reason: 'stale' };
  }
  return { refreshed: false, reason: 'fresh' };
}

export async function getCurrentMonthUsage() {
  const usage = await getConcertsApiUsage();
  const cap = await getCap();
  const monthlyCap = (await getSystemSetting('jambaseMonthlyCap')) as number | null;
  return {
    yearMonth: usage.year_month,
    count: usage.count,
    lastCallAt: usage.last_call_at,
    cap: typeof monthlyCap === 'number' && monthlyCap > 0 ? monthlyCap : 1000,
    hardStopActive: cap !== null,
    stopped: cap !== null && usage.count >= cap,
  };
}
