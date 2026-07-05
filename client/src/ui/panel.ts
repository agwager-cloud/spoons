import Phaser from "phaser";

export function addPanel(scene: Phaser.Scene, x: number, y: number, w: number, h: number, fill = 0xffffff, alpha = 0.92) {
  return scene.add.rectangle(x, y, w, h, fill, alpha).setStrokeStyle(3, 0x102a43, 0.22);
}

export function addTitle(scene: Phaser.Scene, text: string) {
  return scene.add.text(640, 48, text, {
    fontFamily: "Arial",
    fontSize: "54px",
    color: "#ffffff",
    fontStyle: "bold"
  }).setOrigin(0.5);
}

export function addSoundButton(scene: Phaser.Scene, onClick: () => void) {
  const box = scene.add.circle(1230, 42, 26, 0xffffff, 0.18).setStrokeStyle(2, 0xffffff, 0.55).setInteractive({ useHandCursor: true });
  const label = scene.add.text(1230, 42, "♪", { fontFamily: "Arial", fontSize: "26px", color: "#ffffff", fontStyle: "bold" })
    .setOrigin(0.5)
    .setInteractive({ useHandCursor: true });
  box.on("pointerdown", onClick);
  label.on("pointerdown", onClick);
  return { box, label };
}
