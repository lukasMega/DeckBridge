// Deck-picker DTOs (multi-deck Settings block), split from contract.ts to keep it under the line cap.

/** One physical deck seen by the USB scan (GET /api/detected-decks). */
export interface DetectedDeck {
  key: string; // stable device key (device-identity.ts): what activeDecks stores
  name: string; // model name
  serial?: string;
  active: boolean; // a dock is running it right now
}

/** The deck picker's data: what the scan sees, what the user chose, and how many may run. */
export interface DetectedDecksView {
  decks: DetectedDeck[];
  selected: string[]; // persisted choice; empty = the first decks found run
  max: number; // active cap
}
