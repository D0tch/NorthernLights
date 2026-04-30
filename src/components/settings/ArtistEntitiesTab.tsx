import React, { useState, useCallback, useEffect } from 'react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';
import { Loader2, GitMerge, EyeOff, RefreshCw, AlertCircle, Users2, Layers } from 'lucide-react';
import { ConfirmModal } from '../ConfirmModal';

interface ArtistDuplicateCandidate {
    candidateKey: string;
    normalizedKey: string;
    signature: string;
    totalTracks: number;
    artists: Array<{
        id: string;
        name: string;
        mbid: string | null;
        imageUrl?: string;
        trackCount: number;
        albumCount: number;
        displayScore: number;
    }>;
}

type CandidateKind = 'same-identity' | 'compound-credit';

const candidateKind = (candidate: ArtistDuplicateCandidate): CandidateKind =>
    candidate.candidateKey.startsWith('artist-amp-compound:') ? 'compound-credit' : 'same-identity';

const KindBadge: React.FC<{ kind: CandidateKind }> = ({ kind }) => {
    if (kind === 'compound-credit') {
        return (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                <Layers size={11} />
                Compound credit
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/30">
            <Users2 size={11} />
            Same identity
        </span>
    );
};

export const ArtistEntitiesTab: React.FC = () => {
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const fetchLibraryFromServer = usePlayerStore(state => state.fetchLibraryFromServer);

    const [candidates, setCandidates] = useState<ArtistDuplicateCandidate[]>([]);
    const [loading, setLoading] = useState(false);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [canonicalByKey, setCanonicalByKey] = useState<Record<string, string>>({});
    const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; confirmLabel?: string; onConfirm: () => void } | null>(null);

    const { addToast } = useToast();
    const showToast = useCallback((msg: string, type: 'success' | 'error' | 'info') => addToast(msg, type), [addToast]);

    const fetchCandidates = useCallback(async () => {
        try {
            setLoading(true);
            const res = await fetch('/api/library/artist-duplicates', { headers: getAuthHeader() });
            if (!res.ok) return;
            const data = await res.json();
            const rows: ArtistDuplicateCandidate[] = Array.isArray(data.candidates) ? data.candidates : [];
            setCandidates(rows);
            setCanonicalByKey(prev => {
                const next = { ...prev };
                for (const candidate of rows) {
                    if (!next[candidate.candidateKey] || !candidate.artists.some(a => a.id === next[candidate.candidateKey])) {
                        next[candidate.candidateKey] = candidate.artists[0]?.id || '';
                    }
                }
                return next;
            });
        } catch (e) {
            console.error('Failed to fetch artist duplicate candidates', e);
        } finally {
            setLoading(false);
        }
    }, [getAuthHeader]);

    useEffect(() => {
        fetchCandidates();
    }, [fetchCandidates]);

    const handleDismiss = useCallback(async (candidate: ArtistDuplicateCandidate) => {
        try {
            setBusyKey(candidate.candidateKey);
            const res = await fetch('/api/library/artist-duplicates/dismiss', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                body: JSON.stringify({
                    candidateKey: candidate.candidateKey,
                    signature: candidate.signature,
                    artistIds: candidate.artists.map(a => a.id),
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                showToast(data.error || 'Failed to dismiss artist duplicate', 'error');
                return;
            }
            showToast('Candidate dismissed', 'success');
            await fetchCandidates();
        } catch (e) {
            showToast(`Dismiss failed: ${e}`, 'error');
        } finally {
            setBusyKey(null);
        }
    }, [fetchCandidates, getAuthHeader, showToast]);

    const handleMerge = useCallback((candidate: ArtistDuplicateCandidate) => {
        const canonicalArtistId = canonicalByKey[candidate.candidateKey] || candidate.artists[0]?.id;
        const canonicalArtist = candidate.artists.find(a => a.id === canonicalArtistId);
        if (!canonicalArtist) return;
        const duplicateArtistIds = candidate.artists.filter(a => a.id !== canonicalArtistId).map(a => a.id);
        const kind = candidateKind(candidate);

        const message = kind === 'compound-credit'
            ? `Merge the credit row${duplicateArtistIds.length === 1 ? '' : 's'} into "${canonicalArtist.name}"? Tracks, subscriptions, dismissed-auto state, and concert events will be moved. Metadata (MBID, image, bio) will NOT be copied across — the credit row's MBID belongs to the credit string, not to ${canonicalArtist.name}.`
            : `Merge ${duplicateArtistIds.length} artist entr${duplicateArtistIds.length === 1 ? 'y' : 'ies'} into "${canonicalArtist.name}"? Track links, subscriptions, dismissed-auto state, concert events, and any missing metadata will be copied to the canonical artist.`;

        setConfirmDialog({
            title: 'Merge Artist Entries',
            message,
            confirmLabel: 'Merge Artists',
            onConfirm: async () => {
                setConfirmDialog(null);
                try {
                    setBusyKey(candidate.candidateKey);
                    const res = await fetch('/api/library/artist-duplicates/merge', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                        body: JSON.stringify({
                            candidateKey: candidate.candidateKey,
                            signature: candidate.signature,
                            canonicalArtistId,
                            duplicateArtistIds,
                        }),
                    });
                    if (!res.ok) {
                        const data = await res.json().catch(() => ({}));
                        showToast(data.error || 'Failed to merge artists', 'error');
                        return;
                    }
                    showToast(`Merged into ${canonicalArtist.name}`, 'success');
                    await fetchLibraryFromServer();
                    await fetchCandidates();
                } catch (e) {
                    showToast(`Merge failed: ${e}`, 'error');
                } finally {
                    setBusyKey(null);
                }
            },
        });
    }, [canonicalByKey, fetchCandidates, fetchLibraryFromServer, getAuthHeader, showToast]);

    const sameIdentityCount = candidates.filter(c => candidateKind(c) === 'same-identity').length;
    const compoundCount = candidates.filter(c => candidateKind(c) === 'compound-credit').length;

    return (
        <div className="settings-section mb-8">
            <div className="settings-section-header mb-4">
                <h3 className="text-lg font-bold text-[var(--color-text-primary)]">Artist Entities</h3>
                <p className="text-sm text-[var(--color-text-muted)] mt-1">
                    Review and consolidate artist rows that look like duplicates or compound credit strings. Merges
                    are reversible only by re-scanning the library, so read each candidate carefully before acting.
                </p>
            </div>

            {/* How this works */}
            <div className="rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] p-4 mb-4 text-sm text-[var(--color-text-secondary)] space-y-3">
                <div className="flex items-start gap-2">
                    <KindBadge kind="same-identity" />
                    <div className="flex-1">
                        <p className="font-medium text-[var(--color-text-primary)] mb-1">Same identity duplicates</p>
                        <p className="text-xs leading-relaxed">
                            Two or more artist rows whose names normalize to the same canonical key — typically diacritic
                            or punctuation variants like <span className="font-mono">Tiësto</span> /{' '}
                            <span className="font-mono">Tiesto</span> or <span className="font-mono">N&rsquo;to</span> /{' '}
                            <span className="font-mono">NTO</span>. Pick the row with the right display name (usually the
                            one with diacritics) and click Merge. Tracks, subscriptions, concert events, and any missing
                            metadata fields (MBID, image, bio) are moved to the canonical row.
                        </p>
                    </div>
                </div>
                <div className="flex items-start gap-2">
                    <KindBadge kind="compound-credit" />
                    <div className="flex-1">
                        <p className="font-medium text-[var(--color-text-primary)] mb-1">Compound credits</p>
                        <p className="text-xs leading-relaxed">
                            A credit string like <span className="font-mono">Tony Bennett &amp; Lady Gaga</span> or{' '}
                            <span className="font-mono">Sia &amp; At home with the kids</span> got stored as a single
                            artist row. The first half of the credit already exists as its own artist row in your library —
                            that&rsquo;s the canonical individual to merge into. Tracks and attachments move across, but the
                            credit row&rsquo;s MBID/image/etc. are <em>not</em> copied (they belong to the credit string,
                            not the individual). Album collaborations like Cheek to Cheek will then show under primary
                            releases on both collaborators&rsquo; pages, because ArtistDetail treats &ge;50% credited tracks
                            as a co-primary album.
                        </p>
                    </div>
                </div>
                <div className="flex items-start gap-2 pt-1">
                    <AlertCircle size={14} className="text-[var(--color-text-muted)] mt-0.5 shrink-0" />
                    <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
                        Genuine duos (Nik &amp; Jay, Chase &amp; Status, Demons &amp; Wizards) are not surfaced because their
                        first half doesn&rsquo;t exist as a separate artist row. If you do see a candidate that&rsquo;s
                        actually a real group, click <em>Dismiss</em> — the dismissal is signature-keyed by current track
                        and album counts, so the candidate stays hidden until the underlying data changes.
                    </p>
                </div>
            </div>

            {/* Header row with refresh + counts */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-3">
                <div className="text-xs text-[var(--color-text-muted)]">
                    {loading
                        ? 'Checking artist identity keys...'
                        : `${candidates.length} candidate${candidates.length === 1 ? '' : 's'} (${sameIdentityCount} same identity, ${compoundCount} compound)`}
                </div>
                <button
                    className="btn btn-ghost btn-sm flex items-center gap-1.5 self-start sm:self-auto"
                    onClick={fetchCandidates}
                    disabled={loading}
                >
                    <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                    Refresh
                </button>
            </div>

            {/* Candidate list */}
            {loading ? (
                <div className="p-4 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-sm text-[var(--color-text-muted)]">
                    Checking artist identity keys...
                </div>
            ) : candidates.length === 0 ? (
                <div className="p-4 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-sm text-[var(--color-text-muted)]">
                    No artist candidates need review.
                </div>
            ) : (
                <div className="flex flex-col gap-3">
                    {candidates.map(candidate => {
                        const canonicalArtistId = canonicalByKey[candidate.candidateKey] || candidate.artists[0]?.id || '';
                        const busy = busyKey === candidate.candidateKey;
                        const kind = candidateKind(candidate);
                        return (
                            <div key={`${candidate.candidateKey}:${candidate.signature}`} className="p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)]">
                                <div className="flex flex-col gap-3">
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <KindBadge kind={kind} />
                                            <span className="text-sm font-semibold text-[var(--color-text-primary)] break-words">{candidate.normalizedKey}</span>
                                            <span className="text-xs text-[var(--color-text-muted)]">{candidate.artists.length} artists · {candidate.totalTracks} tracks</span>
                                        </div>
                                        <div className="mt-2 flex flex-col gap-2">
                                            {candidate.artists.map(artist => (
                                                <label key={artist.id} className={`flex items-start gap-3 rounded-lg border p-2 transition-colors ${canonicalArtistId === artist.id ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10' : 'border-[var(--glass-border)] bg-[var(--color-surface)]'}`}>
                                                    <input
                                                        type="radio"
                                                        name={`canonical-${candidate.candidateKey}`}
                                                        checked={canonicalArtistId === artist.id}
                                                        onChange={() => setCanonicalByKey(prev => ({ ...prev, [candidate.candidateKey]: artist.id }))}
                                                        className="mt-1 accent-[var(--color-primary)]"
                                                    />
                                                    <div className="min-w-0 flex-1">
                                                        <div className="text-sm font-medium text-[var(--color-text-primary)] break-words">{artist.name}</div>
                                                        <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
                                                            <span>{artist.trackCount} tracks</span>
                                                            <span>{artist.albumCount} albums</span>
                                                            {artist.mbid && <span className="font-mono">MBID {artist.mbid.slice(0, 8)}</span>}
                                                        </div>
                                                    </div>
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                    <div className="flex flex-col gap-2">
                                        <button
                                            className="btn btn-primary btn-sm flex items-center justify-center gap-1.5"
                                            onClick={() => handleMerge(candidate)}
                                            disabled={busy}
                                        >
                                            {busy ? <Loader2 size={13} className="animate-spin" /> : <GitMerge size={13} />}
                                            Merge into selected
                                        </button>
                                        <button
                                            className="btn btn-ghost btn-sm flex items-center justify-center gap-1.5"
                                            onClick={() => handleDismiss(candidate)}
                                            disabled={busy}
                                        >
                                            <EyeOff size={13} />
                                            Dismiss
                                        </button>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {confirmDialog && (
                <ConfirmModal
                    title={confirmDialog.title}
                    message={confirmDialog.message}
                    confirmLabel={confirmDialog.confirmLabel}
                    onConfirm={confirmDialog.onConfirm}
                    onCancel={() => setConfirmDialog(null)}
                />
            )}
        </div>
    );
};
