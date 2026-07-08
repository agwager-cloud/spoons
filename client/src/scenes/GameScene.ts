import Phaser from "phaser";
import { Net } from "../net/Net";
import { addPanel, addSoundButton } from "../ui/panel";
import { toggleSound, isSoundOn, preloadBackgroundMusic, syncBackgroundMusic } from "../utils/sound";

interface CardView { id: string; rank: string; suit: string; short: string; faceDown?: boolean; }
interface PlayerLike {
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
  playedThisGame?: boolean;
}

function players(): PlayerLike[] {
  const infoPlayers = Net.lastRoomInfo?.players;
  if (Array.isArray(infoPlayers)) return infoPlayers as PlayerLike[];

  const infoJson = Net.lastRoomInfo?.playersJson;
  if (typeof infoJson === "string" && infoJson.length) {
    try {
      const parsed = JSON.parse(infoJson);
      if (Array.isArray(parsed)) return parsed as PlayerLike[];
    } catch {
      return [];
    }
  }

  const state: any = Net.room?.state;
  if (!state) return [];
  if (typeof state.playersJson === "string" && state.playersJson.length) {
    try {
      const parsed = JSON.parse(state.playersJson);
      if (Array.isArray(parsed)) return parsed as PlayerLike[];
    } catch {
      return [];
    }
  }

  const out: PlayerLike[] = [];
  const map: any = state.players;
  if (!map) return out;
  if (typeof map.forEach === "function") {
    map.forEach((value: any, key: string) => out.push({ id: value?.id || key, ...value }));
  } else {
    Object.entries(map).forEach(([key, value]: [string, any]) => out.push({ id: value?.id || key, ...value }));
  }
  return out;
}

function arrayFromSchema(value: any): string[] {
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value;
  if (typeof value.toArray === "function") return value.toArray();
  return Array.from(value);
}

function numberArrayFromSchema(value: any): number[] {
  return arrayFromSchema(value)
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v >= 0);
}

export class GameScene extends Phaser.Scene {
  private hand: CardView[] = [];
  private newCardId = "";
  private selectedCardId = "";
  private newCardFaceDown = false;
  private cardTimerText?: Phaser.GameObjects.Text;
  private spectatorHand = false;
  private handOwnerName = "Dealer";
  private objects: Phaser.GameObjects.GameObject[] = [];
  private pulseText!: Phaser.GameObjects.Text;
  private soundLabel!: Phaser.GameObjects.Text;
  private countdownNumber?: Phaser.GameObjects.Text;
  private offState?: () => void;
  private offRoomInfo?: () => void;
  private offHand?: () => void;
  private offToast?: () => void;

  constructor() {
    super("GameScene");
  }

  preload() {
    if (!this.textures.exists("gameBg")) this.load.image("gameBg", "assets/backgrounds/bg.jpg");
    if (!this.textures.exists("spoonSprite")) this.load.image("spoonSprite", "assets/sprites/spoonSprite.png");
    preloadBackgroundMusic(this);
  }

  create() {
    if (!Net.room) {
      this.scene.start("StartScene");
      return;
    }
    this.drawBackground();
    const sound = addSoundButton(this, () => {
      const on = toggleSound(this);
      this.soundLabel.setText(on ? "♪" : "×");
    });
    this.soundLabel = sound.label;
    this.soundLabel.setText(isSoundOn() ? "♪" : "×");
    syncBackgroundMusic(this);
    this.add.text(640, 38, "Spoons", {
      fontFamily: "Arial",
      fontSize: "42px",
      color: "#ffffff",
      fontStyle: "bold",
      shadow: { offsetX: 0, offsetY: 4, color: "#00162e", blur: 6, fill: true }
    }).setOrigin(0.5);
    this.pulseText = this.add.text(640, 84, "", {
      fontFamily: "Arial",
      fontSize: "23px",
      color: "#ffffff",
      fontStyle: "bold",
      shadow: { offsetX: 0, offsetY: 2, color: "#00162e", blur: 4, fill: true }
    }).setOrigin(0.5);

    this.offState = Net.on("state", () => this.render());
    this.offRoomInfo = Net.on("roomInfo", () => this.render());
    this.offHand = Net.on("hand", (payload) => {
      this.hand = payload.cards ?? [];
      this.newCardId = String(payload.newCardId ?? "");
      this.newCardFaceDown = !!payload.newCardFaceDown || this.hand.some((card) => card.id === this.newCardId && card.faceDown);
      this.selectedCardId = String(payload.selectedCardId ?? this.selectedCardId ?? "");
      this.spectatorHand = !!payload.spectatorView;
      this.handOwnerName = String(payload.handOwnerName ?? "Dealer");
      if (!this.hand.some((card) => card.id === this.selectedCardId)) this.selectedCardId = "";
      this.render();
    });
    this.offToast = Net.on("toast", (payload) => this.toast(payload.message ?? String(payload)));
    Net.send("requestRoomInfo");
    Net.room.send("requestHand");
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.offState?.();
      this.offRoomInfo?.();
      this.offHand?.();
      this.offToast?.();
      this.objects.forEach((o) => o.destroy());
    });
    this.render();
  }

  update() {
    const state: any = Net.room?.state;
    if (!state || state.phase !== "playing") return;
    const countdownMs = this.getCountdownMs(state);
    if (countdownMs > 0) {
      const remaining = Math.max(0, Math.ceil(countdownMs / 100) / 10);
      this.pulseText.setText(`Next round in ${remaining.toFixed(1)}s`);
      this.countdownNumber?.setText(String(Math.max(0, Math.ceil(countdownMs / 1000))));
      return;
    }
    const remaining = this.getPulseSecondsRemainingPrecise();
    this.pulseText.setText(state.scrambleActive ? `SPOON SCRAMBLE! Passes continue in ${remaining.toFixed(1)}s` : `Next pass in ${remaining.toFixed(1)}s`);
    if (this.cardTimerText?.active) {
      this.cardTimerText.setText(`${Math.max(0, Math.ceil(remaining))}s`);
    }
  }

  private getCountdownMs(state: any): number {
    const serverCountdown = Number(Net.lastRoomInfo?.roundCountdownMs);
    if (Number.isFinite(serverCountdown) && serverCountdown > 0) {
      const receivedAt = Number(Net.lastRoomInfo?._receivedAt ?? Date.now());
      return Math.max(0, serverCountdown - (Date.now() - receivedAt));
    }

    const roundStartsAt = Number(Net.lastRoomInfo?.roundStartsAt ?? state?.roundStartsAt ?? 0);
    return roundStartsAt > 0 ? Math.max(0, roundStartsAt - Date.now()) : 0;
  }

  private drawBackground() {
    if (this.textures.exists("gameBg")) {
      this.add.image(640, 360, "gameBg").setDisplaySize(1280, 720);
      this.add.rectangle(640, 360, 1280, 720, 0x00162e, 0.18);
      return;
    }
    const g = this.add.graphics();
    g.fillGradientStyle(0x09233d, 0x0f766e, 0x102a43, 0x1b4332, 1);
    g.fillRect(0, 0, 1280, 720);
  }

  private drawRoomCodePill(state: any) {
    const code = String(Net.lastRoomInfo?.roomCode || state?.roomCode || Net.roomCode || "-----");
    const bg = this.add.rectangle(108, 38, 160, 34, 0x00162e, 0.62).setStrokeStyle(2, 0xffffff, 0.28);
    const txt = this.add.text(108, 38, `Code: ${code}`, {
      fontFamily: "Arial",
      fontSize: "18px",
      color: "#ffffff",
      fontStyle: "bold"
    }).setOrigin(0.5);
    this.objects.push(bg, txt);
  }

  private render() {
    const state: any = Net.room?.state;
    if (!state) return;
    const phase = Net.lastRoomInfo?.phase ?? state.phase;
    if (phase === "results") {
      this.scene.start("ResultsScene");
      return;
    }
    if (phase === "lobby") {
      this.scene.start("LobbyScene");
      return;
    }

    this.objects.forEach((o) => o.destroy());
    this.objects = [];
    this.countdownNumber = undefined;
    this.cardTimerText = undefined;
    this.drawRoomCodePill(state);
    const roster = players();
    const me = roster.find((p) => p.id === Net.playerId);
    const activeOrder = arrayFromSchema(Net.lastRoomInfo?.activeOrderJson ?? Net.lastRoomInfo?.activeOrder ?? state.activeOrderJson ?? state.activeOrder);
    const activeRoster = activeOrder.map((id) => roster.find((p) => p.id === id)).filter(Boolean) as PlayerLike[];
    const myIndex = activeOrder.indexOf(Net.playerId);
    const left = myIndex >= 0 ? activeRoster[(myIndex + 1) % activeRoster.length] : undefined;
    const right = myIndex >= 0 ? activeRoster[(myIndex - 1 + activeRoster.length) % activeRoster.length] : undefined;

    const countdownMs = this.getCountdownMs(state);
    const countdownActive = countdownMs > 0;
    const scrambleActive = Boolean(Net.lastRoomInfo?.scrambleActive ?? state.scrambleActive);
    const hasSpoon = !!me?.hasSpoon;

    this.drawNeighbourPanel(116, 402, "Passes to", left?.name ?? (me?.spectator || me?.eliminated ? "Spectating" : "Waiting"), 0x38bdf8);
    this.drawNeighbourPanel(1164, 402, "Receives from", right?.name ?? (me?.spectator || me?.eliminated ? "Spectating" : "Waiting"), 0xf59e0b);

    const spoonsAvailable = Number(Net.lastRoomInfo?.spoonsAvailable ?? state.spoonsAvailable ?? 0);
    const takenSpoons = numberArrayFromSchema(Net.lastRoomInfo?.takenSpoonsJson ?? Net.lastRoomInfo?.takenSpoons ?? state.takenSpoonsJson);
    const spoonCount = Math.max(0, spoonsAvailable - takenSpoons.length);
    const canGrabFirst = this.hasFourOfKind() && !this.newCardFaceDown && !scrambleActive && !countdownActive && !me?.spectator && !me?.eliminated && !hasSpoon && spoonCount > 0;
    const canGrabScramble = scrambleActive && !countdownActive && !me?.spectator && !me?.eliminated && !hasSpoon && spoonCount > 0;
    this.drawSpoons(spoonCount, scrambleActive, spoonsAvailable, takenSpoons, canGrabFirst || canGrabScramble, hasSpoon, canGrabFirst);

    const countdownMessage = String(Net.lastRoomInfo?.roundMessage ?? state.roundMessage ?? "Round reset. Next round begins soon.");
    const status = countdownActive
      ? countdownMessage
      : me?.spectator && !me?.eliminated
        ? "You joined during an active game. You are spectating until the next game."
        : me?.eliminated
          ? `You are out. Spectator view: watching ${this.handOwnerName}'s hand.`
          : hasSpoon
            ? "You have a spoon. Keep watching until one player misses out."
            : scrambleActive
              ? "A spoon has been taken. Click one of the remaining spoons before they run out."
              : this.newCardFaceDown
              ? "Tap FLIP on the new card, then choose one of your 5 cards to pass left."
              : "Choose one card to pass left before the timer reaches zero.";
    this.objects.push(this.add.text(640, 118, status, {
      fontFamily: "Arial",
      fontSize: "19px",
      color: "#ffffff",
      align: "center",
      wordWrap: { width: 860 },
      shadow: { offsetX: 0, offsetY: 3, color: "#00162e", blur: 5, fill: true }
    }).setOrigin(0.5));

    const activeCount = Net.lastRoomInfo?.activeCount ?? Net.room?.state.activeCount ?? 0;
    const eliminatedCount = Net.lastRoomInfo?.eliminatedCount ?? Net.room?.state.eliminatedCount ?? 0;
    this.objects.push(this.add.text(640, 336, `Active: ${activeCount}    Eliminated: ${eliminatedCount}`, {
      fontFamily: "Arial",
      fontSize: "23px",
      color: "#ffffff",
      fontStyle: "bold",
      shadow: { offsetX: 0, offsetY: 3, color: "#00162e", blur: 5, fill: true }
    }).setOrigin(0.5));

    const readOnly = countdownActive || !!me?.spectator || !!me?.eliminated || hasSpoon;
    const handTitle = this.spectatorHand || me?.spectator || me?.eliminated
      ? `${this.handOwnerName.toUpperCase()}'S HAND — spectator view`
      : hasSpoon
        ? "YOUR HAND — you already have a spoon"
        : this.newCardFaceDown
          ? "YOUR HAND — tap FLIP, then choose a card"
          : "YOUR HAND — tap one card to pass left";
    this.drawHand(readOnly, handTitle);

    this.drawRoundInfo(roster, me);

    if (countdownActive) this.drawCountdownOverlay(countdownMs, countdownMessage);
  }

  private drawNeighbourPanel(x: number, y: number, title: string, name: string, accent: number) {
    const shadow = this.add.rectangle(x + 5, y + 6, 170, 360, 0x000000, 0.18);
    const panel = addPanel(this, x, y, 170, 360, 0xffffff, 0.9);
    const stripe = this.add.rectangle(x, y - 165, 170, 18, accent, 0.95);
    const titleText = this.add.text(x, y - 118, title, { fontFamily: "Arial", fontSize: "19px", color: "#41556e" }).setOrigin(0.5);
    const nameText = this.add.text(x, y - 76, name, {
      fontFamily: "Arial",
      fontSize: "27px",
      color: "#102a43",
      fontStyle: "bold",
      align: "center",
      wordWrap: { width: 138 }
    }).setOrigin(0.5);
    this.objects.push(shadow, panel, stripe, titleText, nameText);
  }

  private drawSpoons(count: number, scramble: boolean, availableFromInfo: number | undefined, takenSlots: number[], canClick: boolean, hasSpoon: boolean, firstSpoonReady: boolean) {
    const totalSlots = Math.max(1, availableFromInfo ?? Net.room?.state.spoonsAvailable ?? 1);
    const taken = new Set(takenSlots);
    const cols = totalSlots > 30 ? 20 : totalSlots > 20 ? 15 : totalSlots > 10 ? 10 : totalSlots;
    const spacingX = totalSlots > 30 ? 31 : totalSlots > 20 ? 36 : totalSlots > 10 ? 42 : 50;
    const spacingY = totalSlots > 30 ? 38 : 42;
    const rows = Math.ceil(totalSlots / cols);
    const spoonW = totalSlots > 30 ? 18 : totalSlots > 20 ? 20 : 24;
    const spoonH = totalSlots > 30 ? 38 : totalSlots > 20 ? 42 : 50;
    const labelY = 158;
    const padY = rows >= 3 ? 236 : 222;
    const startX = 640 - ((cols - 1) * spacingX) / 2;
    const startY = padY - ((rows - 1) * spacingY) / 2;

    this.objects.push(this.add.text(640, labelY, `${count} spoon${count === 1 ? "" : "s"} left`, {
      fontFamily: "Arial",
      fontSize: totalSlots > 30 ? "25px" : "29px",
      color: "#ffffff",
      fontStyle: "bold",
      shadow: { offsetX: 0, offsetY: 3, color: "#00162e", blur: 5, fill: true }
    }).setOrigin(0.5));

    const padW = Math.min(880, Math.max(300, (cols - 1) * spacingX + spoonW + 58));
    const padH = Math.max(74, (rows - 1) * spacingY + spoonH + 36);
    const pad = this.add.rectangle(640, padY, padW, padH, canClick ? 0x173b2e : 0x00162e, canClick ? 0.32 : 0.2)
      .setStrokeStyle(canClick ? 4 : 2, canClick ? 0xdbeafe : 0xffffff, canClick ? 0.95 : 0.18);
    this.objects.push(pad);

    for (let i = 0; i < totalSlots; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = startX + col * spacingX;
      const y = startY + row * spacingY;
      const available = !taken.has(i);
      const clickable = canClick && available;

      if (available && this.textures.exists("spoonSprite")) {
        const spoon = this.add.image(x, y, "spoonSprite").setDisplaySize(spoonW, spoonH).setAlpha(clickable || !scramble ? 1 : 0.9);
        if (clickable) {
          spoon.setInteractive({ useHandCursor: true, pixelPerfect: true, alphaTolerance: 1 });
          spoon.on("pointerdown", () => Net.send("grabSpoon", { spoonIndex: i }));
          this.tweens.add({ targets: spoon, scaleX: spoon.scaleX * 1.08, scaleY: spoon.scaleY * 1.08, yoyo: true, repeat: -1, duration: 420 });
        }
        this.objects.push(spoon);
      } else if (available) {
        // Fallback only if the sprite fails to load. Taken spoons deliberately leave
        // empty space so they look like they have disappeared.
        const fallback = this.add.ellipse(x, y, spoonW * 0.7, spoonH * 0.82, 0xcbd5e1, 0.85)
          .setStrokeStyle(2, 0xffffff, 0.7)
          .setRotation(-0.45);
        this.objects.push(fallback);
      }
    }

    const hint = canClick
      ? firstSpoonReady
        ? "FOUR OF A KIND — CLICK A SILVER SPOON!"
        : "CLICK A SILVER SPOON TO STAY IN!"
      : hasSpoon && scramble
        ? "Spoon secured — wait for the round to finish."
        : scramble
          ? "Only silver spoons can be grabbed."
          : "Spoons unlock after someone flips into four of a kind.";
    this.objects.push(this.add.text(640, padY + padH / 2 + 20, hint, {
      fontFamily: "Arial",
      fontSize: canClick ? "17px" : "14px",
      color: canClick ? "#e0f2fe" : "#dbeafe",
      fontStyle: "bold",
      shadow: { offsetX: 0, offsetY: 2, color: "#00162e", blur: 4, fill: true }
    }).setOrigin(0.5));
  }

  private drawHand(readOnly: boolean, title: string) {
    const panelShadow = this.add.rectangle(640, 594, 770, 172, 0x000000, 0.22);
    const panel = addPanel(this, 640, 586, 770, 172, 0xffffff, 0.94);
    const header = this.add.rectangle(640, 505, 770, 34, readOnly ? 0x41556e : this.newCardFaceDown ? 0xf59e0b : 0x1d4ed8, 0.95);
    const headerText = this.add.text(640, 505, title, {
      fontFamily: "Arial",
      fontSize: "19px",
      color: "#ffffff",
      fontStyle: "bold"
    }).setOrigin(0.5);
    this.objects.push(panelShadow, panel, header, headerText);

    if (this.hand.length === 0) {
      this.objects.push(this.add.text(640, 600, "Waiting for the next deal...", {
        fontFamily: "Arial",
        fontSize: "26px",
        color: "#41556e",
        fontStyle: "bold"
      }).setOrigin(0.5));
      return;
    }

    const spacing = this.hand.length >= 5 ? 124 : 140;
    const startX = 640 - ((this.hand.length - 1) * spacing) / 2;
    const pulseSeconds = this.getPulseSecondsRemaining();

    this.hand.forEach((card, index) => {
      const x = startX + index * spacing;
      const y = 593;
      const selected = !readOnly && card.id === this.selectedCardId;
      const isNew = card.id === this.newCardId;
      const faceDown = !!card.faceDown;
      const mustFlipFirst = !readOnly && this.newCardFaceDown;
      const canFlip = mustFlipFirst && isNew && faceDown;
      const canSelect = !readOnly && !this.newCardFaceDown && !faceDown;
      const fill = faceDown ? 0x1e3a8a : isNew ? 0xfffbeb : 0xffffff;
      const stroke = selected ? 0xf97316 : faceDown ? 0xf59e0b : isNew ? 0xf2c94c : 0x102a43;
      const strokeWidth = selected ? 7 : isNew || faceDown ? 5 : 3;
      const rect = this.add.rectangle(x, y, 100, 126, fill, 1).setStrokeStyle(strokeWidth, stroke, 0.98);

      if (faceDown) {
        const back1 = this.add.rectangle(x, y, 78, 104, 0x2563eb, 0.95).setStrokeStyle(2, 0xdbeafe, 0.9);
        const back2 = this.add.text(x, y, "♠\n♥\n♦\n♣", {
          fontFamily: "Arial",
          fontSize: "18px",
          color: "#dbeafe",
          align: "center",
          fontStyle: "bold"
        }).setOrigin(0.5);
        if (canFlip) {
          rect.setInteractive({ useHandCursor: true });
          back1.setInteractive({ useHandCursor: true });
          back2.setInteractive({ useHandCursor: true });
          const flip = () => Net.send("flipNewCard");
          rect.on("pointerdown", flip);
          back1.on("pointerdown", flip);
          back2.on("pointerdown", flip);
        }
        this.objects.push(rect, back1, back2);
      } else {
        if (canSelect) rect.setInteractive({ useHandCursor: true });
        const rankColor = card.suit === "♥" || card.suit === "♦" ? "#b42318" : "#102a43";
        const txt = this.add.text(x, y + 2, card.short, { fontFamily: "Arial", fontSize: "32px", color: rankColor, fontStyle: "bold" }).setOrigin(0.5);
        if (canSelect) {
          rect.on("pointerdown", () => {
            this.selectedCardId = card.id;
            Net.send("selectDiscard", { cardId: card.id });
            this.render();
          });
        }
        this.objects.push(rect, txt);
      }

      if (isNew) {
        const badgeColour = faceDown ? 0xf97316 : 0xf59e0b;
        const badge = this.add.rectangle(x, y - 83, 82, 26, badgeColour, 1).setStrokeStyle(2, 0xffffff, 0.95);
        const badgeText = this.add.text(x, y - 83, faceDown ? "FLIP" : "NEW", { fontFamily: "Arial", fontSize: "15px", color: "#ffffff", fontStyle: "bold" }).setOrigin(0.5);
        this.objects.push(badge, badgeText);
        if (!readOnly) {
          const seconds = this.getPulseSecondsRemaining();
          const timerBubble = this.add.rectangle(x + 58, y - 83, 42, 26, 0x102a43, 0.92).setStrokeStyle(2, 0xffffff, 0.8);
          this.cardTimerText = this.add.text(x + 58, y - 83, `${seconds}s`, { fontFamily: "Arial", fontSize: "14px", color: "#ffffff", fontStyle: "bold" }).setOrigin(0.5);
          this.objects.push(timerBubble, this.cardTimerText);
        }
      }
      if (selected) {
        const passBadge = this.add.rectangle(x, y + 83, 96, 26, 0xf97316, 1).setStrokeStyle(2, 0xffffff, 0.95);
        const passText = this.add.text(x, y + 83, "PASSING", { fontFamily: "Arial", fontSize: "13px", color: "#ffffff", fontStyle: "bold" }).setOrigin(0.5);
        this.objects.push(passBadge, passText);
      }
    });

    const instruction = readOnly
      ? "Spectators can watch the dealer hand while the remaining players continue."
      : this.newCardFaceDown
        ? "Tap FLIP on the face-down new card first. The game only recognises four of a kind after the card is flipped."
        : this.selectedCardId
          ? "Selected card will pass left on the next pulse. You can change your mind before the timer ends."
          : "New card is revealed. Choose one of your 5 cards to discard left.";
    this.objects.push(this.add.text(640, 692, instruction, {
      fontFamily: "Arial",
      fontSize: "16px",
      color: "#ffffff",
      align: "center",
      wordWrap: { width: 860 },
      shadow: { offsetX: 0, offsetY: 2, color: "#00162e", blur: 4, fill: true }
    }).setOrigin(0.5));
  }

  private getPulseSecondsRemainingPrecise() {
    const info = Net.lastRoomInfo ?? {};
    const receivedAt = Number(info._receivedAt ?? 0);
    const fromInfoMs = Number(info.nextPulseMs);
    if (Number.isFinite(fromInfoMs) && fromInfoMs > 0 && receivedAt > 0) {
      return Math.max(0, Math.ceil((fromInfoMs - (Date.now() - receivedAt)) / 100) / 10);
    }

    const infoAt = Number(info.nextPulseAt ?? 0);
    if (Number.isFinite(infoAt) && infoAt > 0) {
      return Math.max(0, Math.ceil((infoAt - Date.now()) / 100) / 10);
    }

    const state: any = Net.room?.state;
    const stateAt = Number(state?.nextPulseAt ?? 0);
    return Math.max(0, Math.ceil((stateAt - Date.now()) / 100) / 10);
  }

  private getPulseSecondsRemaining() {
    return Math.max(0, Math.ceil(this.getPulseSecondsRemainingPrecise()));
  }

  private drawRoundInfo(roster: PlayerLike[], me?: PlayerLike) {
    const state: any = Net.room?.state;
    const dealerId = String(Net.lastRoomInfo?.dealerId ?? state?.dealerId ?? "");
    const firstId = String(Net.lastRoomInfo?.firstSpoonId ?? state?.firstSpoonId ?? "");
    const dealer = roster.find((p) => p.id === dealerId);
    const first = roster.find((p) => p.id === firstId);
    const myStatus = me?.eliminated
      ? "Spectating"
      : me?.hasSpoon
        ? "Spoon safe"
        : me?.spectator
          ? "Spectating"
          : "Playing";
    const items = [
      `Dealer: ${dealer?.name ?? "-"}`,
      first ? `First spoon: ${first.name}` : "First spoon: waiting",
      `You: ${myStatus}`
    ];
    const widths = [230, 300, 210];
    let x = 640 - widths.reduce((a, b) => a + b, 0) / 2 - 16;
    items.forEach((label, i) => {
      const w = widths[i];
      const cx = x + w / 2;
      const bg = i === 0 ? 0x0ea5e9 : i === 1 ? 0xf59e0b : 0x22c55e;
      const box = this.add.rectangle(cx, 408, w, 34, bg, 0.78).setStrokeStyle(2, 0xffffff, 0.22);
      const text = this.add.text(cx, 408, label, {
        fontFamily: "Arial",
        fontSize: "15px",
        color: "#ffffff",
        fontStyle: "bold"
      }).setOrigin(0.5);
      this.objects.push(box, text);
      x += w + 16;
    });
  }

  private drawCountdownOverlay(countdownMs: number, message: string) {
    const remaining = Math.max(0, Math.ceil(countdownMs / 1000));
    const c = this.add.container(0, 0);
    c.add(this.add.rectangle(640, 360, 1280, 720, 0x000000, 0.18));
    c.add(this.add.rectangle(640, 356, 600, 180, 0xffffff, 0.94).setStrokeStyle(4, 0xfacc15, 0.9));
    const lines = String(message).split("\n").filter(Boolean);
    const mainLine = lines[0] ?? message;
    const secondLine = lines.slice(1).join(" ");
    c.add(this.add.text(640, 300, mainLine, {
      fontFamily: "Arial",
      fontSize: "26px",
      color: "#102a43",
      fontStyle: "bold",
      align: "center",
      wordWrap: { width: 550 }
    }).setOrigin(0.5));
    if (secondLine) {
      c.add(this.add.text(640, 335, secondLine, {
        fontFamily: "Arial",
        fontSize: "22px",
        color: "#41556e",
        fontStyle: "bold",
        align: "center",
        wordWrap: { width: 550 }
      }).setOrigin(0.5));
    }
    this.countdownNumber = this.add.text(640, 402, String(remaining), {
      fontFamily: "Arial",
      fontSize: "54px",
      color: "#f97316",
      fontStyle: "bold"
    }).setOrigin(0.5);
    c.add(this.countdownNumber);
    this.objects.push(c);
  }

  private hasFourOfKind() {
    if (this.hand.length < 4 || this.spectatorHand || this.newCardFaceDown) return false;
    const ranks = new Map<string, number>();
    this.hand.forEach((c) => ranks.set(c.rank, (ranks.get(c.rank) ?? 0) + 1));
    return Array.from(ranks.values()).some((count) => count >= 4);
  }

  private toast(message: string) {
    const t = this.add.text(640, 454, message, {
      fontFamily: "Arial",
      fontSize: "17px",
      color: "#ffffff",
      backgroundColor: "#102a43",
      padding: { x: 12, y: 7 },
      align: "center",
      wordWrap: { width: 600 }
    }).setOrigin(0.5).setDepth(50);
    this.tweens.add({ targets: t, alpha: 0, delay: 1100, duration: 450, onComplete: () => t.destroy() });
  }
}
