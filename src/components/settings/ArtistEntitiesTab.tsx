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
            <span className="artist-entity-badge artist-entity-badge--compound">
                <Layers size={11} aria-hidden="true" />
                Compound credit
            </span>
        );
    }
    return (
        <span className="artist-entity-badge artist-entity-badge--same">
            <Users2 size={11} aria-hidden="true" />
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
            ? `Merge the credit row${duplicateArtistIds.length === 1 ? '' : 's'} into "${canonicalArtist.name}"? Tracks, subscriptions, dismissed-auto state, and concert events will be moved. Metadata (MBID, image, bio) will not be copied across because the credit row's MBID belongs to the credit string, not to ${canonicalArtist.name}.`
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
        <div className="settings-section artist-entities-settings">
            <header className="artist-entities-settings__header">
                <div>
                    <p className="artist-entities-settings__eyebrow">Library Hygiene</p>
                    <h3>Artist Entities</h3>
                    <p>Review duplicate rows and compound credit strings before they shape artist pages.</p>
                </div>
                <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={fetchCandidates}
                    disabled={loading}
                >
                    <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
                    Refresh
                </button>
            </header>

            <section className="artist-entities-overview" aria-label="Artist entity review summary">
                <div className="artist-entities-overview__item">
                    <span>Candidates</span>
                    <strong>{candidates.length}</strong>
                </div>
                <div className="artist-entities-overview__item">
                    <span>Same identity</span>
                    <strong>{sameIdentityCount}</strong>
                </div>
                <div className="artist-entities-overview__item">
                    <span>Compound</span>
                    <strong>{compoundCount}</strong>
                </div>
            </section>

            <section className="artist-entities-guide">
                <div className="artist-entities-guide__item">
                    <KindBadge kind="same-identity" />
                    <div>
                        <h4>Same identity duplicates</h4>
                        <p>
                            Name variants normalize to the same key, for example <code>Tiësto</code> and <code>Tiesto</code>.
                            Choose the best display name, then merge tracks, subscriptions, events, and missing metadata into it.
                        </p>
                    </div>
                </div>
                <div className="artist-entities-guide__item">
                    <KindBadge kind="compound-credit" />
                    <div>
                        <h4>Compound credits</h4>
                        <p>
                            Credits such as <code>Tony Bennett &amp; Lady Gaga</code> or <code>The Chainsmokers + Kygo</code>
                            can be folded into the canonical artist row. Tracks move across, but credit-string metadata stays behind.
                        </p>
                    </div>
                </div>
                <div className="artist-entities-guide__note">
                    <AlertCircle size={15} aria-hidden="true" />
                    <p>
                        Genuine duos are intentionally skipped when their first half is not already a separate artist row.
                        Dismiss real groups you do see; dismissals return only when track or album counts change.
                    </p>
                </div>
            </section>

            <section className="artist-entities-queue">
                <div className="artist-entities-queue__header">
                    <div>
                        <h4>Review Queue</h4>
                        <p>
                            {loading
                                ? 'Checking artist identity keys...'
                                : `${candidates.length} candidate${candidates.length === 1 ? '' : 's'} ready for review`}
                        </p>
                    </div>
                </div>

            {loading ? (
                <div className="artist-entities-empty" role="status">
                    <Loader2 size={17} className="animate-spin" aria-hidden="true" />
                    <span>Checking artist identity keys...</span>
                </div>
            ) : candidates.length === 0 ? (
                <div className="artist-entities-empty" role="status">
                    <GitMerge size={17} aria-hidden="true" />
                    <span>No artist candidates need review.</span>
                </div>
            ) : (
                <div className="artist-candidate-list">
                    {candidates.map(candidate => {
                        const canonicalArtistId = canonicalByKey[candidate.candidateKey] || candidate.artists[0]?.id || '';
                        const busy = busyKey === candidate.candidateKey;
                        const kind = candidateKind(candidate);
                        return (
                            <article key={`${candidate.candidateKey}:${candidate.signature}`} className="artist-candidate">
                                <div className="artist-candidate__head">
                                    <div className="artist-candidate__title">
                                        <KindBadge kind={kind} />
                                        <h5>{candidate.normalizedKey}</h5>
                                    </div>
                                    <div className="artist-candidate__meta">
                                        <span>{candidate.artists.length} artists</span>
                                        <span>{candidate.totalTracks} tracks</span>
                                    </div>
                                </div>

                                <div className="artist-candidate__body">
                                    <div className="artist-choice-list">
                                        {candidate.artists.map(artist => (
                                            <label key={artist.id} className="artist-choice" data-selected={canonicalArtistId === artist.id ? 'true' : 'false'}>
                                                <input
                                                    type="radio"
                                                    name={`canonical-${candidate.candidateKey}`}
                                                    checked={canonicalArtistId === artist.id}
                                                    onChange={() => setCanonicalByKey(prev => ({ ...prev, [candidate.candidateKey]: artist.id }))}
                                                />
                                                <span className="artist-choice__copy">
                                                    <span className="artist-choice__name">{artist.name}</span>
                                                    <span className="artist-choice__meta">
                                                        <span>{artist.trackCount} tracks</span>
                                                        <span>{artist.albumCount} albums</span>
                                                        {artist.mbid && <code>MBID {artist.mbid.slice(0, 8)}</code>}
                                                    </span>
                                                </span>
                                            </label>
                                        ))}
                                    </div>

                                    <div className="artist-candidate__actions">
                                        <button
                                            type="button"
                                            className="btn btn-primary btn-sm"
                                            onClick={() => handleMerge(candidate)}
                                            disabled={busy}
                                        >
                                            {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <GitMerge size={13} aria-hidden="true" />}
                                            Merge into selected
                                        </button>
                                        <button
                                            type="button"
                                            className="btn btn-ghost btn-sm"
                                            onClick={() => handleDismiss(candidate)}
                                            disabled={busy}
                                        >
                                            <EyeOff size={13} aria-hidden="true" />
                                            Dismiss
                                        </button>
                                    </div>
                                </div>
                            </article>
                        );
                    })}
                </div>
            )}
            </section>

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
