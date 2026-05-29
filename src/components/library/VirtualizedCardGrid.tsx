import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

// Match the breakpoints used by `.album-grid` / `.artist-grid` / `.genre-grid`
// in src/index.css so a virtualized grid looks identical to the static one.
// Keep these in sync if those breakpoints change.
const COLUMN_BREAKPOINTS = [
    { minWidth: 1280, columns: 6 },
    { minWidth: 1024, columns: 5 },
    { minWidth: 768, columns: 4 },
    { minWidth: 640, columns: 4 },
    { minWidth: 0, columns: 3 },
] as const;

const ROW_GAP_BY_WIDTH = (width: number): number => {
    if (width >= 768) return 24; // 1.5rem
    if (width >= 640) return 16; // 1rem
    return 12; // 0.75rem
};

const COLUMN_GAP_BY_WIDTH = ROW_GAP_BY_WIDTH;

const columnsForWidth = (width: number): number => {
    for (const bp of COLUMN_BREAKPOINTS) {
        if (width >= bp.minWidth) return bp.columns;
    }
    return 3;
};

interface VirtualizedCardGridProps<T> {
    items: T[];
    renderItem: (item: T, index: number) => React.ReactNode;
    getKey: (item: T, index: number) => React.Key;
    // Aspect of the card art (width / height). For album cards (square art +
    // text below) this is roughly 1. For artist cards (circular + name) it's
    // also ~1 but with slightly different text trail. Caller supplies the
    // estimated row height (excluding gap) in pixels so the virtualizer can
    // place rows without measuring every one.
    estimatedRowHeight: (columnWidth: number) => number;
    scrollParentRef: React.RefObject<HTMLElement>;
    overscan?: number;
}

// Windowed grid that mirrors the static CSS-grid layout but only mounts the
// rows currently in (or near) the viewport. Avoids paying React reconciliation
// + DOM creation cost for hundreds of cards at once — the original killer on
// mobile when navigating into the album or artist library.
export function VirtualizedCardGrid<T>({
    items,
    renderItem,
    getKey,
    estimatedRowHeight,
    scrollParentRef,
    overscan = 4,
}: VirtualizedCardGridProps<T>) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState(0);

    // Track the container's inner width so we can compute column count and row
    // height. Layout effect + ResizeObserver keeps it in sync with orientation
    // changes and side-panel toggles.
    useLayoutEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const measure = () => setContainerWidth(el.clientWidth);
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const columns = useMemo(() => columnsForWidth(containerWidth || (typeof window !== 'undefined' ? window.innerWidth : 1024)), [containerWidth]);
    const columnGap = COLUMN_GAP_BY_WIDTH(containerWidth);
    const rowGap = ROW_GAP_BY_WIDTH(containerWidth);

    const columnWidth = useMemo(() => {
        if (!containerWidth || columns <= 0) return 0;
        const totalGap = columnGap * (columns - 1);
        return Math.max(0, (containerWidth - totalGap) / columns);
    }, [containerWidth, columns, columnGap]);

    const rowCount = Math.ceil(items.length / columns);
    const rowHeight = estimatedRowHeight(columnWidth);

    const virtualizer = useVirtualizer({
        count: rowCount,
        getScrollElement: () => scrollParentRef.current,
        estimateSize: () => rowHeight + rowGap,
        overscan,
    });

    // When width or item count changes, re-measure so virtualizer doesn't keep
    // stale row positions.
    useEffect(() => {
        virtualizer.measure();
    }, [columns, rowHeight, rowGap, items.length, virtualizer]);

    const virtualRows = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();

    return (
        <div ref={containerRef} style={{ position: 'relative', width: '100%', height: totalSize > 0 ? totalSize : undefined }}>
            {virtualRows.map((virtualRow) => {
                const rowIndex = virtualRow.index;
                const startIndex = rowIndex * columns;
                const rowItems = items.slice(startIndex, startIndex + columns);
                return (
                    <div
                        key={virtualRow.key}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            transform: `translateY(${virtualRow.start}px)`,
                            display: 'grid',
                            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                            columnGap: `${columnGap}px`,
                            rowGap: `${rowGap}px`,
                        }}
                    >
                        {rowItems.map((item, colIndex) => (
                            <React.Fragment key={getKey(item, startIndex + colIndex)}>
                                {renderItem(item, startIndex + colIndex)}
                            </React.Fragment>
                        ))}
                    </div>
                );
            })}
        </div>
    );
}
