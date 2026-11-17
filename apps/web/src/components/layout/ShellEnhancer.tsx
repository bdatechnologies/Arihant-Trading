'use client';

import { useEffect } from 'react';
import { NativeSelectMenu } from './NativeSelectMenu';

/**
 * Behaviour shared by every theme:
 *  - themed listbox for native <select>s (NativeSelectMenu)
 *  - labels every table cell with its column header so narrow screens can stack rows into cards
 */
export function ShellEnhancer() {
  useEffect(() => {
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /** One label per column, resolving colSpan / rowSpan across every header row ("Leads · New"). */
    const columnLabels = (thead: HTMLTableSectionElement | null) => {
      const grid: string[][] = [];
      Array.from(thead?.rows ?? []).forEach((row, r) => {
        grid[r] ??= [];
        let c = 0;
        for (const cell of Array.from(row.cells)) {
          while (grid[r][c] !== undefined) c++;
          const text = (cell.textContent || '').trim();
          for (let dr = 0; dr < Math.max(cell.rowSpan, 1); dr++)
            for (let dc = 0; dc < Math.max(cell.colSpan, 1); dc++) (grid[r + dr] ??= [])[c + dc] = text;
          c += Math.max(cell.colSpan, 1);
        }
      });
      const width = Math.max(0, ...grid.map((g) => g.length));
      return Array.from({ length: width }, (_, i) =>
        [...new Set(grid.map((g) => g[i]).filter(Boolean))].join(' · '),
      );
    };

    /** Most cells after the first column are figures: counts, ₹ amounts, percentages or a dash. */
    const isFigureMatrix = (rows: HTMLTableRowElement[]) => {
      let cells = 0;
      let figures = 0;
      for (const r of rows)
        for (const c of Array.from(r.cells).slice(1)) {
          const t = (c.textContent || '').trim();
          if (!t) continue;
          cells++;
          if (/^[-–—+₹\s\d.,%()·:/]*(lakh|cr|k|l)?[\s\d.,%()·:/-]*$/i.test(t)) figures++;
        }
      return cells >= 4 && figures / cells >= 0.7;
    };

    const FOLD_SHOWN = 4;
    const labelTables = () => {
      document.querySelectorAll<HTMLTableElement>('table').forEach((table) => {
        const heads = columnLabels(table.tHead);
        if (heads.length <= 2) return;
        const rows = Array.from(table.tBodies).flatMap((b) => Array.from(b.rows)).filter((r) => r.cells.length > 1); // single spanning cell = empty / message row
        // Report breakdowns (zone / person × figures) stay a real table — swiped sideways with the name column pinned —
        // because numbers are compared down a column; stacked into cards they become 18-field blocks per row.
        if (location.pathname.startsWith('/reports/') && isFigureMatrix(rows)) {
          delete table.dataset.stackable;
          table.dataset.matrix = '1';
          return;
        }
        for (const r of rows) Array.from(r.cells).forEach((c, i) => { if (heads[i] && c.dataset.label !== heads[i]) c.dataset.label = heads[i]; });
        table.dataset.stackable = '1';
        // A first column with no text in any row (an expand / select control) is tucked into the card's corner.
        const leadEmpty = rows.length > 0 && rows.every((r) => !(r.cells[0]?.textContent || '').trim());
        if (leadEmpty) table.dataset.leadEmpty = '1';
        else delete table.dataset.leadEmpty;
        // Phones: a card shows its first four fields (plus its action buttons); "+N more · tap" reveals the rest.
        for (const r of rows) {
          const cells = Array.from(r.cells);
          const actions = cells.length > 1 && cells[cells.length - 1].querySelector('button, a') ? 1 : 0;
          const hidden = cells.length - FOLD_SHOWN - actions - (leadEmpty ? 1 : 0);
          if (hidden > 1) {
            if (r.dataset.more !== String(hidden)) r.dataset.more = String(hidden);
            if (!r.hasAttribute('tabindex')) r.tabIndex = 0;
          } else if (r.dataset.more) delete r.dataset.more;
        }
      });
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      timer = setTimeout(() => (raf = requestAnimationFrame(labelTables)), 80);
    };

    labelTables();
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, []);
  return <NativeSelectMenu />;
}
