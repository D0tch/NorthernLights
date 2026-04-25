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

import React from 'react';
import { Play, Pin, PinOff, Trash2 } from 'lucide-react';
import type { Playlist } from '../../store';
import {
    ContextMenuButton,
    ContextMenuDivider,
    ContextMenuFrame,
    ContextMenuHeader,
    ContextMenuList,
    ContextMenuPortal,
} from '../ContextMenu';

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
    onDelete?: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const PlaylistContextMenu: React.FC<PlaylistContextMenuProps> = ({
    menu, onClose, onPlay, onPinToggle, onDelete,
}) => {
    if (!menu) return null;

    const { playlist, x, y } = menu;

    return (
        <ContextMenuPortal
            open={!!menu}
            onClose={onClose}
            position={{ x, y }}
            desktopWidth={192}
            desktopHeight={160}
        >
            {({ isMobile }) => (
                <ContextMenuFrame isMobile={isMobile} widthClassName="w-48">
                    <ContextMenuHeader
                        title={playlist.title}
                        subtitle={`${playlist.tracks.length} ${playlist.tracks.length === 1 ? 'track' : 'tracks'}`}
                    />

                    <ContextMenuList>
                        <ContextMenuButton
                            icon={<Play size={15} />}
                            label="Play"
                            onClick={() => { onPlay(); onClose(); }}
                        />
                        {onPinToggle && (
                            <ContextMenuButton
                                icon={playlist.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                                label={playlist.pinned ? 'Unpin' : 'Pin'}
                                onClick={() => { onPinToggle(); onClose(); }}
                            />
                        )}
                        {onDelete && (
                            <>
                                <ContextMenuDivider />
                                <ContextMenuButton
                                    icon={<Trash2 size={15} />}
                                    label="Delete"
                                    onClick={() => { onDelete(); onClose(); }}
                                    danger
                                />
                            </>
                        )}
                    </ContextMenuList>
                </ContextMenuFrame>
            )}
        </ContextMenuPortal>
    );
};
