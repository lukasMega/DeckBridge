import { useMemo, useState, type ReactNode } from 'react';
import Link from '@docusaurus/Link';

import styles from '../DeviceTable/styles.module.css';

interface DeviceRow {
  id: string;
  name: string;
  testedLabel: string;
  cells: {
    identity: Record<string, string>;
  };
}

interface DeviceData {
  models: DeviceRow[];
}

export default function DeviceSummaryTable({ data }: Readonly<{ data: unknown }>): ReactNode {
  const { models } = data as DeviceData;
  const [query, setQuery] = useState('');
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((model) =>
      [model.name, model.testedLabel, ...Object.values(model.cells.identity)].some((value) =>
        value.toLowerCase().includes(needle),
      ),
    );
  }, [models, query]);

  return (
    <div className={styles.wrap}>
      <div className={styles.controls}>
        <input
          type="search"
          className={styles.search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter devices…"
          aria-label="Filter devices"
        />
        <span className={styles.count} aria-live="polite">
          showing {rows.length} of {models.length}
        </span>
      </div>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.stickyCol}>
                Device
              </th>
              <th scope="col">Vendor</th>
              <th scope="col">Keys</th>
              <th scope="col">Grid</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((model) => (
              <tr key={model.id}>
                <th scope="row" className={styles.stickyCol}>
                  <Link to={`/devices#${model.id}`}>{model.name}</Link>
                </th>
                <td>{model.cells.identity.vendor}</td>
                <td>{model.cells.identity.keyCount}</td>
                <td>
                  {model.cells.identity.columns}×{model.cells.identity.rows}
                </td>
                <td>{model.testedLabel}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className={styles.empty}>
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
