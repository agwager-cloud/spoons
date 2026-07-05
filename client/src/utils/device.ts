export function getDeviceId(): string {
  const key = "spoonsDeviceId";
  let id = localStorage.getItem(key);
  if (!id) {
    id = `${Date.now().toString(36)}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    localStorage.setItem(key, id);
  }
  return id;
}

export function cleanName(value: string): string {
  return value.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 12) || "Player";
}

export function cleanRoomCode(value: string): string {
  return value.replace(/\D/g, "").slice(0, 5);
}
