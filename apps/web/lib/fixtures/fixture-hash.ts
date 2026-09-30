/**
 * MOCK DATA helper — deterministic, dependency-free stand-in for a SHA-256
 * hex digest. Fixture hashes only need to satisfy the contract's `Sha256Hex`
 * format (64 lowercase hex chars); pack/artifact integrity is a runtime
 * concern (D28) and the UI never verifies a hash. Implemented without
 * node:crypto so the fixture layer stays bundleable inside the browser client.
 */
const LANES = 8;
const LANE_SEED = 0x811c9dc5;

export function fixtureHash(label: string): string {
  const lanes = new Array<number>(LANES);
  for (let lane = 0; lane < LANES; lane += 1) {
    lanes[lane] = (LANE_SEED + Math.imul(lane + 1, 0x9e3779b9)) >>> 0;
  }
  for (let i = 0; i < label.length; i += 1) {
    const code = label.charCodeAt(i);
    for (let lane = 0; lane < LANES; lane += 1) {
      const current = lanes[lane] ?? 0;
      lanes[lane] = Math.imul(current ^ (code + lane * 31 + i), 0x01000193) >>> 0;
    }
  }
  return lanes.map((lane) => lane.toString(16).padStart(8, "0")).join("");
}
