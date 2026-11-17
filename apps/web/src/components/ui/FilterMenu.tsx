'use client';

import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, X } from 'lucide-react';
import { twMerge } from 'tailwind-merge';
import { useActionDock } from './ToolbarBox';

export interface FilterMenuOption {
  key: string;
  label: string;
  /** small count shown at the right of the row */
  count?: number | string;
  icon?: React.ReactNode;
  /** whether this option is currently applied */
  active: boolean;
  onSelect: () => void;
  /** highlights the row in terracotta (urgent items) */
  urgent?: boolean;
}

/** Phones (below Tailwind's `sm`): menus open as a bottom sheet instead of a dropdown under the button. */
const PHONE_QUERY = '(max-width: 639px)';
const subscribePhone = (cb: () => void) => {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};
const usePhone = () => useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE_QUERY).matches, () => false);

/**
 * One compact button that opens a list of quick filters (alerts, stages, toggles).
 * Replaces long rows of chips: the button itself shows what is active.
 */
export const FilterMenu: React.FC<{
  label: string;
  icon?: React.ReactNode;
  options: FilterMenuOption[];
  /** options flagged as "off / show all" are not counted as an active filter */
  neutralKeys?: string[];
  align?: 'left' | 'right';
  className?: string;
  /** Phones: show only the icon and the active-choice chip (the label stays for screen readers). */
  compactOnPhone?: boolean;
  /** false: this menu's row never hosts the page actions (New, Export…) — for menus inside cards */
  dock?: boolean;
}> = ({ label, icon, options, neutralKeys = ['all'], align = 'left', className, compactOnPhone, dock = true }) => {
  const [open, setOpen] = useState(false);
  const [nudge, setNudge] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const phone = usePhone();
  // Page actions (New, Import…) dock at the end of this filter row — the "View" menu's row first.
  useActionDock(ref, !dock ? 0 : label === 'View' ? 3 : 2);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // the phone sheet is portalled to <body>, outside `ref`
      if (ref.current && !ref.current.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); // closes only this menu, not an enclosing Modal
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // On a phone the filter row wraps, so a menu can sit at either edge of the screen: slide its panel
  // sideways until it is fully on-screen (8px gutter). `translate` leaves the open animation's transform alone.
  useLayoutEffect(() => {
    if (!open || phone) {
      setNudge(0);
      return;
    }
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const gutter = 8;
    setNudge(r.left < gutter ? gutter - r.left : r.right > vw - gutter ? vw - gutter - r.right : 0);
  }, [open, phone]);

  const applied = options.filter((o) => o.active && !neutralKeys.includes(o.key));
  const urgentTotal = options.reduce((n, o) => (o.urgent && Number(o.count) > 0 ? n + 1 : n), 0);

  const rows = options.map((o) => (
    <button
      key={o.key}
      type="button"
      role="option"
      aria-selected={o.active}
      onClick={() => {
        o.onSelect();
        setOpen(false);
      }}
      className={twMerge('filter-menu-row', o.active && 'filter-menu-row--on', o.urgent && Number(o.count) > 0 && 'filter-menu-row--urgent')}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {o.active ? <Check className="h-3.5 w-3.5" /> : o.icon ? <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{o.icon}</span> : null}
      </span>
      <span className="flex-1 truncate text-left">{o.label}</span>
      {o.count !== undefined && <span className="font-mono text-[11px] font-bold">{o.count}</span>}
    </button>
  ));

  return (
    <div ref={ref} className={twMerge('filter-menu relative inline-block', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={twMerge('filter-menu-btn', (open || applied.length > 0) && 'filter-menu-btn--on')}
      >
        {icon && <span className="shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>}
        <span className={compactOnPhone ? 'max-sm:sr-only' : undefined}>{label}</span>
        {applied.length === 1 ? (
          <span className="filter-menu-chip max-w-[130px] truncate">{applied[0].label}</span>
        ) : applied.length > 1 ? (
          <span className="filter-menu-chip">{applied.length}</span>
        ) : urgentTotal > 0 ? (
          <span className="filter-menu-chip filter-menu-chip--urgent">{urgentTotal}</span>
        ) : null}
        <ChevronDown className={twMerge('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {open && !phone && (
        <div
          ref={panelRef}
          role="listbox"
          aria-label={label}
          className={twMerge('filter-menu-panel max-w-[min(320px,calc(100vw-16px))]', align === 'right' ? 'right-0' : 'left-0')}
          style={nudge ? { translate: `${nudge}px 0` } : undefined}
        >
          {rows}
        </div>
      )}
      {open &&
        phone &&
        createPortal(
          <div className="filter-sheet">
            <div className="filter-sheet__backdrop" onClick={() => setOpen(false)} aria-hidden />
            <div ref={panelRef} role="listbox" aria-label={label} className="filter-sheet__panel">
              <div className="filter-sheet__head">
                <span className="filter-sheet__title">{label}</span>
                <button type="button" onClick={() => setOpen(false)} aria-label={`Close ${label}`} className="filter-sheet__close">
                  <X className="h-4 w-4" />
                </button>
              </div>
              {rows}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
};
