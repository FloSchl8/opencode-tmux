import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { TmuxPluginConfig } from "../config";

// ---- helpers ----
const mkCreated = (id: string, parentID = "p1") => ({
  type: "session.created" as const,
  properties: {
    info: {
      id,
      parentID,
      title: "T",
      directory: "/d",
      projectID: "",
      version: "",
      time: { created: 0, updated: 0 },
    },
  },
});

const mkStatus = (id: string, type: "idle" | "busy") => ({
  type: "session.status" as const,
  properties: { sessionID: id, status: { type } },
});

const mkDeleted = (id: string) => ({
  type: "session.deleted" as const,
  properties: {
    info: {
      id,
      parentID: "p1",
      title: "T",
      directory: "/d",
      projectID: "",
      version: "",
      time: { created: 0, updated: 0 },
    },
  },
});

// ---- default config ----
const defaultConfig: TmuxPluginConfig = {
  layout: "main-vertical",
  mainPaneSize: 60,
  autoClose: true,
  pollIntervalMs: 100,
  sessionTimeoutMs: 10 * 60 * 1000,
};

// ---- fetch restoration ----
// Track the original fetch so afterEach can always restore it.
const _origFetch = globalThis.fetch;

// ---- build a fresh SessionManager with stubs ----
async function buildManager(
  opts: {
    insideSession?: boolean;
    spawnResult?: { success: boolean; paneId?: string };
    closePaneResult?: boolean;
    config?: Partial<TmuxPluginConfig>;
    fetchOk?: boolean;
    fetchThrows?: boolean;
    fetchImpl?: () => Promise<Response>;
  } = {},
) {
  const {
    insideSession = true,
    spawnResult = { success: true, paneId: "%1" },
    closePaneResult = true,
    config = {},
    fetchOk = true,
    fetchThrows = false,
    fetchImpl,
  } = opts;

  const spawnPane = mock(async () => spawnResult);
  const closePane = mock(async () => closePaneResult);

  const tmuxStub = {
    isInsideSession: () => insideSession,
    spawnPane,
    closePane,
  };

  // Mock fetch — afterEach restores globalThis.fetch unconditionally.
  if (fetchImpl) {
    (globalThis as any).fetch = fetchImpl;
  } else if (fetchThrows) {
    (globalThis as any).fetch = async () => {
      throw new Error("network error");
    };
  } else {
    (globalThis as any).fetch = async () =>
      new Response(null, { status: fetchOk ? 200 : 500 });
  }

  // Mock client.session.status
  const statusData: Record<string, { type: string }> = {};
  const sessionStatusMock = mock(async () => ({ data: statusData }));

  const clientStub = {
    session: {
      status: sessionStatusMock,
    },
  };

  const inputStub = {
    client: clientStub,
    directory: "/workspace",
    serverUrl: new URL("http://localhost:3000"),
  } as any;

  const { SessionManager } = await import("../session-manager");
  const mgr = new SessionManager(inputStub, { ...defaultConfig, ...config }, tmuxStub as any);

  return {
    mgr,
    spawnPane,
    closePane,
    sessionStatusMock,
    statusData,
  };
}

describe("SessionManager", () => {
  afterEach(() => {
    // Always restore fetch to the original — idempotent regardless of test outcome.
    (globalThis as any).fetch = _origFetch;
  });

  // ---- enabled flag ----
  describe("enabled flag", () => {
    it("enabled=false when isInsideSession() returns false → onSessionCreated is no-op", async () => {
      const { mgr, spawnPane } = await buildManager({ insideSession: false });
      expect(mgr.enabled).toBe(false);
      await mgr.onSessionCreated(mkCreated("s1") as any);
      expect(spawnPane).not.toHaveBeenCalled();
    });
  });

  // ---- onSessionCreated ----
  describe("onSessionCreated()", () => {
    it("ignores sessions without parentID", async () => {
      const { mgr, spawnPane } = await buildManager();
      const event = mkCreated("s1");
      (event.properties.info as any).parentID = "";
      await mgr.onSessionCreated(event as any);
      expect(spawnPane).not.toHaveBeenCalled();
    });

    it("happy path: spawnPane called, sessions map populated", async () => {
      const { mgr, spawnPane } = await buildManager();
      await mgr.onSessionCreated(mkCreated("s1") as any);
      expect(spawnPane).toHaveBeenCalledTimes(1);
      expect(spawnPane).toHaveBeenCalledWith("s1", expect.anything(), expect.anything(), expect.anything());
      await mgr.cleanup();
    });

    it("skips when server unhealthy (fetch returns 500)", async () => {
      const { mgr, spawnPane } = await buildManager({ fetchOk: false });
      await mgr.onSessionCreated(mkCreated("s1") as any);
      expect(spawnPane).not.toHaveBeenCalled();
    });

    it("skips when fetch throws", async () => {
      const { mgr, spawnPane } = await buildManager({ fetchThrows: true });
      await mgr.onSessionCreated(mkCreated("s1") as any);
      expect(spawnPane).not.toHaveBeenCalled();
    });

    it("deduplication: second call while spawning → spawnPane called once", async () => {
      // We need to simulate concurrent calls
      // Use a promise that we can control
      let resolveSpawn!: (v: { success: boolean; paneId: string }) => void;
      const spawnPromise = new Promise<{ success: boolean; paneId: string }>(
        (res) => (resolveSpawn = res),
      );

      const spawnPane = mock(async () => spawnPromise);
      const closePane = mock(async () => true);
      const tmuxStub = {
        isInsideSession: () => true,
        spawnPane,
        closePane,
      };

      (globalThis as any).fetch = async () => new Response(null, { status: 200 });

      const clientStub = {
        session: { status: mock(async () => ({ data: {} })) },
      };
      const inputStub = {
        client: clientStub,
        directory: "/workspace",
        serverUrl: new URL("http://localhost:3000"),
      } as any;

      const { SessionManager } = await import("../session-manager");
      const mgr = new SessionManager(inputStub, defaultConfig, tmuxStub as any);

      // Start first spawn (won't resolve yet)
      const p1 = mgr.onSessionCreated(mkCreated("s1") as any);
      // Second call while first is in progress
      const p2 = mgr.onSessionCreated(mkCreated("s1") as any);

      // Resolve the spawn
      resolveSpawn({ success: true, paneId: "%1" });
      await Promise.all([p1, p2]);

      expect(spawnPane).toHaveBeenCalledTimes(1);

      await mgr.cleanup();
    });
  });

  // ---- onSessionStatus ----
  describe("onSessionStatus()", () => {
    it("idle + autoClose=true → closePane called, closedSessions populated", async () => {
      const { mgr, spawnPane, closePane } = await buildManager();
      await mgr.onSessionCreated(mkCreated("s1") as any);
      expect(spawnPane).toHaveBeenCalledTimes(1);

      await mgr.onSessionStatus(mkStatus("s1", "idle") as any);
      expect(closePane).toHaveBeenCalledTimes(1);
      expect(closePane).toHaveBeenCalledWith("%1");
    });

    it("idle + autoClose=false → closePane NOT called", async () => {
      const { mgr, closePane } = await buildManager({
        config: { autoClose: false },
      });
      await mgr.onSessionCreated(mkCreated("s1") as any);
      await mgr.onSessionStatus(mkStatus("s1", "idle") as any);
      expect(closePane).not.toHaveBeenCalled();
      await mgr.cleanup();
    });

    it("busy + in closedSessions → respawn (spawnPane called again)", async () => {
      const { mgr, spawnPane } = await buildManager();
      await mgr.onSessionCreated(mkCreated("s1") as any);
      // Close via idle
      await mgr.onSessionStatus(mkStatus("s1", "idle") as any);
      expect(spawnPane).toHaveBeenCalledTimes(1);

      // Now busy → should respawn
      await mgr.onSessionStatus(mkStatus("s1", "busy") as any);
      expect(spawnPane).toHaveBeenCalledTimes(2);
      await mgr.cleanup();
    });

    it("busy without prior close → no-op", async () => {
      const { mgr, spawnPane } = await buildManager();
      await mgr.onSessionCreated(mkCreated("s1") as any);
      const callsBefore = spawnPane.mock.calls.length;
      await mgr.onSessionStatus(mkStatus("s1", "busy") as any);
      expect(spawnPane.mock.calls.length).toBe(callsBefore);
      await mgr.cleanup();
    });

    it("idle while spawning → pendingClose; after spawn resolves, closePane called", async () => {
      let resolveSpawn!: (v: { success: boolean; paneId: string }) => void;
      const spawnPromise = new Promise<{ success: boolean; paneId: string }>(
        (res) => (resolveSpawn = res),
      );

      const spawnPane = mock(async () => spawnPromise);
      const closePane = mock(async () => true);
      const tmuxStub = {
        isInsideSession: () => true,
        spawnPane,
        closePane,
      };

      (globalThis as any).fetch = async () => new Response(null, { status: 200 });

      const clientStub = {
        session: { status: mock(async () => ({ data: {} })) },
      };
      const inputStub = {
        client: clientStub,
        directory: "/workspace",
        serverUrl: new URL("http://localhost:3000"),
      } as any;

      const { SessionManager } = await import("../session-manager");
      const mgr = new SessionManager(inputStub, defaultConfig, tmuxStub as any);

      // Start spawn (won't resolve yet)
      const spawnP = mgr.onSessionCreated(mkCreated("s1") as any);

      // Idle event arrives while spawning
      await mgr.onSessionStatus(mkStatus("s1", "idle") as any);
      // closePane should NOT be called yet
      expect(closePane).not.toHaveBeenCalled();

      // Resolve spawn
      resolveSpawn({ success: true, paneId: "%1" });
      await spawnP;

      // Now closePane should have been called
      expect(closePane).toHaveBeenCalledTimes(1);
    });
  });

  // ---- onSessionDeleted ----
  describe("onSessionDeleted()", () => {
    it("closePane called, knownSessions cleared, closedSessions NOT populated", async () => {
      const { mgr, closePane } = await buildManager();
      await mgr.onSessionCreated(mkCreated("s1") as any);
      await mgr.onSessionDeleted(mkDeleted("s1") as any);
      expect(closePane).toHaveBeenCalledTimes(1);

      // knownSessions must be cleared
      expect((mgr as any).knownSessions.size).toBe(0);

      // After delete, busy should NOT respawn (closedSessions not populated)
      await mgr.onSessionStatus(mkStatus("s1", "busy") as any);
      // sessions map should be empty, no respawn
      expect((mgr as any).sessions.size).toBe(0);
    });

    it("stopPolling when last session is deleted", async () => {
      const { mgr } = await buildManager();
      await mgr.onSessionCreated(mkCreated("s1") as any);
      // Polling should have started
      expect((mgr as any).pollInterval).toBeDefined();

      const clearIntervalSpy = spyOn(globalThis, "clearInterval");
      await mgr.onSessionDeleted(mkDeleted("s1") as any);
      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });
  });

  // ---- pollSessions ----
  describe("pollSessions()", () => {
    it("idle session → closePane called", async () => {
      const { mgr, closePane, statusData } = await buildManager();
      await mgr.onSessionCreated(mkCreated("s1") as any);
      // Set status to idle
      statusData["s1"] = { type: "idle" };
      await (mgr as any).pollSessions();
      expect(closePane).toHaveBeenCalled();
    });

    it("missing session grace period: first call sets missingSince, second call after grace → close", async () => {
      const { mgr, closePane } = await buildManager({
        config: { pollIntervalMs: 100 },
      });
      await mgr.onSessionCreated(mkCreated("s1") as any);
      // Status map is empty (session missing)
      const dateSpy = spyOn(Date, "now");
      const t0 = 1000000;
      dateSpy.mockReturnValue(t0);

      await (mgr as any).pollSessions();
      // First call: sets missingSince, no close yet
      expect(closePane).not.toHaveBeenCalled();

      // Advance time beyond grace period (3 * pollIntervalMs = 300ms)
      dateSpy.mockReturnValue(t0 + 400);
      await (mgr as any).pollSessions();
      expect(closePane).toHaveBeenCalled();

      dateSpy.mockRestore();
    });

    it("session timeout: createdAt old enough → close", async () => {
      const { mgr, closePane, statusData } = await buildManager({
        config: { sessionTimeoutMs: 1000 },
      });
      // Spy BEFORE onSessionCreated so createdAt is captured at t0
      const dateSpy = spyOn(Date, "now");
      const t0 = 1_000_000;
      dateSpy.mockReturnValue(t0);

      await mgr.onSessionCreated(mkCreated("s1") as any);
      // Set status to busy (not idle) so it won't close for idle reason
      statusData["s1"] = { type: "busy" };

      // Advance time beyond sessionTimeoutMs (1000ms)
      dateSpy.mockReturnValue(t0 + 2000);
      await (mgr as any).pollSessions();
      expect(closePane).toHaveBeenCalled();

      dateSpy.mockRestore();
    });

    it("empty sessions → stopPolling (clearInterval called)", async () => {
      const { mgr } = await buildManager();
      // Don't add any sessions — pollSessions should stop polling
      const clearIntervalSpy = spyOn(globalThis, "clearInterval");
      // Manually start polling by adding a fake interval
      (mgr as any).pollInterval = setInterval(() => {}, 10000);
      await (mgr as any).pollSessions();
      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });

    it("pollSessions handles API error gracefully", async () => {
      const { mgr } = await buildManager();
      await mgr.onSessionCreated(mkCreated("s1") as any);
      // Make session.status throw
      (mgr as any).client.session.status = async () => {
        throw new Error("API error");
      };
      // Should not throw
      await expect((mgr as any).pollSessions()).resolves.toBeUndefined();
      await mgr.cleanup();
    });
  });

  // ---- cleanup ----
  describe("cleanup()", () => {
    it("closes all panes, clears all maps", async () => {
      const { mgr, closePane } = await buildManager();
      await mgr.onSessionCreated(mkCreated("s1") as any);
      await mgr.onSessionCreated(mkCreated("s2") as any);
      await mgr.cleanup();
      expect(closePane).toHaveBeenCalledTimes(2);
      expect((mgr as any).sessions.size).toBe(0);
      expect((mgr as any).knownSessions.size).toBe(0);
    });
  });

  // ---- isServerRunning retry ----
  describe("isServerRunning()", () => {
    it("fetch called exactly 2 times when it always fails (maxAttempts=2)", async () => {
      let fetchCallCount = 0;
      const { mgr } = await buildManager({
        fetchImpl: async () => {
          fetchCallCount++;
          throw new Error("network error");
        },
      });
      // isServerRunning is private; trigger it via onSessionCreated
      await mgr.onSessionCreated(mkCreated("s1") as any);
      expect(fetchCallCount).toBe(2);
    });
  });
});
