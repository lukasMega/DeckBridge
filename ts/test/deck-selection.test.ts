import assert from 'tjs:assert';
import { deckAllowed } from '../src/main/deck-selection.js';
import type { DetectedUnit } from '../src/main/deck-selection.js';
import { test, summaryExit } from './helpers/harness.js';

const unit = (key: string): DetectedUnit => ({ key, name: 'Deck', serial: null, hidPath: key });
const seen = [unit('a'), unit('b'), unit('c')];

test('no saved choice allows every deck', () => {
  assert.ok(deckAllowed('c', [], seen));
});

test('a saved choice allows only the chosen decks', () => {
  assert.ok(deckAllowed('a', ['a', 'b'], seen));
  assert.equal(deckAllowed('c', ['a', 'b'], seen), false);
});

test('a choice matching nothing detected falls back to allowing all', () => {
  assert.ok(deckAllowed('c', ['gone'], seen));
});

test('one still-detected chosen deck is enough to apply the choice', () => {
  assert.equal(deckAllowed('b', ['a', 'gone'], seen), false);
});

summaryExit();
