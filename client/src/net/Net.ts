import { Client, Room } from "colyseus.js";
import { getDeviceId } from "../utils/device";

export type SpoonsRoom = Room<any>;
export type ConnectionProgress = (message: string, elapsedSeconds: number) => void;

type MessageHandler = (payload: any) => void;

const CONNECT_WINDOW_MS = 100_000;
const MATCHMAKING_ATTEMPT_MS = 45_000;
const STATUS_REQUEST_MS = 6_000;
const INITIAL_SYNC_MS = 20_000;

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

    return "wss://spoons-67eu.onrender.com";
  }

  getHttpServerUrl(): string {
    return this.getServerUrl().replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  }

  private getClient(): Client {
    const serverUrl = this.getServerUrl();
    if (!serverUrl) {
      throw new Error("Missing VITE_SERVER_URL for hosted build. Local testing should use localhost or a private LAN IP.");
    }
    return new Client(serverUrl);
  }

  async createRoom(name: string, onProgress?: ConnectionProgress): Promise<SpoonsRoom> {
    await this.leave();
    const roomCode = this.makeRoomCode();
    const room = await this.connectWithRenderWake(
      "Creating the classroom room",
      async () => {
        this.client = this.getClient();
        return this.client.create("spoons", { name, roomCode, deviceId: getDeviceId() });
      },
      onProgress
    );
    this.attach(room);
    room.send("requestRoomInfo");
    await this.waitForInitialSync(room);
    return room;
  }

  async joinRoom(name: string, roomCode: string, onProgress?: ConnectionProgress): Promise<SpoonsRoom> {
    await this.leave();
    const room = await this.connectWithRenderWake(
      "Joining the classroom room",
      async () => {
        this.client = this.getClient();
        return this.client.join("spoons", { name, roomCode, deviceId: getDeviceId() });
      },
      onProgress,
      true
    );
    this.attach(room);
    room.send("requestRoomInfo");
    await this.waitForInitialSync(room);
    return room;
  }

  private async connectWithRenderWake(
    actionLabel: string,
    action: () => Promise<SpoonsRoom>,
    onProgress?: ConnectionProgress,
    joining = false
  ): Promise<SpoonsRoom> {
    const startedAt = Date.now();
    const deadline = startedAt + CONNECT_WINDOW_MS;
    // Reserve at least 30 seconds for Colyseus matchmaking after the wake checks.
    const wakeDeadline = Math.min(deadline - 30_000, startedAt + 70_000);
    let statusAttempt = 0;
    let serverReachable = false;
    let consecutiveFastFailures = 0;

    while (Date.now() < wakeDeadline && !serverReachable) {
      statusAttempt += 1;
      const checkStartedAt = Date.now();
      serverReachable = await this.wakeServer(startedAt, onProgress, statusAttempt);
      if (serverReachable) break;

      const checkDuration = Date.now() - checkStartedAt;
      consecutiveFastFailures = checkDuration < 800 ? consecutiveFastFailures + 1 : 0;

      // Two immediate failures usually mean a normal-profile extension is blocking
      // background fetches. Do not make the teacher wait 70 seconds before trying
      // the real secure WebSocket, which may still be allowed.
      if (consecutiveFastFailures >= 2 && Date.now() - startedAt >= 4_000) break;

      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      onProgress?.(
        elapsed < 60
          ? "The free server is still waking. This is normal—Spoons is checking again automatically."
          : "The server is taking longer than usual, but Spoons is still checking it automatically.",
        elapsed
      );
      await this.delay(Math.min(2500, Math.max(250, wakeDeadline - Date.now())));
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("Spoons could not reach the classroom server within 100 seconds.");
    }

    onProgress?.(`${actionLabel}… please keep this window open.`, Math.floor((Date.now() - startedAt) / 1000));
    try {
      // The room request is made once only. This avoids accidentally creating two
      // host rooms if a sleeping server responds just after a client-side timeout.
      return await this.withTimeout(
        action(),
        Math.max(10_000, remaining),
        "The multiplayer connection did not finish within the 100-second classroom connection window."
      );
    } catch (err) {
      const message = this.errorText(err).toLowerCase();
      if (joining && serverReachable && this.isRoomNotFoundError(message)) {
        throw new Error("Room not found. Check the 5-digit code and make sure the host is still in the lobby.");
      }
      if (joining && this.isRoomNotFoundError(message)) {
        throw new Error("Room not found. Check the 5-digit code and make sure the host is still in the lobby.");
      }
      if (!this.isRetriableConnectionError(message)) throw err;
      throw new Error(
        "Spoons could not connect after allowing the free server up to 100 seconds to wake. " +
          "If it works in InPrivate/Incognito but not in a normal window, a browser extension or school security rule is blocking the Render connection."
      );
    }
  }

  private async wakeServer(startedAt: number, onProgress?: ConnectionProgress, attempt = 1): Promise<boolean> {
    const base = this.getHttpServerUrl().replace(/\/$/, "");
    const endpoint = attempt % 2 === 1 ? "/api/status" : "/";
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), STATUS_REQUEST_MS);

    try {
      onProgress?.(
        attempt === 1 ? "Waking the free classroom server…" : "Checking whether the classroom server is ready…",
        Math.floor((Date.now() - startedAt) / 1000)
      );
      const response = await fetch(`${base}${endpoint}`, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json, text/plain, */*" }
      });
      return response.ok;
    } catch {
      // This request is only a wake-up aid. Some managed browser profiles block
      // background requests while still allowing the real secure WebSocket.
      return false;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      promise.then(
        (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          window.clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  private isRoomNotFoundError(message: string): boolean {
    return (
      message.includes("room not found") ||
      message.includes("no rooms found") ||
      message.includes("no available rooms") ||
      message.includes("matchmake") ||
      message.includes("seat reservation expired")
    );
  }

  private isRetriableConnectionError(message: string): boolean {
    return (
      !message ||
      message.includes("timeout") ||
      message.includes("still waiting") ||
      message.includes("network") ||
      message.includes("failed to fetch") ||
      message.includes("websocket") ||
      message.includes("connection") ||
      message.includes("502") ||
      message.includes("503") ||
      message.includes("504") ||
      message.includes("matchmake") ||
      message.includes("seat reservation") ||
      message.includes("load failed") ||
      message.includes("blocked")
    );
  }

  private errorText(err: unknown): string {
    return err instanceof Error ? err.message : err == null ? "" : String(err);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
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
    return new Promise((resolve, reject) => {
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
      }, 100);
      window.setTimeout(() => {
        if (done) return;
        done = true;
        if (typeof dispose === "function") dispose();
        reject(new Error("Connected to the server, but the first classroom update did not arrive within 20 seconds."));
      }, INITIAL_SYNC_MS);
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
