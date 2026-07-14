import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { AlertCircle, GitMerge, Layers3, Loader2, RefreshCw, RotateCcw, Tags, Wand2 } from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import { usePlayerStore, type EntityInfo } from '../../store/index';
import { ConfirmModal } from '../ConfirmModal';

interface ReviewGenre {
  id: string;
  name: string;
  normalizedKey: string;
  trackCount: number;
  albumCount: number;
  taxonomyPath: string | null;
}

interface GenreCandidate {
  candidateKey: string;
  signature: string;
  score: number;
  reasons: string[];
  taxonomyConflict: boolean;
  genres: ReviewGenre[];
}

interface CompoundCandidate {
  candidateKey: string;
  signature: string;
  genre: ReviewGenre;
  reason: 'compound-tag';
}

interface GenreGroup {
  canonical: ReviewGenre;
  aliases: ReviewGenre[];
}

interface GenreReviewState {
  candidates: GenreCandidate[];
  compounds: CompoundCandidate[];
  groups: GenreGroup[];
}

const EMPTY_STATE: GenreReviewState = { candidates: [], compounds: [], groups: [] };

function taxonomyLabel(path: string | null): string {
  return path || 'Not mapped';
}

export const GenreEntitiesTab: React.FC = () => {
  const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
  const fetchLibraryFromServer = usePlayerStore(state => state.fetchLibraryFromServer);
  const genreEntities = usePlayerStore(state => state.genres);
  const { addToast } = useToast();
  const [review, setReview] = useState<GenreReviewState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [canonicalByKey, setCanonicalByKey] = useState<Record<string, string>>({});
  const [manualCanonical, setManualCanonical] = useState('');
  const [manualAlias, setManualAlias] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);
  const listId = useId();

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info') => {
    addToast(message, type);
  }, [addToast]);

  const fetchReview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/library/genre-duplicates', { headers: getAuthHeader() });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to load genre review');
      const next: GenreReviewState = {
        candidates: Array.isArray(data.candidates) ? data.candidates : [],
        compounds: Array.isArray(data.compounds) ? data.compounds : [],
        groups: Array.isArray(data.groups) ? data.groups : [],
      };
      setReview(next);
      setCanonicalByKey(previous => {
        const updated = { ...previous };
        for (const candidate of next.candidates) {
          if (!candidate.genres.some(genre => genre.id === updated[candidate.candidateKey])) {
            updated[candidate.candidateKey] = candidate.genres[0]?.id || '';
          }
        }
        return updated;
      });
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Failed to load genre review');
    } finally {
      setLoading(false);
    }
  }, [getAuthHeader]);

  useEffect(() => {
    void fetchReview();
  }, [fetchReview]);

  const refreshAfterMutation = useCallback(async () => {
    await Promise.all([fetchReview(), fetchLibraryFromServer()]);
  }, [fetchLibraryFromServer, fetchReview]);

  const dismiss = useCallback(async (candidateKey: string, signature: string, genreIds: string[]) => {
    setBusyKey(candidateKey);
    try {
      const response = await fetch('/api/library/genre-duplicates/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify({ candidateKey, signature, genreIds }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to dismiss genre candidate');
      showToast('Genre candidate dismissed', 'success');
      await fetchReview();
    } catch (dismissError) {
      showToast(dismissError instanceof Error ? dismissError.message : 'Dismiss failed', 'error');
    } finally {
      setBusyKey(null);
    }
  }, [fetchReview, getAuthHeader, showToast]);

  const merge = useCallback(async (opts: {
    canonicalGenreId: string;
    aliasGenreIds: string[];
    candidateKey?: string;
    signature?: string;
    scoreEvidence?: unknown;
    acknowledgeTaxonomyConflict?: boolean;
  }) => {
    const key = opts.candidateKey || `manual:${opts.canonicalGenreId}`;
    setBusyKey(key);
    try {
      const response = await fetch('/api/library/genres/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify(opts),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409 && data.code === 'GENRE_TAXONOMY_CONFLICT' && !opts.acknowledgeTaxonomyConflict) {
        setConfirmDialog({
          title: 'Confirm taxonomy conflict',
          message: 'These genres currently resolve to different taxonomy roots. Grouping them will use the canonical genre path for playlist behavior.',
          confirmLabel: 'Group anyway',
          onConfirm: () => {
            setConfirmDialog(null);
            void merge({ ...opts, acknowledgeTaxonomyConflict: true });
          },
        });
        return;
      }
      if (!response.ok) throw new Error(data.error || 'Failed to group genres');
      showToast('Genres grouped', 'success');
      setManualCanonical('');
      setManualAlias('');
      await refreshAfterMutation();
    } catch (mergeError) {
      showToast(mergeError instanceof Error ? mergeError.message : 'Grouping failed', 'error');
    } finally {
      setBusyKey(null);
    }
  }, [getAuthHeader, refreshAfterMutation, showToast]);

  const reviewMerge = useCallback((candidate: GenreCandidate) => {
    const canonicalId = canonicalByKey[candidate.candidateKey] || candidate.genres[0]?.id;
    const canonical = candidate.genres.find(genre => genre.id === canonicalId);
    if (!canonical) return;
    const aliases = candidate.genres.filter(genre => genre.id !== canonical.id);
    const conflictCopy = candidate.taxonomyConflict
      ? ' These genres currently resolve to different taxonomy roots. The canonical genre path will control playlist behavior.'
      : '';
    setConfirmDialog({
      title: 'Group genre variants',
      message: `Keep “${canonical.name}” and fold in ${aliases.map(alias => `“${alias.name}”`).join(', ')}? Raw track tags stay unchanged and this can be restored later.${conflictCopy}`,
      confirmLabel: `Group as ${canonical.name}`,
      onConfirm: () => {
        setConfirmDialog(null);
        void merge({
          canonicalGenreId: canonical.id,
          aliasGenreIds: aliases.map(alias => alias.id),
          candidateKey: candidate.candidateKey,
          signature: candidate.signature,
          scoreEvidence: { score: candidate.score, reasons: candidate.reasons },
          acknowledgeTaxonomyConflict: candidate.taxonomyConflict,
        });
      },
    });
  }, [canonicalByKey, merge]);

  const restore = useCallback((group: GenreGroup, alias: ReviewGenre) => {
    setConfirmDialog({
      title: 'Restore genre variant',
      message: `Restore “${alias.name}” as a separate genre from “${group.canonical.name}”? Aurora will rebuild affected associations from the preserved raw tags.`,
      confirmLabel: `Restore ${alias.name}`,
      onConfirm: async () => {
        setConfirmDialog(null);
        setBusyKey(alias.id);
        try {
          const response = await fetch(`/api/library/genres/${encodeURIComponent(alias.id)}/restore`, {
            method: 'POST',
            headers: getAuthHeader(),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || 'Failed to restore genre');
          showToast(`Restored ${alias.name}`, 'success');
          await refreshAfterMutation();
        } catch (restoreError) {
          showToast(restoreError instanceof Error ? restoreError.message : 'Restore failed', 'error');
        } finally {
          setBusyKey(null);
        }
      },
    });
  }, [getAuthHeader, refreshAfterMutation, showToast]);

  const sortedGenres = useMemo(
    () => [...genreEntities].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
    [genreEntities],
  );
  const genreByName = useMemo(
    () => new Map(sortedGenres.filter(genre => genre.name).map(genre => [String(genre.name).toLowerCase(), genre])),
    [sortedGenres],
  );
  const manualCanonicalGenre = genreByName.get(manualCanonical.trim().toLowerCase());
  const manualAliasGenre = genreByName.get(manualAlias.trim().toLowerCase());
  const manualReady = Boolean(manualCanonicalGenre && manualAliasGenre && manualCanonicalGenre.id !== manualAliasGenre.id);

  const reviewManualMerge = useCallback(() => {
    if (!manualCanonicalGenre || !manualAliasGenre || manualCanonicalGenre.id === manualAliasGenre.id) return;
    setConfirmDialog({
      title: 'Group genres manually',
      message: `Keep “${manualCanonicalGenre.name}” and fold in “${manualAliasGenre.name}”? Raw tags remain unchanged and the alias can be restored later.`,
      confirmLabel: `Group as ${manualCanonicalGenre.name}`,
      onConfirm: () => {
        setConfirmDialog(null);
        void merge({ canonicalGenreId: manualCanonicalGenre.id, aliasGenreIds: [manualAliasGenre.id] });
      },
    });
  }, [manualAliasGenre, manualCanonicalGenre, merge]);

  return (
    <div className="settings-section artist-entities-settings genre-entities-settings">
      <header className="artist-entities-settings__header">
        <div>
          <p className="artist-entities-settings__eyebrow">Library Hygiene</p>
          <h3>Genre Entities</h3>
          <p>Group inconsistent tags before they shape genre browsing and generated playlists.</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={fetchReview} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
          Refresh
        </button>
      </header>

      <section className="artist-entities-overview" aria-label="Genre entity review summary">
        <div className="artist-entities-overview__item"><span>Candidates</span><strong>{review.candidates.length}</strong></div>
        <div className="artist-entities-overview__item"><span>Grouped</span><strong>{review.groups.reduce((sum, group) => sum + group.aliases.length, 0)}</strong></div>
        <div className="artist-entities-overview__item"><span>Compound</span><strong>{review.compounds.length}</strong></div>
      </section>

      <section className="artist-entities-guide">
        <div className="artist-entities-guide__item">
          <Tags size={16} aria-hidden="true" />
          <div>
            <h4>Similarity is a review aid</h4>
            <p>Scores combine spelling, word overlap, and word order. MusicBrainz paths add context, but never group genres automatically.</p>
          </div>
        </div>
        <div className="artist-entities-guide__note">
          <AlertCircle size={15} aria-hidden="true" />
          <p>Slash tags are held separately because values such as Pop/Rock may be intentional. Raw Picard metadata is never rewritten.</p>
        </div>
      </section>

      <section className="artist-entities-manual" aria-label="Manual genre grouping">
        <div className="artist-entities-manual__head">
          <Wand2 size={15} aria-hidden="true" />
          <div><h4>Manual grouping</h4><p>Choose the display genre to keep, then choose one variant to fold in.</p></div>
        </div>
        <div className="genre-manual-grid">
          {([
            ['Keep', manualCanonical, setManualCanonical, `${listId}-keep`],
            ['Fold in', manualAlias, setManualAlias, `${listId}-alias`],
          ] as const).map(([label, value, setter, id]) => (
            <label key={label} className="artist-entities-manual__field">
              <span>{label}</span>
              <input value={value} onChange={event => setter(event.target.value)} list={id} placeholder="Search genres…" autoComplete="off" spellCheck={false} />
              <datalist id={id}>{sortedGenres.map(genre => <option key={genre.id} value={genre.name || ''} />)}</datalist>
            </label>
          ))}
        </div>
        <div className="artist-entities-manual__footer">
          <button type="button" className="btn btn-primary btn-sm" disabled={!manualReady || busyKey?.startsWith('manual:')} onClick={reviewManualMerge}>
            <GitMerge size={13} aria-hidden="true" />
            Review grouping
          </button>
        </div>
      </section>

      <section className="artist-entities-queue">
        <div className="artist-entities-queue__header"><div><h4>Review queue</h4><p>{review.candidates.length} possible group{review.candidates.length === 1 ? '' : 's'}, highest similarity first</p></div></div>
        {loading ? (
          <div className="artist-entities-empty" role="status"><Loader2 size={17} className="animate-spin" aria-hidden="true" /><span>Comparing library genres...</span></div>
        ) : error ? (
          <div className="artist-entities-empty" role="alert"><AlertCircle size={17} aria-hidden="true" /><span>{error}</span></div>
        ) : review.candidates.length === 0 ? (
          <div className="artist-entities-empty" role="status"><Tags size={17} aria-hidden="true" /><span>No genre variants need review.</span></div>
        ) : (
          <div className="genre-candidate-list">
            {review.candidates.map(candidate => {
              const canonicalId = canonicalByKey[candidate.candidateKey] || candidate.genres[0]?.id;
              const busy = busyKey === candidate.candidateKey;
              return (
                <article className="genre-candidate" key={`${candidate.candidateKey}:${candidate.signature}`}>
                  <div className="genre-candidate__head">
                    <div><strong>{candidate.score}</strong><span>Similarity score</span></div>
                    <div className="genre-candidate__evidence">
                      {candidate.reasons.map(reason => <span key={reason}>{reason}</span>)}
                    </div>
                  </div>
                  <div className="genre-choice-list">
                    {candidate.genres.map(genre => (
                      <label key={genre.id} className={canonicalId === genre.id ? 'selected' : ''}>
                        <input type="radio" name={candidate.candidateKey} checked={canonicalId === genre.id} onChange={() => setCanonicalByKey(previous => ({ ...previous, [candidate.candidateKey]: genre.id }))} />
                        <span className="genre-choice__name">{genre.name}</span>
                        <span>{genre.trackCount} tracks</span>
                        <span title={taxonomyLabel(genre.taxonomyPath)}>{taxonomyLabel(genre.taxonomyPath)}</span>
                      </label>
                    ))}
                  </div>
                  <div className="genre-candidate__actions">
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => reviewMerge(candidate)}>{busy ? <Loader2 size={13} className="animate-spin" /> : <GitMerge size={13} />}Group</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void dismiss(candidate.candidateKey, candidate.signature, candidate.genres.map(genre => genre.id))}>Dismiss</button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {review.compounds.length > 0 && (
        <section className="artist-entities-queue">
          <div className="artist-entities-queue__header"><div><h4>Compound tags</h4><p>Ambiguous slash values stay separate from duplicate scoring.</p></div></div>
          <div className="genre-compact-list">
            {review.compounds.map(candidate => (
              <div key={candidate.candidateKey} className="genre-compact-row">
                <Layers3 size={15} aria-hidden="true" />
                <div><strong>{candidate.genre.name}</strong><span>{candidate.genre.trackCount} tracks</span></div>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busyKey === candidate.candidateKey} onClick={() => void dismiss(candidate.candidateKey, candidate.signature, [candidate.genre.id])}>Leave as one genre</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {review.groups.length > 0 && (
        <section className="artist-entities-queue">
          <div className="artist-entities-queue__header"><div><h4>Active groups</h4><p>Restore an alias without rescanning or changing the source tags.</p></div></div>
          <div className="genre-compact-list">
            {review.groups.flatMap(group => group.aliases.map(alias => (
              <div key={alias.id} className="genre-compact-row">
                <GitMerge size={15} aria-hidden="true" />
                <div><strong>{alias.name}</strong><span>Grouped into {group.canonical.name}</span></div>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busyKey === alias.id} onClick={() => restore(group, alias)}><RotateCcw size={13} aria-hidden="true" />Restore</button>
              </div>
            )))}
          </div>
        </section>
      )}

      {confirmDialog && <ConfirmModal title={confirmDialog.title} message={confirmDialog.message} confirmLabel={confirmDialog.confirmLabel} confirmTone="primary" onConfirm={confirmDialog.onConfirm} onCancel={() => setConfirmDialog(null)} />}
    </div>
  );
};
