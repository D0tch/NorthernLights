import React, { useState } from 'react';
import { ListMusic, X, Loader2 } from 'lucide-react';
import { usePlayerStore } from '../../store';
import type { Playlist } from '../../store';

// Small modal for creating a blank playlist with a name + optional description.
// Mirrors the GeneratePlaylistModal shell (fixed overlay, glass card, X close,
// click-outside-to-close). On success it hands the created playlist back to the
// caller via onCreated so the page can open it.
const CreatePlaylistModal: React.FC<{
  onClose: () => void;
  onCreated: (playlist: Playlist) => void;
}> = ({ onClose, onCreated }) => {
  const createPlaylist = usePlayerStore((s) => s.createPlaylist);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    const title = name.trim();
    if (!title || isSaving) return;
    setIsSaving(true);
    setError('');
    try {
      const created = await createPlaylist(title, description.trim() || undefined);
      if (created) {
        onCreated(created);
      } else {
        setError('Could not create the playlist. Please try again.');
      }
    } catch {
      setError('Network error. Is the server running?');
    } finally {
      setIsSaving(false);
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
          aria-label="Close"
        >
          <X size={20} />
        </button>

        <div>
          <div className="flex items-center gap-3 mb-1">
            <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center">
              <ListMusic className="w-5 h-5 text-[var(--color-primary)]" />
            </div>
            <h2 className="text-xl font-bold text-[var(--color-text-primary)]">New Playlist</h2>
          </div>
          <p className="text-sm text-[var(--color-text-secondary)] ml-12">
            Name it now — add tracks once it's open.
          </p>
        </div>

        <div className="space-y-3">
          <input
            type="text"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
            placeholder="Playlist name…"
            className="w-full px-4 py-3 rounded-xl bg-[var(--color-surface)] border border-[var(--glass-border)] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)] transition-colors text-sm"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCreate(); }}
            placeholder="Description (optional)"
            rows={3}
            className="w-full px-4 py-3 rounded-xl bg-[var(--color-surface)] border border-[var(--glass-border)] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)] transition-colors resize-none text-sm"
          />
        </div>

        {error && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2">{error}</p>}

        <div className="flex gap-3">
          <button
            onClick={handleCreate}
            disabled={!name.trim() || isSaving}
            className="flex-1 py-3 rounded-xl bg-aurora-gradient hover:brightness-110 text-white font-semibold shadow-lg transition-ui active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isSaving
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating…</>
              : <>Create playlist</>
            }
          </button>
          <button
            onClick={onClose}
            className="px-4 py-3 rounded-xl bg-[var(--color-surface)] border border-[var(--glass-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default CreatePlaylistModal;
