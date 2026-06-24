// Derives a small identity avatar (initials + deterministic colour) from an author name.

const AVATAR_COLORS = [
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#f59e0b', // amber
  '#10b981', // emerald
  '#06b6d4', // cyan
  '#ef4444', // red
  '#6366f1', // indigo
];

export function avatarInitials(name: string): string {
  const trimmed = (name || '').trim();
  if (!trimmed) return '?';
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

export function avatarColor(name: string): string {
  const key = (name || '').trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
