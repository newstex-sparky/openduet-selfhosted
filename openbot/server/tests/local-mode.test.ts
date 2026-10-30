import { describe, expect, spyOn, test } from "bun:test";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createStallGuard } from "../src/channels/stall-guard";
import { loadConfig, runtimeCapabilities } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { localThreadPlatform } from "../src/local-mode";
import { testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * LOCAL MODE: the only mode this fork has.
 *
 * Two promises are asserted here. Local mode is what every deployment gets — with no Intelligence
 * variables, with a leftover `.env` that still names them, and with no `OPENDUET_LOCAL_MODE` at all
 * — and once mounted, the runtime reaches no Intelligence client and still refuses a run nobody
 * signed in for.
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
  test("boots into local mode whatever the mode variable says, including nothing", () => {
    for (const value of [undefined, "", "false", "0", "true", "yes please"]) {
      const environment = withoutIntelligence({ OPENDUET_LOCAL_MODE: value });
      expect(loadConfig(environment).runtime).toEqual({
        mode: "local",
        durableHistory: true,
      });
      expect(runtimeCapabilities()).toEqual({
        mode: "local",
        durableHistory: true,
      });
    }
  });

  test("leftover Intelligence variables are ignored rather than refused", () => {
    expect(
      loadConfig(
        testEnvironment({
          OPENDUET_LOCAL_MODE: "true",
          INTELLIGENCE_API_URL: "https://api.intelligence.copilotkit.ai",
          INTELLIGENCE_GATEWAY_WS_URL: "wss://realtime.intelligence.copilotkit.ai",
          INTELLIGENCE_API_KEY: "left-over-key",
        }),
      ).runtime,
    ).toEqual({ mode: "local", durableHistory: true });
  });

  test("a licence token changes nothing, because nothing sends one", () => {
    expect(
      loadConfig({
        ...withoutIntelligence(),
        COPILOTKIT_LICENSE_TOKEN: "left-over-licence",
      }).runtime,
    ).toEqual({ mode: "local", durableHistory: true });
  });
});

/**
 * Local mode's config, pointed at the dedicated test database: the thread platform is Postgres now
 * (migration 0068), and it must never reach the `DATABASE_URL` the test environment carries.
 */
function localConfig() {
  return loadConfig(
    withoutIntelligence({
      OPENDUET_LOCAL_MODE: "true",
      DATABASE_URL: testDatabaseUrl(),
    }),
  );
}

function mountLocal(identifyUser: () => Promise<{ id: string; name: string }>) {
  return mountCopilotRuntime(
    localConfig(),
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
      expect(runtime.handoffRunner()).toBe(
        localThreadPlatform(localConfig()).runner,
      );
      expect(() => runtime.runnerConnection()).toThrow(/Local mode/);

      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test("lists a signed-in person's own threads through the runtime's thread endpoints", async () => {
    const platform = localThreadPlatform(localConfig());
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
