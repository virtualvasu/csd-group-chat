// Muted, paper-legible hues, spread far enough apart in hue to stay
// distinguishable at a glance across a handful of simultaneous speakers.
const PALETTE = [
  "#3f6b4f", // moss
  "#a34b28", // terracotta
  "#45508c", // indigo
  "#7a4272", // plum
  "#8a6d1f", // ochre
  "#2e6e72", // teal-slate
];

export function colorForUser(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash * 31 + username.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
