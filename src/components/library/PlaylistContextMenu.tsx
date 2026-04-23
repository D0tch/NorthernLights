/**
 * PlaylistContextMenu
 *
 * Mirrors the exact behaviour of TrackContextMenu:
 *  - Mobile  → portal bottom-sheet (blurred backdrop, drag handle, slide-up)
 *  - Desktop → portal positioned dropdown (scale+fade entrance, click-outside dismiss)
 *
 * Usage:
 *   const [menu, setMenu] = useState<PlaylistMenuTrigger | null>(null);
 *   <PlaylistContextMenu menu={menu} onClose={() => setMenu(null)} ... />
 *   // open:
 *   setMenu({ playlist, x: e.clientX, y: e.clientY });
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Play, Pin, PinOff, Trash2 } from 'lucide-react';
import type { Playlist } from '../../store';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlaylistMenuTrigger {
    playlist: Playlist;
    x: number;
    y: number;
}

interface PlaylistContextMenuProps {
    menu: PlaylistMenuTrigger | null;
    onClose: () => void;
    onPlay: () => void;
    onPinToggle?: () => void;
    onDelete: () => void;
}

// ─── useIsMobile ─────────────────────────────────────────────────────────────

function useIsMobile(breakpoint = 640) {
    const [isMobile, setIsMobile] = useState(() => window.innerWidth < breakpoint);
    useEffect(() => {
        const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
        const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, [breakpoint]);
    return isMobile;
}

// ─── CtxButton ────────────────────────────────────────────────────────────────

const CtxButton: React.FC<{
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
    danger?: boolean;
}> = ({ icon, label, onClick, danger }) => (
    <button
        onClick={onClick}
        className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors active:bg-white/10 ${
            danger
                ? 'text-rose-400 hover:bg-rose-500/10'
                : 'text-[var(--color-text-primary)] hover:bg-white/5'
        }`}
    >
        <span className={`flex-shrink-0 ${danger ? 'text-rose-400' : 'text-[var(--color-text-secondary)]'}`}>
            {icon}
        </span>
        {label}
    </button>
);

// ─── Component ────────────────────────────────────────────────────────────────

export const PlaylistContextMenu: React.FC<PlaylistContextMenuProps> = ({
    menu, onClose, onPlay, onPinToggle, onDelete,
}) => {
    const isMobile  = useIsMobile();
    const menuRef   = useRef<HTMLDivElement>(null);
    const [isVisible, setIsVisible] = useState(false);

    // Animate in on open
    useEffect(() => {
        if (menu) requestAnimationFrame(() => setIsVisible(true));
        else setIsVisible(false);
    }, [menu]);

    // Escape key
    useEffect(() => {
        if (!menu) return;
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [menu, onClose]);

    // Desktop: click outside to dismiss
    useEffect(() => {
        if (!menu || isMobile) return;
        const handler = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [menu, isMobile, onClose]);

    if (!menu) return null;

    const { playlist, x, y } = menu;

    // Desktop: keep menu within viewport
    const menuW = 192, menuH = 160;
    const posX = Math.min(x, window.innerWidth  - menuW - 16);
    const posY = Math.min(y, window.innerHeight - menuH - 16);

    // ── Shared inner shell ────────────────────────────────────────────────────
    const inner = (
        <div
            ref={menuRef}
            className={`bg-[var(--glass-bg)] backdrop-blur-3xl border border-[var(--glass-border)] rounded-2xl shadow-2xl overflow-hidden ${
                isMobile ? 'w-full rounded-b-none' : 'w-48'
            }`}
            onContextMenu={(e) => e.preventDefault()}
        >
            {/* Header */}
            <div className="px-4 py-3 border-b border-[var(--glass-border)]">
                <div className="text-sm font-semibold text-[var(--color-text-primary)] truncate">
                    {playlist.title}
                </div>
                <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
                    {playlist.tracks.length} {playlist.tracks.length === 1 ? 'track' : 'tracks'}
                </div>
            </div>

            {/* Actions */}
            <div className="py-1.5">
                <CtxButton
                    icon={<Play size={15} />}
                    label="Play"
                    onClick={() => { onPlay(); onClose(); }}
                />
                {onPinToggle && (
                    <CtxButton
                        icon={playlist.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                        label={playlist.pinned ? 'Unpin' : 'Pin'}
                        onClick={() => { onPinToggle(); onClose(); }}
                    />
                )}
                <div className="h-px bg-[var(--glass-border)] my-1.5 mx-3" />
                <CtxButton
                    icon={<Trash2 size={15} />}
                    label="Delete"
                    onClick={() => { onDelete(); onClose(); }}
                    danger
                />
            </div>
        </div>
    );

    // ── Mobile: bottom-sheet ──────────────────────────────────────────────────
    if (isMobile) {
        return createPortal(
            <>
                <div
                    className="fixed inset-0 z-[9998] transition-opacity duration-200"
                    style={{
                        background: 'rgba(0,0,0,0.55)',
                        opacity: isVisible ? 1 : 0,
                        backdropFilter: 'blur(4px)',
                        WebkitBackdropFilter: 'blur(4px)',
                    }}
                    onClick={onClose}
                />
                <div
                    className="fixed bottom-0 left-0 right-0 z-[9999] transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
                    style={{ transform: isVisible ? 'translateY(0)' : 'translateY(100%)' }}
                >
                    {/* Drag handle */}
                    <div className="flex justify-center pt-3 pb-1 bg-[var(--glass-bg)] rounded-t-2xl border-t border-x border-[var(--glass-border)]">
                        <div className="w-10 h-1 rounded-full bg-[var(--color-border)]" />
                    </div>
                    {inner}
                    <div className="h-[env(safe-area-inset-bottom,0px)] bg-[var(--glass-bg)] border-x border-[var(--glass-border)]" />
                </div>
            </>,
            document.body
        );
    }

    // ── Desktop: positioned dropdown ──────────────────────────────────────────
    return createPortal(
        <div
            className="fixed z-[9999]"
            style={{
                top: posY, left: posX,
                opacity:   isVisible ? 1 : 0,
                transform: isVisible ? 'scale(1) translateY(0)' : 'scale(0.95) translateY(-4px)',
                transition: 'opacity 0.15s, transform 0.15s',
                transformOrigin: 'top left',
            }}
        >
            {inner}
        </div>,
        document.body
    );
};
