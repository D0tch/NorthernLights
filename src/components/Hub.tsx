import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../store';
import { Play, Pin, PinOff, Disc3, Sparkles, Wand2, Compass, Radio, Repeat, Rewind, Sunrise, Sun, Moon, Sunset, User2, ListMusic, Loader2 } from 'lucide-react';
import type { TrackInfo } from '../utils/fileSystem';
import type { Playlist } from '../store';
import { useDominantColor } from '../hooks/useDominantColor';
import { useExternalImage } from '../hooks/useExternalImage';
import { useInView } from '../hooks/useInView';
import { fetchGenreImage } from '../utils/externalImagery';
import { LiveConcertsHubSection } from './LiveConcertsHubSection';
import { HorizontalScrollRail } from './HorizontalScrollRail';

type HubCollection = Partial<Playlist> & { tracks: TrackInfo[] };

const HUB_REFRESH_POLL_MS = 30_000;
const HUB_REFRESH_POLL_DURATION_MS = 2 * 60_000;
const HUB_SWAP_DURATION_MS = 180;

interface JumpTile {
  type: 'album' | 'playlist' | 'artist';
  id: string;
  title: string;
  subtitle: string;
  imageUrl: string | null;
  lastPlayedAt: number;
}

interface ArtistRadioCandidate {
  artistId: string;
  artistName: string;
  imageUrl: string | null;
  recentPlays: number;
  withArtists: string[];
}

interface SmartBundle {
  jumpBackIn: JumpTile[];
  onRepeat: HubCollection | null;
  repeatRewind: HubCollection | null;
  daylist: HubCollection | null;
  artistRadios: ArtistRadioCandidate[];
  seasonalRewind: HubCollection | null;
  yearRewind: HubCollection | null;
}

let hasPlayedHubCardIntro = false;

function getCollectionSignature(collection: HubCollection | null | undefined): string {
  if (!collection) return 'none';
  const trackIds = (collection.tracks || []).map((track) => track.id).join(',');
  return [
    collection.id || '',
    collection.title || '',
    collection.description || '',
    collection.createdAt || '',
    trackIds,
  ].join('|');
}

function getCollectionsSignature(collections: HubCollection[]): string {
  return collections.map(getCollectionSignature).join('||');
}

function getSmartBundleSignature(bundle: SmartBundle | null): string {
  if (!bundle) return 'none';
  const jumpBackIn = bundle.jumpBackIn
    .map((tile) => `${tile.type}:${tile.id}:${tile.title}:${tile.lastPlayedAt}`)
    .join(',');
  const radios = bundle.artistRadios
    .map((radio) => `${radio.artistId}:${radio.artistName}:${radio.imageUrl || ''}:${radio.withArtists.join('+')}`)
    .join(',');
  return [
    jumpBackIn,
    getCollectionSignature(bundle.daylist),
    getCollectionSignature(bundle.onRepeat),
    getCollectionSignature(bundle.repeatRewind),
    getCollectionSignature(bundle.seasonalRewind),
    getCollectionSignature(bundle.yearRewind),
    radios,
  ].join('||');
}

const isCollectionListEmpty = (value: HubCollection[]) => value.length === 0;
const isSmartBundleEmpty = (value: SmartBundle | null) => !value;
type TileSwapPhase = 'idle' | 'out' | 'in';

function useCrossfadedValue<T>(
  value: T,
  signature: string,
  isEmpty: (value: T) => boolean
): { value: T; className: string } {
  const [displayValue, setDisplayValue] = useState(value);
  const [phase, setPhase] = useState<'idle' | 'out' | 'in'>('idle');
  const signatureRef = useRef(signature);
  const displayValueRef = useRef(value);
  const timeoutRef = useRef<number | null>(null);
  const setNextDisplayValue = (nextValue: T) => {
    displayValueRef.current = nextValue;
    setDisplayValue(nextValue);
  };

  useEffect(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (signatureRef.current === signature) {
      setNextDisplayValue(value);
      setPhase('idle');
      return;
    }

    if (isEmpty(displayValueRef.current)) {
      signatureRef.current = signature;
      setNextDisplayValue(value);
      setPhase('idle');
      return;
    }

    setPhase('out');
    timeoutRef.current = window.setTimeout(() => {
      signatureRef.current = signature;
      setNextDisplayValue(value);
      setPhase('in');
      timeoutRef.current = window.setTimeout(() => {
        setPhase('idle');
        timeoutRef.current = null;
      }, HUB_SWAP_DURATION_MS);
    }, HUB_SWAP_DURATION_MS);

    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [isEmpty, signature, value]);

  return {
    value: displayValue,
    className: phase === 'out' ? 'hub-swap-out' : phase === 'in' ? 'hub-swap-in' : '',
  };
}

function getTileMotionClassName(phase: TileSwapPhase): string {
  if (phase === 'out') return 'hub-tile-flip-out';
  if (phase === 'in') return 'hub-tile-flip-in';
  return '';
}

function getTileTextMotionClassName(phase: TileSwapPhase): string {
  if (phase === 'out') return 'hub-tile-text-out';
  if (phase === 'in') return 'hub-tile-text-in';
  return '';
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function asHexColor(color: string | undefined, fallback: string): string {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = asHexColor(hex, '#7c3aed').slice(1);
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function buildRolledCoverGradient(seed: string, palette: string[], fallbackColor: string): string {
  const fallbackPalette = ['#7c3aed', '#0ea5e9', '#10b981', '#f59e0b'];
  const usablePalette = [...palette, fallbackColor]
    .map((color, index) => asHexColor(color, fallbackPalette[index % fallbackPalette.length]))
    .filter(Boolean);
  const colors = Array.from(new Set(usablePalette));
  while (colors.length < 4) colors.push(fallbackPalette[(colors.length + hashString(seed)) % fallbackPalette.length]);

  const roll = hashString(`${seed}:${colors.join('|')}`);
  const pick = (offset: number) => colors[(roll + offset) % colors.length];
  const angle = roll % 360;
  const x1 = 18 + (roll % 58);
  const y1 = 14 + ((roll >> 4) % 62);
  const x2 = 22 + ((roll >> 8) % 56);
  const y2 = 20 + ((roll >> 12) % 58);
  const conicX = 34 + ((roll >> 16) % 36);
  const conicY = 28 + ((roll >> 20) % 42);

  const c1 = pick(0);
  const c2 = pick(1);
  const c3 = pick(2);
  const c4 = pick(3);

  return [
    `radial-gradient(circle at ${x1}% ${y1}%, ${hexToRgba(c1, 0.70)} 0%, ${hexToRgba(c1, 0.34)} 24%, transparent 58%)`,
    `radial-gradient(circle at ${x2}% ${y2}%, ${hexToRgba(c2, 0.62)} 0%, ${hexToRgba(c2, 0.28)} 22%, transparent 56%)`,
    `conic-gradient(from ${angle}deg at ${conicX}% ${conicY}%, ${hexToRgba(c3, 0.58)}, ${hexToRgba(c4, 0.48)}, ${hexToRgba(c2, 0.52)}, ${hexToRgba(c1, 0.58)})`,
    `linear-gradient(${(angle + 90) % 360}deg, ${hexToRgba(c1, 0.46)}, ${hexToRgba(c4, 0.38)})`,
  ].join(', ');
}

interface AnimatedTileSlotProps<T> {
  value: T;
  signature: string;
  children: (value: T, phase: TileSwapPhase) => React.ReactNode;
}

function AnimatedTileSlot<T>({ value, signature, children }: AnimatedTileSlotProps<T>) {
  const [displayValue, setDisplayValue] = useState(value);
  const [phase, setPhase] = useState<TileSwapPhase>('idle');
  const signatureRef = useRef(signature);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (signatureRef.current === signature) {
      setDisplayValue(value);
      return;
    }

    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    setPhase('out');
    timeoutRef.current = window.setTimeout(() => {
      signatureRef.current = signature;
      setDisplayValue(value);
      setPhase('in');
      timeoutRef.current = window.setTimeout(() => {
        setPhase('idle');
        timeoutRef.current = null;
      }, HUB_SWAP_DURATION_MS);
    }, HUB_SWAP_DURATION_MS);

    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [signature, value]);

  return <>{children(displayValue, phase)}</>;
}

const HubCardSkeleton: React.FC = () => (
  <div className="p-4 sm:p-5 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-[var(--radius)] animate-pulse">
    <div className="flex items-center gap-2 mb-3">
      <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-[var(--color-surface-variant)]" />
      <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-[var(--color-surface-variant)] -ml-2" />
      <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-[var(--color-surface-variant)] -ml-2" />
    </div>
    <div className="h-5 w-3/4 rounded bg-[var(--color-surface-variant)] mb-2" />
    <div className="h-4 w-1/2 rounded bg-[var(--color-surface-variant)]" />
  </div>
);

const HubLoadingSkeleton: React.FC = () => (
  <div className="page-container space-y-8">
    <header>
      <div className="h-8 w-24 rounded bg-[var(--color-surface-variant)] animate-pulse" />
      <div className="h-4 w-48 rounded bg-[var(--color-surface-variant)] animate-pulse mt-2" />
    </header>

    <section>
      <div className="h-5 w-32 rounded bg-[var(--color-surface-variant)] animate-pulse mb-4" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-[64px] rounded-[var(--radius)] bg-[var(--glass-bg)] border border-[var(--glass-border)] overflow-hidden animate-pulse sm:h-[80px]"
          >
            <div className="h-full w-[56px] bg-[var(--color-surface-variant)] sm:w-[80px]" />
          </div>
        ))}
      </div>
    </section>

    <section>
      <div className="h-7 w-44 rounded bg-[var(--color-surface-variant)] animate-pulse mb-2" />
      <div className="h-4 w-64 max-w-full rounded bg-[var(--color-surface-variant)] animate-pulse mb-5" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5 lg:gap-6">
        {[1, 2, 3].map((i) => (
          <HubCardSkeleton key={i} />
        ))}
      </div>
    </section>

    <section>
      <div className="h-7 w-40 rounded bg-[var(--color-surface-variant)] animate-pulse mb-2" />
      <div className="h-4 w-72 max-w-full rounded bg-[var(--color-surface-variant)] animate-pulse mb-5" />
      <div className="flex gap-3 hide-scrollbar overflow-hidden sm:gap-5">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="w-[min(52vw,200px)] shrink-0 sm:w-[190px]">
            <div className="aspect-square rounded-[var(--radius)] bg-[var(--color-surface-variant)] animate-pulse" />
            <div className="h-4 w-4/5 rounded bg-[var(--color-surface-variant)] animate-pulse mt-3" />
            <div className="h-3 w-2/3 rounded bg-[var(--color-surface-variant)] animate-pulse mt-2" />
          </div>
        ))}
      </div>
    </section>
  </div>
);

const JumpBackInSectionSkeleton: React.FC = () => (
  <section aria-hidden="true">
    <div className="h-5 w-32 rounded bg-[var(--color-surface-variant)] animate-pulse mb-4" />
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="h-[64px] rounded-[var(--radius)] bg-[var(--glass-bg)] border border-[var(--glass-border)] overflow-hidden animate-pulse sm:h-[80px]"
        >
          <div className="h-full w-[56px] bg-[var(--color-surface-variant)] sm:w-[80px]" />
        </div>
      ))}
    </div>
  </section>
);

const UniqueYoursSectionSkeleton: React.FC = () => (
  <section aria-hidden="true">
    <div className="h-7 w-40 rounded bg-[var(--color-surface-variant)] animate-pulse mb-2" />
    <div className="h-4 w-72 max-w-full rounded bg-[var(--color-surface-variant)] animate-pulse mb-5" />
    <div className="flex overflow-x-auto snap-x snap-mandatory gap-3 hub-scroll-mobile hub-scroll-unique pb-1 sm:gap-5 sm:pb-2 hide-scrollbar">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="w-[min(52vw,200px)] shrink-0 snap-start sm:w-[190px]">
          <div className="aspect-square rounded-[var(--radius)] bg-[var(--color-surface-variant)] animate-pulse" />
          <div className="h-4 w-4/5 rounded bg-[var(--color-surface-variant)] animate-pulse mt-3" />
          <div className="h-3 w-2/3 rounded bg-[var(--color-surface-variant)] animate-pulse mt-2" />
        </div>
      ))}
    </div>
  </section>
);

interface HubCardProps {
  collection: HubCollection;
  onOpen: () => void;
  onPlay: () => void;
  onPinToggle?: () => void;
  animate?: boolean;
}

const HubCard: React.FC<HubCardProps> = ({ collection, onOpen, onPlay, onPinToggle, animate = false }) => {
  const { artUrls, bgColor, palette } = useDominantColor(collection.tracks);
  const hasCovers = artUrls.length > 0;
  const gradientSeed = `${collection.id || collection.title || 'hub'}:${collection.tracks.map((track) => track.id).join(',')}`;
  const rolledGradient = useMemo(
    () => buildRolledCoverGradient(gradientSeed, palette, bgColor),
    [bgColor, gradientSeed, palette]
  );

  return (
    <div
      className={`relative overflow-hidden p-4 sm:p-5 cursor-pointer group rounded-[var(--radius)] bg-[var(--glass-bg)] border border-[var(--glass-border)] backdrop-blur-sm transition-ui duration-200 hover:-translate-y-0.5 hover:shadow-md active:scale-[0.98] ${animate ? 'hub-card-animate' : ''}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`Play ${collection.title || 'Untitled playlist'}`}
    >
      <div
        className="absolute inset-0 rounded-[inherit] opacity-70 transition-opacity duration-300 group-hover:opacity-90 pointer-events-none"
        style={{ background: rolledGradient }}
      />
      <div className="absolute inset-0 rounded-[inherit] bg-white/65 dark:bg-[rgba(0,0,0,0.25)] dark:backdrop-blur-[10px] pointer-events-none" />
      <div className="absolute inset-0 rounded-[inherit] bg-gradient-to-br from-white/55 via-white/20 to-transparent dark:from-white/10 dark:via-black/10 dark:to-black/35 pointer-events-none" />

      <div className="relative flex items-center mb-3">
        <div className="flex items-center">
          {hasCovers ? (
            artUrls.slice(0, 4).map((url, i) => (
              <img
                key={i}
                src={url}
                alt=""
                className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg shadow-sm object-cover transition-transform duration-200 group-hover:translate-x-1"
                style={{
                  marginLeft: i > 0 ? '-8px' : 0,
                  zIndex: 10 - i,
                }}
              />
            ))
          ) : (
            <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-[var(--color-surface-variant)] flex items-center justify-center">
              <Disc3 className="w-6 h-6 text-[var(--color-text-muted)] opacity-40" />
            </div>
          )}
        </div>
      </div>

      <div className="relative z-10">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-base sm:text-lg text-[var(--color-text-primary)] line-clamp-1 group-hover:text-[var(--color-primary)] transition-colors">
            {collection.title || 'Untitled Playlist'}
          </h3>
          {onPinToggle && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onPinToggle();
              }}
              className="min-w-11 min-h-11 flex items-center justify-center rounded-lg p-2 -m-2 hover:bg-white/10 dark:hover:bg-white/5 transition-colors"
              aria-label={collection.pinned ? 'Unpin playlist' : 'Pin playlist'}
            >
              {collection.pinned ? (
                <Pin className="w-4 h-4 text-[var(--color-primary)]" />
              ) : (
                <PinOff className="w-4 h-4 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
              )}
            </button>
          )}
        </div>

        {collection.description && (
          <p className="text-sm text-[var(--color-text-secondary)] line-clamp-2 mt-1">
            {collection.description}
          </p>
        )}

        <p className="text-xs font-medium text-[var(--color-text-secondary)] dark:text-white/80 mt-2">
          {collection.tracks.length} {collection.tracks.length === 1 ? 'track' : 'tracks'}
        </p>
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onPlay();
        }}
        className="absolute bottom-4 right-4 w-11 h-11 rounded-full bg-[var(--color-primary)] text-white flex items-center justify-center shadow-lg shadow-emerald-500/30 opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:opacity-100 group-focus-within:translate-y-0 transition-ui duration-200 hover:bg-[var(--color-primary-dark)] hover:scale-110 active:scale-95 z-20"
        aria-label="Play"
      >
        <Play className="w-5 h-5 ml-0.5" fill="currentColor" />
      </button>
    </div>
  );
};

interface DiscoverCardProps {
  collection: HubCollection;
  onOpen: () => void;
  onPlay: () => void;
  animate?: boolean;
}

const DiscoverCard: React.FC<DiscoverCardProps> = ({ collection, onOpen, onPlay, animate = false }) => {
  const { artUrls } = useDominantColor(collection.tracks);
  const covers = artUrls.slice(0, 4);
  const hasCovers = covers.length > 0;

  return (
    <div
      className={`relative flex flex-col sm:flex-row gap-3 p-4 cursor-pointer group rounded-[var(--radius)] bg-[var(--glass-bg)] border border-[var(--glass-border)] backdrop-blur-sm transition-ui duration-200 hover:-translate-y-0.5 hover:shadow-md active:scale-[0.98] ${animate ? 'hub-card-animate' : ''}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`Play ${collection.title || 'Untitled playlist'}`}
    >
      {/* Left: 2x2 Cover Grid */}
      <div className="grid grid-cols-2 gap-0 shrink-0 w-full sm:w-40 rounded-lg overflow-hidden">
        {hasCovers ? (
          covers.map((url, i) => (
            <img
              key={i}
              src={url}
              alt=""
              className="aspect-square object-cover"
            />
          ))
        ) : (
          <div className="col-span-2 aspect-video bg-[var(--color-surface-variant)] flex items-center justify-center">
            <Disc3 className="w-8 h-8 text-[var(--color-text-muted)] opacity-40" />
          </div>
        )}
      </div>

      {/* Right: Content */}
      <div className="flex flex-col justify-center min-w-0">
        <h3 className="font-semibold text-base sm:text-lg text-[var(--color-text-primary)] line-clamp-1 group-hover:text-[var(--color-primary)] transition-colors">
          {collection.title || 'Untitled Playlist'}
        </h3>
        {collection.description && (
          <p className="text-sm text-[var(--color-text-secondary)] line-clamp-2 mt-1">
            {collection.description}
          </p>
        )}
        <p className="text-xs text-[var(--color-text-muted)] mt-2">
          {collection.tracks.length} {collection.tracks.length === 1 ? 'track' : 'tracks'}
        </p>
      </div>

      {/* Floating Play Button (hover reveal) */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onPlay();
        }}
        className="absolute bottom-4 right-4 w-11 h-11 rounded-full bg-[var(--color-primary)] text-white flex items-center justify-center shadow-lg shadow-emerald-500/30 opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:opacity-100 group-focus-within:translate-y-0 transition-ui duration-200 hover:bg-[var(--color-primary-dark)] hover:scale-110 active:scale-95 z-20"
        aria-label="Play"
      >
        <Play className="w-5 h-5 ml-0.5" fill="currentColor" />
      </button>
    </div>
  );
};

interface ExploreCardProps {
  genre: string;
  trackCount: number;
  entity?: { id: string; name?: string };
  animate?: boolean;
}

const ExploreCard: React.FC<ExploreCardProps> = ({ genre, trackCount, entity, animate = false }) => {
  const [ref, inView] = useInView();
  const { imageUrl } = useExternalImage(() => fetchGenreImage(genre), [genre], { enabled: inView });

  const CardContent = (
    <div
      ref={ref}
      className={`relative overflow-hidden rounded-[var(--radius)] cursor-pointer group aspect-[2/1] sm:aspect-[3/2] ${animate ? 'hub-card-animate' : ''}`}
    >
      {imageUrl ? (
        <div className="absolute inset-0 z-0">
          <img
            src={imageUrl}
            alt={genre}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-black/10" />
        </div>
      ) : (
        <div className="absolute inset-0 z-0 bg-[var(--color-surface)]">
          <div className="absolute inset-0 bg-gradient-to-br from-[var(--color-primary)]/[0.15] to-transparent" />
        </div>
      )}

      <div className="relative z-10 h-full flex flex-col justify-end p-4 sm:p-5">
        <h3
          className={`font-bold text-xl sm:text-2xl tracking-tight leading-tight transition-colors duration-200 ${imageUrl
            ? 'text-white drop-shadow-lg'
            : 'text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)]'
            }`}
        >
          {genre}
        </h3>
        <p
          className={`text-xs mt-1 ${imageUrl
            ? 'text-white/70'
            : 'text-[var(--color-text-muted)]'
            }`}
        >
          {trackCount} {trackCount === 1 ? 'track' : 'tracks'}
        </p>
      </div>
    </div>
  );

  if (entity) {
    return (
      <Link to={`/library/genre/${entity.id}`} className="no-underline">
        {CardContent}
      </Link>
    );
  }

  return CardContent;
};

// ─── Jump Back In: compact mixed tile ─────────────────────────────────
interface JumpTileCardProps {
  tile: JumpTile;
  onActivate: (tile: JumpTile) => void;
  onPlay: (tile: JumpTile) => void;
  motionClassName?: string;
  textMotionClassName?: string;
}

// Distinct fallback identity per tile type when no artwork is available.
function getJumpTileFallback(type: JumpTile['type']): { gradient: string; Icon: React.FC<any> } {
  if (type === 'artist') {
    return { gradient: 'linear-gradient(135deg, #4338ca, #6366f1, #8b5cf6)', Icon: User2 };
  }
  if (type === 'playlist') {
    return { gradient: 'linear-gradient(135deg, #047857, #10b981, #14b8a6)', Icon: ListMusic };
  }
  return { gradient: 'linear-gradient(135deg, #92400e, #d97706, #f59e0b)', Icon: Disc3 };
}

const JumpTileCard: React.FC<JumpTileCardProps> = ({
  tile,
  onActivate,
  onPlay,
  motionClassName = '',
  textMotionClassName = '',
}) => {
  const fallback = getJumpTileFallback(tile.type);
  const FallbackIcon = fallback.Icon;
  return (
    <div
      onClick={() => onActivate(tile)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate(tile);
        }
      }}
      className={`group relative flex h-[64px] cursor-pointer items-center gap-2 overflow-hidden rounded-[var(--radius)] border border-[var(--glass-border)] bg-[var(--glass-bg)] text-left backdrop-blur-sm transition-colors hover:bg-[var(--glass-bg-hover)] sm:h-[80px] sm:gap-3 ${motionClassName}`}
      aria-label={`Open ${tile.title}`}
    >
      <div className="relative h-[64px] w-[56px] shrink-0 overflow-hidden sm:h-[80px] sm:w-[80px]">
        {tile.imageUrl ? (
          <img src={tile.imageUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <>
            <div className="absolute inset-0" style={{ background: fallback.gradient }} />
            <FallbackIcon
              className="absolute inset-0 m-auto w-7 h-7 text-white/85 drop-shadow"
              strokeWidth={1.5}
            />
          </>
        )}
      </div>
      <div className={`min-w-0 flex-1 py-1 pr-2 sm:pr-3 ${textMotionClassName}`}>
        <span className="line-clamp-2 block text-xs font-semibold leading-tight text-[var(--color-text-primary)] transition-colors group-hover:text-[var(--color-primary)] sm:text-base">
          {tile.title}
        </span>
        {tile.type !== 'playlist' && tile.subtitle && (
          <span className="block text-[11px] text-[var(--color-text-muted)] line-clamp-1 mt-0.5">
            {tile.subtitle}
          </span>
        )}
      </div>
      {/* Play button — hover-only, hidden entirely on touch devices */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onPlay(tile);
        }}
        className="hidden [@media(hover:hover)]:flex absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-[var(--color-primary)] text-white items-center justify-center shadow-lg opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150 hover:bg-[var(--color-primary-dark)] hover:scale-105 active:scale-95 z-10"
        aria-label={`Play ${tile.title}`}
      >
        <Play className="w-4 h-4 ml-0.5" fill="currentColor" />
      </button>
    </div>
  );
};

// ─── Time Capsule: seasonal/year rewind tile ──────────────────────────
interface CapsuleCardProps {
  collection: HubCollection;
  onOpen: () => void;
  onPlay: () => void;
  motionClassName?: string;
  textMotionClassName?: string;
}

// Maps the leading emoji in the capsule title to a gradient. Keeps the
// component self-contained without needing the season/year metadata.
function getCapsuleGradient(title: string | null | undefined): string {
  const t = title || '';
  if (t.includes('🌸')) return 'linear-gradient(135deg, #fb7185, #f97316, #fbbf24)';   // spring
  if (t.includes('☀️')) return 'linear-gradient(135deg, #fbbf24, #f97316, #ec4899)';   // summer
  if (t.includes('🍂')) return 'linear-gradient(135deg, #f97316, #b45309, #7c2d12)';   // autumn
  if (t.includes('❄️')) return 'linear-gradient(135deg, #60a5fa, #6366f1, #1e1b4b)';   // winter
  if (t.includes('🎉')) return 'linear-gradient(135deg, #ec4899, #8b5cf6, #3b82f6)';   // year wrap
  return 'linear-gradient(135deg, var(--color-primary), #6366f1)';
}

const CapsuleCard: React.FC<CapsuleCardProps> = ({
  collection,
  onOpen,
  onPlay,
  motionClassName = '',
  textMotionClassName = '',
}) => {
  const gradient = getCapsuleGradient(collection.title);
  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`group relative w-[260px] sm:w-[300px] aspect-square rounded-[var(--radius)] overflow-hidden cursor-pointer transition-ui duration-200 hover:-translate-y-0.5 hover:shadow-xl active:scale-[0.98] shrink-0 ${motionClassName}`}
      aria-label={`Open ${collection.title || 'Time capsule'}`}
      style={{ background: gradient }}
    >
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
      <div className="absolute inset-0 flex flex-col justify-between p-5 text-white">
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-80">
          Time capsule
        </span>
        <div className={textMotionClassName}>
          <h3 className="font-bold text-2xl leading-tight line-clamp-2 drop-shadow-sm">
            {collection.title || 'Rewind'}
          </h3>
          {collection.description && (
            <p className="text-sm opacity-90 mt-2 line-clamp-2 drop-shadow-sm">
              {collection.description}
            </p>
          )}
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onPlay();
        }}
        className="absolute bottom-4 right-4 w-12 h-12 rounded-full bg-white text-black flex items-center justify-center shadow-lg opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:opacity-100 group-focus-within:translate-y-0 transition-ui duration-200 hover:scale-110 active:scale-95 z-20"
        aria-label="Play"
      >
        <Play className="w-5 h-5 ml-0.5" fill="currentColor" />
      </button>
    </div>
  );
};

// ─── Unique Card: unified square-cover tile for "Uniquely yours" ──────
// Single shape for daylist / on-repeat / repeat-rewind / artist-radio,
// matching Spotify's row in screenshot 2. The cover treatment varies by
// kind, but the wrapper geometry stays consistent so the row reads as a
// single grid.
type UniqueCardKind = 'daylist' | 'on-repeat' | 'repeat-rewind' | 'artist-radio';

function getDaylistCover(): { gradient: string; Icon: React.FC<any> } {
  const h = new Date().getHours();
  if (h < 6) return { gradient: 'linear-gradient(135deg, #1e1b4b, #4338ca)', Icon: Moon };       // late night
  if (h < 11) return { gradient: 'linear-gradient(135deg, #fed7aa, #fb923c, #f97316)', Icon: Sunrise }; // morning
  if (h < 16) return { gradient: 'linear-gradient(135deg, #fde68a, #f59e0b, #ef4444)', Icon: Sun };     // midday
  if (h < 19) return { gradient: 'linear-gradient(135deg, #fb923c, #ec4899, #8b5cf6)', Icon: Sunset };  // evening
  return { gradient: 'linear-gradient(135deg, #312e81, #1e3a8a, #0c4a6e)', Icon: Moon };          // night
}

interface UniqueCardProps {
  kind: UniqueCardKind;
  title: string;
  subtitle?: string;
  imageUrl?: string | null;
  onClick: () => void;
  onPlay?: () => void;
  loading?: boolean;
  coverMotionClassName?: string;
  textMotionClassName?: string;
}

const UniqueCard: React.FC<UniqueCardProps> = ({
  kind,
  title,
  subtitle,
  imageUrl,
  onClick,
  onPlay,
  loading = false,
  coverMotionClassName = '',
  textMotionClassName = '',
}) => {
  let coverContent: React.ReactNode;
  let badgeLabel: string;

  if (kind === 'daylist') {
    const { gradient, Icon } = getDaylistCover();
    coverContent = (
      <>
        <div className="absolute inset-0" style={{ background: gradient }} />
        <Icon className="absolute right-4 bottom-4 w-12 h-12 text-white/85 drop-shadow" strokeWidth={1.5} />
      </>
    );
    badgeLabel = 'Daylist';
  } else if (kind === 'on-repeat') {
    coverContent = (
      <>
        <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, #831843, #be185d, #db2777)' }} />
        <Repeat className="absolute right-4 bottom-4 w-12 h-12 text-white/85 drop-shadow" strokeWidth={1.5} />
      </>
    );
    badgeLabel = 'On Repeat';
  } else if (kind === 'repeat-rewind') {
    coverContent = (
      <>
        <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, #1e3a8a, #312e81, #4338ca)' }} />
        <Rewind className="absolute right-4 bottom-4 w-12 h-12 text-white/85 drop-shadow" strokeWidth={1.5} />
      </>
    );
    badgeLabel = 'Rewind';
  } else {
    coverContent = imageUrl ? (
      <img src={imageUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
    ) : (
      <>
        <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, #1f2937, #374151)' }} />
        <Radio className="absolute right-4 bottom-4 w-12 h-12 text-white/70 drop-shadow" strokeWidth={1.5} />
      </>
    );
    badgeLabel = 'Radio';
  }

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      aria-disabled={loading}
      className={`group relative flex w-[min(52vw,200px)] shrink-0 snap-start flex-col gap-2.5 cursor-pointer transition-ui duration-200 hover:-translate-y-0.5 sm:w-[190px] sm:gap-3 ${loading ? 'opacity-60 pointer-events-none' : ''}`}
      aria-label={`Open ${title}`}
    >
      <div className={`relative w-full aspect-square rounded-[var(--radius)] overflow-hidden shadow-md ring-1 ring-black/10 ${coverMotionClassName}`}>
        {coverContent}
        <span className="absolute top-2.5 left-2.5 text-[10px] font-bold uppercase tracking-[0.15em] text-white/95 bg-black/35 backdrop-blur-sm px-2 py-0.5 rounded-full">
          {badgeLabel}
        </span>
        {loading && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
            <Loader2 className="h-7 w-7 animate-spin text-white drop-shadow" />
          </div>
        )}
        {onPlay && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPlay();
            }}
            className="absolute bottom-3 left-3 w-10 h-10 rounded-full bg-[var(--color-primary)] text-white flex items-center justify-center shadow-lg opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:opacity-100 group-focus-within:translate-y-0 transition-ui duration-200 hover:bg-[var(--color-primary-dark)] hover:scale-110 active:scale-95 z-20"
            aria-label="Play"
          >
            <Play className="w-4 h-4 ml-0.5" fill="currentColor" />
          </button>
        )}
      </div>
      <div className={`px-0.5 ${textMotionClassName}`}>
        <p className="font-semibold text-sm text-[var(--color-text-primary)] line-clamp-2 leading-tight group-hover:text-[var(--color-primary)] transition-colors">
          {title}
        </p>
        {subtitle && (
          <p className="mt-1 line-clamp-2 text-xs leading-snug text-[var(--color-text-muted)]">
            {subtitle}
          </p>
        )}
      </div>
    </div>
  );
};

export const Hub: React.FC = () => {
  const { library, setPlaylist, getAuthHeader, togglePin, currentUser, genres: genreEntities, fetchPlaylistsFromServer, playlists } = usePlayerStore();
  const navigate = useNavigate();
  const [collections, setCollections] = useState<HubCollection[]>([]);
  const [smartBundle, setSmartBundle] = useState<SmartBundle | null>(null);
  const [radioLoadingId, setRadioLoadingId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSmartLoading, setIsSmartLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [openingSmartPlaylistId, setOpeningSmartPlaylistId] = useState<string | null>(null);
  const [generationError, setGenerationError] = useState('');
  const [shouldAnimateCards] = useState(() => !hasPlayedHubCardIntro);
  const collectionsSignatureRef = useRef('');
  const smartBundleSignatureRef = useRef('');

  const resolveTracks = useCallback((rawTracks: any[]): TrackInfo[] =>
    (rawTracks || [])
      .map((t: any) => library.find((lt) => lt.id === t.id) || t)
      .filter(Boolean) as TrackInfo[], [library]);

  const fetchSmartBundle = useCallback(async (options: { background?: boolean } = {}) => {
    if (!options.background) setIsSmartLoading(true);
    try {
      const res = await fetch('/api/hub/smart', { headers: getAuthHeader() });
      if (!res.ok) return;
      const data = await res.json();
      const resolve = (raw: any) =>
        raw ? { ...raw, tracks: resolveTracks(raw.tracks) } : null;
      const orNull = (col: HubCollection | null) =>
        col && col.tracks.length > 0 ? col : null;
      const nextBundle = {
        jumpBackIn: data.jumpBackIn || [],
        onRepeat: orNull(resolve(data.onRepeat)),
        repeatRewind: orNull(resolve(data.repeatRewind)),
        daylist: orNull(resolve(data.daylist)),
        artistRadios: (data.artistRadios || []).map((c: any) => ({
          artistId: c.artistId,
          artistName: c.artistName,
          imageUrl: c.imageUrl ?? null,
          recentPlays: c.recentPlays ?? 0,
          withArtists: Array.isArray(c.withArtists) ? c.withArtists : [],
        })),
        seasonalRewind: orNull(resolve(data.seasonalRewind)),
        yearRewind: orNull(resolve(data.yearRewind)),
      };
      const nextSignature = getSmartBundleSignature(nextBundle);
      const didChange = smartBundleSignatureRef.current !== nextSignature;
      smartBundleSignatureRef.current = nextSignature;
      setSmartBundle((prev) => (getSmartBundleSignature(prev) === nextSignature ? prev : nextBundle));
      if (didChange) void fetchPlaylistsFromServer();
    } catch (e) {
      console.error('Failed to load smart hub', e);
    } finally {
      if (!options.background) setIsSmartLoading(false);
    }
  }, [fetchPlaylistsFromServer, getAuthHeader, resolveTracks]);

  const handleJumpTile = (tile: JumpTile) => {
    if (tile.type === 'playlist') {
      navigate(`/playlists/${tile.id}`);
    } else if (tile.type === 'artist') {
      navigate(`/library/artist/${tile.id}`);
    } else if (tile.type === 'album') {
      navigate(`/library/album/${encodeURIComponent(tile.id)}`);
    }
  };

  const handlePlayJumpTile = (tile: JumpTile) => {
    let tracks: TrackInfo[] = [];
    if (tile.type === 'playlist') {
      const pl = playlists.find((p) => p.id === tile.id);
      tracks = pl?.tracks || [];
    } else if (tile.type === 'album') {
      tracks = library
        .filter((t: any) => t.albumId === tile.id)
        .sort((a: any, b: any) => (a.discNumber || 0) - (b.discNumber || 0) || (a.trackNumber || 0) - (b.trackNumber || 0));
    } else if (tile.type === 'artist') {
      tracks = library.filter((t: any) => t.artistId === tile.id);
    }
    if (tracks.length > 0) setPlaylist(tracks, 0);
  };

  // Server-side imageUrl is populated for artists (artists.image_url) but
  // null for albums/playlists. Fill in the gap from the local library /
  // playlist store, which carries embedded artwork from the audio files.
  const resolveTileImage = (tile: JumpTile): string | null => {
    if (tile.imageUrl) return tile.imageUrl;
    if (tile.type === 'album') {
      const t = library.find((lt) => (lt as any).albumId === tile.id);
      return t?.artUrl ?? null;
    }
    if (tile.type === 'playlist') {
      const pl = playlists.find((p) => p.id === tile.id);
      const firstWithArt = pl?.tracks?.find((tr: any) => tr.artUrl);
      return firstWithArt?.artUrl ?? null;
    }
    if (tile.type === 'artist') {
      const t = library.find((lt) => (lt as any).artistId === tile.id);
      return t?.artUrl ?? null;
    }
    return null;
  };

  const handleOpenArtistRadio = async (candidate: ArtistRadioCandidate) => {
    if (radioLoadingId) return;
    setRadioLoadingId(candidate.artistId);
    try {
      const res = await fetch('/api/hub/artist-radio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify({ artistId: candidate.artistId }),
      });
      if (!res.ok) throw new Error('Failed to load artist radio');
      const { playlist } = await res.json();
      // Make the smart playlist visible to the playlist store before navigating
      await fetchPlaylistsFromServer();
      if (playlist?.id) {
        navigate(`/playlists/${playlist.id}`);
      }
    } catch (e) {
      console.error('[Artist Radio] Failed', e);
    } finally {
      setRadioLoadingId(null);
    }
  };

  const fetchHubData = useCallback(async (options: { background?: boolean } = {}) => {
    if (!options.background) setIsLoading(true);
    try {
      const url = options.background ? '/api/hub?queueRefresh=false' : '/api/hub';
      const res = await fetch(url, { headers: getAuthHeader() });

      if (res.ok) {
        const data = await res.json();
        const mappedCollections = data.collections
          .map((col: any) => ({
            ...col,
            tracks: col.tracks
              .map((t: any) => {
                const libTrack = library.find((lt) => lt.id === t.id);
                return libTrack || (col.isLlmGenerated ? t : null);
              })
              .filter(Boolean),
          }))
          .filter((col: any) => col.tracks.length > 0);

        const nextSignature = getCollectionsSignature(mappedCollections);
        const didChange = collectionsSignatureRef.current !== nextSignature;
        collectionsSignatureRef.current = nextSignature;
        setCollections((prev) => (getCollectionsSignature(prev) === nextSignature ? prev : mappedCollections));
        // System playlists are persisted server-side during the hub fetch.
        // Refresh the playlist store so PlaylistDetail can resolve them by ID.
        if (didChange) void fetchPlaylistsFromServer();
      }
    } catch (e) {
      console.error('Failed to load hub data', e);
    } finally {
      if (!options.background) setIsLoading(false);
    }
  }, [fetchPlaylistsFromServer, getAuthHeader, library]);

  const handleOpenSmartPlaylist = async (collection: HubCollection | null | undefined) => {
    if (!collection?.id || openingSmartPlaylistId) return;

    setOpeningSmartPlaylistId(collection.id);
    try {
      const currentPlaylists = usePlayerStore.getState().playlists;
      if (!currentPlaylists.some((playlist) => playlist.id === collection.id)) {
        await fetchPlaylistsFromServer();
      }
      navigate(`/playlists/${collection.id}`);
    } finally {
      setOpeningSmartPlaylistId(null);
    }
  };

  const isInitialLoading = (isLoading || isSmartLoading) && collections.length === 0 && !smartBundle;

  useEffect(() => {
    if (library.length > 0) {
      fetchHubData();
      void fetchSmartBundle();
    } else {
      setIsLoading(false);
      setIsSmartLoading(false);
    }
  }, [fetchHubData, fetchSmartBundle, library.length]);

  useEffect(() => {
    if (library.length === 0 || isInitialLoading) return;

    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      if (Date.now() - startedAt > HUB_REFRESH_POLL_DURATION_MS) {
        window.clearInterval(interval);
        return;
      }
      void fetchHubData({ background: true });
      void fetchSmartBundle({ background: true });
    }, HUB_REFRESH_POLL_MS);

    return () => window.clearInterval(interval);
  }, [fetchHubData, fetchSmartBundle, library.length, isInitialLoading]);

  useEffect(() => {
    if (shouldAnimateCards && !isLoading) hasPlayedHubCardIntro = true;
  }, [isLoading, shouldAnimateCards]);

  const handleGeneratePlaylists = async () => {
    setIsGenerating(true);
    setGenerationError('');
    try {
      const authHeaders = getAuthHeader();
      const res = await fetch('/api/hub/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ force: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Failed to generate playlists.');
      }
      if (data.skipped) {
        throw new Error(data.reason || 'Playlist generation was skipped.');
      }
      if (typeof data.generated === 'number' && data.generated < 1) {
        throw new Error('No playlists were generated. Check your LLM configuration and genre mappings.');
      }
      await fetchHubData();
    } catch (e: any) {
      console.error('Failed to generate playlists', e);
      setGenerationError(e.message || 'Failed to generate playlists.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleTogglePin = (collectionId: string, pinned: boolean) => {
    togglePin(collectionId, pinned);
    setCollections((prev) =>
      prev.map((c) => (c.id === collectionId ? { ...c, pinned } : c))
    );
  };

  const handlePlayCollection = (tracks: TrackInfo[]) => {
    setPlaylist(tracks, 0);
  };

  const collectionSignature = useMemo(() => getCollectionsSignature(collections), [collections]);
  const smartBundleSignature = useMemo(() => getSmartBundleSignature(smartBundle), [smartBundle]);
  const { value: visibleCollections } = useCrossfadedValue(
    collections,
    collectionSignature,
    isCollectionListEmpty
  );
  const { value: visibleSmartBundle } = useCrossfadedValue(
    smartBundle,
    smartBundleSignature,
    isSmartBundleEmpty
  );
  const showSmartSkeletons = isSmartLoading && !visibleSmartBundle;

  const aiPlaylists = visibleCollections.filter((c) => c.isLlmGenerated);
  const systemCollections = visibleCollections.filter(
    (c) => !c.isLlmGenerated && (c.isSystem || (c.id || '').startsWith('engine_'))
  );

  // Derive top 6 genres by track count
  const topGenres = useMemo(() => {
    const genreCounts = new Map<string, number>();
    library.forEach((track) => {
      const genre = (track as any).genre;
      if (genre) {
        genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
      }
    });

    return Array.from(genreCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([genre, count]) => ({
        genre,
        count,
        entity: genreEntities.find((g: any) => g.name?.toLowerCase() === genre.toLowerCase()),
      }));
  }, [library, genreEntities]);

  if (isInitialLoading) {
    return <HubLoadingSkeleton />;
  }

  return (
    <div className="page-container space-y-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-[var(--color-text-primary)]">
            Home
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            Your personalized music experience
          </p>
        </div>
        {aiPlaylists.length > 0 && (
          <button
            onClick={handleGeneratePlaylists}
            disabled={isGenerating}
            className="btn btn-ghost btn-sm"
            aria-label="Refresh AI playlists"
          >
            <Wand2 className="w-4 h-4" />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        )}
      </header>

      {generationError && aiPlaylists.length > 0 && (
        <div className="rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/10 px-4 py-3 text-sm font-medium text-[var(--color-error)]">
          {generationError}
        </div>
      )}

      {showSmartSkeletons ? (
        <JumpBackInSectionSkeleton />
      ) : visibleSmartBundle && visibleSmartBundle.jumpBackIn.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-[var(--color-text-secondary)] mb-4">
            Jump back in
          </h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
            {visibleSmartBundle.jumpBackIn.slice(0, 8).map((tile, index) => (
              <AnimatedTileSlot
                key={`jump-back-in-${index}`}
                value={tile}
                signature={`${tile.type}:${tile.id}:${tile.title}:${tile.subtitle}:${tile.imageUrl || ''}:${tile.lastPlayedAt}`}
              >
                {(displayTile, phase) => (
                  <JumpTileCard
                    tile={{ ...displayTile, imageUrl: resolveTileImage(displayTile) }}
                    onActivate={handleJumpTile}
                    onPlay={handlePlayJumpTile}
                    motionClassName={getTileMotionClassName(phase)}
                    textMotionClassName={getTileTextMotionClassName(phase)}
                  />
                )}
              </AnimatedTileSlot>
            ))}
          </div>
        </section>
      )}

      {aiPlaylists.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 rounded-full bg-[var(--color-surface-variant)] flex items-center justify-center mb-4">
            <Sparkles className="w-8 h-8 text-[var(--color-primary)]" />
          </div>
          <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-2">
            No AI Playlists Yet
          </h3>
          <p className="text-sm text-[var(--color-text-secondary)] max-w-sm mb-6">
            Connect an LLM in{' '}
            <strong className="text-[var(--color-text-primary)]">Settings → Providers</strong>,
            then generate your first personalized playlists.
          </p>
          <button
            onClick={handleGeneratePlaylists}
            disabled={isGenerating || library.length === 0}
            className="btn btn-primary btn-lg"
            aria-label="Generate AI playlists"
          >
            {isGenerating ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <Sparkles className="w-5 h-5" />
            )}
            <span>{isGenerating ? 'Generating...' : 'Generate Playlists'}</span>
          </button>
          {generationError && (
            <p className="text-xs text-[var(--color-error)] mt-4 font-medium max-w-sm">
              {generationError}
            </p>
          )}
          {library.length === 0 && (
            <p className="text-xs text-[var(--color-error)] mt-4 font-medium">
              Scan music into your library first
            </p>
          )}
        </div>
      )}

      {aiPlaylists.length > 0 && (
        <section>
          <h2 className="text-xl sm:text-2xl font-bold text-[var(--color-text-primary)] mb-1">
            For you, {currentUser?.username || 'there'}
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)] mb-5">
            Curated intelligently for your current vibe
          </p>
          <div className="flex sm:grid sm:grid-cols-2 lg:grid-cols-3 overflow-x-auto snap-x snap-mandatory gap-4 sm:gap-5 lg:gap-6 hub-scroll-mobile hide-scrollbar">
            {aiPlaylists.map((collection) => (
              <HubCard
                key={collection.id}
                collection={collection}
                onOpen={() => collection.id && navigate(`/playlists/${collection.id}`)}
                onPlay={() => handlePlayCollection(collection.tracks)}
                onPinToggle={() =>
                  collection.id && handleTogglePin(collection.id, !collection.pinned)
                }
                animate={shouldAnimateCards}
              />
            ))}
          </div>
        </section>
      )}

      {showSmartSkeletons ? (
        <UniqueYoursSectionSkeleton />
      ) : visibleSmartBundle && (visibleSmartBundle.daylist || visibleSmartBundle.onRepeat || visibleSmartBundle.repeatRewind || visibleSmartBundle.artistRadios.length > 0) && (
        <section>
          <h2 className="text-xl sm:text-2xl font-bold text-[var(--color-text-primary)] mb-1">
            Uniquely yours
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)] mb-5">
            Personalised mixes that update with your listening
          </p>
          <HorizontalScrollRail
            ariaLabel="Uniquely yours"
            viewportClassName="flex overflow-x-auto snap-x snap-mandatory gap-3 hub-scroll-mobile hub-scroll-unique pb-1 sm:gap-5 sm:pb-2"
          >
            {visibleSmartBundle.daylist && (
              <AnimatedTileSlot
                value={visibleSmartBundle.daylist}
                signature={getCollectionSignature(visibleSmartBundle.daylist)}
              >
                {(displayDaylist, phase) => (
                  <UniqueCard
                    kind="daylist"
                    title={displayDaylist.title || 'Daylist'}
                    subtitle={displayDaylist.description || undefined}
                    onClick={() => handleOpenSmartPlaylist(displayDaylist)}
                    onPlay={() => handlePlayCollection(displayDaylist.tracks)}
                    loading={openingSmartPlaylistId === displayDaylist.id}
                    coverMotionClassName={getTileMotionClassName(phase)}
                    textMotionClassName={getTileTextMotionClassName(phase)}
                  />
                )}
              </AnimatedTileSlot>
            )}
            {visibleSmartBundle.onRepeat && (
              <AnimatedTileSlot
                value={visibleSmartBundle.onRepeat}
                signature={getCollectionSignature(visibleSmartBundle.onRepeat)}
              >
                {(displayOnRepeat, phase) => (
                  <UniqueCard
                    kind="on-repeat"
                    title="On Repeat"
                    subtitle="Songs you love right now"
                    onClick={() => handleOpenSmartPlaylist(displayOnRepeat)}
                    onPlay={() => handlePlayCollection(displayOnRepeat.tracks)}
                    loading={openingSmartPlaylistId === displayOnRepeat.id}
                    coverMotionClassName={getTileMotionClassName(phase)}
                    textMotionClassName={getTileTextMotionClassName(phase)}
                  />
                )}
              </AnimatedTileSlot>
            )}
            {visibleSmartBundle.repeatRewind && (
              <AnimatedTileSlot
                value={visibleSmartBundle.repeatRewind}
                signature={getCollectionSignature(visibleSmartBundle.repeatRewind)}
              >
                {(displayRepeatRewind, phase) => (
                  <UniqueCard
                    kind="repeat-rewind"
                    title="Repeat Rewind"
                    subtitle="Your past favorites"
                    onClick={() => handleOpenSmartPlaylist(displayRepeatRewind)}
                    onPlay={() => handlePlayCollection(displayRepeatRewind.tracks)}
                    loading={openingSmartPlaylistId === displayRepeatRewind.id}
                    coverMotionClassName={getTileMotionClassName(phase)}
                    textMotionClassName={getTileTextMotionClassName(phase)}
                  />
                )}
              </AnimatedTileSlot>
            )}
            {visibleSmartBundle.artistRadios.map((candidate, index) => (
              <AnimatedTileSlot
                key={`artist-radio-${index}`}
                value={candidate}
                signature={`${candidate.artistId}:${candidate.artistName}:${candidate.imageUrl || ''}:${candidate.withArtists.join('|')}`}
              >
                {(displayCandidate, phase) => (
                  <UniqueCard
                    kind="artist-radio"
                    title={`${displayCandidate.artistName} Radio`}
                    subtitle={
                      displayCandidate.withArtists && displayCandidate.withArtists.length > 0
                        ? `With ${displayCandidate.withArtists.join(', ')}`
                        : 'Inspired by your top artist'
                    }
                    imageUrl={displayCandidate.imageUrl}
                    onClick={() => handleOpenArtistRadio(displayCandidate)}
                    loading={radioLoadingId === displayCandidate.artistId}
                    coverMotionClassName={getTileMotionClassName(phase)}
                    textMotionClassName={getTileTextMotionClassName(phase)}
                  />
                )}
              </AnimatedTileSlot>
            ))}
          </HorizontalScrollRail>
        </section>
      )}

      <LiveConcertsHubSection />

      {visibleSmartBundle && (visibleSmartBundle.seasonalRewind || visibleSmartBundle.yearRewind) && (
        <section>
          <h2 className="text-xl sm:text-2xl font-bold text-[var(--color-text-primary)] mb-1">
            Time capsules
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)] mb-5">
            Your listening, frozen in moments
          </p>
          <HorizontalScrollRail
            ariaLabel="Time capsules"
            viewportClassName="flex overflow-x-auto snap-x snap-mandatory gap-4 hub-scroll-mobile pb-2"
          >
            {visibleSmartBundle.yearRewind && (
              <div className="snap-start">
                <AnimatedTileSlot
                  value={visibleSmartBundle.yearRewind}
                  signature={getCollectionSignature(visibleSmartBundle.yearRewind)}
                >
                  {(displayYearRewind, phase) => (
                    <CapsuleCard
                      collection={displayYearRewind}
                      onOpen={() => handleOpenSmartPlaylist(displayYearRewind)}
                      onPlay={() => handlePlayCollection(displayYearRewind.tracks)}
                      motionClassName={getTileMotionClassName(phase)}
                      textMotionClassName={getTileTextMotionClassName(phase)}
                    />
                  )}
                </AnimatedTileSlot>
              </div>
            )}
            {visibleSmartBundle.seasonalRewind && (
              <div className="snap-start">
                <AnimatedTileSlot
                  value={visibleSmartBundle.seasonalRewind}
                  signature={getCollectionSignature(visibleSmartBundle.seasonalRewind)}
                >
                  {(displaySeasonalRewind, phase) => (
                    <CapsuleCard
                      collection={displaySeasonalRewind}
                      onOpen={() => handleOpenSmartPlaylist(displaySeasonalRewind)}
                      onPlay={() => handlePlayCollection(displaySeasonalRewind.tracks)}
                      motionClassName={getTileMotionClassName(phase)}
                      textMotionClassName={getTileTextMotionClassName(phase)}
                    />
                  )}
                </AnimatedTileSlot>
              </div>
            )}
          </HorizontalScrollRail>
        </section>
      )}

      {systemCollections.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-[var(--color-text-secondary)] mb-4">
            Discover
          </h2>
          <div className="grid grid-cols-2 gap-3">
            {systemCollections.map((collection) => (
              <DiscoverCard
                key={collection.id}
                collection={collection}
                onOpen={() => collection.id && navigate(`/playlists/${collection.id}`)}
                onPlay={() => handlePlayCollection(collection.tracks)}
                animate={shouldAnimateCards}
              />
            ))}
          </div>
        </section>
      )}

      {topGenres.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-4">
            <Compass className="w-5 h-5 text-[var(--color-text-muted)]" />
            <h2 className="text-lg font-semibold text-[var(--color-text-secondary)]">
              Explore
            </h2>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
            {topGenres.map(({ genre, count, entity }) => (
              <ExploreCard
                key={genre}
                genre={genre}
                trackCount={count}
                entity={entity}
                animate={shouldAnimateCards}
              />
            ))}
          </div>
        </section>
      )}


    </div>
  );
};
