export type Profile = "constant" | "ramp" | "spike" | "stress" | "soak";

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

export function targetRps(profile: Profile, t: number): number {
  switch (profile) {
    case "constant":
      return 70;
    case "ramp":
      return clamp(10 + t * 2.1, 10, 260);
    case "spike": {
      const c = t % 24;
      if (c < 16) return 55;
      const x = (c - 16) / 8;
      const bump = x < 0.5 ? x * 2 : (1 - x) * 2;
      return 55 + (330 - 55) * clamp(bump, 0, 1);
    }
    case "stress":
      return clamp(15 + t * 3.2, 15, 520);
    case "soak":
      return 95;
    default:
      return 60;
  }
}
