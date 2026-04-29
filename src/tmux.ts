import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TmuxLayout } from "./config";
import { debug as _debug } from "./util";

const execFileAsync = promisify(execFile);

export interface PaneResult {
  success: boolean;
  paneId?: string;
}

function debug(msg: string, data?: unknown): void {
  _debug("tmux", msg, data);
}

function quoteShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export class TmuxMultiplexer {
  private binaryPath: string | null = null;
  private hasChecked = false;
  private targetPane = process.env.TMUX_PANE;

  constructor(
    private layout: TmuxLayout = "main-vertical",
    private mainPaneSize: number = 60,
  ) {}

  async isAvailable(): Promise<boolean> {
    if (this.hasChecked) return this.binaryPath !== null;
    this.binaryPath = await this.findBinary();
    this.hasChecked = true;
    return this.binaryPath !== null;
  }

  isInsideSession(): boolean {
    return !!process.env.TMUX;
  }

  private async findBinary(): Promise<string | null> {
    const cmd = process.platform === "win32" ? "where" : "which";
    try {
      const { stdout } = await execFileAsync(cmd, ["tmux"]);
      return stdout.trim().split("\n")[0] ?? null;
    } catch {
      return null;
    }
  }

  private targetArgs(): string[] {
    return this.targetPane ? ["-t", this.targetPane] : [];
  }

  private async getMainPaneId(): Promise<string | null> {
    const tmux = await this.getBinary();
    if (!tmux) return null;
    try {
      const { stdout } = await execFileAsync(tmux, [
        "list-panes",
        ...this.targetArgs(),
        "-F", "#{pane_index} #{pane_id}",
      ]);
      const line = stdout.trim().split("\n").find(l => l.startsWith("0 "));
      return line ? (line.split(" ")[1] || null) : null;
    } catch (err) {
      debug("getMainPaneId: ERROR", err);
      return null;
    }
  }

  private async getBinary(): Promise<string | null> {
    if (!this.hasChecked) await this.isAvailable();
    return this.binaryPath;
  }

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
  ): Promise<PaneResult> {
    const tmux = await this.getBinary();
    if (!tmux) {
      debug("spawnPane: tmux binary not found");
      return { success: false };
    }

    try {
      const quotedDirectory = quoteShellArg(directory);
      const quotedUrl = quoteShellArg(serverUrl);
      const quotedSessionId = quoteShellArg(sessionId);

      const opencodeCmd = [
        "opencode",
        "attach",
        quotedUrl,
        "--session",
        quotedSessionId,
        "--dir",
        quotedDirectory,
      ].join(" ");

      // Always split from the main pane (index 0) so that successive
      // spawnPane calls don't nest splits inside previously-created sub-panes.
      const splitTarget = await this.getMainPaneId();
      if (!splitTarget) {
        debug("spawnPane: could not resolve main pane ID, aborting");
        return { success: false };
      }
      const splitTargetArgs = ["-t", splitTarget];

      const args = [
        "split-window",
        ...splitTargetArgs,
        "-h",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        opencodeCmd,
      ];

      debug("spawnPane: executing", { tmux, args });

      const { stdout, stderr } = await execFileAsync(tmux, args);
      const paneId = stdout.trim();

      debug("spawnPane: result", { paneId, stderr: stderr.trim() });

      if (paneId) {
        // Rename pane for visibility
        try {
          await execFileAsync(tmux, [
            "select-pane",
            "-t",
            paneId,
            "-T",
            description.slice(0, 30),
          ]);
        } catch {
          // cosmetic — ignore
        }

        await this.applyLayout(this.layout, this.mainPaneSize);

        debug("spawnPane: SUCCESS", { paneId });
        return { success: true, paneId };
      }

      return { success: false };
    } catch (err) {
      debug("spawnPane: ERROR", err);
      return { success: false };
    }
  }

  async closePane(paneId: string): Promise<boolean> {
    const tmux = await this.getBinary();
    if (!tmux) return false;

    try {
      // Graceful: send Ctrl-C first
      try {
        await execFileAsync(tmux, ["send-keys", "-t", paneId, "C-c"]);
        await new Promise((r) => setTimeout(r, 250));
      } catch {
        // ignore
      }

      await execFileAsync(tmux, ["kill-pane", "-t", paneId]);
      debug("closePane: killed", { paneId });

      // Re-apply layout after close
      try {
        await this.applyLayout(this.layout, this.mainPaneSize);
      } catch {
        // cosmetic
      }

      return true;
    } catch (err) {
      debug("closePane: ERROR", err);
      return false;
    }
  }

  async applyLayout(layout: TmuxLayout, mainPaneSize: number): Promise<void> {
    const tmux = await this.getBinary();
    if (!tmux) return;

    try {
      await execFileAsync(tmux, [
        "select-layout",
        ...this.targetArgs(),
        layout,
      ]);

      if (layout === "main-vertical" || layout === "main-horizontal") {
        const option =
          layout === "main-vertical" ? "main-pane-width" : "main-pane-height";
        await execFileAsync(tmux, [
          "set-window-option",
          ...this.targetArgs(),
          option,
          `${mainPaneSize}%`,
        ]);
        // Re-apply after setting size
        await execFileAsync(tmux, [
          "select-layout",
          ...this.targetArgs(),
          layout,
        ]);
      }
    } catch (err) {
      debug("applyLayout: ERROR", err);
    }
  }
}
