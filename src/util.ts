export function debug(prefix: string, msg: string, data?: unknown): void {
  if (process.env.OPENCODE_TMUX_DEBUG) {
    console.error(`[opencode-tmux:${prefix}] ${msg}`, data ?? "");
  }
}
