import type { DocsTopic } from '../../contract.js';
import { ICON, Icon } from './Icon.js';

interface Props {
  topic: DocsTopic;
  label?: string;
  block?: boolean;
}

// Plain href, no onClick: middle-click, Cmd-click and the keyboard all reach the
// /go/docs redirect, which is where the open is counted. `noopener` without
// `noreferrer` keeps the Referer the route falls back on.
export function DocsLink({ topic, label = 'Docs', block }: Readonly<Props>) {
  const href = `/go/docs/${topic}`;
  const aria = `${label} (opens documentation in a new tab)`;
  if (block) {
    return (
      <a class="manual-add-docs" href={href} target="_blank" rel="noopener" aria-label={aria}>
        <Icon html={ICON.book} />
        <span>{label}</span>
      </a>
    );
  }
  return (
    <a class="docs-link" href={href} target="_blank" rel="noopener" aria-label={aria}>
      {label}
    </a>
  );
}
