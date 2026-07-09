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
  private spectatorWatchTargets = new Map<string, string>();
  private drawPile: Card[] = [];
  private discardPile: Card[] = [];
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
  private turnSeq = 0;
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
        this.spectatorWatchTargets.delete(p.id);
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
    this.drawPile = deck;
    this.discardPile = [];
    this.seedOpeningHands(current);
    this.markCurrentNewCardsFaceDown();
    this.resetSpectatorWatchTargets(dealerId);

    this.recount();
    this.startPassWindow(true);
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
    this.spectatorWatchTargets.clear();
    this.drawPile = [];
    this.discardPile = [];
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
    this.clearTurnClock();
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
    this.startPassWindow(true);
  }

  private startPassWindow(broadcast = true) {
    // Every card window gets an authoritative server timestamp and a turn number.
    // Clients render the visible countdown locally from these values, so the timer
    // keeps moving even when no one flips, clicks, or receives a state patch.
    if (this.state.phase !== "playing" || this.state.roundStartsAt > 0) {
      this.clearTurnClock();
      this.syncState();
      this.sendAllRoomInfo();
      return;
    }

    if (this.pulseTimer) clearTimeout(this.pulseTimer);
    const now = Date.now();
    this.turnSeq += 1;
    this.state.currentTurnStartedAt = now;
    this.state.currentTurnEndsAt = now + PULSE_MS;
    this.state.turnDurationMs = PULSE_MS;
    this.state.turnNumber = this.turnSeq;
    this.state.nextPulseAt = this.state.currentTurnEndsAt;
    this.syncState();

    const windowNumber = this.turnSeq;
    this.pulseTimer = setTimeout(() => {
      this.pulseTimer = undefined;
      if (this.state.phase !== "playing" || this.state.roundStartsAt > 0) return;
      if (windowNumber !== this.turnSeq) return;
      this.pulse();
      if (this.state.phase === "playing" && this.state.roundStartsAt === 0) this.startPassWindow(true);
      else {
        this.clearTurnClock();
        this.syncState();
        this.sendAllRoomInfo();
      }
    }, PULSE_MS);

    if (broadcast) {
      this.sendAllRoomInfo();
      this.sendAllHands();
      this.scheduleBotFlips();
    }
  }

  private clearTurnClock() {
    this.state.nextPulseAt = 0;
    this.state.currentTurnStartedAt = 0;
    this.state.currentTurnEndsAt = 0;
    this.state.turnDurationMs = PULSE_MS;
    this.state.turnNumber = this.turnSeq;
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

    // The pulse is the deadline. A human hand only changes if the player has
    // flipped the new card and selected one of their original four hand cards.
    // Otherwise the current new card (face-down or revealed) is passed left and
    // the four kept cards remain unchanged.
    for (const id of order) {
      const p = this.players.get(id);
      const hand = this.hands.get(id) ?? [];
      const currentNewId = this.lastReceived.get(id) ?? "";
      const unflippedId = this.unflippedNewCards.get(id);
      const selectedId = this.selected.get(id) ?? "";
      const selectedIsValid = !!selectedId && hand.some((card) => card.id === selectedId);

      if (unflippedId && hand.some((card) => card.id === unflippedId)) {
        this.selected.set(id, unflippedId);
        this.clearBotFlipTimer(id);
        continue;
      }

      if (p?.isBot) {
        if (!selectedIsValid) {
          const pick = this.chooseBotDiscard(id);
          if (pick) this.selected.set(id, pick.id);
        }
        continue;
      }

      // Human timeout path: no server/bot-style decision is ever made for them.
      // If the new card was flipped but no original hand card was chosen, pass
      // the new card on and leave the human's existing four cards untouched.
      if (!selectedIsValid || selectedId === currentNewId) {
        const newCard = hand.find((card) => card.id === currentNewId) ?? hand[hand.length - 1];
        if (newCard) this.selected.set(id, newCard.id);
      }
    }

    const outgoing = new Map<string, Card>();
    for (const id of order) {
      const hand = this.hands.get(id) ?? [];
      if (hand.length === 0) continue;
      const selectedId = this.selected.get(id);
      const idx = selectedId ? hand.findIndex((c) => c.id === selectedId) : -1;
      const currentNewId = this.lastReceived.get(id) ?? "";
      const fallbackIndex = currentNewId ? hand.findIndex((c) => c.id === currentNewId) : hand.length - 1;
      const cardIndex = idx >= 0 ? idx : fallbackIndex >= 0 ? fallbackIndex : hand.length - 1;
      const [card] = hand.splice(Math.max(0, cardIndex), 1);
      if (card) {
        outgoing.set(id, card);
        if (this.unflippedNewCards.get(id) === card.id) this.unflippedNewCards.delete(id);
      }
    }

    // Feed the table like real Spoons: the dealer receives a fresh draw-pile card,
    // every other player receives the card from the player on their right, and
    // the final outgoing card leaves play into the discard pile. This prevents
    // the two-player final from endlessly recycling the same small card loop.
    for (let i = 0; i < order.length - 1; i++) {
      const from = order[i];
      const to = order[i + 1];
      const card = outgoing.get(from);
      if (!card) continue;
      this.deliverIncomingCard(to, card);
    }

    const lastOutgoing = outgoing.get(order[order.length - 1]);
    if (lastOutgoing) this.discardPile.push(lastOutgoing);

    const dealerId = order[0];
    const freshCard = this.drawFreshCard(order.length);
    if (freshCard) this.deliverIncomingCard(dealerId, freshCard);

    this.selected.clear();

    if (!this.state.scrambleActive) {
      this.maybeAssistSlowRound(order);
      this.maybeAssistHumanFinal(order);
    }

    this.normalizeActiveHands(order);

    if (!this.state.scrambleActive) {
      for (const id of order) {
        const p = this.players.get(id);
        if (p?.isBot && this.hasFourOfKindRevealed(id)) {
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
    const currentNewId = this.lastReceived.get(playerId) ?? "";
    if (unflippedId) {
      this.clients.find((c) => c.sessionId === playerId)?.send("toast", { message: "Flip the new card first, then choose one of your original 4 cards to pass." });
      this.sendHand(playerId);
      return;
    }
    if (cardId === currentNewId) {
      this.clients.find((c) => c.sessionId === playerId)?.send("toast", { message: "To keep the new card, choose one of your original 4 cards to pass. Or leave it and the new card will pass on." });
      this.sendHand(playerId);
      return;
    }
    if (hand.some((card) => card.id === cardId)) {
      this.selected.set(playerId, cardId);
      this.sendHand(playerId);
      this.sendSpectatorHandsFor(playerId);
      if (this.hasFourOfKindRevealed(playerId)) {
        this.clients.find((c) => c.sessionId === playerId)?.send("toast", { message: "Four of a kind! Click a silver spoon!" });
      }
    }
  }

  private flipNewCard(playerId: string, silent = false) {
    const p = this.players.get(playerId);
    if (!p || p.eliminated || p.spectator || this.state.phase !== "playing" || this.state.roundStartsAt > 0) return;
    const cardId = this.unflippedNewCards.get(playerId);
    if (!cardId) return;
    this.unflippedNewCards.delete(playerId);
    this.clearBotFlipTimer(playerId);

    if (p.isBot) {
      const pick = this.chooseBotDiscard(playerId);
      if (pick) this.selected.set(playerId, pick.id);
      this.sendSpectatorHandsFor(playerId);
      this.sendAllHands();
      if (!this.state.scrambleActive && this.hasFourOfKindRevealed(playerId)) this.maybeScheduleBotFirstSpoon(playerId);
      return;
    }

    this.sendHand(playerId);
    this.sendSpectatorHandsFor(playerId);
    if (!silent) {
      this.clients.find((c) => c.sessionId === playerId)?.send("toast", { message: "New card flipped. Tap one of your original 4 cards to keep it." });
    }
  }

  private clearBotFlipTimer(playerId: string) {
    const timer = this.botFlipTimers.get(playerId);
    if (timer) clearTimeout(timer);
    this.botFlipTimers.delete(playerId);
  }

  private hasFourOfKindRevealed(playerId: string): boolean {
    const hand = this.hands.get(playerId) ?? [];
    if (hand.length < 4) return false;
    const currentNewId = this.lastReceived.get(playerId) ?? "";
    const selectedId = this.selected.get(playerId) ?? "";

    // During a decision window, the incoming card is a separate 5th card. It only
    // counts toward four-of-a-kind after the player/bot has chosen an original
    // hand card to pass. If no such choice has been made, only the kept 4-card
    // hand is checked, so an unflipped or merely flipped new card cannot help.
    if (currentNewId && hand.some((card) => card.id === currentNewId)) {
      if (selectedId && selectedId !== currentNewId && hand.some((card) => card.id === selectedId)) {
        return hasFourOfKind(hand.filter((card) => card.id !== selectedId));
      }
      return hasFourOfKind(hand.filter((card) => card.id !== currentNewId));
    }

    return hasFourOfKind(hand);
  }

  private scheduleBotFlips() {
    if (this.state.phase !== "playing" || this.state.roundStartsAt > 0) return;
    for (const id of this.activeOrder) {
      const p = this.players.get(id);
      if (!p?.isBot || p.eliminated || p.spectator || !this.unflippedNewCards.has(id)) continue;
      if (this.botFlipTimers.has(id)) continue;
      const delay = 350 + Math.floor(Math.random() * 1100);
      const timer = setTimeout(() => {
        this.botFlipTimers.delete(id);
        if (this.state.phase === "playing" && this.state.roundStartsAt === 0) this.flipNewCard(id, true);
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
    const delay = 300 + Math.floor(Math.random() * 500);
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
      if (!this.hasFourOfKindRevealed(playerId)) {
        if (!p.isBot) {
          const message = this.unflippedNewCards.has(playerId)
            ? "You need four of a kind in your kept hand. The face-down new card does not count."
            : "You need four of a kind before you can take the first spoon.";
          this.clients.find((c) => c.sessionId === playerId)?.send("toast", { message });
        }
        return;
      }
      this.state.scrambleActive = true;
      // Do NOT stop the pulse timer here. The game should keep flipping and passing
      // while spoons disappear, so players can bluff instead of being tipped off by
      // the card timer freezing.
      this.state.firstSpoonId = playerId;
      this.state.dealerId = playerId;
      p.firstSpoon = true;
      p.score += 1;
      // Clear any delayed first-spoon bot attempts before starting the slower scramble timers.
      this.clearBotScrambleTimers();
      this.sendAllHands();
      this.sendAllRoomInfo();
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
      const delay = 600 + index * 180 + Math.floor(Math.random() * 1400);
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
      if (this.pulseTimer) clearTimeout(this.pulseTimer);
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
    this.state.currentTurnStartedAt = 0;
    this.state.currentTurnEndsAt = 0;
    this.state.turnDurationMs = PULSE_MS;
    this.state.turnNumber = this.turnSeq;
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
    this.state.currentTurnStartedAt = 0;
    this.state.currentTurnEndsAt = 0;
    this.state.turnDurationMs = PULSE_MS;
    this.state.turnNumber = this.turnSeq;
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

  private deliverIncomingCard(playerId: string, card: Card) {
    const targetHand = this.hands.get(playerId);
    if (!targetHand) return;
    targetHand.push(card);
    this.lastReceived.set(playerId, card.id);
    this.unflippedNewCards.set(playerId, card.id);
  }

  private drawFreshCard(activeCount: number): Card | undefined {
    if (this.drawPile.length === 0 && this.discardPile.length > 0) {
      this.drawPile = shuffle(this.discardPile);
      this.discardPile = [];
    }
    if (this.drawPile.length === 0) {
      // Emergency fallback only: make a new shuffled deck if a very long final
      // burns through every card. This keeps the game from stalling.
      this.drawPile = makeDecks(activeCount);
    }
    return this.drawPile.shift();
  }

  private maybeAssistHumanFinal(order: string[]) {
    const active = order
      .map((id) => this.players.get(id))
      .filter((p): p is PlayerData => !!p && !p.eliminated && !p.spectator && (p.connected || p.isBot));
    const activeHumans = active.filter((p) => !p.isBot && p.connected);
    const activeBots = active.filter((p) => p.isBot);

    // If the final is two humans only, there is no bot that can force the round
    // to finish. After a long dead final, make the current incoming card helpful
    // for a human who already has three of a kind in their kept four cards. This
    // does not alter the human's kept hand: they still must flip the new card,
    // choose a discard, and take the spoon themselves.
    if (active.length !== 2 || activeHumans.length !== 2 || activeBots.length !== 0) return;
    if (this.pulsesThisRound < 10) return;
    if (order.some((id) => this.hasFourOfKindRevealed(id))) return;

    const targetId = order[this.pulsesThisRound % order.length];
    const helpfulRank = this.bestThreeOfKindRank(targetId);
    if (!helpfulRank) return;

    const hand = this.hands.get(targetId);
    const currentNewId = this.lastReceived.get(targetId) ?? "";
    if (!hand || !currentNewId) return;
    const idx = hand.findIndex((card) => card.id === currentNewId);
    if (idx < 0) return;

    const replaced = hand[idx];
    if (replaced) this.discardPile.push(replaced);
    const suitIndex = Math.floor(Math.random() * CARD_SUITS.length);
    const card = this.makeCard(helpfulRank, suitIndex, `final-assist-${targetId}-${this.pulsesThisRound}`);
    hand[idx] = card;
    this.lastReceived.set(targetId, card.id);
    this.unflippedNewCards.set(targetId, card.id);
    this.sendHand(targetId);
    this.sendSpectatorHandsFor(targetId);
  }

  private bestThreeOfKindRank(playerId: string): string {
    const hand = this.hands.get(playerId) ?? [];
    const currentNewId = this.lastReceived.get(playerId) ?? "";
    const keptCards = currentNewId ? hand.filter((card) => card.id !== currentNewId) : hand.slice(0, 4);
    const counts = this.rankCounts(keptCards);
    let bestRank = "";
    let bestCount = 0;
    for (const [rank, count] of counts.entries()) {
      if (count > bestCount) {
        bestRank = rank;
        bestCount = count;
      }
    }
    return bestCount >= 3 ? bestRank : "";
  }

  private normalizeActiveHands(order: string[] = this.activeOrder) {
    // Defensive repair for rare edge cases during disconnects / scramble timing.
    // Every active player should always have exactly 5 cards: four kept cards plus one current new card.
    for (const id of order) {
      const p = this.players.get(id);
      if (!p || p.eliminated || p.spectator || !(p.connected || p.isBot)) continue;
      const hand = this.hands.get(id) ?? [];
      while (hand.length < 5) {
        const card = this.drawFreshCard(Math.max(2, this.activeOrder.length || order.length));
        if (!card) break;
        hand.push(card);
      }
      while (hand.length > 5) {
        const hiddenId = this.unflippedNewCards.get(id);
        const removableIndex = hand.findIndex((c) => c.id !== hiddenId);
        hand.splice(removableIndex >= 0 ? removableIndex : hand.length - 1, 1);
      }
      this.hands.set(id, hand);
      const currentNew = this.lastReceived.get(id);
      if (!currentNew || !hand.some((c) => c.id === currentNew)) {
        const newest = hand[hand.length - 1];
        if (newest) {
          this.lastReceived.set(id, newest.id);
          if (!this.unflippedNewCards.has(id)) this.unflippedNewCards.set(id, newest.id);
        }
      }
    }
  }

  private sendHand(playerId: string, preferredOwnerId = "") {
    const client = this.clients.find((c) => c.sessionId === playerId);
    if (!client) return;
    const p = this.players.get(playerId);
    const spectatorView = !!p && this.state.phase === "playing" && (p.spectator || p.eliminated);
    const handOwnerId = spectatorView ? this.resolveSpectatorHandOwner(playerId, preferredOwnerId) : playerId;
    const owner = this.players.get(handOwnerId);
    if (this.activeOrder.includes(handOwnerId)) this.normalizeActiveHands([handOwnerId]);
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
      serverNow: Date.now(),
      nextPulseAt: this.state.nextPulseAt,
      nextPulseMs: this.state.nextPulseAt > 0 ? Math.max(0, this.state.nextPulseAt - Date.now()) : 0,
      currentTurnStartedAt: this.state.currentTurnStartedAt,
      currentTurnEndsAt: this.state.currentTurnEndsAt,
      turnDurationMs: this.state.turnDurationMs,
      turnNumber: this.state.turnNumber,
      turnSeq: this.turnSeq,
      spectatorView,
      handOwnerName: owner?.name ?? "Dealer"
    });
  }

  private sendAllHands() {
    for (const client of this.clients) this.sendHand(client.sessionId);
  }

  private sendSpectatorHandsFor(ownerId: string) {
    // Spectators should follow the current dealer only. Earlier hotfixes sent
    // the spectator view to whichever player just flipped/selected, which made
    // eliminated players see everyone's moves. Ignore non-dealer hand actions.
    const dealerOwnerId = this.currentDealerHandOwner();
    if (!dealerOwnerId || ownerId !== dealerOwnerId) return;
    for (const client of this.clients) {
      const p = this.players.get(client.sessionId);
      if (p && this.state.phase === "playing" && (p.spectator || p.eliminated)) {
        this.sendHand(client.sessionId, dealerOwnerId);
      }
    }
  }

  private resolveSpectatorHandOwner(spectatorId: string, _preferredOwnerId = "") {
    const dealerOwnerId = this.currentDealerHandOwner();
    if (dealerOwnerId) {
      this.spectatorWatchTargets.set(spectatorId, dealerOwnerId);
      return dealerOwnerId;
    }

    const currentTarget = this.spectatorWatchTargets.get(spectatorId) ?? "";
    if (currentTarget && this.isActiveHandOwner(currentTarget)) return currentTarget;

    return spectatorId;
  }

  private currentDealerHandOwner() {
    // The live card-flow dealer is the first active player in activeOrder. The
    // state.dealerId may be updated mid-scramble to seed the next round's dealer,
    // so do not use it to switch spectator view until the next round is actually
    // begun and activeOrder is rotated.
    const orderDealerId = this.activeOrder[0] ?? "";
    if (this.isActiveHandOwner(orderDealerId)) return orderDealerId;
    if (this.isActiveHandOwner(this.state.dealerId)) return this.state.dealerId;
    return this.activeOrder.find((id) => this.isActiveHandOwner(id)) ?? "";
  }

  private isActiveHandOwner(playerId: string) {
    const p = this.players.get(playerId);
    return !!p && this.activeOrder.includes(playerId) && !p.eliminated && !p.spectator && (p.connected || p.isBot);
  }

  private resetSpectatorWatchTargets(defaultOwnerId = "") {
    this.spectatorWatchTargets.clear();
    const ownerId = this.currentDealerHandOwner() || (this.isActiveHandOwner(defaultOwnerId) ? defaultOwnerId : "");
    if (!ownerId) return;
    for (const client of this.clients) {
      const p = this.players.get(client.sessionId);
      if (p && (p.spectator || p.eliminated)) this.spectatorWatchTargets.set(p.id, ownerId);
    }
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
      serverNow: Date.now(),
      nextPulseAt: this.state.nextPulseAt,
      nextPulseMs: this.state.nextPulseAt > 0 ? Math.max(0, this.state.nextPulseAt - Date.now()) : 0,
      currentTurnStartedAt: this.state.currentTurnStartedAt,
      currentTurnEndsAt: this.state.currentTurnEndsAt,
      turnDurationMs: this.state.turnDurationMs,
      turnNumber: this.state.turnNumber,
      firstSpoonId: this.state.firstSpoonId,
      loserId: this.state.loserId,
      championId: this.state.championId,
      dealerId: this.state.dealerId,
      roundMessage: this.state.roundMessage,
      roundStartsAt: this.state.roundStartsAt,
      roundCountdownMs: this.state.roundStartsAt > 0 ? Math.max(0, this.state.roundStartsAt - Date.now()) : 0,
      revision: this.state.revision,
      pulseMs: PULSE_MS,
      turnSeq: this.turnSeq
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
    this.spectatorWatchTargets.delete(playerId);
    for (const [spectatorId, targetId] of [...this.spectatorWatchTargets.entries()]) {
      if (targetId === playerId) this.spectatorWatchTargets.delete(spectatorId);
    }
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
      const delay = 400 + Math.floor(Math.random() * 600);
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
    this.sendSpectatorHandsFor(playerId);
    this.scheduleBotFlips();
  }

  private makeCard(rank: string, suitIndex: number, prefix: string): Card {
    const suit = CARD_SUITS[((suitIndex % CARD_SUITS.length) + CARD_SUITS.length) % CARD_SUITS.length];
    return { id: `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, rank, suit, short: `${rank}${suit}` };
  }

  private randomRank() {
    return CARD_RANKS[Math.floor(Math.random() * CARD_RANKS.length)];
  }

  private chooseBotDiscard(playerId: string): Card | undefined {
    const hand = this.hands.get(playerId) ?? [];
    if (hand.length === 0) return undefined;
    const currentNewId = this.lastReceived.get(playerId) ?? "";
    const currentNew = hand.find((card) => card.id === currentNewId);
    if (!currentNew) return this.chooseWeakestCard(hand);

    let bestCard = currentNew;
    let bestScore = -1;
    for (const candidate of hand) {
      const kept = hand.filter((card) => card.id !== candidate.id);
      const score = this.handStrengthScore(kept) + (candidate.id === currentNewId ? 0.02 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestCard = candidate;
      }
    }
    return bestCard;
  }

  private chooseWeakestCard(hand: Card[]): Card | undefined {
    if (hand.length === 0) return undefined;
    const counts = this.rankCounts(hand);
    const sorted = [...hand].sort((a, b) => (counts.get(a.rank) ?? 0) - (counts.get(b.rank) ?? 0));
    return sorted[0];
  }

  private handStrengthScore(cards: Card[]): number {
    const counts = [...this.rankCounts(cards).values()].sort((a, b) => b - a);
    const best = counts[0] ?? 0;
    const second = counts[1] ?? 0;
    return best * 10 + second;
  }

  private rankCounts(cards: Card[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const c of cards) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
    return counts;
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
