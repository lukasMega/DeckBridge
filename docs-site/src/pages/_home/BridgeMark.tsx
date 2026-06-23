import type { ReactNode } from 'react';

export function BridgeMark(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="9" width="6" height="6" rx="1.5" fill="currentColor" />
      <rect x="16" y="9" width="6" height="6" rx="1.5" fill="currentColor" />
      <path d="M8 12h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
