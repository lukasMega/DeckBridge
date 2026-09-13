import { useState, type ReactNode } from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import { useAnimationsDisabled } from '../../useAnimationsDisabled';
import { DEVICES } from './content';
import home from '../index.module.css';
import styles from './Devices.module.css';

const tested = DEVICES.filter((device) => device.tested);
const untested = DEVICES.filter((device) => !device.tested);
const rows = [
  tested,
  untested.slice(0, Math.ceil(untested.length / 2)),
  untested.slice(Math.ceil(untested.length / 2)),
];

function Badge({ tested }: { tested: boolean }): ReactNode {
  return (
    <span className={`${home.chipBadge} ${tested ? home.chipBadgeOk : home.chipBadgeMuted}`}>
      {tested ? '✓ tested' : 'untested'}
    </span>
  );
}

export function Devices(): ReactNode {
  const [listView, setListView] = useState(false);
  const motionDisabled = useAnimationsDisabled();
  const showList = listView || motionDisabled;
  // From static/, not a bundler import: that would inline all 16 as base64, defeating
  // both caching and `loading="lazy"`.
  const imgBase = useBaseUrl('/img/devices/');

  return (
    <div className={styles.hardware}>
      <div className={styles.viewSwitch} role="group" aria-label="Device view">
        <button
          type="button"
          aria-pressed={!showList}
          disabled={motionDisabled}
          onClick={() => setListView(false)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 3h12M2 8h12M2 13h12M10 1l3 2-3 2M6 6 3 8l3 2M10 11l3 2-3 2" />
          </svg>
          Scrolling view
        </button>
        <button type="button" aria-pressed={showList} onClick={() => setListView(true)}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 3h8M6 8h8M6 13h8M2 3h.5M2 8h.5M2 13h.5" />
          </svg>
          List view
        </button>
      </div>
      {showList ? (
        <div className={home.devices} aria-label="Supported devices">
          {DEVICES.map((device) => (
            <span className={home.chip} key={device.id}>
              {device.name} <Badge tested={device.tested} />
            </span>
          ))}
        </div>
      ) : (
        <div className={styles.rows}>
          {rows.map((devices, row) => (
            <div className={styles.row} key={row}>
              <p className={styles.rowLabel}>
                {row === 0
                  ? 'Hardware tested'
                  : row === 1
                    ? 'Also supported · untested'
                    : 'More supported · untested'}
              </p>
              <div className={styles.viewport}>
                <div
                  className={styles.track}
                  style={{ animationDuration: `${devices.length * 16}s` }}
                >
                  {[false, true].map((duplicate) => (
                    <div
                      className={styles.group}
                      aria-hidden={duplicate || undefined}
                      key={String(duplicate)}
                    >
                      {devices.map((device) => (
                        <div className={styles.card} key={device.id}>
                          <img
                            src={`${imgBase}${device.id}.svg`}
                            alt=""
                            width="102"
                            height="80"
                            loading="lazy"
                          />
                          <div className={styles.caption}>
                            <span className={styles.deviceName}>{device.name}</span>
                            <Badge tested={device.tested} />
                            {device.id === 'mirabox-k1pro' && (
                              <span className={styles.moduleNote}>Deck module shown</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className={styles.hint}>
        {showList ? 'Static list · no motion' : 'Hover to pause · switch to list view anytime'}
      </p>
    </div>
  );
}
