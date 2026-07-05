import { Schema, type } from "@colyseus/schema";

export interface PlayerData {
  id: string;
  deviceId: string;
  name: string;
  isHost: boolean;
  isBot: boolean;
  connected: boolean;
  eliminated: boolean;
  spectator: boolean;
  hasSpoon: boolean;
  firstSpoon: boolean;
  playedThisGame: boolean;
  score: number;
}

export function createPlayer(partial: Partial<PlayerData> = {}): PlayerData {
  return {
    id: "",
    deviceId: "",
    name: "Player",
    isHost: false,
    isBot: false,
    connected: true,
    eliminated: false,
    spectator: false,
    hasSpoon: false,
    firstSpoon: false,
    playedThisGame: false,
    score: 0,
    ...partial
  };
}

export class SpoonsState extends Schema {
  @type("string") roomCode = "";
  @type("string") phase = "lobby";

  // JSON strings are used here deliberately. This starter project is designed to be
  // robust with the Colyseus/Schema versions installed by a local npm install.
  // The previous MapSchema<ArraySchema> version could crash during initial state
  // encoding on some installs. Primitive schema fields avoid that serialization issue.
  @type("string") playersJson = "[]";
  @type("string") activeOrderJson = "[]";
  @type("string") awardEligibleIdsJson = "[]";
  @type("string") takenSpoonsJson = "[]";

  @type("number") spoonsAvailable = 0;
  @type("number") spoonsTaken = 0;
  @type("boolean") scrambleActive = false;
  @type("number") nextPulseAt = 0;
  @type("number") activeCount = 0;
  @type("number") eliminatedCount = 0;
  @type("number") revision = 0;
  @type("string") firstSpoonId = "";
  @type("string") loserId = "";
  @type("string") championId = "";
  @type("string") dealerId = "";
  @type("string") roundMessage = "";
  @type("number") roundStartsAt = 0;
}
