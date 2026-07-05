import Phaser from "phaser";
import { Net } from "../net/Net";
import { makeButton, TextButton } from "../ui/button";
import { addSoundButton } from "../ui/panel";
import { toggleSound, isSoundOn, preloadBackgroundMusic, syncBackgroundMusic } from "../utils/sound";

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
}

function sortRoster(players: PlayerLike[]): PlayerLike[] {
  return players.sort((a, b) => Number(b.isHost) - Number(a.isHost) || Number(a.isBot) - Number(b.isBot) || String(a.name).localeCompare(String(b.name)));
}

function readPlayers(): PlayerLike[] {
  const infoPlayers = Net.lastRoomInfo?.players;
  if (Array.isArray(infoPlayers)) return sortRoster(infoPlayers as PlayerLike[]);

  const infoJson = Net.lastRoomInfo?.playersJson;
  if (typeof infoJson === "string" && infoJson.length) {
    try {
      const parsed = JSON.parse(infoJson);
      if (Array.isArray(parsed)) return sortRoster(parsed as PlayerLike[]);
    } catch {
      return [];
    }
  }

  const state: any = Net.room?.state;
  if (!state) return [];
  if (typeof state.playersJson === "string" && state.playersJson.length) {
    try {
      const parsed = JSON.parse(state.playersJson);
      if (Array.isArray(parsed)) return sortRoster(parsed as PlayerLike[]);
    } catch {
      return [];
    }
  }

  const players: PlayerLike[] = [];
  const map: any = state.players;
  if (!map) return players;
  if (typeof map.forEach === "function") {
    map.forEach((value: any, key: string) => players.push({ id: value?.id || key, ...value }));
  } else {
    Object.entries(map).forEach(([key, value]: [string, any]) => players.push({ id: value?.id || key, ...value }));
  }
  return sortRoster(players);
}

export class LobbyScene extends Phaser.Scene {
  private playerTexts: Phaser.GameObjects.GameObject[] = [];
  private hostButtons: TextButton[] = [];
  private info!: Phaser.GameObjects.Text;
  private soundLabel!: Phaser.GameObjects.Text;
  private manageOverlay?: Phaser.GameObjects.Container;
  private manageOpen = false;
  private offState?: () => void;
  private offRoomInfo?: () => void;
  private offToast?: () => void;

  constructor() {
    super("LobbyScene");
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
    this.drawLobbyShell();

    this.info = this.add.text(640, 112, "", {
      fontFamily: "Arial",
      fontSize: "27px",
      color: "#ffffff",
      fontStyle: "bold",
      shadow: { offsetX: 0, offsetY: 3, color: "#00162e", blur: 5, fill: true }
    }).setOrigin(0.5);

    const sound = addSoundButton(this, () => {
      const on = toggleSound(this);
      this.soundLabel.setText(on ? "♪" : "×");
    });
    this.soundLabel = sound.label;
    this.soundLabel.setText(isSoundOn() ? "♪" : "×");
    syncBackgroundMusic(this);

    this.offState = Net.on("state", () => this.render());
    this.offRoomInfo = Net.on("roomInfo", () => this.render());
    this.offToast = Net.on("toast", (payload) => this.showToast(payload.message ?? String(payload)));
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.offState?.();
      this.offRoomInfo?.();
      this.offToast?.();
      this.manageOverlay?.destroy(true);
    });

    Net.send("requestRoomInfo");
    this.render();
    this.time.delayedCall(160, () => this.render());
  }

  private drawBackground() {
    if (this.textures.exists("gameBg")) {
      this.add.image(640, 360, "gameBg").setDisplaySize(1280, 720);
      this.add.rectangle(640, 360, 1280, 720, 0x00162e, 0.12);
      return;
    }
    const g = this.add.graphics();
    g.fillGradientStyle(0x071326, 0x123c69, 0x08162d, 0x0b2342, 1);
    g.fillRect(0, 0, 1280, 720);
  }

  private drawLobbyShell() {
    this.add.text(640, 45, "Spoons Lobby", {
      fontFamily: "Arial",
      fontSize: "58px",
      color: "#ffffff",
      fontStyle: "bold",
      shadow: { offsetX: 0, offsetY: 5, color: "#00162e", blur: 7, fill: true }
    }).setOrigin(0.5);

    const shadow = this.add.graphics();
    shadow.fillStyle(0x000000, 0.28);
    shadow.fillRoundedRect(67, 153, 1146, 526, 26);

    const panel = this.add.graphics();
    panel.fillGradientStyle(0xffffff, 0xffffff, 0xeaf2ff, 0xe2ecf8, 0.97);
    panel.fillRoundedRect(60, 146, 1160, 526, 26);
    panel.lineStyle(5, 0xffffff, 0.78);
    panel.strokeRoundedRect(60, 146, 1160, 526, 26);
    panel.lineStyle(3, 0x2f80ed, 0.25);
    panel.strokeRoundedRect(68, 154, 1144, 510, 20);

    const banner = this.add.graphics();
    banner.fillGradientStyle(0x2f80ed, 0x7b61ff, 0x19a7ce, 0x31c48d, 0.95);
    banner.fillRoundedRect(86, 170, 1108, 47, 18);
    this.add.text(108, 181, "CLASSROOM TABLE", { fontFamily: "Arial", fontSize: "22px", color: "#ffffff", fontStyle: "bold" });
    this.add.text(1170, 181, "40 SEATS", { fontFamily: "Arial", fontSize: "20px", color: "#ffffff", fontStyle: "bold" }).setOrigin(1, 0);
    this.add.text(640, 198, "Add test bots • manage names • start when ready", {
      fontFamily: "Arial",
      fontSize: "14px",
      color: "#eef7ff",
      fontStyle: "bold"
    }).setOrigin(0.5);
  }

  private render() {
    const state: any = Net.room?.state;
    if (!state) return;
    const phase = Net.lastRoomInfo?.phase ?? state.phase;
    if (phase === "playing") {
      this.scene.start("GameScene");
      return;
    }
    if (phase === "results") {
      this.scene.start("ResultsScene");
      return;
    }

    const roster = readPlayers();
    const self = roster.find((p) => p.id === Net.playerId);
    const isHost = !!self?.isHost || Net.isHost;
    const humanCount = Number.isFinite(Net.lastRoomInfo?.humans) ? Number(Net.lastRoomInfo.humans) : roster.filter((p) => !p.isBot && p.connected !== false).length || (Net.playerId ? 1 : 0);
    const botCount = Number.isFinite(Net.lastRoomInfo?.bots) ? Number(Net.lastRoomInfo.bots) : roster.filter((p) => p.isBot).length;
    const totalCount = Math.min(40, humanCount + botCount);
    const roomCode = String(Net.lastRoomInfo?.roomCode || state.roomCode || Net.roomCode || "-----");
    this.info.setText(`Code: ${roomCode}    Humans: ${humanCount}    Bots: ${botCount}    Seats: ${totalCount}/40`);

    this.playerTexts.forEach((x) => x.destroy());
    this.playerTexts = [];
    this.hostButtons.forEach((b) => b.destroy());
    this.hostButtons = [];

    this.drawSeatTable(roster, isHost);

    if (isHost) {
      this.renderHostControls(roster, humanCount, botCount);
      if (this.manageOpen) this.redrawManageOverlay();
    } else {
      this.closeManageOverlay();
      this.playerTexts.push(this.add.text(640, 642, "Waiting for the host to start the game...", {
        fontFamily: "Arial",
        fontSize: "22px",
        color: "#41556e",
        fontStyle: "bold"
      }).setOrigin(0.5));
    }
  }

  private drawSeatTable(roster: PlayerLike[], isHost: boolean) {
    const visibleRoster = roster.length
      ? roster
      : [{ id: Net.playerId, name: "You", isHost, isBot: false, connected: true, eliminated: false, spectator: false, hasSpoon: false, firstSpoon: false, score: 0 }];

    const startX = 96;
    const startY = 248;
    const colW = 258;
    const rowH = 28;
    const gapX = 18;
    const gapY = 7;
    const rows = 10;

    for (let col = 0; col < 4; col++) {
      const x = startX + col * (colW + gapX);
      const colHeader = this.add.graphics();
      colHeader.fillStyle([0x2f80ed, 0x31c48d, 0x7b61ff, 0xf97316][col], 0.95);
      colHeader.fillRoundedRect(x, startY - 26, colW, 22, 9);
      this.playerTexts.push(colHeader);
      this.playerTexts.push(this.add.text(x + colW / 2, startY - 24, `Seats ${col * rows + 1}-${col * rows + 10}`, {
        fontFamily: "Arial",
        fontSize: "14px",
        color: "#ffffff",
        fontStyle: "bold"
      }).setOrigin(0.5, 0));
    }

    for (let slot = 0; slot < 40; slot++) {
      const col = Math.floor(slot / rows);
      const row = slot % rows;
      const x = startX + col * (colW + gapX);
      const y = startY + row * (rowH + gapY);
      const p = visibleRoster[slot];

      const cell = this.add.graphics();
      const fill = p ? (p.isHost ? 0xe7f3ff : p.isBot ? 0xf2edff : 0xffffff) : 0xf6f9fd;
      const stroke = p?.isHost ? 0x2f80ed : p?.isBot ? 0x7b61ff : p ? 0x31c48d : 0xd4deea;
      cell.fillStyle(fill, p ? 0.98 : 0.78);
      cell.fillRoundedRect(x, y, colW, rowH, 8);
      cell.lineStyle(p ? 2 : 1, stroke, p ? 0.9 : 0.55);
      cell.strokeRoundedRect(x, y, colW, rowH, 8);
      if (p?.isHost) {
        cell.fillStyle(0x2f80ed, 0.16);
        cell.fillRoundedRect(x + 2, y + 2, colW - 4, rowH - 4, 7);
      }
      this.playerTexts.push(cell);

      this.playerTexts.push(this.add.text(x + 11, y + 6, String(slot + 1).padStart(2, "0"), {
        fontFamily: "Arial",
        fontSize: "14px",
        color: p ? "#41556e" : "#9aa7b8",
        fontStyle: "bold"
      }));

      if (p) {
        const tag = p.isHost ? "HOST" : p.isBot ? "BOT" : p.connected ? "" : "OFF";
        const rawName = p.id === Net.playerId ? `${p.name}  (You)` : p.name;
        const name = rawName.length > 17 ? `${rawName.slice(0, 16)}…` : rawName;
        const color = p.connected || p.isBot ? "#102a43" : "#8a97a8";
        this.playerTexts.push(this.add.text(x + 43, y + 5, name, {
          fontFamily: "Arial",
          fontSize: "15px",
          color,
          fontStyle: p.isHost || p.id === Net.playerId ? "bold" : "normal"
        }));
        if (tag) {
          this.playerTexts.push(this.add.text(x + colW - 11, y + 6, tag, {
            fontFamily: "Arial",
            fontSize: "12px",
            color: p.isHost ? "#2f80ed" : p.isBot ? "#7b61ff" : "#8a97a8",
            fontStyle: "bold"
          }).setOrigin(1, 0));
        }
      } else {
        this.playerTexts.push(this.add.text(x + 43, y + 6, "Empty", {
          fontFamily: "Arial",
          fontSize: "14px",
          color: "#9aa7b8"
        }));
      }
    }
  }

  private renderHostControls(roster: PlayerLike[], humanCount?: number, botCount?: number) {
    const humans = humanCount ?? (roster.filter((p) => !p.isBot && p.connected !== false).length || 1);
    const bots = botCount ?? roster.filter((p) => p.isBot).length;
    const canStart = humans + bots >= 2;

    const dock = this.add.graphics();
    dock.fillStyle(0x102a43, 0.13);
    dock.fillRoundedRect(212, 611, 856, 56, 18);
    this.playerTexts.push(dock);

    const start = makeButton(this, 315, 639, 160, 44, "Start Game", () => Net.send("startGame"), 0x1b9c85);
    start.setDisabled(!canStart);
    this.hostButtons.push(start);

    this.hostButtons.push(makeButton(this, 505, 639, 190, 44, "Manage Players", () => this.openManageOverlay(), 0x2f80ed));
    this.hostButtons.push(makeButton(this, 680, 639, 130, 44, "+8 Bots", () => Net.send("addBots", { mode: "eight" }), 0x7b61ff));
    this.hostButtons.push(makeButton(this, 825, 639, 130, 44, "Fill 40", () => Net.send("addBots", { mode: "fill" }), 0x8b5cf6));
    this.hostButtons.push(makeButton(this, 970, 639, 130, 44, "No Bots", () => Net.send("clearBots"), 0x9b2c2c));
  }

  private openManageOverlay() {
    this.manageOpen = true;
    this.redrawManageOverlay();
  }

  private closeManageOverlay() {
    this.manageOpen = false;
    this.manageOverlay?.destroy(true);
    this.manageOverlay = undefined;
  }

  private redrawManageOverlay() {
    if (!this.manageOpen) return;

    this.manageOverlay?.destroy(true);

    const c = this.add.container(0, 0);
    c.setDepth(20000);

    const blocker = this.add.rectangle(640, 360, 1280, 720, 0x000000, 0.58).setInteractive({ useHandCursor: false });
    c.add(blocker);

    const shell = this.add.graphics();
    shell.fillStyle(0x000000, 0.32);
    shell.fillRoundedRect(142, 88, 1004, 548, 30);
    shell.fillGradientStyle(0xffffff, 0xffffff, 0xeaf2ff, 0xe5eefb, 0.99);
    shell.fillRoundedRect(134, 80, 1004, 548, 30);
    shell.lineStyle(5, 0xffffff, 0.82);
    shell.strokeRoundedRect(134, 80, 1004, 548, 30);
    shell.lineStyle(3, 0x2f80ed, 0.42);
    shell.strokeRoundedRect(144, 90, 984, 528, 24);
    c.add(shell);

    const banner = this.add.graphics();
    banner.fillGradientStyle(0x2f80ed, 0x7b61ff, 0x19a7ce, 0x31c48d, 0.97);
    banner.fillRoundedRect(168, 106, 944, 58, 18);
    c.add(banner);

    c.add(this.add.text(640, 134, "Manage Players", {
      fontFamily: "Arial",
      fontSize: "36px",
      color: "#ffffff",
      fontStyle: "bold",
      shadow: { offsetX: 0, offsetY: 3, color: "#0b2342", blur: 5, fill: true }
    }).setOrigin(0.5));

    c.add(this.add.text(640, 178, "Kick test bots or remove inappropriate names. The lobby table stays locked behind this panel.", {
      fontFamily: "Arial",
      fontSize: "16px",
      color: "#41556e",
      fontStyle: "bold",
      align: "center"
    }).setOrigin(0.5));

    const close = makeButton(this, 1061, 134, 96, 38, "Close", () => this.closeManageOverlay(), 0x41556e);
    c.add([close.box, close.label]);

    const roster = readPlayers().filter((p) => !p.isHost).slice(0, 39);
    if (roster.length === 0) {
      c.add(this.add.text(640, 360, "No other players yet.", { fontFamily: "Arial", fontSize: "24px", color: "#41556e", fontStyle: "bold" }).setOrigin(0.5));
      this.manageOverlay = c;
      return;
    }

    const startX = 170;
    const startY = 216;
    const colW = 225;
    const rowH = 30;
    const gapX = 22;
    const gapY = 8;
    const rows = 10;

    for (let col = 0; col < 4; col++) {
      const x = startX + col * (colW + gapX);
      const header = this.add.graphics();
      header.fillStyle([0x2f80ed, 0x31c48d, 0x7b61ff, 0xf97316][col], 0.96);
      header.fillRoundedRect(x, startY - 30, colW, 23, 9);
      c.add(header);
      c.add(this.add.text(x + colW / 2, startY - 27, `Players ${col * rows + 1}-${col * rows + 10}`, {
        fontFamily: "Arial",
        fontSize: "13px",
        color: "#ffffff",
        fontStyle: "bold"
      }).setOrigin(0.5, 0));
    }

    roster.forEach((p, i) => {
      const col = Math.floor(i / rows);
      const row = i % rows;
      const x = startX + col * (colW + gapX);
      const y = startY + row * (rowH + gapY);

      const cell = this.add.graphics();
      cell.fillStyle(p.isBot ? 0xf2edff : 0xffffff, 0.96);
      cell.fillRoundedRect(x, y, colW, rowH, 9);
      cell.lineStyle(2, p.isBot ? 0x7b61ff : 0x31c48d, 0.45);
      cell.strokeRoundedRect(x, y, colW, rowH, 9);
      c.add(cell);

      const rawName = `${String(i + 1).padStart(2, "0")}  ${p.name}${p.isBot ? " (bot)" : ""}`;
      const name = rawName.length > 18 ? `${rawName.slice(0, 17)}…` : rawName;
      c.add(this.add.text(x + 12, y + 7, name, {
        fontFamily: "Arial",
        fontSize: "14px",
        color: "#102a43",
        fontStyle: p.isBot ? "bold" : "normal"
      }));

      const kickBg = this.add.rectangle(x + colW - 39, y + rowH / 2, 66, 23, 0xfffbeb, 1)
        .setStrokeStyle(2, 0xf97316, 0.75)
        .setInteractive({ useHandCursor: true });
      const kickText = this.add.text(x + colW - 39, y + rowH / 2, "Kick", {
        fontFamily: "Arial",
        fontSize: "13px",
        color: "#b42318",
        fontStyle: "bold"
      }).setOrigin(0.5).setInteractive({ useHandCursor: true });

      const doKick = () => {
        kickBg.disableInteractive().setAlpha(0.45);
        kickText.disableInteractive().setAlpha(0.45).setText("...");
        Net.send("kick", { playerId: p.id });
      };
      kickBg.on("pointerdown", doKick);
      kickText.on("pointerdown", doKick);
      c.add([kickBg, kickText]);
    });

    this.manageOverlay = c;
  }

  private showToast(message: string) {
    const bg = this.add.graphics();
    bg.fillStyle(0x102a43, 0.94);
    bg.fillRoundedRect(420, 124, 440, 46, 18);
    const t = this.add.text(640, 147, message, {
      fontFamily: "Arial",
      fontSize: "19px",
      color: "#ffffff",
      fontStyle: "bold",
      align: "center",
      wordWrap: { width: 400 }
    }).setOrigin(0.5);
    this.tweens.add({ targets: [t, bg], alpha: 0, delay: 1500, duration: 420, onComplete: () => { t.destroy(); bg.destroy(); } });
  }
}
