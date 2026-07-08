import { Client, Room } from "colyseus";
import { SpoonsState, createPlayer, PlayerData } from "./schema.js";
import { Card, hasFourOfKind, makeDecks, shuffle } from "./cards.js";

const MAX_PLAYERS = 40;
const PULSE_MS = 5000;
const BETWEEN_ROUND_MS = 5000;
const DISCONNECT_GRACE_SECONDS = 20;
const CARD_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const CARD_SUITS = ["♠", "♥", "♦", "♣"];

interface JoinOptions {
  name?: string;
  roomCode?: string;
  deviceId?: string;
}

export class SpoonsRoom extends Room<SpoonsState> {
  maxClients = MAX_PLAYERS;

  private players = new Map<string, PlayerData>();
  private hands = new Map<string, Card[]>();
  private selected = new Map<string, string>();
  private lastReceived = new Map<string, string>();
  private unflippedNewCards = new Map<string, string>();
  private activeOrder: string[] = [];
  private awardEligibleIds: string[] = [];
  private takenSpoonSlots = new Set<number>();
  private pulseTimer?: NodeJS.Timeout;
  private roundStartTimer?: NodeJS.Timeout;
  private roundCountdownTimer?: NodeJS.Timeout;
  private scrambleBotTimers: NodeJS.Timeout[] = [];
  private botFlipTimers = new Map<string, NodeJS.Timeout>();
  private botCounter = 1;
  private pulsesThisRound = 0;
  private roundAssistUsed = false;
  private lateBotAssistUsed = false;
  private roomHostId = "";

  onCreate(options: JoinOptions) {
    this.setState(new SpoonsState());
    this.state.roomCode = this.validRoomCode(options.roomCode) ? String(options.roomCode) : this.generateRoomCode();
    this.setMetadata({ roomCode: this.state.roomCode });
    this.autoDispose = true;
    this.syncState();

    this.onMessage("startGame", (client) => this.hostOnly(client, () => this.startNewGameFromLobby()));
    this.onMessage("playAgain", (client) => this.hostOnly(client, () => this.startNewGameFromLobby()));
    this.onMessage("returnLobby", (client) => this.hostOnly(client, () => this.returnToLobby()));
    this.onMessage("requestRoomInfo", (client) => this.sendRoomInfo(client));
    this.onMessage("addBots", (client, payload) => this.hostOnly(client, () => this.addBots(payload?.mode === "fill" ? "fill" : "eight")));
    this.onMessage("addEightBots", (client) => this.hostOnly(client, () => this.addBots("eight")));
    this.onMessage("fillBots", (client) => this.hostOnly(client, () => this.addBots("fill")));
    this.onMessage("clearBots", (client) => this.hostOnly(client, () => this.clearBots()));
    this.onMessage("kick", (client, payload) => this.hostOnly(client, () => this.kickPlayer(String(payload?.playerId ?? ""))));
    this.onMessage("selectDiscard", (client, payload) => this.selectDiscard(client.sessionId, String(payload?.cardId ?? "")));
    this.onMessage("flipNewCard", (client) => this.flipNewCard(client.sessionId));
    this.onMessage("grabSpoon", (client, payload) => this.grabSpoon(client.sessionId, payload?.spoonIndex));
    this.onMessage("requestHand", (client) => this.sendHand(client.sessionId));
  }

  onJoin(client: Client, options: JoinOptions) {
    const name = this.cleanName(options.name);
    const deviceId = String(options.deviceId ?? "unknown-device");

    const duplicateConnected = [...this.players.values()].find((p) => !p.isBot && p.connected && p.deviceId === deviceId);
    if (duplicateConnected) {
      const liveClient = this.clients.find((c) => c.sessionId === duplicateConnected.id);
      if (liveClient) {
        client.send("errorMessage", { message: "This device is already connected to the room." });
        throw new Error("duplicate device");
      }
      this.removePlayerCompletely(duplicateConnected.id);
    }

    this.removeStalePlayerRecords(deviceId, name);

    this.purgeDisconnectedLobbyPlayers();
    if (this.lobbySeatCount() >= MAX_PLAYERS) {
      const bot = [...this.players.values()].find((p) => p.isBot);
      if (bot) this.removePlayerCompletely(bot.id);
      else throw new Error("Game is at capacity. Try again later.");
    }

    const activeGame = this.state.phase === "playing" || this.state.phase === "results";
    const p = createPlayer({
      id: client.sessionId,
      deviceId,
      name,
      connected: true,
      isHost: this.players.size === 0 || !this.hasConnectedHost(),
      spectator: activeGame,
      eliminated: false,
      playedThisGame: false
    });

    this.players.set(p.id, p);
    if (p.isHost) this.roomHostId = p.id;

    this.recount();
    this.sendAllRoomInfo();
    this.sendRoomInfo(client);
    setTimeout(() => this.sendAllRoomInfo(), 120);
    this.broadcast("toast", { message: `${p.name} joined.` });

    if (activeGame) {
      client.send("toast", { message: "You joined during a game and will spectate until the next game." });
      this.sendHand(p.id);
    }
  }

  async onLeave(client: Client, consented: boolean) {
    const p = this.players.get(client.sessionId);
    if (!p) return;
    p.connected = false;
    this.syncState();
    this.broadcast("toast", { message: `${p.name} left.` });

    try {
      if (consented) throw new Error("left voluntarily");
      await this.allowReconnection(client, DISCONNECT_GRACE_SECONDS);
      p.connected = true;
      this.recount();
      this.broadcast("toast", { message: `${p.name} reconnected.` });
      this.sendAllRoomInfo();
      this.sendHand(p.id);
    } catch {
      p.connected = false;
      if (this.state.phase === "lobby") {
        this.removePlayerCompletely(p.id);
      } else if (!p.spectator && !p.eliminated && this.state.phase === "playing") {
        p.eliminated = true;
        p.spectator = true;
        p.hasSpoon = false;
        this.hands.delete(p.id);
        this.selected.delete(p.id);
        this.lastReceived.delete(p.id);
        this.unflippedNewCards.delete(p.id);
        this.activeOrder = this.activeOrder.filter((id) => id !== p.id);
        if (this.state.scrambleActive) this.finishScrambleIfReady();
        else this.checkForFinalOrScheduleRound(`${p.name} disconnected and is out.`);
      }
      if (p.isHost) this.promoteHost();
      this.recount();
      this.sendAllRoomInfo();
    }
  }

  onDispose() {
    if (this.pulseTimer) clearTimeout(this.pulseTimer);
    if (this.roundStartTimer) clearTimeout(this.roundStartTimer);
    if (this.roundCountdownTimer) clearInterval(this.roundCountdownTimer);
    this.clearBotScrambleTimers();
    this.clearBotFlipTimers();
  }

  private startNewGameFromLobby() {
    this.stopGameTimers();
    if (this.state.phase === "lobby") this.purgeDisconnectedLobbyPlayers();

    for (const p of this.players.values()) {
      if (!p.isBot && !p.connected) continue;
      p.eliminated = false;
      p.spectator = false;
      p.hasSpoon = false;
      p.firstSpoon = false;
      p.playedThisGame = false;
      p.score = 0;
    }

    this.awardEligibleIds = [];
    this.state.phase = "playing";
    this.state.championId = "";
    this.state.loserId = "";
    this.state.firstSpoonId = "";
    this.state.dealerId = "";
    this.state.roundMessage = "";
    this.state.roundStartsAt = 0;
    this.activeOrder = [];
    this.takenSpoonSlots.clear();
    this.beginRound();
  }

  private beginRound() {
    this.stopGameTimers();

    const current = [...this.players.values()].filter((p) => (p.connected || p.isBot) && !p.eliminated && !p.spectator);
    if (current.length < 2) {
      this.finishGame(current[0]);
      return;
    }

    const existingOrder = this.activeOrder.filter((id) => current.some((p) => p.id === id));
    const missing = current.map((p) => p.id).filter((id) => !existingOrder.includes(id));
    let order = existingOrder.length ? [...existingOrder, ...shuffle(missing)] : shuffle(current.map((p) => p.id));

    const preferredDealer = current.find((p) => p.id === this.state.dealerId) ?? current.find((p) => p.id === this.state.firstSpoonId);
    const dealerId = preferredDealer?.id ?? order[0];
    const dealerIndex = order.indexOf(dealerId);
    if (dealerIndex > 0) order = [...order.slice(dealerIndex), ...order.slice(0, dealerIndex)];

    this.activeOrder = order;
    this.hands.clear();
    this.selected.clear();
    this.lastReceived.clear();
    this.unflippedNewCards.clear();
    this.pulsesThisRound = 0;
    this.roundAssistUsed = false;
    this.lateBotAssistUsed = false;

    this.state.phase = "playing";
    this.state.scrambleActive = false;
    this.state.spoonsAvailable = current.length - 1;
    this.state.spoonsTaken = 0;
    this.takenSpoonSlots.clear();
    this.state.takenSpoonsJson = "[]";
    this.state.firstSpoonId = "";
    this.state.loserId = "";
    this.state.championId = "";
    this.state.dealerId = dealerId;
    this.state.roundStartsAt = 0;
    this.state.roundMessage = current.length === 2 ? "Final round. One spoon decides the champion!" : "";

    for (const p of this.players.values()) {
      p.hasSpoon = false;
      p.firstSpoon = false;
      if ((p.connected || p.isBot) && !p.eliminated && !p.spectator) p.playedThisGame = true;
    }

    const deck = makeDecks(current.length);
    for (const id of this.activeOrder) {
      const hand = deck.splice(0, 5);
      this.hands.set(id, hand);
    }
    this.seedOpeningHands(current);
    this.markCurrentNewCardsFaceDown();

    this.recount();
    this.sendAllRoomInfo();
    this.sendAllHands();
    this.scheduleBotFlips();
    this.startPulseLoop();
  }

  private playAgainLegacy() {
    this.startNewGameFromLobby();
  }

  private returnToLobby() {
    this.stopGameTimers();
    for (const p of this.players.values()) {
      p.eliminated = false;
      p.spectator = false;
      p.hasSpoon = false;
      p.firstSpoon = false;
      p.playedThisGame = false;
    }
    this.hands.clear();
    this.selected.clear();
    this.lastReceived.clear();
    this.unflippedNewCards.clear();
    this.activeOrder = [];
    this.awardEligibleIds = [];
    this.state.phase = "lobby";
    this.state.scrambleActive = false;
    this.state.spoonsAvailable = 0;
    this.state.spoonsTaken = 0;
    this.takenSpoonSlots.clear();
    this.state.takenSpoonsJson = "[]";
    this.state.firstSpoonId = "";
    this.state.loserId = "";
    this.state.championId = "";
    this.state.dealerId = "";
    this.state.roundMessage = "";
    this.state.roundStartsAt = 0;
    this.recount();
    this.sendAllRoomInfo();
  }

  private stopGameTimers() {
    if (this.pulseTimer) clearTimeout(this.pulseTimer);
    this.pulseTimer = undefined;
    if (this.roundStartTimer) clearTimeout(this.roundStartTimer);
    this.roundStartTimer = undefined;
    if (this.roundCountdownTimer) clearInterval(this.roundCountdownTimer);
    this.roundCountdownTimer = undefined;
    this.clearBotScrambleTimers();
    this.clearBotFlipTimers();
  }

  private startPulseLoop() {
    if (this.pulseTimer) clearTimeout(this.pulseTimer);
    this.pulseTimer = undefined;
    this.scheduleNextPulse();
  }

  private scheduleNextPulse(resetDeadline = true) {
    if (this.state.phase !== "playing" || this.state.roundStartsAt > 0 || this.state.scrambleActive) {
      this.state.nextPulseAt = 0;
      this.syncState();
      this.sendAllRoomInfo();
      return;
    }

    if (this.pulseTimer) clearTimeout(this.pulseTimer);
    if (resetDeadline || this.state.nextPulseAt <= Date.now()) this.state.nextPulseAt = Date.now() + PULSE_MS;
    const delay = Math.max(50, this.state.nextPulseAt - Date.now());
    this.syncState();
    // Send an explicit roomInfo packet as soon as the timer starts so clients can
    // run a smooth local 5 second card countdown between server pulses.
    this.sendAllRoomInfo();

    this.pulseTimer = setTimeout(() => {
      this.pulseTimer = undefined;
      if (this.state.phase !== "playing" || this.state.roundStartsAt > 0) return;
      if (this.state.scrambleActive) {
        this.state.nextPulseAt = 0;
        this.syncState();
        this.sendAllRoomInfo();
        return;
      }
      // Pre-anchor the next visible card timer before sending hands from pulse().
      // scheduleNextPulse() below will attach the actual timeout using the same window.
      this.state.nextPulseAt = Date.now() + PULSE_MS;
      this.pulse();
      if (this.state.phase === "playing" && this.state.roundStartsAt === 0 && !this.state.scrambleActive) this.scheduleNextPulse(false);
      else {
        this.state.nextPulseAt = 0;
        this.syncState();
        this.sendAllRoomInfo();
      }
    }, delay);
  }

  private pulse() {
    const order = this.activeOrder.filter((id) => {
      const p = this.players.get(id);
      return p && !p.eliminated && !p.spectator && (p.connected || p.isBot);
    });
    this.pulsesThisRound += 1;
    if (order.length < 2) {
      this.finishGame(order.length === 1 ? this.players.get(order[0]) : undefined);
      return;
    }

    // The pulse is the deadline. If a player has not flipped their new card,
    // that exact face-down card is passed on untouched. The server does not
    // auto-reveal it and it cannot count toward four-of-a-kind for that player.
    for (const id of order) {
      const p = this.players.get(id);
      const hand = this.hands.get(id) ?? [];
      const unflippedId = this.unflippedNewCards.get(id);
      if (unflippedId && hand.some((card) => card.id === unflippedId)) {
        this.selected.set(id, unflippedId);
        this.clearBotFlipTimer(id);
        continue;
      }
      if (p?.isBot || !this.selected.has(id)) {
        const pick = this.pickBotDiscard(hand);
        if (pick) this.selected.set(id, pick.id);
      }
    }

    const outgoing = new Map<string, Card>();
    for (const id of order) {
      const hand = this.hands.get(id) ?? [];
      if (hand.length === 0) continue;
      const selectedId = this.selected.get(id);
      const idx = selectedId ? hand.findIndex((c) => c.id === selectedId) : -1;
      const fallback = this.pickBotDiscard(hand);
      const cardIndex = idx >= 0 ? idx : fallback ? hand.findIndex((c) => c.id === fallback.id) : hand.length - 1;
      const [card] = hand.splice(Math.max(0, cardIndex), 1);
      if (card) {
        outgoing.set(id, card);
        if (this.unflippedNewCards.get(id) === card.id) this.unflippedNewCards.delete(id);
      }
    }

    for (let i = 0; i < order.length; i++) {
      const from = order[i];
      const to = order[(i + 1) % order.length];
      const card = outgoing.get(from);
      if (!card) continue;
      const targetHand = this.hands.get(to);
      if (!targetHand) continue;
      targetHand.push(card);
      this.lastReceived.set(to, card.id);
      this.unflippedNewCards.set(to, card.id);
    }

    this.selected.clear();

    if (!this.state.scrambleActive) this.maybeAssistSlowRound(order);

    this.sendAllHands();
    this.scheduleBotFlips();

    if (!this.state.scrambleActive) {
      for (const id of order) {
        const p = this.players.get(id);
        if (p?.isBot && this.hasFourOfKindRevealed(id) && Math.random() < 0.38) {
          this.maybeScheduleBotFirstSpoon(id);
          break;
        }
      }
    } else {
      this.scheduleBotScramble();
    }
  }

  private selectDiscard(playerId: string, cardId: string) {
    const p = this.players.get(playerId);
    if (!p || p.eliminated || p.spectator || this.state.phase !== "playing" || this.state.roundStartsAt > 0) return;
    const hand = this.hands.get(playerId) ?? [];
    const unflippedId = this.unflippedNewCards.get(playerId);
    if (unflippedId) {
      this.clients.find((c) => c.sessionId === playerId)?.send("toast", { message: "Flip the new card first, then choose a card to pass." });
      this.sendHand(playerId);
      return;
    }
    if (hand.some((card) => card.id === cardId)) {
      this.selected.set(playerId, cardId);
      this.sendHand(playerId);
    }
  }

  private flipNewCard(playerId: string, silent = false) {
    const p = this.players.get(playerId);
    if (!p || p.eliminated || p.spectator || this.state.phase !== "playing" || this.state.roundStartsAt > 0) return;
    const cardId = this.unflippedNewCards.get(playerId);
    if (!cardId) return;
    this.unflippedNewCards.delete(playerId);
    this.clearBotFlipTimer(playerId);
    this.sendHand(playerId);
    if (!silent && this.hasFourOfKindRevealed(playerId)) {
      this.clients.find((c) => c.sessionId === playerId)?.send("toast", { message: "Four of a kind! Click a silver spoon!" });
    }
    if (p.isBot && !this.state.scrambleActive && this.hasFourOfKindRevealed(playerId)) this.maybeScheduleBotFirstSpoon(playerId);
  }

  private ensureNewCardFlipped(playerId: string) {
    const cardId = this.unflippedNewCards.get(playerId);
    if (!cardId) return false;
    this.unflippedNewCards.delete(playerId);
    this.clearBotFlipTimer(playerId);
    return true;
  }

  private clearBotFlipTimer(playerId: string) {
    const timer = this.botFlipTimers.get(playerId);
    if (timer) clearTimeout(timer);
    this.botFlipTimers.delete(playerId);
  }

  private hasFourOfKindRevealed(playerId: string): boolean {
    if (this.unflippedNewCards.has(playerId)) return false;
    return hasFourOfKind(this.hands.get(playerId) ?? []);
  }

  private scheduleBotFlips() {
    if (this.state.phase !== "playing" || this.state.roundStartsAt > 0) return;
    for (const id of this.activeOrder) {
      const p = this.players.get(id);
      if (!p?.isBot || p.eliminated || p.spectator || !this.unflippedNewCards.has(id)) continue;
      if (this.botFlipTimers.has(id)) continue;
      const delay = 650 + Math.floor(Math.random() * 2100);
      const timer = setTimeout(() => {
        this.botFlipTimers.delete(id);
        if (this.state.phase === "playing" && this.state.roundStartsAt === 0) this.flipNewCard(id, true);
        this.sendAllHands();
      }, delay);
      this.botFlipTimers.set(id, timer);
    }
  }

  private clearBotFlipTimers() {
    for (const timer of this.botFlipTimers.values()) clearTimeout(timer);
    this.botFlipTimers.clear();
  }

  private maybeScheduleBotFirstSpoon(playerId: string) {
    const p = this.players.get(playerId);
    if (!p?.isBot || this.state.scrambleActive || this.state.phase !== "playing" || this.state.roundStartsAt > 0) return;
    if (!this.hasFourOfKindRevealed(playerId)) return;
    const delay = 2200 + Math.floor(Math.random() * 3600);
    const timer = setTimeout(() => {
      if (this.state.phase === "playing" && !this.state.scrambleActive && this.state.roundStartsAt === 0) this.grabSpoon(playerId);
    }, delay);
    this.scrambleBotTimers.push(timer);
  }

  private grabSpoon(playerId: string, requestedSlot?: unknown) {
    const p = this.players.get(playerId);
    if (!p || p.eliminated || p.spectator || this.state.phase !== "playing" || this.state.roundStartsAt > 0) return;
    if (p.hasSpoon) return;

    const slot = this.resolveSpoonSlot(requestedSlot, p.isBot);
    if (slot < 0) {
      if (!p.isBot) this.clients.find((c) => c.sessionId === playerId)?.send("toast", { message: "That spoon has already been taken. Click a silver spoon." });
      return;
    }

    if (!this.state.scrambleActive) {
      if (this.unflippedNewCards.has(playerId)) {
        if (!p.isBot) this.clients.find((c) => c.sessionId === playerId)?.send("toast", { message: "Flip the new card first." });
        return;
      }
      if (!this.hasFourOfKindRevealed(playerId)) {
        if (!p.isBot) this.clients.find((c) => c.sessionId === playerId)?.send("toast", { message: "You need four of a kind before you can take the first spoon." });
        return;
      }
      this.state.scrambleActive = true;
      this.state.nextPulseAt = 0;
      this.state.firstSpoonId = playerId;
      this.state.dealerId = playerId;
      p.firstSpoon = true;
      p.score += 1;
      // Once spoons are live, freeze card passing so players do not see their
      // hands randomly change into four of a kind during the scramble.
      if (this.pulseTimer) clearTimeout(this.pulseTimer);
      this.pulseTimer = undefined;
      this.selected.clear();
      // Clear any delayed first-spoon bot attempts before starting the slower scramble timers.
      this.clearBotScrambleTimers();
      this.broadcast("toast", { message: `${p.name} got four of a kind — spoons are live!` });
      this.sendAllHands();
    }

    if (this.state.spoonsTaken >= this.state.spoonsAvailable || this.takenSpoonSlots.has(slot)) return;
    this.takenSpoonSlots.add(slot);
    p.hasSpoon = true;
    this.state.spoonsTaken = this.takenSpoonSlots.size;
    this.state.takenSpoonsJson = JSON.stringify([...this.takenSpoonSlots]);
    this.syncState();
    this.sendAllRoomInfo();
    this.scheduleBotScramble();
    this.finishScrambleIfReady();
  }

  private resolveSpoonSlot(requestedSlot: unknown, allowRandomFallback: boolean): number {
    const available = this.availableSpoonSlots();
    if (available.length === 0) return -1;

    const n = Number(requestedSlot);
    if (Number.isInteger(n) && n >= 0 && n < this.state.spoonsAvailable && !this.takenSpoonSlots.has(n)) return n;

    // Bots choose a random physical spoon. Human clients normally send a specific slot
    // from the spoon they clicked, but this fallback keeps old clients/test commands safe.
    if (allowRandomFallback) return available[Math.floor(Math.random() * available.length)];
    return -1;
  }

  private availableSpoonSlots(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.state.spoonsAvailable; i++) {
      if (!this.takenSpoonSlots.has(i)) out.push(i);
    }
    return out;
  }

  private scheduleBotScramble() {
    if (!this.state.scrambleActive || this.state.phase !== "playing") return;
    if (this.scrambleBotTimers.length > 0) return;

    const bots = this.activeOrder
      .map((id) => this.players.get(id))
      .filter((p): p is PlayerData => !!p && p.isBot && !p.eliminated && !p.spectator && !p.hasSpoon);

    bots.forEach((bot, index) => {
      const delay = 3200 + index * 750 + Math.floor(Math.random() * 4200);
      const timer = setTimeout(() => {
        if (this.state.phase === "playing" && this.state.scrambleActive && this.state.roundStartsAt === 0) this.grabSpoon(bot.id);
      }, delay);
      this.scrambleBotTimers.push(timer);
    });
  }

  private clearBotScrambleTimers() {
    for (const timer of this.scrambleBotTimers) clearTimeout(timer);
    this.scrambleBotTimers = [];
  }

  private finishScrambleIfReady() {
    if (!this.state.scrambleActive) return;
    const active = this.activeOrder
      .map((id) => this.players.get(id))
      .filter((p): p is PlayerData => !!p && !p.eliminated && !p.spectator && (p.connected || p.isBot));
    const without = active.filter((p) => !p.hasSpoon);

    if (without.length <= 1 || this.state.spoonsTaken >= this.state.spoonsAvailable) {
      const loser = without[0] ?? active.find((p) => !p.hasSpoon);
      if (loser) {
        loser.eliminated = true;
        loser.spectator = true;
        loser.hasSpoon = false;
        this.state.loserId = loser.id;
        this.hands.delete(loser.id);
        this.selected.delete(loser.id);
        this.lastReceived.delete(loser.id);
        this.unflippedNewCards.delete(loser.id);
        this.activeOrder = this.activeOrder.filter((id) => id !== loser.id);
      }
      this.clearBotScrambleTimers();
      if (this.pulseTimer) clearInterval(this.pulseTimer);
      this.pulseTimer = undefined;
      this.checkForFinalOrScheduleRound(loser ? `${loser.name} is out.` : "Round complete.");
    }
  }

  private checkForFinalOrScheduleRound(message: string) {
    const stillIn = this.activeOrder
      .map((id) => this.players.get(id))
      .filter((p): p is PlayerData => !!p && !p.eliminated && !p.spectator && (p.connected || p.isBot));

    if (stillIn.length <= 1) {
      this.finishGame(stillIn[0]);
      return;
    }

    this.state.phase = "playing";
    this.state.scrambleActive = false;
    this.state.spoonsAvailable = stillIn.length - 1;
    this.state.spoonsTaken = 0;
    this.takenSpoonSlots.clear();
    this.state.takenSpoonsJson = "[]";
    this.state.nextPulseAt = 0;
    this.state.roundStartsAt = Date.now() + BETWEEN_ROUND_MS;
    const cleanedMessage = message.trim().replace(/\s+$/, "");
    this.state.roundMessage = `${cleanedMessage}\nNext round starts with ${stillIn.length} players.`;
    this.selected.clear();
    this.recount();
    this.sendAllRoomInfo();
    this.sendAllHands();

    this.startBetweenRoundCountdown();
  }

  private startBetweenRoundCountdown() {
    if (this.roundStartTimer) clearTimeout(this.roundStartTimer);
    this.roundStartTimer = undefined;
    if (this.roundCountdownTimer) clearInterval(this.roundCountdownTimer);
    this.roundCountdownTimer = undefined;

    const beginNextRound = () => {
      if (this.roundStartTimer) clearTimeout(this.roundStartTimer);
      this.roundStartTimer = undefined;
      if (this.roundCountdownTimer) clearInterval(this.roundCountdownTimer);
      this.roundCountdownTimer = undefined;
      if (this.state.phase === "playing" && this.state.roundStartsAt > 0) this.beginRound();
    };

    this.roundCountdownTimer = setInterval(() => {
      if (this.state.phase !== "playing" || this.state.roundStartsAt <= 0) {
        if (this.roundCountdownTimer) clearInterval(this.roundCountdownTimer);
        this.roundCountdownTimer = undefined;
        return;
      }
      const remainingMs = this.state.roundStartsAt - Date.now();
      if (remainingMs <= 0) {
        beginNextRound();
        return;
      }
      // Send a lightweight pulse so the overlay visibly counts down on every device.
      this.syncState();
      this.sendAllRoomInfo();
    }, 250);

    // Backup timeout in case the interval is delayed by the Node event loop.
    this.roundStartTimer = setTimeout(beginNextRound, BETWEEN_ROUND_MS + 150);
  }

  private finishGame(champion?: PlayerData) {
    this.stopGameTimers();
    this.state.phase = "results";
    this.state.scrambleActive = false;
    this.state.roundStartsAt = 0;
    this.state.roundMessage = "";
    this.state.nextPulseAt = 0;
    this.state.spoonsAvailable = 0;
    this.state.spoonsTaken = 0;
    this.takenSpoonSlots.clear();
    this.state.takenSpoonsJson = "[]";
    if (champion) {
      champion.score += 1;
      this.state.championId = champion.id;
    } else {
      const fallback = [...this.players.values()].find((p) => p.playedThisGame && !p.eliminated && (p.connected || p.isBot));
      this.state.championId = fallback?.id ?? "";
    }
    this.awardEligibleIds = [...this.players.values()]
      .filter((p) => !p.isBot && p.connected && p.playedThisGame)
      .map((p) => p.id);
    this.recount();
    this.sendAllRoomInfo();
  }

  private sendHand(playerId: string) {
    const client = this.clients.find((c) => c.sessionId === playerId);
    if (!client) return;
    const p = this.players.get(playerId);
    const dealer = this.players.get(this.state.dealerId);
    const spectatorView = !!p && this.state.phase === "playing" && (p.spectator || p.eliminated);
    const handOwnerId = spectatorView ? (dealer?.id ?? this.activeOrder[0] ?? playerId) : playerId;
    const owner = this.players.get(handOwnerId);
    const hiddenNewCardId = this.unflippedNewCards.get(handOwnerId) ?? "";
    const rawCards = this.hands.get(handOwnerId) ?? [];
    const visibleCards = rawCards.map((card) => {
      if (card.id === hiddenNewCardId) {
        return { id: card.id, rank: "", suit: "", short: "?", faceDown: true };
      }
      return { ...card, faceDown: false };
    });
    client.send("hand", {
      cards: visibleCards,
      newCardId: this.lastReceived.get(handOwnerId) ?? "",
      newCardFaceDown: !!hiddenNewCardId,
      selectedCardId: spectatorView ? "" : this.selected.get(playerId) ?? "",
      pulseMs: PULSE_MS,
      nextPulseAt: this.state.nextPulseAt,
      nextPulseMs: this.state.nextPulseAt > 0 ? Math.max(0, this.state.nextPulseAt - Date.now()) : 0,
      spectatorView,
      handOwnerName: owner?.name ?? "Dealer"
    });
  }

  private sendAllHands() {
    for (const client of this.clients) this.sendHand(client.sessionId);
  }

  private addBots(mode: "eight" | "fill") {
    if (this.state.phase !== "lobby") return;

    this.purgeDisconnectedLobbyPlayers();

    const before = this.lobbySeatCount();
    const target = mode === "fill" ? MAX_PLAYERS : Math.min(MAX_PLAYERS, before + 8);
    const toAdd = Math.max(0, target - before);

    for (let i = 0; i < toAdd; i++) {
      const botNumber = this.nextBotNumber();
      const id = `bot-${Date.now()}-${botNumber}-${Math.random().toString(36).slice(2, 7)}`;
      const p = createPlayer({
        id,
        deviceId: `bot-device-${botNumber}`,
        name: `Bot ${botNumber}`,
        isBot: true,
        connected: true,
        spectator: false,
        eliminated: false,
        playedThisGame: false
      });
      this.players.set(p.id, p);
    }

    const added = this.lobbySeatCount() - before;
    this.recount();
    this.sendAllRoomInfo();
    this.broadcast("toast", { message: added > 0 ? `${added} bot${added === 1 ? "" : "s"} added.` : "Room is already full." });
  }

  private clearBots() {
    let removed = 0;
    for (const p of [...this.players.values()]) {
      if (p.isBot) {
        this.removePlayerCompletely(p.id);
        removed += 1;
      }
    }
    this.recount();
    this.broadcast("toast", { message: removed > 0 ? "Test bots cleared." : "No bots to clear." });
    this.sendAllRoomInfo();
  }

  private kickPlayer(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.isHost) return;
    if (!p.isBot) {
      const client = this.clients.find((c) => c.sessionId === playerId);
      client?.leave(1000);
    }
    this.removePlayerCompletely(playerId);
    this.recount();
    this.sendAllRoomInfo();
  }

  private purgeDisconnectedLobbyPlayers() {
    if (this.state.phase !== "lobby") return;
    const liveClientIds = new Set(this.clients.map((c) => c.sessionId));
    for (const p of [...this.players.values()]) {
      if (!p.isBot && (!p.connected || !liveClientIds.has(p.id))) this.removePlayerCompletely(p.id);
    }
  }

  private lobbySeatCount() {
    return [...this.players.values()].filter((p) => p.isBot || p.connected !== false).length;
  }

  private nextBotNumber() {
    const used = new Set<number>();
    for (const p of this.players.values()) {
      const match = /^Bot (\d+)$/.exec(p.name);
      if (p.isBot && match) used.add(Number(match[1]));
    }
    while (used.has(this.botCounter)) this.botCounter += 1;
    return this.botCounter++;
  }

  private rosterPayload() {
    const players = [...this.players.values()].map((p) => ({ ...p }));
    const humans = players.filter((p) => !p.isBot && p.connected !== false).length;
    const bots = players.filter((p) => p.isBot).length;
    return {
      roomCode: this.state.roomCode,
      phase: this.state.phase,
      players,
      playersJson: JSON.stringify(players),
      activeOrder: [...this.activeOrder],
      activeOrderJson: JSON.stringify(this.activeOrder),
      awardEligibleIds: [...this.awardEligibleIds],
      awardEligibleIdsJson: JSON.stringify(this.awardEligibleIds),
      humans,
      bots,
      seats: Math.min(MAX_PLAYERS, humans + bots),
      activeCount: this.state.activeCount,
      eliminatedCount: this.state.eliminatedCount,
      spoonsAvailable: this.state.spoonsAvailable,
      spoonsTaken: this.state.spoonsTaken,
      takenSpoons: [...this.takenSpoonSlots],
      takenSpoonsJson: JSON.stringify([...this.takenSpoonSlots]),
      scrambleActive: this.state.scrambleActive,
      nextPulseAt: this.state.nextPulseAt,
      nextPulseMs: this.state.nextPulseAt > 0 ? Math.max(0, this.state.nextPulseAt - Date.now()) : 0,
      firstSpoonId: this.state.firstSpoonId,
      loserId: this.state.loserId,
      championId: this.state.championId,
      dealerId: this.state.dealerId,
      roundMessage: this.state.roundMessage,
      roundStartsAt: this.state.roundStartsAt,
      roundCountdownMs: this.state.roundStartsAt > 0 ? Math.max(0, this.state.roundStartsAt - Date.now()) : 0,
      revision: this.state.revision,
      pulseMs: PULSE_MS
    };
  }

  private sendAllRoomInfo() {
    for (const client of this.clients) this.sendRoomInfo(client);
  }

  private sendRoomInfo(client: Client) {
    this.syncState();
    const p = this.players.get(client.sessionId);
    client.send("roomInfo", {
      ...this.rosterPayload(),
      playerId: client.sessionId,
      isHost: !!p?.isHost
    });
  }

  private hostOnly(client: Client, action: () => void) {
    const p = this.players.get(client.sessionId);
    if (!p?.isHost) return;
    action();
  }

  private removeStalePlayerRecords(deviceId: string, name: string) {
    for (const p of [...this.players.values()]) {
      if (p.isBot) continue;
      if (!p.connected && (p.deviceId === deviceId || p.name.toLowerCase() === name.toLowerCase())) {
        this.removePlayerCompletely(p.id);
      }
    }
  }

  private removePlayerCompletely(playerId: string) {
    this.players.delete(playerId);
    this.hands.delete(playerId);
    this.selected.delete(playerId);
    this.lastReceived.delete(playerId);
    this.unflippedNewCards.delete(playerId);
    const flipTimer = this.botFlipTimers.get(playerId);
    if (flipTimer) clearTimeout(flipTimer);
    this.botFlipTimers.delete(playerId);
    this.activeOrder = this.activeOrder.filter((id) => id !== playerId);
    this.awardEligibleIds = this.awardEligibleIds.filter((id) => id !== playerId);
  }

  private hasConnectedHost() {
    return [...this.players.values()].some((p) => p.isHost && p.connected && !p.isBot);
  }

  private promoteHost() {
    if (this.hasConnectedHost()) return;
    const next = [...this.players.values()].find((p) => !p.isBot && p.connected);
    if (next) {
      next.isHost = true;
      this.roomHostId = next.id;
      this.broadcast("toast", { message: `${next.name} is now host.` });
    }
  }

  private recount() {
    const active = [...this.players.values()].filter((p) => !p.spectator && !p.eliminated && (p.connected || p.isBot));
    this.state.activeCount = active.length;
    this.state.eliminatedCount = [...this.players.values()].filter((p) => p.eliminated).length;
    this.syncState();
  }

  private syncState() {
    this.state.playersJson = JSON.stringify([...this.players.values()]);
    this.state.activeOrderJson = JSON.stringify(this.activeOrder);
    this.state.awardEligibleIdsJson = JSON.stringify(this.awardEligibleIds);
    this.state.takenSpoonsJson = JSON.stringify([...this.takenSpoonSlots]);
    this.state.revision = (this.state.revision + 1) % 1000000;
  }

  private markCurrentNewCardsFaceDown() {
    this.unflippedNewCards.clear();
    for (const id of this.activeOrder) {
      const hand = this.hands.get(id) ?? [];
      const newCard = hand[hand.length - 1];
      if (newCard) {
        this.lastReceived.set(id, newCard.id);
        this.unflippedNewCards.set(id, newCard.id);
      }
    }
  }

  private seedOpeningHands(current: PlayerData[]) {
    // Keep the classroom prototype lively: each new round gives a small number of
    // active players a near-set. This avoids long dead rounds when testing with bots,
    // while still requiring several passes or a player decision before spoons appear.
    const candidates = shuffle(current.filter((p) => p.connected || p.isBot)).slice(0, Math.min(3, current.length));
    for (const p of candidates) {
      const hand = this.hands.get(p.id);
      if (!hand || hand.length < 5) continue;
      const rank = this.randomRank();
      const kickers = CARD_RANKS.filter((r) => r !== rank);
      const newHand = [
        this.makeCard(rank, 0, `seed-${p.id}-0`),
        this.makeCard(rank, 1, `seed-${p.id}-1`),
        this.makeCard(rank, 2, `seed-${p.id}-2`),
        this.makeCard(kickers[Math.floor(Math.random() * kickers.length)], 0, `seed-${p.id}-3`),
        this.makeCard(kickers[Math.floor(Math.random() * kickers.length)], 1, `seed-${p.id}-4`)
      ];
      const shuffledHand = shuffle(newHand);
      this.hands.set(p.id, shuffledHand);
      this.lastReceived.set(p.id, shuffledHand[shuffledHand.length - 1]?.id ?? "");
    }
  }

  private maybeAssistSlowRound(order: string[]) {
    const activeHumans = order
      .map((id) => this.players.get(id))
      .filter((p): p is PlayerData => !!p && !p.isBot && p.connected && !p.eliminated && !p.spectator);
    const activeBots = order
      .map((id) => this.players.get(id))
      .filter((p): p is PlayerData => !!p && p.isBot && !p.eliminated && !p.spectator);

    // First nudge for bot-heavy testing. Do not modify a human hand here: that
    // felt like the game was randomly changing a player's cards when another
    // player triggered the spoons. Humans should only reach four of a kind through
    // the normal passing flow.
    if (!this.roundAssistUsed && this.pulsesThisRound >= 7 && activeBots.length > 0 && !order.some((id) => this.hasFourOfKindRevealed(id))) {
      const bot = activeBots[Math.floor(Math.random() * activeBots.length)];
      this.giveFourOfKind(bot.id);
      this.roundAssistUsed = true;
    }

    // Safety nudge for bot-heavy testing: a bot will eventually become a threat
    // so the round never drags on forever.
    if (!this.lateBotAssistUsed && this.pulsesThisRound >= 11 && activeBots.length > 0) {
      const bot = activeBots[Math.floor(Math.random() * activeBots.length)];
      this.giveFourOfKind(bot.id);
      this.lateBotAssistUsed = true;
      const delay = 3600 + Math.floor(Math.random() * 3200);
      const timer = setTimeout(() => {
        if (this.state.phase === "playing" && !this.state.scrambleActive && this.state.roundStartsAt === 0) this.grabSpoon(bot.id);
      }, delay);
      this.scrambleBotTimers.push(timer);
    }
  }

  private giveFourOfKind(playerId: string) {
    const hand = this.hands.get(playerId);
    if (!hand || hand.length < 5) return;
    const rank = this.randomRank();
    const otherRanks = CARD_RANKS.filter((r) => r !== rank);
    const extraRank = otherRanks[Math.floor(Math.random() * otherRanks.length)];
    const newHand = [
      this.makeCard(rank, 0, `assist-${playerId}-0`),
      this.makeCard(rank, 1, `assist-${playerId}-1`),
      this.makeCard(rank, 2, `assist-${playerId}-2`),
      this.makeCard(rank, 3, `assist-${playerId}-3`),
      this.makeCard(extraRank, Math.floor(Math.random() * CARD_SUITS.length), `assist-${playerId}-4`)
    ];
    const shuffledHand = shuffle(newHand);
    this.hands.set(playerId, shuffledHand);
    const newId = shuffledHand[shuffledHand.length - 1]?.id ?? "";
    this.lastReceived.set(playerId, newId);
    if (newId) this.unflippedNewCards.set(playerId, newId);
    this.sendHand(playerId);
    this.scheduleBotFlips();
  }

  private makeCard(rank: string, suitIndex: number, prefix: string): Card {
    const suit = CARD_SUITS[((suitIndex % CARD_SUITS.length) + CARD_SUITS.length) % CARD_SUITS.length];
    return { id: `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, rank, suit, short: `${rank}${suit}` };
  }

  private randomRank() {
    return CARD_RANKS[Math.floor(Math.random() * CARD_RANKS.length)];
  }

  private pickBotDiscard(hand: Card[]): Card | undefined {
    if (hand.length === 0) return undefined;
    const counts = new Map<string, number>();
    for (const c of hand) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
    let bestRank = hand[0].rank;
    let bestCount = 0;
    for (const [rank, count] of counts) {
      if (count > bestCount) {
        bestRank = rank;
        bestCount = count;
      }
    }
    const discardable = hand.filter((c) => c.rank !== bestRank);
    const pool = discardable.length ? discardable : hand;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private cleanName(value?: string) {
    return String(value ?? "Player").replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 12) || "Player";
  }

  private generateRoomCode() {
    return String(Math.floor(10000 + Math.random() * 90000));
  }

  private validRoomCode(value?: string) {
    return /^\d{5}$/.test(String(value ?? ""));
  }
}
