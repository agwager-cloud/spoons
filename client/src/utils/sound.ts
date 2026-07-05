import Phaser from "phaser";

const KEY = "spoonsSoundOn";
const MUSIC_KEY = "slimeyfoxbgm";
const MUSIC_PATH = "assets/audio/slimeyfoxbgm.mp3";
const MUSIC_VOLUME = 0.42;

let music: Phaser.Sound.BaseSound | null = null;
let unlockListenerAttached = false;

export function isSoundOn(): boolean {
  return localStorage.getItem(KEY) !== "false";
}

export function toggleSound(scene?: Phaser.Scene): boolean {
  const next = !isSoundOn();
  localStorage.setItem(KEY, String(next));
  if (scene) syncBackgroundMusic(scene);
  return next;
}

export function preloadBackgroundMusic(scene: Phaser.Scene) {
  if (!scene.cache.audio.exists(MUSIC_KEY)) {
    scene.load.audio(MUSIC_KEY, MUSIC_PATH);
  }
}

export function syncBackgroundMusic(scene: Phaser.Scene) {
  const sound = scene.sound;

  if (!isSoundOn()) {
    if (music?.isPlaying) music.pause();
    return;
  }

  if (!scene.cache.audio.exists(MUSIC_KEY)) return;

  if (!music) {
    const existing = sound.get(MUSIC_KEY);
    music = existing ?? sound.add(MUSIC_KEY, { loop: true, volume: MUSIC_VOLUME });
  }

  if (sound.locked) {
    if (!unlockListenerAttached) {
      unlockListenerAttached = true;
      sound.once("unlocked", () => {
        unlockListenerAttached = false;
        syncBackgroundMusic(scene);
      });
    }
    return;
  }

  if (music.isPaused) {
    music.resume();
  } else if (!music.isPlaying) {
    music.play();
  }
}
