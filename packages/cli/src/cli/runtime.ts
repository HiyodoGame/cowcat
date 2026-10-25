export interface NodeFloor {
  readonly major: number;
  readonly minor: number;
}

export const RENDERER_NODE_FLOOR: NodeFloor = { major: 26, minor: 4 };

export function meetsNodeFloor(version: string, floor: NodeFloor): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > floor.major || (major === floor.major && minor >= floor.minor);
}

export function defaultEntryProblem(version: string): string | null {
  if (meetsNodeFloor(version, RENDERER_NODE_FLOOR)) return null;
  return `默认 TUI 需要 Node >=${String(RENDERER_NODE_FLOOR.major)}.${String(RENDERER_NODE_FLOOR.minor)}，现在是 v${version}`;
}
