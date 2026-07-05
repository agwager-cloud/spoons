import { Client, Room } from "colyseus.js";
import { getDeviceId } from "../utils/device";

export type SpoonsRoom = Room<any>;

type MessageHandler = (payload: any) => void;

class NetService {
  client: Client | null = null;
  room: SpoonsRoom | null = null;
  playerId = "";
  roomCode = "";
  isHost = false;
  lastError = "";
  lastRoomInfo: any = {};
  private handlers = new Map<string, Set<MessageHandler>>();

  private makeRoomCode(): string {
    return String(Math.floor(10000 + Math.random() * 90000));
  }

  getServerUrl(): string {
    const configured = import.meta.env.VITE_SERVER_URL as string | undefined;
    if (configured && configured.trim()) return configured.trim();

    const host = window.location.hostname;
    const isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
    const isPrivateLan =
      host.startsWith("192.168.") ||
      host.startsWith("10.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
      host.endsWith(".local");

    if (isLocalHost || isPrivateLan) {
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      return `${protocol}://${host}:2567`;
    }

    return "";
  }

  private getClient(): Client {
    const serverUrl = this.getServerUrl();
    if (!serverUrl) {
      throw new Error("Missing VITE_SERVER_URL for hosted build. Local testing should use localhost or a private LAN IP.");
    }
    return new Client(serverUrl);
  }

  async createRoom(name: string): Promise<SpoonsRoom> {
    await this.leave();
    this.client = this.getClient();
    const roomCode = this.makeRoomCode();
    const room = await this.client.create("spoons", { name, roomCode, deviceId: getDeviceId() });
    this.attach(room);
    room.send("requestRoomInfo");
    await this.waitForInitialSync(room);
    return room;
  }

  async joinRoom(name: string, roomCode: string): Promise<SpoonsRoom> {
    await this.leave();
    this.client = this.getClient();
    const room = await this.client.join("spoons", { name, roomCode, deviceId: getDeviceId() });
    this.attach(room);
    room.send("requestRoomInfo");
    await this.waitForInitialSync(room);
    return room;
  }

  private attach(room: SpoonsRoom) {
    this.room = room;
    this.playerId = room.sessionId;
    this.roomCode = "";
    this.isHost = false;
    this.lastRoomInfo = {};

    room.onStateChange((state) => {
      if (state?.roomCode) this.roomCode = String(state.roomCode);
      const me = this.getPlayerFromState(state, this.playerId);
      if (me) this.isHost = !!me.isHost;
      this.emit("state", state);
    });

    room.onMessage("roomInfo", (payload) => {
      const receivedAt = Date.now();
      this.lastRoomInfo = { ...(payload ?? {}), _receivedAt: receivedAt };
      this.roomCode = String(payload.roomCode ?? this.roomCode ?? "");
      this.playerId = String(payload.playerId ?? this.playerId ?? room.sessionId);
      this.isHost = !!payload.isHost;
      this.emit("roomInfo", payload);
      this.emit("state", room.state);
    });
    room.onMessage("hand", (payload) => this.emit("hand", payload));
    room.onMessage("toast", (payload) => this.emit("toast", payload));
    room.onMessage("errorMessage", (payload) => this.emit("errorMessage", payload));
    room.onLeave((code) => {
      this.emit("left", { code });
      this.room = null;
    });
  }

  private waitForInitialSync(room: SpoonsRoom): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      let dispose: any;
      const finish = () => {
        if (done) return;
        const state = room.state as any;
        const hasUsefulState = !!state && typeof state.phase !== "undefined";
        const hasInfo = !!this.roomCode || !!state?.roomCode;
        if (!hasUsefulState && !hasInfo) return;
        done = true;
        if (typeof dispose === "function") dispose();
        window.setTimeout(() => resolve(), 80);
      };
      dispose = (room.onStateChange as any)(finish);
      window.setTimeout(() => {
        room.send("requestRoomInfo");
        finish();
      }, 80);
      window.setTimeout(() => {
        if (done) return;
        done = true;
        if (typeof dispose === "function") dispose();
        resolve();
      }, 900);
    });
  }

  private getPlayerFromState(state: any, id: string): any | undefined {
    if (!state || !id) return undefined;
    const infoPlayers = this.lastRoomInfo?.players;
    if (Array.isArray(infoPlayers)) return infoPlayers.find((p) => p?.id === id);
    const playersJson = this.lastRoomInfo?.playersJson ?? state.playersJson;
    if (typeof playersJson === "string" && playersJson.length) {
      try {
        const players = JSON.parse(playersJson);
        if (Array.isArray(players)) return players.find((p) => p?.id === id);
      } catch {
        return undefined;
      }
    }
    const players = state?.players;
    if (!players) return undefined;
    if (typeof players.get === "function") return players.get(id);
    if (players[id]) return players[id];
    return undefined;
  }

  send(type: string, payload: any = {}) {
    this.room?.send(type, payload);
  }

  on(type: string, handler: MessageHandler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  emit(type: string, payload: any) {
    for (const handler of this.handlers.get(type) ?? []) handler(payload);
  }

  async leave() {
    if (this.room) {
      this.room.removeAllListeners();
      await this.room.leave();
    }
    this.room = null;
    this.playerId = "";
    this.roomCode = "";
    this.isHost = false;
    this.lastRoomInfo = {};
  }
}

export const Net = new NetService();
