'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { twMerge } from 'tailwind-merge';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const ACTIVE = '[aria-selected="true"], [aria-checked="true"], [aria-current="page"], [data-active="true"]';

export interface ScrollStripProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  children: React.ReactNode;
  /** Classes for the outer box (borders, background, margins). `className` styles the sliding row. */
  wrapperClassName?: string;
  /** Change this when the selection changes to slide the active item (aria-selected…) into view. */
  activeKey?: unknown;
}

/**
 * Sideways slider for tab strips and chip rows that do not fit, e.g. an 11-tab dossier on a phone.
 * Swipe, trackpad or shift-scroll it. While it overflows both arrow buttons stay in place (room is kept for them, so
 * they never cover a tab); the one at an end dims instead of disappearing, and the edge with more content fades.
 * The selected item is kept in view.
 *
 * overflowX is inline so the track always scrolls, whatever class a caller passes (theme.css only resets
 * `.overflow-x-auto` around stacked tables). Callers must not force `min-w-max` on it: the track would grow to fit
 * every tab and never scroll.
 */
export const ScrollStrip: React.FC<ScrollStripProps> = ({ children, className, wrapperClassName, activeKey, style, ...rest }) => {
  const track = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false, overflow: false });
  const shownActive = useRef(false);
  const measureRef = useRef<() => void>(() => {});

  /** Slides the selected tab / chip into view (only this row moves, never the page or dialog). */
  const keepActiveInView = useCallback((smooth: boolean) => {
    const el = track.current;
    const on = el?.querySelector<HTMLElement>(ACTIVE);
    if (!el || !on) return;
    const pad = 36; // clear of the arrow button
    const start = on.offsetLeft;
    const end = start + on.offsetWidth;
    let target: number | null = null;
    if (start < el.scrollLeft + pad) target = Math.max(0, start - pad);
    else if (end > el.scrollLeft + el.clientWidth - pad) target = end - el.clientWidth + pad;
    if (target === null) return;
    el.scrollTo({ left: target, behavior: smooth ? 'smooth' : 'auto' });
    // A smooth scroll can be dropped (a re-render while the next page loads, a background tab): make sure it landed,
    // then refresh the arrows directly rather than waiting for a scroll event that may not come.
    const want = target;
    window.setTimeout(
      () => {
        if (track.current !== el) return;
        if (smooth && Math.abs(el.scrollLeft - Math.min(want, el.scrollWidth - el.clientWidth)) > 4) el.scrollTo({ left: want });
        measureRef.current();
      },
      smooth ? 450 : 0,
    );
  }, []);

  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    // A strip often reaches its real width after mount (fonts, a page's enter animation): the first time it actually
    // overflows, put the selected item on screen — e.g. "Productivity" in the report tabs on a phone.
    if (!shownActive.current && el.scrollWidth > el.clientWidth + 2) {
      shownActive.current = true;
      keepActiveInView(false);
    }
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    const overflow = el.scrollWidth > el.clientWidth + 2;
    setEdge((e) => (e.left === left && e.right === right && e.overflow === overflow ? e : { left, right, overflow }));
  }, [keepActiveInView]);
  measureRef.current = measure;

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    Array.from(el.children).forEach((c) => ro?.observe(c));
    el.addEventListener('scroll', measure, { passive: true });
    return () => {
      ro?.disconnect();
      el.removeEventListener('scroll', measure);
    };
  }, [measure, children]);

  // Keep the selected tab/chip visible when the selection changes.
  useIsoLayoutEffect(() => keepActiveInView(true), [activeKey, keepActiveInView]);

  const slide = (dir: -1 | 1) => {
    const el = track.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.7), behavior: 'smooth' });
    window.setTimeout(() => measureRef.current(), 450);
  };

  const fade = 28;
  // 'none' (not undefined) so a theme fade on tab rows does not dim a strip that already fits.
  const mask =
    edge.left || edge.right
      ? `linear-gradient(to right, ${edge.left ? `transparent 0, #000 ${fade}px` : '#000 0'}, ${edge.right ? `#000 calc(100% - ${fade}px), transparent 100%` : '#000 100%'})`
      : 'none';

  const arrow = (dir: -1 | 1) => {
    const more = dir < 0 ? edge.left : edge.right;
    return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={dir < 0 ? 'Scroll left' : 'Scroll right'}
      aria-disabled={!more}
      onClick={() => more && slide(dir)}
      className={twMerge(
        'absolute top-1/2 z-[2] inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-[#DCD8CE] bg-white text-[#14213D] shadow-sm transition-opacity hover:border-[#0F5E63] hover:text-[#0F5E63]',
        dir < 0 ? 'left-0' : 'right-0',
        !more && 'cursor-default opacity-35 hover:border-[#DCD8CE] hover:text-[#14213D]',
      )}
    >
      {dir < 0 ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
    </button>
    );
  };

  return (
    <div className={twMerge('relative min-w-0', wrapperClassName)}>
      <div
        ref={track}
        className={twMerge('relative flex min-w-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)}
        style={{
          overflowX: 'auto',
          overflowY: 'hidden',
          overscrollBehaviorX: 'contain',
          minWidth: 0,
          // room for the two arrow buttons while they show, so neither sits on top of a tab
          ...(edge.overflow ? { paddingInline: 34, scrollPaddingInline: 34 } : null),
          WebkitMaskImage: mask,
          maskImage: mask,
          ...style,
        }}
        {...rest}
      >
        {children}
      </div>
      {edge.overflow && arrow(-1)}
      {edge.overflow && arrow(1)}
    </div>
  );
};
