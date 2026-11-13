import { useMemo, useState, type ReactNode } from 'react';

import styles from './styles.module.css';

// Shape of docs-site/src/data/devices.generated.json (ts/scripts/gen-device-docs.mjs).
// The `data` prop is `unknown` and cast once here on purpose: typing it as DeviceData
// would make tsc structurally check a 16-row x ~40-field JSON literal on every
// `npm run typecheck`.

export interface DeviceColumn {
  key: string;
  label: string;
  numeric?: boolean;
  /** Always shown; not offered in the show/hide chips. */
  sticky?: boolean;
  /** Plain-text `title` tooltip for the header cell and the chip — labels are abbreviated. */
  description?: string;
  defaultVisible: boolean;
}

interface TableSpec {
  columns: DeviceColumn[];
  /** What a `—` means in this table. Rendered as the <caption>. */
  legend: string;
}

interface DeviceRow {
  id: string;
  name: string;
  tested: boolean;
  cells: Record<string, Record<string, string>>;
}

interface DeviceData {
  tables: Record<string, TableSpec>;
  models: DeviceRow[];
}

type SortDir = 'asc' | 'desc';

interface Props {
  table: 'identity' | 'image' | 'wire';
  data: unknown;
}

/** Above this many distinct values a per-column dropdown stops being useful. */
const MAX_FILTER_VALUES = 6;

/** Numeric columns sort numerically: "112" < "1024", and "no cap" / "—" sort last. */
function numericValue(raw: string): number {
  const n = Number.parseFloat(raw.replace(/[^\d.-]/g, ''));
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
}

export default function DeviceTable({ table, data }: Props): ReactNode {
  const { tables, models } = data as DeviceData;
  const spec = tables[table];
  const columns = spec.columns;

  // Initial state must reproduce the SSR output exactly (empty query, no sort,
  // default-visible columns) or hydration mismatches and rows flash out of existence.
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [hidden, setHidden] = useState<ReadonlySet<string>>(
    () => new Set(columns.filter((c) => !c.defaultVisible).map((c) => c.key)),
  );
  const [filters, setFilters] = useState<Readonly<Record<string, string>>>({});

  const shown = columns.filter((c) => !hidden.has(c.key));

  /** Distinct values per column, for the dropdowns. Independent of the current filter. */
  const choices = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const col of columns) {
      if (col.sticky) continue;
      const values = [...new Set(models.map((m) => m.cells[table][col.key] ?? ''))].sort();
      if (values.length > 1 && values.length <= MAX_FILTER_VALUES) out[col.key] = values;
    }
    return out;
  }, [columns, models, table]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const active = Object.entries(filters).filter(([, v]) => v !== '');

    let out = models.filter((m) => {
      const cells = m.cells[table];
      if (active.some(([key, value]) => cells[key] !== value)) return false;
      if (!needle) return true;
      return [m.id, m.name, ...Object.values(cells)].some((v) => v.toLowerCase().includes(needle));
    });

    if (sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      const sign = sortDir === 'asc' ? 1 : -1;
      out = [...out].sort((a, b) => {
        const x = a.cells[table][sortKey] ?? '';
        const y = b.cells[table][sortKey] ?? '';
        const cmp = col?.numeric ? numericValue(x) - numericValue(y) : x.localeCompare(y);
        return cmp * sign;
      });
    }
    return out;
  }, [columns, filters, models, query, sortDir, sortKey, table]);

  /** Click cycles asc -> desc -> off (off = registry order, the default). */
  function toggleSort(key: string): void {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir('asc');
    } else if (sortDir === 'asc') {
      setSortDir('desc');
    } else {
      setSortKey(null);
    }
  }

  function toggleColumn(key: string): void {
    setHidden((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  const hasFilters = query !== '' || Object.values(filters).some((v) => v !== '');

  return (
    <div className={styles.wrap}>
      <div className={styles.controls}>
        {/* The input is labelled "Filter devices", NOT "Search": test-content.mts proves
            the Docusaurus search box still renders by matching aria-label="Search on
            every route, and a second match would let a real regression through. */}
        <input
          type="search"
          className={styles.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter devices…"
          aria-label="Filter devices"
        />
        <span className={styles.count} aria-live="polite">
          showing {rows.length} of {models.length}
        </span>
        {hasFilters && (
          <button
            type="button"
            className={styles.reset}
            onClick={() => {
              setQuery('');
              setFilters({});
            }}
          >
            Reset
          </button>
        )}
      </div>

      <fieldset className={styles.chips}>
        <legend className={styles.chipsLegend}>Columns</legend>
        {columns
          .filter((c) => !c.sticky)
          .map((col) => (
            <label
              key={col.key}
              className={`${styles.chip} ${hidden.has(col.key) ? '' : styles.chipOn}`}
              title={col.description}
            >
              <input
                type="checkbox"
                checked={!hidden.has(col.key)}
                onChange={() => toggleColumn(col.key)}
              />
              {col.label}
            </label>
          ))}
      </fieldset>

      <div className={styles.scroll}>
        <table className={styles.table}>
          <caption className={styles.caption}>{spec.legend}</caption>
          <thead>
            <tr>
              {shown.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  className={col.sticky ? styles.stickyCol : undefined}
                  title={col.description}
                  aria-sort={
                    sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
                  }
                >
                  <button
                    type="button"
                    className={styles.sortBtn}
                    onClick={() => toggleSort(col.key)}
                  >
                    {/* Dotted underline is the only hint that the header carries a tooltip;
                        it hugs the label so the sort arrow stays clean. */}
                    <span className={col.description ? styles.described : undefined}>
                      {col.label}
                    </span>
                    <span aria-hidden="true" className={styles.arrow}>
                      {sortKey === col.key ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
                    </span>
                  </button>
                  {choices[col.key] && (
                    <select
                      className={styles.select}
                      aria-label={`Filter by ${col.label}`}
                      value={filters[col.key] ?? ''}
                      onChange={(e) =>
                        setFilters((prev) => ({ ...prev, [col.key]: e.target.value }))
                      }
                    >
                      <option value="">all</option>
                      {choices[col.key].map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                {shown.map((col) =>
                  col.sticky ? (
                    <th key={col.key} scope="row" className={styles.stickyCol}>
                      {m.cells[table][col.key]}
                    </th>
                  ) : (
                    <td key={col.key}>{m.cells[table][col.key]}</td>
                  ),
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={shown.length} className={styles.empty}>
                  No device matches that filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
