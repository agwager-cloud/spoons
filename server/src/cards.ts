export interface Card {
  id: string;
  rank: string;
  suit: string;
  short: string;
}

const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const suits = ["♠", "♥", "♦", "♣"];

export function makeDecks(activePlayers: number): Card[] {
  const deckCount = Math.max(1, Math.ceil(activePlayers / 13), Math.ceil((activePlayers * 4 + 20) / 52));
  const cards: Card[] = [];
  for (let d = 1; d <= deckCount; d++) {
    for (const rank of ranks) {
      for (const suit of suits) {
        cards.push({ id: `${d}-${rank}-${suit}-${cryptoRandom()}`, rank, suit, short: `${rank}${suit}` });
      }
    }
  }
  return shuffle(cards);
}

export function shuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function hasFourOfKind(cards: Card[]): boolean {
  const counts = new Map<string, number>();
  for (const card of cards) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  return Array.from(counts.values()).some((count) => count >= 4);
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2, 8);
}
