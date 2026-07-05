import Phaser from "phaser";

export interface TextButton {
  box: Phaser.GameObjects.Rectangle;
  label: Phaser.GameObjects.Text;
  setDisabled(disabled: boolean): void;
  destroy(): void;
}

export function makeButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  onClick: () => void,
  fill = 0x2f80ed
): TextButton {
  let disabled = false;
  const box = scene.add.rectangle(x, y, w, h, fill, 1)
    .setStrokeStyle(3, 0xffffff, 0.9)
    .setInteractive({ useHandCursor: true });

  const fontSize = text.length > 14 ? 18 : text.length > 10 ? 20 : 22;
  const label = scene.add.text(x, y, text, {
    fontFamily: "Arial",
    fontSize: `${fontSize}px`,
    color: "#ffffff",
    fontStyle: "bold",
    align: "center"
  }).setOrigin(0.5).setInteractive({ useHandCursor: true });

  const trigger = () => {
    if (!disabled) onClick();
  };

  box.on("pointerdown", trigger);
  label.on("pointerdown", trigger);

  const hoverOn = () => {
    if (!disabled) box.setScale(1.03, 1.06);
  };
  const hoverOff = () => box.setScale(1, 1);
  box.on("pointerover", hoverOn);
  box.on("pointerout", hoverOff);
  label.on("pointerover", hoverOn);
  label.on("pointerout", hoverOff);

  return {
    box,
    label,
    setDisabled(value: boolean) {
      disabled = value;
      box.setAlpha(value ? 0.45 : 1);
      label.setAlpha(value ? 0.45 : 1);
      box.setScale(1, 1);
    },
    destroy() {
      box.destroy();
      label.destroy();
    }
  };
}
