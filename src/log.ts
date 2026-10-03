export function log(...parts: unknown[]) {
  console.log(new Date().toISOString(), ...parts);
}

/** One line per chain event: `pad kind token block tx`. */
export function logEvent(pad: string, kind: string, token: string, block: number | string, tx?: string) {
  log(pad, kind, token, block, tx ?? "-");
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
