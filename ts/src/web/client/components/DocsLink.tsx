import type { DocsTopic } from '../../contract.js';
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ICON, Icon } from './Icon.js';

interface Props {
  topic: DocsTopic;
  label?: string;
  block?: boolean;
}

function DocsDialog({
  href,
  label,
  onClose,
}: Readonly<{ href: string; label: string; onClose: () => void }>) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const title = label === 'Docs' ? 'Documentation' : label;
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={ref}
      class="docs-modal floating-surface"
      aria-labelledby={titleId}
      onClose={(event) => {
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => {
        // Escape belongs to this dialog, not an underlying help/about overlay.
        if (event.key === 'Escape') event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
      }}
    >
      <header class="docs-modal-header">
        <h2 id={titleId}>{title}</h2>
        <a class="docs-link" href={href} target="_blank" rel="noopener">
          Open in new tab
        </a>
        <button
          type="button"
          class="docs-modal-close circle"
          aria-label="Close documentation"
          onClick={onClose}
        >
          <Icon html={ICON.close} />
        </button>
      </header>
      <iframe src={href} title={title} />
    </dialog>
  );
}

// Keep the plain href for middle-click, Cmd-click and keyboard navigation.
// Both entry points use the same tracked /go/docs redirect.
export function DocsLink({ topic, label = 'Docs', block }: Readonly<Props>) {
  const [open, setOpen] = useState(false);
  const href = `/go/docs/${topic}`;
  return (
    <>
      <span class={`docs-link-group${block ? ' docs-link-block' : ''}`}>
        <a
          class={block ? 'manual-add-docs' : 'docs-link'}
          href={href}
          target="_blank"
          rel="noopener"
          aria-label={`${label} (opens documentation in a new tab)`}
        >
          {block ? (
            <>
              <Icon html={ICON.book} />
              <span>{label}</span>
            </>
          ) : (
            label
          )}
        </a>
        <button
          class="docs-modal-open"
          type="button"
          title={`Open ${label} in modal`}
          aria-label={`Open ${label} in documentation dialog`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <Icon html={ICON.window} />
        </button>
      </span>
      {open && <DocsDialog href={href} label={label} onClose={() => setOpen(false)} />}
    </>
  );
}
