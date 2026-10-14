export function createTokenBucket(capacity: number, refillPerSec: number) {
  let tokens = capacity;
  let last = Date.now();
  return {
    allow(): boolean {
      const now = Date.now();
      tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSec);
      last = now;
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      return false;
    },
  };
}
