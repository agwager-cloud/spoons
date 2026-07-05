import Phaser from "phaser";
import { StartScene } from "./scenes/StartScene";
import { LobbyScene } from "./scenes/LobbyScene";
import { GameScene } from "./scenes/GameScene";
import { ResultsScene } from "./scenes/ResultsScene";

window.addEventListener("error", (event) => showBootError(event.message));
window.addEventListener("unhandledrejection", (event) => showBootError(String(event.reason)));

function showBootError(message: string) {
  const loading = document.getElementById("loading");
  const error = document.getElementById("boot-error");
  if (loading) loading.style.display = "none";
  if (error) {
    error.style.display = "flex";
    error.textContent = `Spoons could not start. Refresh the page or check the upload zip. ${message}`;
  }
}

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: "app",
  width: 1280,
  height: 720,
  backgroundColor: "#0e1730",
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  dom: {
    createContainer: true
  },
  scene: [StartScene, LobbyScene, GameScene, ResultsScene]
};

try {
  new Phaser.Game(config);
  const loading = document.getElementById("loading");
  if (loading) loading.style.display = "none";
} catch (err) {
  showBootError(err instanceof Error ? err.message : String(err));
}
