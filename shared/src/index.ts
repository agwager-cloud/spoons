export type RoomPhase = "lobby" | "playing" | "results";

export interface PublicPlayer {
  id: string;
  name: string;
  isHost: boolean;
  isBot: boolean;
  connected: boolean;
  eliminated: boolean;
  spectator: boolean;
  hasSpoon: boolean;
  firstSpoon: boolean;
  score: number;
}

export interface CardView {
  id: string;
  rank: string;
  suit: string;
  short: string;
}

export const GAME = {
  width: 1280,
  height: 720,
  maxPlayers: 40,
  pulseMs: 1200,
  roomCodeLength: 5
} as const;
