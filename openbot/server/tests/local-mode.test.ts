import { describe, expect, spyOn, test } from "bun:test";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createStallGuard } from "../src/channels/stall-guard";
import { loadConfig, runtimeCapabilities } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { localThreadPlatform } from "../src/local-mode";
import { testEnvironment } from "./support/environment";

/**
 * LOCAL MODE: running with no CopilotKit Intelligence, by explicit opt-in only.
 *
 * Two promises are asserted here. The selection is strictly additive — nothing changes for a
 * deployment that has Intelligence configured or that configured nothing — and once selected, the
 * runtime mount reaches no Intelligence client at all and still refuses a run nobody signed in for.
 */

/** The test environment with every Intelligence variable removed. */
function withoutIntelligence(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return testEnvironment({
    INTELLIGENCE_API_URL: undefined,
    INTELLIGENCE_GATEWAY_WS_URL: undefined,
    INTELLIGENCE_API_KEY: undefined,
    COPILOTKIT_LICENSE_TOKEN: undefined,
    ...overrides,
  });
}

describe("choosing local mode", () => {
  test("OPENDUET_LOCAL_MODE=true with no Intelligence selects local mode", () => {
    expect(
      loadConfig(withoutIntelligence({ OPENDUET_LOCAL_MODE: "true" })).runtime,
    ).toEqual({ mode: "local", durableHistory: false });
    expect(
      runtimeCapabilities(withoutIntelligence({ OPENDUET_LOCAL_MODE: "1" })),
    ).toEqual({ mode: "local", durableHistory: false });
  });

  test("a deployment with Intelligence configured is unchanged when the variable is absent or false", () => {
    for (const value of [undefined, "", "false", "0"]) {
      expect(
        loadConfig(testEnvironment({ OPENDUET_LOCAL_MODE: value })).runtime
          .mode,
      ).toBe("intelligence");
    }
  });

  test("asking for local mode while an Intelligence key is set is refused", () => {
    expect(() =>
      loadConfig(testEnvironment({ OPENDUET_LOCAL_MODE: "true" })),
    ).toThrow(/INTELLIGENCE_API_KEY is set/);
    expect(() =>
      loadConfig(
        withoutIntelligence({
          OPENDUET_LOCAL_MODE: "true",
          INTELLIGENCE_API_KEY: "left-over",
        }),
      ),
    ).toThrow(/INTELLIGENCE_API_KEY is set/);
  });

  test("the URLs .env.example ships filled in do not block local mode; only a key does", () => {
    expect(
      loadConfig(
        withoutIntelligence({
          OPENDUET_LOCAL_MODE: "true",
          INTELLIGENCE_API_URL: "https://api.intelligence.copilotkit.ai",
          INTELLIGENCE_GATEWAY_WS_URL:
            "wss://realtime.intelligence.copilotkit.ai",
        }),
      ).runtime,
    ).toEqual({ mode: "local", durableHistory: false });
  });

  test("configuring neither is still a refusal to boot, now pointing at the opt-in", () => {
    expect(() => loadConfig(withoutIntelligence())).toThrow(
      /CopilotKit Intelligence is required and is not configured\. Missing: .*OPENDUET_LOCAL_MODE=true/,
    );
  });

  test("a value that is neither true nor false is refused rather than read as no", () => {
    expect(() =>
      loadConfig(withoutIntelligence({ OPENDUET_LOCAL_MODE: "yes please" })),
    ).toThrow(/OPENDUET_LOCAL_MODE must be "true" or "false"/);
  });
});

function mountLocal(identifyUser: () => Promise<{ id: string; name: string }>) {
  return mountCopilotRuntime(
    loadConfig(withoutIntelligence({ OPENDUET_LOCAL_MODE: "true" })),
    createActorAgentResolver({
      model: { provider: "openai", defaultModel: "unused" },
      loadAgents: async () => [
        {
          id: "openduet",
          name: "OpenDuet",
          type: "built_in",
          systemPrompt: "Be brief.",
        },
      ],
      resolveModelApiKey: async () => "unused-key",
      stallGuard: createStallGuard({ stallMs: 0 }),
    }),
    identifyUser,
    async () => ({ id: "person", role: "user" }),
  );
}

describe("the runtime in local mode", () => {
  test("is the SSE runtime, reaches no Intelligence client, and refuses a signed-out run", async () => {
    // Every method on the Intelligence client, watched: none may be called while mounting or serving.
    const methods = Object.getOwnPropertyNames(
      CopilotKitIntelligence.prototype,
    ).filter(
      (name) =>
        name !== "constructor" &&
        typeof (
          CopilotKitIntelligence.prototype as unknown as Record<string, unknown>
        )[name] === "function",
    );
    const spies = methods.map((name) =>
      spyOn(
        CopilotKitIntelligence.prototype as unknown as Record<
          string,
          (...args: unknown[]) => unknown
        >,
        name,
      ),
    );
    try {
      const runtime = mountLocal(async () => {
        throw new Error("nobody is signed in");
      });

      const info = await runtime.handler.fetch(
        new Request("http://openduet.test/api/copilotkit/info"),
      );
      expect(info.status).toBe(200);
      expect(((await info.json()) as { mode?: string }).mode).toBe("sse");

      for (const path of [
        "/api/copilotkit/threads?agentId=openduet",
        "/api/copilotkit/agent/openduet/run",
        "/api/copilotkit/agent/openduet/connect",
      ]) {
        const refused = await runtime.handler.fetch(
          new Request(`http://openduet.test${path}`, {
            method:
              path.endsWith("run") || path.endsWith("connect") ? "POST" : "GET",
            headers: { "content-type": "application/json" },
            ...(path.endsWith("run") || path.endsWith("connect")
              ? {
                  body: JSON.stringify({
                    threadId: "t",
                    runId: "r",
                    messages: [],
                  }),
                }
              : {}),
          }),
        );
        expect(refused.status).toBe(401);
      }

      expect(runtime.learning).toBeUndefined();
      expect(runtime.handoffRunner()).toBe(localThreadPlatform().runner);
      expect(() => runtime.runnerConnection()).toThrow(/Local mode/);

      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test("lists a signed-in person's own threads through the runtime's thread endpoints", async () => {
    const platform = localThreadPlatform();
    await platform.getOrCreateThread({
      threadId: "local-mode-test-thread",
      userId: "local-mode-person",
      agentId: "openduet",
    });
    const runtime = mountLocal(async () => ({
      id: "local-mode-person",
      name: "Person",
    }));
    const listed = await runtime.handler.fetch(
      new Request(
        "http://openduet.test/api/copilotkit/threads?agentId=openduet",
      ),
    );
    expect(listed.status).toBe(200);
    // A thread with no run yet is not listed (nothing to show); reading it is still scoped.
    expect(
      await runtime.history({
        threadId: "local-mode-test-thread",
        actorId: "local-mode-person",
      }),
    ).toEqual([]);
    expect(
      await runtime.history({
        threadId: "local-mode-test-thread",
        actorId: "somebody-else",
      }),
    ).toEqual([]);
    expect(
      await runtime.threadLock.acquire({
        threadId: "local-mode-test-thread",
        runId: "hop",
        userId: "local-mode-person",
        agentId: "openduet",
      }),
    ).toEqual({ runId: "hop" });
    await runtime.threadLock.release({
      threadId: "local-mode-test-thread",
      runId: "hop",
    });
  });
});
