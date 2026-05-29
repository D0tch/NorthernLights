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
    // Caller supplies the estimated row height (excluding gap) in pixels, as a
    // function of the computed column width, so the virtualizer can place rows
    // without measuring every one.
    estimatedRowHeight: (columnWidth: number) => number;
    scrollParentRef: React.RefObject<HTMLElement>;
    overscan?: number;
}

// Windowed grid that mirrors the static CSS-grid layout but only mounts the
// rows currently in (or near) the viewport. Avoids paying React reconciliation
// + DOM creation cost for hundreds of cards at once — the original killer on
// mobile when navigating into the album or artist library.
//
// IMPORTANT — width is measured from a dedicated zero-height sentinel, NOT from
// the tall spacer that carries `height: totalSize`. Observing the tall element
// created a feedback loop: its height made the page scroll-container overflow,
// the scrollbar shrank clientWidth, the ResizeObserver fired, state changed,
// the height changed again… Switching sections (different row heights/counts)
// destabilised that into a non-converging loop that crashed the tab. The
// sentinel's height is always 0, so observing it only ever reacts to genuine
// width changes (viewport resize, scrollbar toggle) and settles immediately.
export function VirtualizedCardGrid<T>({
    items,
    renderItem,
    getKey,
    estimatedRowHeight,
    scrollParentRef,
    overscan = 4,
}: VirtualizedCardGridProps<T>) {
    const measureRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState(0);

    useLayoutEffect(() => {
        const el = measureRef.current;
        if (!el) return;
        const update = () => {
            const next = Math.round(el.clientWidth);
            // Bail when the width is unchanged so a scrollbar toggle (or any
            // observer re-fire) can't bounce state back and forth.
            setContainerWidth((prev) => (prev === next ? prev : next));
        };
        update();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const columns = useMemo(
        () => columnsForWidth(containerWidth || (typeof window !== 'undefined' ? window.innerWidth : 1024)),
        [containerWidth]
    );
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

    // Re-measure when geometry changes (column count, row height, item count).
    // `virtualizer` is a stable instance from @tanstack/react-virtual, so it
    // doesn't retrigger this effect on its own.
    useEffect(() => {
        virtualizer.measure();
    }, [columns, rowHeight, rowGap, items.length, virtualizer]);

    const virtualRows = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();

    return (
        <div style={{ position: 'relative', width: '100%' }}>
            {/* Width measurement sentinel — height:0 so it never participates in
                the scroll-height feedback that crashed the tab. */}
            <div ref={measureRef} aria-hidden style={{ width: '100%', height: 0 }} />

            {/* Spacer that reserves the full virtual height; rows are absolutely
                positioned within it. */}
            <div style={{ position: 'relative', width: '100%', height: totalSize > 0 ? totalSize : undefined }}>
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
        </div>
    );
}
