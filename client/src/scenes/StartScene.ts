import Phaser from "phaser";
import { Net } from "../net/Net";
import { makeButton, TextButton } from "../ui/button";
import { addSoundButton } from "../ui/panel";
import { cleanName, cleanRoomCode } from "../utils/device";
import { toggleSound, isSoundOn, preloadBackgroundMusic, syncBackgroundMusic } from "../utils/sound";

export class StartScene extends Phaser.Scene {
  private status!: Phaser.GameObjects.Text;
  private hostButton!: TextButton;
  private joinButton!: TextButton;
  private nameInput!: HTMLInputElement;
  private codeInput!: HTMLInputElement;
  private soundLabel!: Phaser.GameObjects.Text;
  private progressTrack!: Phaser.GameObjects.Graphics;
  private progressFill!: Phaser.GameObjects.Graphics;
  private elapsedText!: Phaser.GameObjects.Text;
  private connectionStartedAt = 0;
  private connectionTimer?: Phaser.Time.TimerEvent;
  private connecting = false;

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
    const dom = this.add.dom(640, 492).createFromHTML(html);
    this.nameInput = dom.getChildByID("playerName") as HTMLInputElement;
    this.codeInput = dom.getChildByID("roomCode") as HTMLInputElement;
    this.nameInput.value = localStorage.getItem("spoonsPlayerName") ?? "";
    this.codeInput.addEventListener("input", () => (this.codeInput.value = cleanRoomCode(this.codeInput.value)));

    this.hostButton = makeButton(this, 545, 584, 160, 50, "Host Game", () => this.hostGame(), 0x1b9c85);
    this.joinButton = makeButton(this, 735, 584, 160, 50, "Join Game", () => this.joinGame(), 0x2f80ed);
    this.status = this.add.text(640, 633, "Enter a name, then host or join a classroom.", {
      fontFamily: "Arial",
      fontSize: "16px",
      color: "#324761",
      align: "center",
      wordWrap: { width: 344 }
    }).setOrigin(0.5);

    this.progressTrack = this.add.graphics().setVisible(false);
    this.progressTrack.fillStyle(0xc7d5e5, 1);
    this.progressTrack.fillRoundedRect(480, 664, 320, 12, 6);
    this.progressFill = this.add.graphics().setVisible(false);
    this.elapsedText = this.add.text(640, 691, "", {
      fontFamily: "Arial",
      fontSize: "14px",
      color: "#3d526a",
      align: "center"
    }).setOrigin(0.5).setVisible(false);

    const sound = addSoundButton(this, () => {
      const on = toggleSound(this);
      this.soundLabel.setText(on ? "♪" : "×");
    });
    this.soundLabel = sound.label;
    this.soundLabel.setText(isSoundOn() ? "♪" : "×");
    syncBackgroundMusic(this);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.stopConnectionTimer());
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
    const shadow = this.add.graphics();
    shadow.fillStyle(0x000000, 0.34);
    shadow.fillRoundedRect(447, 386, 386, 324, 24);

    const panel = this.add.graphics();
    panel.fillGradientStyle(0xffffff, 0xffffff, 0xeaf7ff, 0xe9f0fa, 0.97);
    panel.fillRoundedRect(440, 378, 386, 324, 24);
    panel.lineStyle(5, 0xffffff, 0.86);
    panel.strokeRoundedRect(440, 378, 386, 324, 24);
    panel.lineStyle(3, 0x2f80ed, 0.35);
    panel.strokeRoundedRect(449, 387, 368, 306, 18);

    const mini = this.add.graphics();
    mini.fillGradientStyle(0x2f80ed, 0x7b61ff, 0x18a2c7, 0x31c48d, 0.98);
    mini.fillRoundedRect(476, 398, 328, 34, 14);
    this.add.text(640, 415, "CREATE OR JOIN", {
      fontFamily: "Arial",
      fontSize: "17px",
      color: "#ffffff",
      fontStyle: "bold"
    }).setOrigin(0.5);
  }

  private async hostGame() {
    const name = cleanName(this.nameInput.value);
    if (!name) {
      this.status.setText("Please enter your name before hosting the classroom.");
      return;
    }
    localStorage.setItem("spoonsPlayerName", name);
    this.setConnecting(true, "Contacting the classroom server. Please keep this page open.");
    try {
      await Net.createRoom(name, (message, elapsed) => this.updateConnectionProgress(message, elapsed));
      this.scene.start("LobbyScene");
    } catch (err) {
      this.setConnecting(false, this.messageFromError(err));
    }
  }

  private async joinGame() {
    const name = cleanName(this.nameInput.value);
    const code = cleanRoomCode(this.codeInput.value);
    if (!name) {
      this.status.setText("Please enter your name before joining the classroom.");
      return;
    }
    if (code.length !== 5) {
      this.status.setText("Please enter the 5-digit room code shown on the teacher's screen.");
      return;
    }
    localStorage.setItem("spoonsPlayerName", name);
    this.setConnecting(true, "Contacting the classroom server. Please keep this page open.");
    try {
      await Net.joinRoom(name, code, (message, elapsed) => this.updateConnectionProgress(message, elapsed));
      this.scene.start("LobbyScene");
    } catch (err) {
      this.setConnecting(false, this.messageFromError(err));
    }
  }

  private setConnecting(connecting: boolean, message: string) {
    this.connecting = connecting;
    this.nameInput.disabled = connecting;
    this.codeInput.disabled = connecting;
    this.hostButton.setDisabled(connecting);
    this.joinButton.setDisabled(connecting);
    this.status.setText(message);

    if (connecting) {
      this.connectionStartedAt = Date.now();
      this.progressTrack.setVisible(true);
      this.progressFill.setVisible(true);
      this.elapsedText.setVisible(true);
      this.updateConnectionProgress(message, 0);
      this.stopConnectionTimer();
      this.connectionTimer = this.time.addEvent({
        delay: 1000,
        loop: true,
        callback: () => {
          if (!this.connecting) return;
          const elapsed = Math.floor((Date.now() - this.connectionStartedAt) / 1000);
          this.updateProgressBar(elapsed);
          if (elapsed >= 20 && elapsed < 55) {
            this.status.setText("The free server is waking. This is normal—Spoons will keep trying automatically.");
          } else if (elapsed >= 55 && elapsed < 85) {
            this.status.setText("Still waking the classroom server. Please keep this page open; no need to press again.");
          } else if (elapsed >= 85) {
            this.status.setText("The server is taking longer than usual. Spoons is making its final connection attempts.");
          }
        }
      });
    } else {
      this.stopConnectionTimer();
      this.progressTrack.setVisible(false);
      this.progressFill.setVisible(false);
      this.elapsedText.setVisible(false);
    }
  }

  private updateConnectionProgress(message: string, elapsedSeconds: number) {
    if (!this.connecting || !this.scene.isActive()) return;
    this.status.setText(message);
    this.updateProgressBar(elapsedSeconds);
  }

  private updateProgressBar(elapsedSeconds: number) {
    const clamped = Phaser.Math.Clamp(elapsedSeconds, 0, 100);
    const width = Math.max(8, 320 * (clamped / 100));
    this.progressFill.clear();
    this.progressFill.fillStyle(elapsedSeconds >= 85 ? 0xf39c12 : 0x2f80ed, 1);
    this.progressFill.fillRoundedRect(480, 664, width, 12, 6);
    this.elapsedText.setText(`Server connection: ${elapsedSeconds}s / up to 100s`);
  }

  private stopConnectionTimer() {
    this.connectionTimer?.remove(false);
    this.connectionTimer = undefined;
  }

  private messageFromError(err: unknown) {
    const text = err instanceof Error ? err.message : String(err);
    const lower = text.toLowerCase();
    if (lower.includes("capacity")) return "This game is full. Ask the teacher to remove a player or start a new room.";
    if (lower.includes("duplicate") || lower.includes("same device")) return "This device is already connected to that room.";
    if (lower.includes("room not found") || lower.includes("no rooms found")) {
      return "Room not found. Check the 5-digit code and make sure the teacher is still in the lobby.";
    }
    if (lower.includes("first classroom update")) {
      return "The server connected but the classroom did not finish loading. Press Host or Join once more.";
    }
    return (
      "Spoons could not connect after allowing the free server up to 100 seconds to wake. " +
      "Try once more. If it works in InPrivate/Incognito but not in a normal window, ask school IT to allow " +
      "spoons-67eu.onrender.com and secure WebSocket (wss) traffic."
    );
  }
}
