import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// ---- mutable execFile mock state ----
type ExecResult = { stdout: string; stderr: string };
let execFileImpl: (file: string, args: string[]) => ExecResult = () => ({
  stdout: "",
  stderr: "",
});

const execFileMock = (
  file: string,
  args: string[],
  callback: (err: Error | null, result: ExecResult) => void,
) => {
  try {
    callback(null, execFileImpl(file, args));
  } catch (e) {
    callback(e as Error, null as any);
  }
};

// Register mock BEFORE any import of tmux
mock.module("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("TmuxMultiplexer", () => {
  let origTmuxPane: string | undefined;
  let origTmux: string | undefined;
  let origSetTimeout: typeof globalThis.setTimeout;

  beforeEach(() => {
    origTmuxPane = process.env.TMUX_PANE;
    origTmux = process.env.TMUX;
    origSetTimeout = globalThis.setTimeout;
    delete process.env.TMUX_PANE;
    delete process.env.TMUX;
    // Default: which tmux succeeds
    execFileImpl = (_file: string, args: string[]) => {
      if (args[0] === "tmux") return { stdout: "/usr/bin/tmux\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };
  });

  afterEach(() => {
    if (origTmuxPane !== undefined) process.env.TMUX_PANE = origTmuxPane;
    else delete process.env.TMUX_PANE;
    if (origTmux !== undefined) process.env.TMUX = origTmux;
    else delete process.env.TMUX;
    globalThis.setTimeout = origSetTimeout;
  });

  // ---- isAvailable ----
  describe("isAvailable()", () => {
    it("returns true when which tmux succeeds", async () => {
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer();
      expect(await t.isAvailable()).toBe(true);
    });

    it("caches result on second call", async () => {
      let callCount = 0;
      execFileImpl = (_file: string, args: string[]) => {
        if (args[0] === "tmux") {
          callCount++;
          return { stdout: "/usr/bin/tmux\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      };
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer();
      await t.isAvailable();
      await t.isAvailable();
      expect(callCount).toBe(1);
    });

    it("returns false when which throws", async () => {
      execFileImpl = () => {
        throw new Error("not found");
      };
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer();
      expect(await t.isAvailable()).toBe(false);
    });

    it("caches false result", async () => {
      let callCount = 0;
      execFileImpl = () => {
        callCount++;
        throw new Error("not found");
      };
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer();
      await t.isAvailable();
      await t.isAvailable();
      expect(callCount).toBe(1);
    });
  });

  // ---- isInsideSession ----
  describe("isInsideSession()", () => {
    it("returns true when TMUX env is set", async () => {
      process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer();
      expect(t.isInsideSession()).toBe(true);
    });

    it("returns false when TMUX env is not set", async () => {
      delete process.env.TMUX;
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer();
      expect(t.isInsideSession()).toBe(false);
    });
  });

  // ---- spawnPane ----
  describe("spawnPane()", () => {
    it("success: returns {success:true, paneId}", async () => {
      execFileImpl = (_file: string, args: string[]) => {
        if (args[0] === "tmux") return { stdout: "/usr/bin/tmux\n", stderr: "" };
        if (args[0] === "split-window") return { stdout: "%5\n", stderr: "" };
        return { stdout: "", stderr: "" };
      };
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer();
      const result = await t.spawnPane("sess1", "My Agent", "http://localhost:3000", "/home/user");
      expect(result.success).toBe(true);
      expect(result.paneId).toBe("%5");
    });

    it("verifies split-window args contain required flags", async () => {
      let capturedArgs: string[] = [];
      execFileImpl = (_file: string, args: string[]) => {
        if (args[0] === "tmux") return { stdout: "/usr/bin/tmux\n", stderr: "" };
        if (args[0] === "split-window") {
          capturedArgs = args;
          return { stdout: "%5\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      };
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer();
      await t.spawnPane("sess1", "Agent", "http://localhost:3000", "/home/user");
      expect(capturedArgs).toContain("split-window");
      expect(capturedArgs).toContain("-h");
      expect(capturedArgs).toContain("-d");
      expect(capturedArgs).toContain("-P");
      expect(capturedArgs).toContain("-F");
      expect(capturedArgs).toContain("#{pane_id}");
      // Last arg should be the opencode command
      const lastArg = capturedArgs[capturedArgs.length - 1];
      expect(lastArg).toContain("opencode");
      expect(lastArg).toContain("attach");
      expect(lastArg).toContain("sess1");
    });

    it("returns {success:false} when no binary", async () => {
      execFileImpl = () => {
        throw new Error("not found");
      };
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer();
      const result = await t.spawnPane("sess1", "Agent", "http://localhost:3000", "/home/user");
      expect(result.success).toBe(false);
    });

    it("returns {success:false} when split-window returns empty paneId", async () => {
      execFileImpl = (_file: string, args: string[]) => {
        if (args[0] === "tmux") return { stdout: "/usr/bin/tmux\n", stderr: "" };
        if (args[0] === "split-window") return { stdout: "   \n", stderr: "" };
        return { stdout: "", stderr: "" };
      };
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer();
      const result = await t.spawnPane("sess1", "Agent", "http://localhost:3000", "/home/user");
      expect(result.success).toBe(false);
    });

    it("returns {success:false} when split-window throws", async () => {
      execFileImpl = (_file: string, args: string[]) => {
        if (args[0] === "tmux") return { stdout: "/usr/bin/tmux\n", stderr: "" };
        if (args[0] === "split-window") throw new Error("split failed");
        return { stdout: "", stderr: "" };
      };
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer();
      const result = await t.spawnPane("sess1", "Agent", "http://localhost:3000", "/home/user");
      expect(result.success).toBe(false);
    });

    it("shell-quoting: directory with single quote", async () => {
      let capturedArgs: string[] = [];
      execFileImpl = (_file: string, args: string[]) => {
        if (args[0] === "tmux") return { stdout: "/usr/bin/tmux\n", stderr: "" };
        if (args[0] === "split-window") {
          capturedArgs = args;
          return { stdout: "%7\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      };
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer();
      await t.spawnPane("sess1", "Agent", "http://localhost:3000", "/home/user's dir");
      const lastArg = capturedArgs[capturedArgs.length - 1];
      // Should contain escaped single quote
      expect(lastArg).toContain("'\\''");
    });

    it("TMUX_PANE env var adds -t args", async () => {
      process.env.TMUX_PANE = "%3";
      let capturedArgs: string[] = [];
      execFileImpl = (_file: string, args: string[]) => {
        if (args[0] === "tmux") return { stdout: "/usr/bin/tmux\n", stderr: "" };
        if (args[0] === "split-window") {
          capturedArgs = args;
          return { stdout: "%5\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      };
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer();
      await t.spawnPane("sess1", "Agent", "http://localhost:3000", "/home/user");
      expect(capturedArgs).toContain("-t");
      expect(capturedArgs).toContain("%3");
    });
  });

  // ---- closePane ----
  describe("closePane()", () => {
    beforeEach(() => {
      // Override setTimeout to immediately invoke callback
      (globalThis as any).setTimeout = (cb: () => void, _ms: number) => {
        cb();
        return 0 as any;
      };
    });

    it("success: returns true; send-keys then kill-pane called", async () => {
      const calledCommands: string[] = [];
      execFileImpl = (_file: string, args: string[]) => {
        if (args[0] === "tmux") return { stdout: "/usr/bin/tmux\n", stderr: "" };
        calledCommands.push(args[0]);
        return { stdout: "", stderr: "" };
      };
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer();
      const result = await t.closePane("%5");
      expect(result).toBe(true);
      expect(calledCommands).toContain("send-keys");
      expect(calledCommands).toContain("kill-pane");
    });

    it("returns false when kill-pane throws", async () => {
      execFileImpl = (_file: string, args: string[]) => {
        if (args[0] === "tmux") return { stdout: "/usr/bin/tmux\n", stderr: "" };
        if (args[0] === "kill-pane") throw new Error("kill failed");
        return { stdout: "", stderr: "" };
      };
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer();
      const result = await t.closePane("%5");
      expect(result).toBe(false);
    });

    it("returns false when no binary", async () => {
      execFileImpl = () => {
        throw new Error("not found");
      };
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer();
      const result = await t.closePane("%5");
      expect(result).toBe(false);
    });
  });

  // ---- applyLayout ----
  describe("applyLayout()", () => {
    it("main-vertical: calls set-window-option with main-pane-width", async () => {
      const calledCommands: string[] = [];
      let setWindowOptionArgs: string[] = [];
      execFileImpl = (_file: string, args: string[]) => {
        if (args[0] === "tmux") return { stdout: "/usr/bin/tmux\n", stderr: "" };
        calledCommands.push(args[0]);
        if (args[0] === "set-window-option") setWindowOptionArgs = args;
        return { stdout: "", stderr: "" };
      };
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer("main-vertical", 60);
      await t.applyLayout("main-vertical", 60);
      expect(calledCommands).toContain("set-window-option");
      expect(setWindowOptionArgs).toContain("main-pane-width");
      expect(setWindowOptionArgs).toContain("60%");
    });

    it("main-horizontal: calls set-window-option with main-pane-height", async () => {
      const calledCommands: string[] = [];
      let setWindowOptionArgs: string[] = [];
      execFileImpl = (_file: string, args: string[]) => {
        if (args[0] === "tmux") return { stdout: "/usr/bin/tmux\n", stderr: "" };
        calledCommands.push(args[0]);
        if (args[0] === "set-window-option") setWindowOptionArgs = args;
        return { stdout: "", stderr: "" };
      };
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer("main-horizontal", 50);
      await t.applyLayout("main-horizontal", 50);
      expect(calledCommands).toContain("set-window-option");
      expect(setWindowOptionArgs).toContain("main-pane-height");
    });

    it("tiled: no set-window-option call", async () => {
      const calledCommands: string[] = [];
      execFileImpl = (_file: string, args: string[]) => {
        if (args[0] === "tmux") return { stdout: "/usr/bin/tmux\n", stderr: "" };
        calledCommands.push(args[0]);
        return { stdout: "", stderr: "" };
      };
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer("tiled", 60);
      await t.applyLayout("tiled", 60);
      expect(calledCommands).not.toContain("set-window-option");
    });

    it("TMUX_PANE env var adds -t args to select-layout", async () => {
      process.env.TMUX_PANE = "%3";
      let selectLayoutArgs: string[] = [];
      execFileImpl = (_file: string, args: string[]) => {
        if (args[0] === "tmux") return { stdout: "/usr/bin/tmux\n", stderr: "" };
        if (args[0] === "select-layout") selectLayoutArgs = args;
        return { stdout: "", stderr: "" };
      };
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer();
      await t.applyLayout("tiled", 60);
      expect(selectLayoutArgs).toContain("-t");
      expect(selectLayoutArgs).toContain("%3");
    });

    it("handles applyLayout error gracefully", async () => {
      execFileImpl = (_file: string, args: string[]) => {
        if (args[0] === "tmux") return { stdout: "/usr/bin/tmux\n", stderr: "" };
        if (args[0] === "select-layout") throw new Error("layout error");
        return { stdout: "", stderr: "" };
      };
      const { TmuxMultiplexer } = await import("../tmux");
      const t = new TmuxMultiplexer();
      // Should not throw
      await expect(t.applyLayout("tiled", 60)).resolves.toBeUndefined();
    });
  });
});
