import type { PluginInput } from "@opencode-ai/plugin";
import type {
  EventSessionCreated,
  EventSessionStatus,
  EventSessionDeleted,
  SessionStatus,
} from "@opencode-ai/sdk";
import type { TmuxPluginConfig } from "./config";
import type { TmuxMultiplexer } from "./tmux";
import { debug as _debug } from "./util";

interface TrackedSession {
  sessionId: string;
  paneId: string;
  parentId: string;
  title: string;
  directory: string;
  createdAt: number;
  lastSeenAt: number;
  missingSince?: number;
}

interface KnownSession {
  parentId: string;
  title: string;
  directory: string;
}

function debug(msg: string, data?: unknown): void {
  _debug("session-manager", msg, data);
}

export class SessionManager {
  private client: PluginInput["client"];
  private serverUrl: string;
  private directory: string;
  private sessions = new Map<string, TrackedSession>();
  private knownSessions = new Map<string, KnownSession>();
  private spawningSessions = new Set<string>();
  private spawnedSessions = new Set<string>();
  // Sessions whose pane was auto-closed (idle/timeout) and may be re-spawned on busy
  private closedSessions = new Set<string>();
  // Sessions that went idle while their pane was still spawning
  private pendingClose = new Set<string>();
  private pollInterval?: ReturnType<typeof setInterval>;
  readonly enabled: boolean;

  constructor(
    private input: PluginInput,
    private config: TmuxPluginConfig,
    private tmux: TmuxMultiplexer,
  ) {
    this.client = input.client;
    this.directory = input.directory;
    // serverUrl is a URL object in PluginInput
    this.serverUrl = input.serverUrl.toString();
    this.enabled = tmux.isInsideSession();

    debug("initialized", { enabled: this.enabled, serverUrl: this.serverUrl });
  }

  async onSessionCreated(event: EventSessionCreated): Promise<void> {
    if (!this.enabled) return;

    const info = event.properties.info;
    if (!info.parentID) return; // only child sessions

    const sessionId = info.id;
    const parentId = info.parentID;
    const title = info.title ?? "Subagent";
    const directory = info.directory ?? this.directory;

    this.knownSessions.set(sessionId, { parentId, title, directory });

    if (this.isTrackedOrSpawning(sessionId)) {
      debug("session already tracked or spawning", { sessionId });
      return;
    }

    if (this.spawnedSessions.has(sessionId)) {
      debug("session already spawned (dedup guard)", { sessionId });
      return;
    }

    this.spawningSessions.add(sessionId);

    try {
      const serverRunning = await this.isServerRunning();
      if (!serverRunning) {
        debug("server not running, skipping spawn", { sessionId });
        return;
      }

      const result = await this.tmux.spawnPane(
        sessionId,
        title,
        this.serverUrl,
        directory,
      );

      if (result.success && result.paneId) {
        this.sessions.set(sessionId, {
          sessionId,
          paneId: result.paneId,
          parentId,
          title,
          directory,
          createdAt: Date.now(),
          lastSeenAt: Date.now(),
        });
        this.closedSessions.delete(sessionId);
        this.spawnedSessions.add(sessionId);
        this.startPolling();
        debug("session spawned", { sessionId, paneId: result.paneId });

        // #3: idle event arrived while we were spawning — close immediately
        if (this.pendingClose.has(sessionId)) {
          this.pendingClose.delete(sessionId);
          debug("closing session that went idle during spawn", { sessionId });
          await this.closeSession(sessionId, true);
        }
      }
    } finally {
      this.spawningSessions.delete(sessionId);
    }
  }

  async onSessionStatus(event: EventSessionStatus): Promise<void> {
    if (!this.enabled) return;

    const sessionId = event.properties.sessionID;
    const status = event.properties.status;
    debug("session.status", { sessionId, statusType: status.type });

    if (status.type === "idle" && this.config.autoClose) {
      if (this.spawningSessions.has(sessionId)) {
        // #3: pane still spawning — defer close until spawn completes
        debug("session went idle during spawn, deferring close", { sessionId });
        this.pendingClose.add(sessionId);
      } else {
        await this.closeSession(sessionId, true);
      }
    } else if (status.type === "busy") {
      // #2: only respawn if we explicitly auto-closed this session before
      if (this.closedSessions.has(sessionId)) {
        await this.respawnIfKnown(sessionId);
      }
    }
  }

  async onSessionDeleted(event: EventSessionDeleted): Promise<void> {
    if (!this.enabled) return;

    const sessionId = event.properties.info.id;
    debug("session.deleted", { sessionId });
    // #2: deleted sessions must not respawn — pass autoClose=false
    await this.closeSession(sessionId, false);
    this.knownSessions.delete(sessionId);
    this.closedSessions.delete(sessionId);
    this.pendingClose.delete(sessionId);
    this.spawnedSessions.delete(sessionId);
  }

  /**
   * Close all tracked panes and stop polling.
   * Best-effort: OpenCode plugin API does not expose a lifecycle hook for this;
   * callers must invoke it manually if needed (e.g. process exit handlers).
   */
  async cleanup(): Promise<void> {
    this.stopPolling();
    const closings = [...this.sessions.values()].map((s) =>
      this.tmux.closePane(s.paneId),
    );
    await Promise.allSettled(closings);
    this.sessions.clear();
    this.knownSessions.clear();
    this.spawningSessions.clear();
    this.spawnedSessions.clear();
    this.closedSessions.clear();
    this.pendingClose.clear();
  }

  private isTrackedOrSpawning(sessionId: string): boolean {
    return this.sessions.has(sessionId) || this.spawningSessions.has(sessionId);
  }

  private startPolling(): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => {
      void this.pollSessions();
    }, this.config.pollIntervalMs);
    debug("polling started");
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
      debug("polling stopped");
    }
  }

  private async pollSessions(): Promise<void> {
    if (this.sessions.size === 0) {
      this.stopPolling();
      return;
    }

    try {
      // #5: wrap with timeout to avoid hanging poll ticks
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("session.status timeout")), 5000),
      );
      const response = await Promise.race([
        this.client.session.status(),
        timeoutPromise,
      ]);

      // #4: response.data is directly typed as { [key: string]: SessionStatus } | undefined
      const statusMap: Record<string, SessionStatus> = response.data ?? {};
      const now = Date.now();
      const gracePeriod = this.config.pollIntervalMs * 3;

      // #6: collect sessions to close, then close in parallel
      const toClose: Array<{ sessionId: string; autoClose: boolean }> = [];

      for (const [sessionId, tracked] of this.sessions) {
        const status = statusMap[sessionId];

        if (!status) {
          // Session missing from API response
          if (!tracked.missingSince) {
            tracked.missingSince = now;
          } else if (now - tracked.missingSince > gracePeriod) {
            debug("pollSessions: session missing too long, closing", { sessionId });
            toClose.push({ sessionId, autoClose: false });
          }
          continue;
        }

        tracked.missingSince = undefined;
        tracked.lastSeenAt = now;

        if (status.type === "idle" && this.config.autoClose) {
          debug("pollSessions: session idle, closing", { sessionId });
          toClose.push({ sessionId, autoClose: true });
          continue;
        }

        if (now - tracked.createdAt > this.config.sessionTimeoutMs) {
          debug("pollSessions: session timed out, closing", { sessionId });
          toClose.push({ sessionId, autoClose: true });
        }
      }

      // #6: close in parallel
      await Promise.allSettled(
        toClose.map(({ sessionId, autoClose }) => this.closeSession(sessionId, autoClose)),
      );
    } catch (err) {
      debug("pollSessions: ERROR", err);
    }
  }

  /**
   * @param autoClose - true when closed due to idle/timeout (eligible for respawn);
   *                    false when closed due to session.deleted (must not respawn).
   */
  private async closeSession(sessionId: string, autoClose: boolean): Promise<void> {
    const tracked = this.sessions.get(sessionId);
    if (!tracked) return;

    debug("closeSession", { sessionId, paneId: tracked.paneId, autoClose });
    await this.tmux.closePane(tracked.paneId);
    this.sessions.delete(sessionId);

    // #2: only mark as eligible for respawn when auto-closed, not when deleted
    if (autoClose) {
      this.closedSessions.add(sessionId);
    } else {
      this.spawnedSessions.delete(sessionId);
    }

    if (this.sessions.size === 0) {
      this.stopPolling();
    }
  }

  private async respawnIfKnown(sessionId: string): Promise<void> {
    if (this.sessions.has(sessionId)) return; // already tracked
    if (this.spawningSessions.has(sessionId)) return;

    const known = this.knownSessions.get(sessionId);
    if (!known) return;

    debug("respawnIfKnown: re-spawning", { sessionId });
    // Remove from closedSessions and spawnedSessions before re-spawning
    this.closedSessions.delete(sessionId);
    this.spawnedSessions.delete(sessionId);
    await this.onSessionCreated({
      type: "session.created",
      properties: {
        info: {
          id: sessionId,
          parentID: known.parentId,
          title: known.title,
          directory: known.directory,
          projectID: "",
          version: "",
          time: { created: 0, updated: 0 },
        },
      },
    });
  }

  private async isServerRunning(
    timeoutMs = 3000,
    maxAttempts = 2,
  ): Promise<boolean> {
    const url = new URL("/health", this.serverUrl).toString();
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (res.ok) return true;
      } catch {
        // retry
      }
    }
    return false;
  }
}
