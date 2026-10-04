// Who holds the USB deck: solid link = holds it now, dashed link = takes over after the
// quit. Line style (not only colour) carries the state; the text sits in the label.
const LABEL =
  'Now the Elgato app holds the USB deck. After you quit it, DeckBridge holds the deck.';

function Row({
  y,
  owner,
  caption,
  solid,
}: Readonly<{ y: number; owner: string; caption: string; solid: boolean }>): preact.JSX.Element {
  return (
    <g>
      <text class="own-cap" x="0" y={y - 12}>
        {caption}
      </text>
      <rect class="own-node" x="0" y={y - 8} width="96" height="26" rx="7" />
      <text class="own-label" x="48" y={y + 9} text-anchor="middle">
        {owner}
      </text>
      <line
        class={solid ? 'own-link' : 'own-link own-new'}
        x1="100"
        y1={y + 5}
        x2="180"
        y2={y + 5}
        stroke-dasharray={solid ? undefined : '5 4'}
      />
      <rect class="own-node" x="184" y={y - 8} width="96" height="26" rx="7" />
      <text class="own-label" x="232" y={y + 9} text-anchor="middle">
        USB deck
      </text>
    </g>
  );
}

export function OwnershipDiagram(): preact.JSX.Element {
  return (
    <svg class="own-diagram" viewBox="0 0 280 102" role="img" aria-label={LABEL}>
      <Row y={20} owner="Elgato app" caption="Now" solid />
      <Row y={74} owner="DeckBridge" caption="After quit" solid={false} />
    </svg>
  );
}
