import Phaser from "phaser";
import { Net } from "../net/Net";
import { makeButton, TextButton } from "../ui/button";
import { addPanel, addSoundButton } from "../ui/panel";
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

function idsFromSchema(value: any): string[] {
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

export class ResultsScene extends Phaser.Scene {
  private objects: Phaser.GameObjects.GameObject[] = [];
  private buttons: TextButton[] = [];
  private drawing = false;
  private soundLabel!: Phaser.GameObjects.Text;
  private offState?: () => void;

  constructor() {
    super("ResultsScene");
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

    this.offState = Net.on("state", () => this.render());
    Net.send("requestRoomInfo");
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.offState?.();
      this.objects.forEach((o) => o.destroy());
      this.buttons.forEach((b) => b.destroy());
    });
    this.render();
    this.time.delayedCall(350, () => this.runParticipationDraw());
  }

  private drawBackground() {
    if (this.textures.exists("gameBg")) {
      this.add.image(640, 360, "gameBg").setDisplaySize(1280, 720);
      this.add.rectangle(640, 360, 1280, 720, 0x00162e, 0.18);
      return;
    }
    const g = this.add.graphics();
    g.fillGradientStyle(0x182848, 0x4b6cb7, 0x142850, 0x27496d, 1);
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
    const state = Net.room?.state;
    if (!state) return;
    const phase = Net.lastRoomInfo?.phase ?? state.phase;
    if (phase === "lobby") {
      this.scene.start("LobbyScene");
      return;
    }
    if (phase === "playing") {
      this.scene.start("GameScene");
      return;
    }
    this.objects.forEach((o) => o.destroy());
    this.buttons.forEach((b) => b.destroy());
    this.objects = [];
    this.buttons = [];
    this.drawRoomCodePill(state);

    const roster = players();
    const self = roster.find((p) => p.id === Net.playerId);
    const host = !!self?.isHost || Net.isHost;
    this.objects.push(this.add.text(640, 45, "Results", { fontFamily: "Arial", fontSize: "56px", color: "#ffffff", fontStyle: "bold" }).setOrigin(0.5));
    this.objects.push(addPanel(this, 640, 350, 1080, 500, 0xffffff, 0.94));

    const championId = (Net.lastRoomInfo?.championId ?? state.championId) as string;
    const loserId = (Net.lastRoomInfo?.loserId ?? state.loserId) as string;
    const firstId = (Net.lastRoomInfo?.firstSpoonId ?? state.firstSpoonId) as string;
    const champion = roster.find((p) => p.id === championId);
    const loser = roster.find((p) => p.id === loserId);
    const first = roster.find((p) => p.id === firstId);
    const topLine = champion ? `Champion: ${champion.name}` : "Game complete";
    const subLine = champion ? "They claimed the final spoon!" : first ? `${first.name} grabbed the first spoon.` : "The game is finished.";
    this.objects.push(this.add.text(640, 120, topLine, { fontFamily: "Arial", fontSize: "34px", color: "#102a43", fontStyle: "bold" }).setOrigin(0.5));
    this.objects.push(this.add.text(640, 158, subLine, { fontFamily: "Arial", fontSize: "22px", color: "#41556e" }).setOrigin(0.5));

    this.drawRoster(roster);
    this.drawButtons(host, !!champion);
  }

  private drawRoster(roster: PlayerLike[]) {
    const list = roster.filter((p) => p.playedThisGame).sort((a, b) => Number(a.eliminated) - Number(b.eliminated) || b.score - a.score || a.name.localeCompare(b.name)).slice(0, 40);
    this.objects.push(this.add.text(165, 205, "Player results", { fontFamily: "Arial", fontSize: "26px", color: "#102a43", fontStyle: "bold" }));
    const cols = list.length > 30 ? 4 : list.length > 20 ? 3 : 2;
    const rows = Math.ceil(list.length / cols);
    const colW = 240;
    const startX = 165;
    const startY = 250;
    const rowH = Math.min(30, 330 / Math.max(1, rows));
    list.forEach((p, i) => {
      const col = Math.floor(i / rows);
      const row = i % rows;
      const x = startX + col * colW;
      const y = startY + row * rowH;
      const label = `${p.eliminated ? "Out" : "In"}  ${p.firstSpoon ? "★ " : ""}${p.name}${p.isBot ? " (bot)" : ""}`;
      this.objects.push(this.add.text(x, y, label, {
        fontFamily: "Arial",
        fontSize: "18px",
        color: p.connected || p.isBot ? "#102a43" : "#8a97a8"
      }));
    });
  }

  private drawButtons(host: boolean, champion: boolean) {
    if (!host) {
      this.objects.push(this.add.text(640, 642, "Waiting for the host...", { fontFamily: "Arial", fontSize: "24px", color: "#ffffff", fontStyle: "bold" }).setOrigin(0.5));
      return;
    }
    const again = makeButton(this, 505, 642, 240, 58, "Start New Game", () => Net.send("playAgain"), 0x1b9c85);
    const lobby = makeButton(this, 775, 642, 230, 58, "Return to Lobby", () => Net.send("returnLobby"), 0x2f80ed);
    again.setDisabled(this.drawing);
    lobby.setDisabled(this.drawing);
    this.buttons.push(again, lobby);
  }

  private runParticipationDraw() {
    const state = Net.room?.state;
    if (!state || this.drawing) return;
    const roster = players();
    const eligibleIds = idsFromSchema(Net.lastRoomInfo?.awardEligibleIdsJson ?? Net.lastRoomInfo?.awardEligibleIds ?? state.awardEligibleIdsJson ?? state.awardEligibleIds);
    const eligible = eligibleIds.map((id) => roster.find((p) => p.id === id)).filter(Boolean) as PlayerLike[];
    if (eligible.length === 0) return;
    this.drawing = true;
    this.render();
    const overlay = this.add.container(0, 0);
    overlay.add(this.add.rectangle(640, 360, 1280, 720, 0x000000, 0.45));
    overlay.add(this.add.rectangle(640, 360, 560, 250, 0xffffff, 0.98).setStrokeStyle(4, 0xf2c94c, 0.9));
    overlay.add(this.add.text(640, 295, "Participation Award", { fontFamily: "Arial", fontSize: "32px", color: "#102a43", fontStyle: "bold" }).setOrigin(0.5));
    const nameText = this.add.text(640, 365, "", { fontFamily: "Arial", fontSize: "42px", color: "#2f80ed", fontStyle: "bold" }).setOrigin(0.5);
    overlay.add(nameText);

    const winner = eligible[Phaser.Math.Between(0, eligible.length - 1)];
    const cycles = Math.max(12, eligible.length * 2);
    let i = 0;
    const timer = this.time.addEvent({
      delay: 110,
      repeat: cycles,
      callback: () => {
        const p = i >= cycles ? winner : eligible[i % eligible.length];
        nameText.setText(p.name);
        i++;
        if (i > cycles) {
          timer.remove(false);
          this.spawnConfetti(overlay);
          this.time.delayedCall(3000, () => {
            overlay.destroy(true);
            this.drawing = false;
            this.render();
          });
        }
      }
    });
  }

  private spawnConfetti(container: Phaser.GameObjects.Container) {
    for (let i = 0; i < 80; i++) {
      const piece = this.add.rectangle(640, 310, Phaser.Math.Between(6, 12), Phaser.Math.Between(8, 18), Phaser.Display.Color.RandomRGB().color, 1);
      container.add(piece);
      this.tweens.add({
        targets: piece,
        x: 640 + Phaser.Math.Between(-320, 320),
        y: 280 + Phaser.Math.Between(-180, 180),
        rotation: Phaser.Math.FloatBetween(-3, 3),
        alpha: 0,
        duration: 1200,
        ease: "Cubic.Out"
      });
    }
  }
}
