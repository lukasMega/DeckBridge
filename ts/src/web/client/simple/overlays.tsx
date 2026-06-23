// Full-stage overlays: the About popover and the per-step help screen.
import { useEffect } from 'preact/hooks';
import { ICON } from '../ui-icons.js';
import { HELP } from '../ui-help.js';
import { Icon } from './Icon.js';

export function AboutPopover({ onClose }: Readonly<{ onClose: () => void }>): preact.JSX.Element {
  // Close on Escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleScrimClick = (e: MouseEvent): void => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div class="scrim" onClick={handleScrimClick}>
      <div class="popover">
        <button
          class="pop-close"
          aria-label="Close"
          type="button"
          onClick={onClose}
          // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG icon markup
          dangerouslySetInnerHTML={{ __html: ICON.close }}
        />
        <h2>What is DeckBridge?</h2>
        <p>
          <strong>DeckBridge</strong> lets you use a USB Stream Deck with the Elgato Stream Deck app
          over your local network. It runs on your computer and appears to the app as a network
          device, so your keys and button images work over WiFi.
        </p>
        <p>It&apos;s a free, community-built tool for personal and hobby use.</p>
        <p class="fine">
          DeckBridge is not affiliated with, endorsed by, or supported by Elgato / Corsair.
          &ldquo;Stream Deck&rdquo; and &ldquo;Elgato&rdquo; are trademarks of their respective
          owners. DeckBridge is intended for hobby and personal use only —{' '}
          <strong>not for professional use</strong> — and it{' '}
          <strong>does not replace the Elgato Network Dock</strong>. For professional or reliable
          setups, use officially supported Elgato hardware.
        </p>
      </div>
    </div>
  );
}

export function HelpScreen({
  topicId,
  onBack,
}: Readonly<{ topicId: string; onBack: () => void }>): preact.JSX.Element {
  const topic = HELP[topicId];
  // Hook must run unconditionally (before any early return). Unknown topic: fall back.
  useEffect(() => {
    if (!topic) onBack();
  }, [topic, onBack]);
  if (!topic) {
    return <></>;
  }

  let n = 0;
  return (
    <div class="help">
      <button class="help-back" type="button" onClick={onBack}>
        <Icon html={ICON.back} />
        <span>Back</span>
      </button>
      {/* eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG from HELP data */}
      <div class="help-stage" dangerouslySetInnerHTML={{ __html: topic.svg() }} />
      <h1>{topic.title}</h1>
      <p class="help-lead">{topic.lead}</p>
      <p class="help-section-label">What happens — and what you do</p>
      <ol class="help-steps">
        {topic.steps.map((s, i) => {
          if (s.you) n++;
          const numClass = 'num' + (s.you ? ' you' : '');
          const numContent = s.you ? String(n) : ICON.check;
          return (
            // eslint-disable-next-line @eslint-react/no-array-index-key -- steps are positional with no stable id
            <li key={i}>
              <Icon class={numClass} html={numContent} />
              <Icon html={s.html} />
            </li>
          );
        })}
      </ol>
      {topic.docs && (
        <a
          class="manual-add-docs"
          href={topic.docs.href}
          target="_blank"
          rel="noopener"
          style="margin-top:16px"
        >
          <Icon html={ICON.book} />
          <span>{topic.docs.label}</span>
        </a>
      )}
    </div>
  );
}
