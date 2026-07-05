import Phaser from "phaser";
import { Net } from "../net/Net";
import { makeButton, TextButton } from "../ui/button";
import { addPanel, addSoundButton } from "../ui/panel";
import { cleanName, cleanRoomCode } from "../utils/device";
import { toggleSound, isSoundOn, preloadBackgroundMusic, syncBackgroundMusic } from "../utils/sound";

export class StartScene extends Phaser.Scene {
  private status!: Phaser.GameObjects.Text;
  private hostButton!: TextButton;
  private joinButton!: TextButton;
  private nameInput!: HTMLInputElement;
  private codeInput!: HTMLInputElement;
  private soundLabel!: Phaser.GameObjects.Text;

  constructor() {
    super("StartScene");
  }

  preload() {
    this.load.image("titleBg", "assets/backgrounds/titlebg.jpg");
    this.load.image("gameBg", "assets/backgrounds/bg.jpg");
    preloadBackgroundMusic(this);
  }

  create() {
    this.drawBackground();
    this.drawStartOverlay();

    const html = `
      <div style="display:flex;flex-direction:column;gap:12px;width:300px;font-family:Arial;">
        <input id="playerName" placeholder="Your name" maxlength="12" style="font-size:22px;padding:11px;border-radius:12px;border:2px solid #b8c4d6;text-align:center;outline:none;background:#ffffff;color:#102a43;" />
        <input id="roomCode" placeholder="5-digit room code" maxlength="5" inputmode="numeric" pattern="[0-9]*" style="font-size:22px;padding:11px;border-radius:12px;border:2px solid #b8c4d6;text-align:center;outline:none;background:#ffffff;color:#102a43;" />
      </div>`;
    const dom = this.add.dom(640, 502).createFromHTML(html);
    this.nameInput = dom.getChildByID("playerName") as HTMLInputElement;
    this.codeInput = dom.getChildByID("roomCode") as HTMLInputElement;
    this.nameInput.value = localStorage.getItem("spoonsPlayerName") ?? "";
    this.codeInput.addEventListener("input", () => (this.codeInput.value = cleanRoomCode(this.codeInput.value)));

    this.hostButton = makeButton(this, 545, 608, 160, 50, "Host Game", () => this.hostGame(), 0x1b9c85);
    this.joinButton = makeButton(this, 735, 608, 160, 50, "Join Game", () => this.joinGame(), 0x2f80ed);
    this.status = this.add.text(640, 660, "Enter a name, then host or join a classroom.", {
      fontFamily: "Arial",
      fontSize: "17px",
      color: "#324761",
      align: "center",
      wordWrap: { width: 340 }
    }).setOrigin(0.5);

    const sound = addSoundButton(this, () => {
      const on = toggleSound(this);
      this.soundLabel.setText(on ? "♪" : "×");
    });
    this.soundLabel = sound.label;
    this.soundLabel.setText(isSoundOn() ? "♪" : "×");
    syncBackgroundMusic(this);
  }

  private drawBackground() {
    if (this.textures.exists("titleBg")) {
      this.add.image(640, 360, "titleBg").setDisplaySize(1280, 720);
      return;
    }
    const g = this.add.graphics();
    g.fillGradientStyle(0x142850, 0x27496d, 0x0f3057, 0x2c7da0, 1);
    g.fillRect(0, 0, 1280, 720);
  }

  private drawStartOverlay() {
    // Lowered and re-spaced so the title artwork remains visible and the
    // CREATE OR JOIN ribbon no longer overlaps the input fields.
    const shadow = this.add.graphics();
    shadow.fillStyle(0x000000, 0.34);
    shadow.fillRoundedRect(447, 398, 386, 284, 24);

    const panel = this.add.graphics();
    panel.fillGradientStyle(0xffffff, 0xffffff, 0xeaf7ff, 0xe9f0fa, 0.97);
    panel.fillRoundedRect(440, 390, 386, 284, 24);
    panel.lineStyle(5, 0xffffff, 0.86);
    panel.strokeRoundedRect(440, 390, 386, 284, 24);
    panel.lineStyle(3, 0x2f80ed, 0.35);
    panel.strokeRoundedRect(449, 399, 368, 266, 18);

    const mini = this.add.graphics();
    mini.fillGradientStyle(0x2f80ed, 0x7b61ff, 0x18a2c7, 0x31c48d, 0.98);
    mini.fillRoundedRect(476, 410, 328, 34, 14);
    this.add.text(640, 427, "CREATE OR JOIN", {
      fontFamily: "Arial",
      fontSize: "17px",
      color: "#ffffff",
      fontStyle: "bold"
    }).setOrigin(0.5);
  }

  private async hostGame() {
    const name = cleanName(this.nameInput.value);
    localStorage.setItem("spoonsPlayerName", name);
    this.setConnecting(true, "Creating classroom... free servers can take a moment to wake.");
    try {
      await Net.createRoom(name);
      this.scene.start("LobbyScene");
    } catch (err) {
      this.setConnecting(false, this.messageFromError(err));
    }
  }

  private async joinGame() {
    const name = cleanName(this.nameInput.value);
    const code = cleanRoomCode(this.codeInput.value);
    if (code.length !== 5) {
      this.status.setText("Please enter a 5-digit room code.");
      return;
    }
    localStorage.setItem("spoonsPlayerName", name);
    this.setConnecting(true, "Joining classroom... waking the server if needed.");
    try {
      await Net.joinRoom(name, code);
      this.scene.start("LobbyScene");
    } catch (err) {
      this.setConnecting(false, this.messageFromError(err));
    }
  }

  private setConnecting(connecting: boolean, message: string) {
    this.nameInput.disabled = connecting;
    this.codeInput.disabled = connecting;
    this.hostButton.setDisabled(connecting);
    this.joinButton.setDisabled(connecting);
    this.status.setText(message);
  }

  private messageFromError(err: unknown) {
    const text = err instanceof Error ? err.message : String(err);
    if (text.includes("capacity")) return "Game is at capacity. Try again later.";
    if (text.includes("duplicate") || text.includes("same device")) return "This device is already in the room.";
    if (text.includes("matchmake")) return "Room not found. Check the 5-digit code.";
    return "Connection failed. Check that the local server is running.";
  }
}
