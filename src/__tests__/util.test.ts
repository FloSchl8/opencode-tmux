import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";

describe("debug()", () => {
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stderrSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env.OPENCODE_TMUX_DEBUG;
  });

  it("writes to stderr when OPENCODE_TMUX_DEBUG is set", async () => {
    process.env.OPENCODE_TMUX_DEBUG = "1";
    // Dynamic import to get fresh module (util has no module-level state, but keep pattern consistent)
    const { debug } = await import("../util");
    debug("test", "hello world", { key: "value" });
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0][0]).toContain("[opencode-tmux:test]");
    expect(stderrSpy.mock.calls[0][0]).toContain("hello world");
  });

  it("is silent when OPENCODE_TMUX_DEBUG is not set", async () => {
    delete process.env.OPENCODE_TMUX_DEBUG;
    const { debug } = await import("../util");
    debug("test", "should not appear");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("uses empty string when data is undefined", async () => {
    process.env.OPENCODE_TMUX_DEBUG = "1";
    const { debug } = await import("../util");
    debug("prefix", "msg only");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    // second arg should be "" (empty string fallback)
    expect(stderrSpy.mock.calls[0][1]).toBe("");
  });
});
