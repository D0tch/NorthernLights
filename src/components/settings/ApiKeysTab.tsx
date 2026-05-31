import React, { useEffect, useRef, useState } from 'react';
import { Ban, Copy, KeyRound, Plus, RotateCw, Trash2 } from 'lucide-react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';
import { ConfirmModal } from '../ConfirmModal';
import { PromptModal } from '../PromptModal';

interface SubsonicApiKeyRecord {
    id: string;
    name: string;
    prefix: string;
    createdAt: number | null;
    lastUsedAt: number | null;
    revokedAt: number | null;
}

export const ApiKeysTab: React.FC = () => {
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const openSubsonicEnabled = usePlayerStore(state => state.openSubsonicEnabled);
    const { addToast } = useToast();

    const [keys, setKeys] = useState<SubsonicApiKeyRecord[]>([]);
    const [isLoadingKeys, setIsLoadingKeys] = useState(true);
    const [isCreatingKey, setIsCreatingKey] = useState(false);
    const [pendingKeyId, setPendingKeyId] = useState<string | null>(null);
    const [revealedKey, setRevealedKey] = useState<{ label: string; value: string } | null>(null);
    const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; confirmLabel?: string; onConfirm: () => void } | null>(null);
    const [promptDialog, setPromptDialog] = useState<{ title: string; label?: string; placeholder?: string; confirmLabel?: string; onSubmit: (value: string) => void } | null>(null);
    const isMountedRef = useRef(true);

    const showToast = (msg: string, type: 'success' | 'error' | 'info') => addToast(msg, type);

    useEffect(() => {
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    const fetchKeys = async () => {
        try {
            const res = await fetch('/api/auth/subsonic-api-keys', { headers: getAuthHeader() });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                showToast(data.error || 'Failed to load API keys', 'error');
                return;
            }
            if (isMountedRef.current) setKeys(Array.isArray(data.keys) ? data.keys : []);
        } catch (e: any) {
            showToast(e?.message || 'Network error', 'error');
        } finally {
            if (isMountedRef.current) setIsLoadingKeys(false);
        }
    };

    useEffect(() => {
        fetchKeys();
    }, []);

    const createKey = () => {
        if (!openSubsonicEnabled) return;
        setPromptDialog({
            title: 'Create API Key',
            label: 'Name this client key.',
            placeholder: 'Symfonium on Pixel',
            confirmLabel: 'Create Key',
            onSubmit: async (name) => {
                setPromptDialog(null);
                setIsCreatingKey(true);
                try {
                    const res = await fetch('/api/auth/subsonic-api-keys', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                        body: JSON.stringify({ name }),
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok || !data.key) {
                        showToast(data.error || 'Failed to create API key', 'error');
                        return;
                    }
                    setRevealedKey({ label: 'New key', value: data.key });
                    await fetchKeys();
                    showToast('API key created', 'success');
                } catch (e: any) {
                    showToast(e?.message || 'Network error', 'error');
                } finally {
                    setIsCreatingKey(false);
                }
            },
        });
    };

    const rotateKey = (key: SubsonicApiKeyRecord) => {
        if (!openSubsonicEnabled || key.revokedAt) return;
        setConfirmDialog({
            title: 'Rotate API Key',
            message: `Rotate "${key.name}"? The current secret stops working immediately and the replacement is shown once.`,
            confirmLabel: 'Rotate Key',
            onConfirm: async () => {
                setConfirmDialog(null);
                setPendingKeyId(key.id);
                try {
                    const res = await fetch(`/api/auth/subsonic-api-keys/${encodeURIComponent(key.id)}/rotate`, {
                        method: 'POST',
                        headers: getAuthHeader(),
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok || !data.key) {
                        showToast(data.error || 'Failed to rotate API key', 'error');
                        return;
                    }
                    setRevealedKey({ label: 'Rotated key', value: data.key });
                    await fetchKeys();
                    showToast('API key rotated', 'success');
                } catch (e: any) {
                    showToast(e?.message || 'Network error', 'error');
                } finally {
                    setPendingKeyId(null);
                }
            },
        });
    };

    const removeKey = (key: SubsonicApiKeyRecord) => {
        const isRevoked = Boolean(key.revokedAt);
        setConfirmDialog({
            title: isRevoked ? 'Delete API Key' : 'Revoke API Key',
            message: isRevoked
                ? `Delete the revoked record "${key.name}" from this list?`
                : `Revoke "${key.name}"? Clients using this key will lose access immediately.`,
            confirmLabel: isRevoked ? 'Delete Key' : 'Revoke Key',
            onConfirm: async () => {
                setConfirmDialog(null);
                setPendingKeyId(key.id);
                try {
                    const res = await fetch(`/api/auth/subsonic-api-keys/${encodeURIComponent(key.id)}`, {
                        method: 'DELETE',
                        headers: getAuthHeader(),
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) {
                        showToast(data.error || 'Failed to update API key', 'error');
                        return;
                    }
                    await fetchKeys();
                    showToast(isRevoked ? 'API key deleted' : 'API key revoked', 'success');
                } catch (e: any) {
                    showToast(e?.message || 'Network error', 'error');
                } finally {
                    setPendingKeyId(null);
                }
            },
        });
    };

    const copyRevealedKey = async () => {
        if (!revealedKey) return;
        try {
            await navigator.clipboard.writeText(revealedKey.value);
            showToast('API key copied', 'success');
        } catch {
            showToast('Could not copy API key', 'error');
        }
    };

    return (
        <div className="settings-section account-settings">
            <header className="account-settings__header">
                <div>
                    <p className="account-settings__eyebrow">OpenSubsonic</p>
                    <h3>API Keys</h3>
                </div>
                <span className={`account-settings__role ${openSubsonicEnabled ? '' : 'account-settings__role--disabled'}`}>
                    {openSubsonicEnabled ? 'enabled' : 'disabled'}
                </span>
            </header>

            <section className="account-panel account-panel--subsonic">
                <div className="account-panel__header">
                    <div className="account-panel__title">
                        <KeyRound size={17} aria-hidden="true" />
                        <h4>Client Access</h4>
                    </div>
                    <p>
                        {openSubsonicEnabled
                            ? 'Create one key per Subsonic client. Rotate a key when a client secret may have been exposed.'
                            : 'OpenSubsonic is disabled by an admin. Existing keys are kept, but /rest requests are blocked.'}
                    </p>
                </div>

                {!openSubsonicEnabled && (
                    <div className="account-api-key-disabled" role="status">
                        <Ban size={16} aria-hidden="true" />
                        <span>Client login, browse, and stream requests are unavailable until OpenSubsonic is enabled again.</span>
                    </div>
                )}

                {revealedKey && (
                    <div className="account-api-key-reveal">
                        <div>
                            <span>{revealedKey.label}</span>
                            <code>{revealedKey.value}</code>
                        </div>
                        <button type="button" onClick={copyRevealedKey} className="btn btn-ghost btn-sm">
                            <Copy size={15} aria-hidden="true" />
                            Copy
                        </button>
                    </div>
                )}

                <div className="account-provider-list">
                    {isLoadingKeys ? (
                        <div className="account-provider account-provider--empty">
                            <div className="account-provider__copy">
                                <h5>Loading keys</h5>
                                <p>Checking client access for this account.</p>
                            </div>
                        </div>
                    ) : keys.length === 0 ? (
                        <div className="account-provider account-provider--empty">
                            <div className="account-provider__copy">
                                <h5>No API keys</h5>
                                <p>Create a key, then paste it into your Subsonic client as the API key.</p>
                            </div>
                        </div>
                    ) : (
                        keys.map(key => {
                            const isRevoked = Boolean(key.revokedAt);
                            const isPending = pendingKeyId === key.id;
                            return (
                                <div key={key.id} className={`account-provider ${isRevoked ? 'account-provider--revoked' : ''}`}>
                                    <div className="account-provider__main">
                                        <div className="account-provider__copy">
                                            <div className="account-provider__title-row">
                                                <h5>{key.name}</h5>
                                                <span className={isRevoked ? 'account-status' : 'account-status account-status--connected'}>
                                                    {isRevoked ? 'Revoked' : key.prefix}
                                                </span>
                                            </div>
                                            <p>
                                                Created {key.createdAt ? new Date(key.createdAt).toLocaleDateString() : 'recently'}
                                                {key.lastUsedAt ? ` · Last used ${new Date(key.lastUsedAt).toLocaleDateString()}` : ' · Never used'}
                                            </p>
                                        </div>
                                        <div className="account-api-key-actions">
                                            {!isRevoked && (
                                                <button
                                                    type="button"
                                                    onClick={() => rotateKey(key)}
                                                    disabled={!openSubsonicEnabled || isPending}
                                                    className="btn btn-ghost btn-sm disabled:opacity-50"
                                                >
                                                    <RotateCw size={15} aria-hidden="true" />
                                                    {isPending ? 'Rotating...' : 'Rotate'}
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => removeKey(key)}
                                                disabled={isPending}
                                                className={`btn ${isRevoked ? 'btn-danger-fill' : 'btn-danger'} btn-sm disabled:opacity-50`}
                                            >
                                                <Trash2 size={15} aria-hidden="true" />
                                                {isPending ? 'Updating...' : isRevoked ? 'Delete' : 'Revoke'}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>

                <button
                    type="button"
                    onClick={createKey}
                    disabled={!openSubsonicEnabled || isCreatingKey}
                    className="btn btn-primary btn-sm account-api-key-create disabled:opacity-50"
                >
                    <Plus size={15} aria-hidden="true" />
                    {isCreatingKey ? 'Creating...' : 'Create API Key'}
                </button>
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

            {promptDialog && (
                <PromptModal
                    title={promptDialog.title}
                    label={promptDialog.label}
                    placeholder={promptDialog.placeholder}
                    confirmLabel={promptDialog.confirmLabel}
                    onSubmit={promptDialog.onSubmit}
                    onCancel={() => setPromptDialog(null)}
                />
            )}
        </div>
    );
};
