import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../../store';
import {
  Play, Plus, Sparkles, X, Loader2,
  Disc3, MoreHorizontal, Pin,
} from 'lucide-react';
import { useDominantColor } from '../../hooks/useDominantColor';
import type { Playlist } from '../../store';
import {
  PlaylistContextMenu,
  type PlaylistMenuTrigger,
} from './PlaylistContextMenu';

// ─── Playlist Card ────────────────────────────────────────────────────────────

const PlaylistCard: React.FC<{
  playlist: Playlist;
  onOpen: () => void;
  onMenuOpen: (x: number, y: number) => void;
  onPlay: () => void;
}> = ({ playlist, onOpen, onMenuOpen, onPlay }) => {
  const { artUrls, bgColor } = useDominantColor(playlist.tracks);
  const hasCovers = artUrls.length > 0;

  return (
    <div
      className="relative p-4 sm:p-5 cursor-pointer group rounded-[var(--radius)] bg-[var(--glass-bg)] border border-[var(--glass-border)] backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md active:scale-[0.98]"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
      }}
      aria-label={`Open ${playlist.title}`}
    >
      {/* Colour bleed */}
      <div
        className="absolute inset-0 rounded-[inherit] opacity-[0.05] group-hover:opacity-[0.10] transition-opacity pointer-events-none"
        style={{ background: `linear-gradient(135deg, ${bgColor}, transparent 60%)` }}
      />

      {/* Top row: stacked art + kebab */}
      <div className="relative flex items-start justify-between mb-4">
        <div className="flex items-center">
          {hasCovers ? (
            artUrls.slice(0, 4).map((url, i) => (
              <img
                key={i}
                src={url}
                alt=""
                className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg shadow-sm object-cover"
                style={{ marginLeft: i > 0 ? '-10px' : 0, zIndex: 10 - i }}
              />
            ))
          ) : (
            <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-[var(--color-surface-variant)] flex items-center justify-center">
              <Disc3 className="w-6 h-6 text-[var(--color-text-muted)] opacity-40" />
            </div>
          )}
        </div>

        <button
          onClick={(e) => { e.stopPropagation(); onMenuOpen(e.clientX, e.clientY); }}
          className="w-9 h-9 rounded-full flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-white/10 dark:hover:bg-white/5 transition-colors"
          aria-label="More options"
        >
          <MoreHorizontal size={18} />
        </button>
      </div>

      {/* Info */}
      <div className="relative z-10">
        <h3 className="font-semibold text-base sm:text-lg text-[var(--color-text-primary)] line-clamp-1 group-hover:text-[var(--color-primary)] transition-colors">
          {playlist.title}
        </h3>

        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
          <p className="text-xs text-[var(--color-text-muted)]">
            {playlist.tracks.length} {playlist.tracks.length === 1 ? 'track' : 'tracks'}
          </p>
          {playlist.isLlmGenerated && (
            <span className="rounded-full border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/15 px-2 py-px text-[10px] font-semibold uppercase tracking-wider text-[var(--color-primary)]">
              AI
            </span>
          )}
          {playlist.pinned && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-px text-[10px] font-semibold uppercase tracking-wider text-amber-400">
              <Pin className="h-2.5 w-2.5" /> Pinned
            </span>
          )}
        </div>
      </div>

      {/* Play FAB — always visible on mobile, hover-reveal on desktop */}
      <button
        onClick={(e) => { e.stopPropagation(); onPlay(); }}
        className="absolute bottom-4 right-4 w-11 h-11 rounded-full bg-[var(--color-primary)] text-white flex items-center justify-center shadow-lg shadow-emerald-500/30 sm:opacity-0 sm:translate-y-2 sm:group-hover:opacity-100 sm:group-hover:translate-y-0 sm:group-focus-within:opacity-100 sm:group-focus-within:translate-y-0 transition-all duration-200 hover:bg-[var(--color-primary-dark)] hover:scale-110 active:scale-95 z-20"
        aria-label={`Play ${playlist.title}`}
      >
        <Play className="w-5 h-5 ml-0.5" fill="currentColor" />
      </button>
    </div>
  );
};

// ─── Card skeleton ────────────────────────────────────────────────────────────

const PlaylistCardSkeleton: React.FC = () => (
  <div className="p-4 sm:p-5 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-[var(--radius)] animate-pulse">
    <div className="flex items-center mb-4">
      <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-[var(--color-surface-variant)]" />
      <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-[var(--color-surface-variant)] -ml-2.5" />
      <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-[var(--color-surface-variant)] -ml-2.5" />
    </div>
    <div className="h-5 w-3/4 rounded bg-[var(--color-surface-variant)] mb-2" />
    <div className="h-3 w-1/3 rounded bg-[var(--color-surface-variant)]" />
  </div>
);

// ─── Generate Playlist Modal ──────────────────────────────────────────────────

const GeneratePlaylistModal: React.FC<{ onClose: () => void; onGenerated: () => void }> = ({
  onClose,
  onGenerated,
}) => {
  const { getAuthHeader, fetchPlaylistsFromServer } = usePlayerStore();
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const examples = [
    'Late night rainy drive through the city',
    'Energetic workout, heavy beats, no vocals',
    'Sunday morning coffee and jazz vibes',
    'Focus music for deep work, minimal and ambient',
  ];

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setIsGenerating(true);
    setError('');
    setSuccess('');
    try {
      const res = await fetch('/api/hub/generate-custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Generation failed. Check your LLM configuration in Settings.');
        return;
      }
      setSuccess(`✓ "${data.playlist?.title || 'Your new playlist'}" has been created!`);
      await fetchPlaylistsFromServer();
      setTimeout(() => { onGenerated(); onClose(); }, 1500);
    } catch {
      setError('Network error. Is the server running?');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-lg bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-3xl p-8 shadow-2xl backdrop-blur-2xl space-y-6"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          <X size={20} />
        </button>

        <div>
          <div className="flex items-center gap-3 mb-1">
            <div className="w-9 h-9 rounded-full bg-[var(--color-primary)]/10 flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-[var(--color-primary)]" />
            </div>
            <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Generate a Playlist</h2>
          </div>
          <p className="text-sm text-[var(--color-text-secondary)] ml-12">
            Describe the vibe — the AI will pick the tracks.
          </p>
        </div>

        <div className="space-y-3">
          <textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate(); }}
            placeholder="e.g. Late night coding session, lo-fi and focused…"
            rows={3}
            className="w-full px-4 py-3 rounded-xl bg-[var(--color-surface)] border border-[var(--glass-border)] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)] transition-colors resize-none text-sm"
          />
          <div className="flex flex-wrap gap-2">
            {examples.map((ex) => (
              <button
                key={ex}
                onClick={() => setPrompt(ex)}
                className="text-xs px-3 py-1.5 rounded-full bg-[var(--color-surface)] border border-[var(--glass-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-text-primary)] transition-all"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>

        {error   && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2">{error}</p>}
        {success && <p className="text-sm text-green-400 bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-2">{success}</p>}

        <div className="flex gap-3">
          <button
            onClick={handleGenerate}
            disabled={!prompt.trim() || isGenerating}
            className="flex-1 py-3 rounded-xl bg-aurora-gradient hover:brightness-110 text-white font-semibold shadow-lg transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isGenerating
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Generating…</>
              : <><Sparkles className="w-4 h-4" /> Generate Playlist</>
            }
          </button>
          <button
            onClick={onClose}
            className="px-4 py-3 rounded-xl bg-[var(--color-surface)] border border-[var(--glass-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            Cancel
          </button>
        </div>
        <p className="text-xs text-center text-[var(--color-text-muted)]">Tip: ⌘ Enter to generate</p>
      </div>
    </div>
  );
};

// ─── Inline create form ───────────────────────────────────────────────────────

const CreatePlaylistForm: React.FC<{ onSubmit: (title: string) => void; onCancel: () => void }> = ({
  onSubmit,
  onCancel,
}) => {
  const [title, setTitle] = useState('');
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (title.trim()) onSubmit(title.trim()); }}
      className="bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-[var(--radius)] p-5 flex flex-col gap-4"
    >
      <h3 className="text-base font-semibold text-[var(--color-text-primary)]">New Playlist</h3>
      <input
        type="text"
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Playlist name…"
        className="w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface)] border border-[var(--glass-border)] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)] text-sm transition-colors"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-lg text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!title.trim()}
          className="px-4 py-2 rounded-lg text-sm bg-[var(--color-primary)] text-white font-medium disabled:opacity-50 transition-opacity"
        >
          Create
        </button>
      </div>
    </form>
  );
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export const Playlists: React.FC = () => {
  const { playlists, setPlaylist, createPlaylist, deletePlaylist, togglePin } = usePlayerStore();
  const navigate = useNavigate();

  const [isCreating,   setIsCreating]   = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [activeMenu,   setActiveMenu]   = useState<PlaylistMenuTrigger | null>(null);

  const handleCreate = async (title: string) => {
    await createPlaylist(title, '');
    setIsCreating(false);
  };

  const openMenu = useCallback((playlist: Playlist, x: number, y: number) => {
    setActiveMenu({ playlist, x, y });
  }, []);

  const closeMenu = useCallback(() => setActiveMenu(null), []);

  // Find the live playlist from store so pin state reflects toggle immediately
  const activePlaylist = activeMenu
    ? playlists.find((p) => p.id === activeMenu.playlist.id) ?? activeMenu.playlist
    : null;

  // Pinned first, then original order
  const sorted = [...playlists].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return 0;
  });

  return (
    <div className="page-container space-y-8">
      {/* Generate modal */}
      {isGenerating && (
        <GeneratePlaylistModal
          onClose={() => setIsGenerating(false)}
          onGenerated={() => setIsGenerating(false)}
        />
      )}

      {/* Playlist context menu — rendered at document root via portal */}
      <PlaylistContextMenu
        menu={activeMenu && activePlaylist ? { ...activeMenu, playlist: activePlaylist } : null}
        onClose={closeMenu}
        onPlay={() => {
          if (activePlaylist && activePlaylist.tracks.length > 0)
            setPlaylist(activePlaylist.tracks, 0);
        }}
        onPinToggle={activePlaylist
          ? () => togglePin(activePlaylist.id!, !activePlaylist.pinned)
          : undefined
        }
        onDelete={() => {
          if (activePlaylist) deletePlaylist(activePlaylist.id!);
        }}
      />

      {/* ── Header ── */}
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-[var(--color-text-primary)]">
            Your Playlists
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            {playlists.length} {playlists.length === 1 ? 'playlist' : 'playlists'} in your library
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => setIsGenerating(true)} className="btn btn-ghost btn-sm">
            <Sparkles className="w-4 h-4" />
            <span className="hidden sm:inline">Generate</span>
          </button>
          <button onClick={() => setIsCreating(true)} className="btn btn-primary btn-sm">
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">New Playlist</span>
            <span className="sm:hidden">New</span>
          </button>
        </div>
      </header>

      {/* ── Grid ── */}
      {playlists.length === 0 && !isCreating ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-16 h-16 rounded-full bg-[var(--color-surface-variant)] flex items-center justify-center mb-4">
            <Sparkles className="w-8 h-8 text-[var(--color-primary)]" />
          </div>
          <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-2">
            No playlists yet
          </h3>
          <p className="text-sm text-[var(--color-text-secondary)] max-w-sm mb-6">
            Create one manually, or hit{' '}
            <strong className="text-[var(--color-text-primary)]">Generate</strong>{' '}
            to let the AI curate your first playlist.
          </p>
          <div className="flex gap-3">
            <button onClick={() => setIsGenerating(true)} className="btn btn-ghost btn-sm">
              <Sparkles className="w-4 h-4" /> Generate with AI
            </button>
            <button onClick={() => setIsCreating(true)} className="btn btn-primary btn-sm">
              <Plus className="w-4 h-4" /> Create Playlist
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5 lg:gap-6">
          {isCreating && (
            <CreatePlaylistForm
              onSubmit={handleCreate}
              onCancel={() => setIsCreating(false)}
            />
          )}

          {sorted.map((pl) => (
            <PlaylistCard
              key={pl.id}
              playlist={pl}
              onOpen={() => navigate(`/playlists/${pl.id}`)}
              onPlay={() => { if (pl.tracks.length > 0) setPlaylist(pl.tracks, 0); }}
              onMenuOpen={(x, y) => openMenu(pl, x, y)}
            />
          ))}
        </div>
      )}
    </div>
  );
};
