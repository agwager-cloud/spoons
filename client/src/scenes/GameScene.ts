import Phaser from "phaser";
import { Net } from "../net/Net";
import { addPanel, addSoundButton } from "../ui/panel";
import { toggleSound, isSoundOn, preloadBackgroundMusic, syncBackgroundMusic } from "../utils/sound";

interface CardView { id: string; rank: string; suit: string; short: string; }
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
    const remaining = Math.max(0, Math.ceil((state.nextPulseAt - Date.now()) / 100) / 10);
    this.pulseText.setText(state.scrambleActive ? `SPOON SCRAMBLE! Passes continue in ${remaining.toFixed(1)}s` : `Next pass in ${remaining.toFixed(1)}s`);
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
    const canGrabFirst = this.hasFourOfKind() && !scrambleActive && !countdownActive && !me?.spectator && !me?.eliminated && !hasSpoon && spoonCount > 0;
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
              : "Pick up the new card first. Then tap one of your 5 cards to pass left.";
    this.objects.push(this.add.text(640, 120, status, {
      fontFamily: "Arial",
      fontSize: "19px",
      color: "#ffffff",
      align: "center",
      wordWrap: { width: 850 },
      shadow: { offsetX: 0, offsetY: 3, color: "#00162e", blur: 5, fill: true }
    }).setOrigin(0.5));

    const activeCount = Net.lastRoomInfo?.activeCount ?? Net.room?.state.activeCount ?? 0;
    const eliminatedCount = Net.lastRoomInfo?.eliminatedCount ?? Net.room?.state.eliminatedCount ?? 0;
    this.objects.push(this.add.text(640, 344, `Active: ${activeCount}    Eliminated: ${eliminatedCount}`, {
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
    const cols = Math.min(13, totalSlots);
    const spacingX = 40;
    const spacingY = 40;
    const rows = Math.ceil(totalSlots / cols);
    const centerY = rows >= 3 ? 220 : 218;
    const startX = 640 - ((cols - 1) * spacingX) / 2;
    const startY = centerY - ((rows - 1) * spacingY) / 2;

    this.objects.push(this.add.text(640, 166, `${count} spoon${count === 1 ? "" : "s"} left`, {
      fontFamily: "Arial",
      fontSize: "30px",
      color: "#ffffff",
      fontStyle: "bold",
      shadow: { offsetX: 0, offsetY: 3, color: "#00162e", blur: 5, fill: true }
    }).setOrigin(0.5));

    const padW = Math.min(760, Math.max(280, cols * spacingX + 48));
    const padH = Math.max(68, rows * spacingY + 32);
    const padY = startY + ((rows - 1) * spacingY) / 2;
    const pad = this.add.rectangle(640, padY, padW, padH, canClick ? 0x173b2e : 0x00162e, canClick ? 0.28 : 0.18)
      .setStrokeStyle(canClick ? 4 : 2, canClick ? 0xfacc15 : 0xffffff, canClick ? 0.95 : 0.16);
    this.objects.push(pad);

    for (let i = 0; i < totalSlots; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = startX + col * spacingX;
      const y = startY + row * spacingY;
      const available = !taken.has(i);
      const clickable = canClick && available;
      const spoon = this.add.ellipse(x, y, clickable ? 20 : 16, clickable ? 46 : 39, available ? 0xf2c94c : 0x56616f, available ? 1 : 0.28)
        .setStrokeStyle(clickable ? 5 : scramble && available ? 3 : 2, clickable ? 0xfffbeb : 0xffffff, clickable ? 1 : 0.65)
        .setRotation(-0.45);
      if (clickable) {
        spoon.setInteractive({ useHandCursor: true });
        spoon.on("pointerdown", () => Net.send("grabSpoon", { spoonIndex: i }));
      }
      this.objects.push(spoon);
    }

    const hint = canClick
      ? firstSpoonReady
        ? "FOUR OF A KIND — CLICK A GOLD SPOON!"
        : "CLICK A GOLD SPOON TO STAY IN!"
      : hasSpoon && scramble
        ? "Spoon secured — wait for the round to finish."
        : scramble
          ? "Only gold spoons can be grabbed."
          : "Spoons unlock when someone gets four of a kind.";
    this.objects.push(this.add.text(640, padY + padH / 2 + 24, hint, {
      fontFamily: "Arial",
      fontSize: canClick ? "18px" : "15px",
      color: canClick ? "#facc15" : "#dbeafe",
      fontStyle: "bold",
      shadow: { offsetX: 0, offsetY: 2, color: "#00162e", blur: 4, fill: true }
    }).setOrigin(0.5));
  }

  private drawHand(readOnly: boolean, title: string) {
    const panelShadow = this.add.rectangle(640, 590, 770, 176, 0x000000, 0.22);
    const panel = addPanel(this, 640, 582, 770, 176, 0xffffff, 0.94);
    const header = this.add.rectangle(640, 500, 770, 36, readOnly ? 0x41556e : 0x1d4ed8, 0.92);
    const headerText = this.add.text(640, 500, title, {
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
    this.hand.forEach((card, index) => {
      const x = startX + index * spacing;
      const y = 588;
      const selected = !readOnly && card.id === this.selectedCardId;
      const isNew = card.id === this.newCardId;
      const fill = isNew ? 0xfffbeb : 0xffffff;
      const stroke = selected ? 0xf97316 : isNew ? 0xf2c94c : 0x102a43;
      const strokeWidth = selected ? 7 : isNew ? 5 : 3;
      const rect = this.add.rectangle(x, y, 100, 126, fill, 1).setStrokeStyle(strokeWidth, stroke, 0.98);
      if (!readOnly) rect.setInteractive({ useHandCursor: true });
      const rankColor = card.suit === "♥" || card.suit === "♦" ? "#b42318" : "#102a43";
      const txt = this.add.text(x, y + 2, card.short, { fontFamily: "Arial", fontSize: "32px", color: rankColor, fontStyle: "bold" }).setOrigin(0.5);
      if (!readOnly) {
        rect.on("pointerdown", () => {
          this.selectedCardId = card.id;
          Net.send("selectDiscard", { cardId: card.id });
          this.render();
        });
      }
      this.objects.push(rect, txt);

      if (isNew) {
        const badge = this.add.rectangle(x, y - 83, 82, 26, 0xf59e0b, 1).setStrokeStyle(2, 0xffffff, 0.95);
        const badgeText = this.add.text(x, y - 83, "NEW", { fontFamily: "Arial", fontSize: "15px", color: "#ffffff", fontStyle: "bold" }).setOrigin(0.5);
        this.objects.push(badge, badgeText);
      }
      if (selected) {
        const passBadge = this.add.rectangle(x, y + 83, 96, 26, 0xf97316, 1).setStrokeStyle(2, 0xffffff, 0.95);
        const passText = this.add.text(x, y + 83, "PASSING", { fontFamily: "Arial", fontSize: "13px", color: "#ffffff", fontStyle: "bold" }).setOrigin(0.5);
        this.objects.push(passBadge, passText);
      }
    });

    const instruction = readOnly
      ? "Spectators can watch the dealer hand while the remaining players continue."
      : this.selectedCardId
        ? "Selected card will pass left on the next pulse. You can change your mind before the timer ends."
        : "You have 5 cards after picking up. Choose the card you want to discard left.";
    this.objects.push(this.add.text(640, 690, instruction, {
      fontFamily: "Arial",
      fontSize: "16px",
      color: "#ffffff",
      align: "center",
      wordWrap: { width: 820 },
      shadow: { offsetX: 0, offsetY: 2, color: "#00162e", blur: 4, fill: true }
    }).setOrigin(0.5));
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
    c.add(this.add.rectangle(640, 356, 560, 170, 0xffffff, 0.94).setStrokeStyle(4, 0xfacc15, 0.9));
    c.add(this.add.text(640, 318, message, {
      fontFamily: "Arial",
      fontSize: "24px",
      color: "#102a43",
      fontStyle: "bold",
      align: "center",
      wordWrap: { width: 510 }
    }).setOrigin(0.5));
    this.countdownNumber = this.add.text(640, 392, String(remaining), {
      fontFamily: "Arial",
      fontSize: "54px",
      color: "#f97316",
      fontStyle: "bold"
    }).setOrigin(0.5);
    c.add(this.countdownNumber);
    this.objects.push(c);
  }

  private hasFourOfKind() {
    if (this.hand.length < 4 || this.spectatorHand) return false;
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
