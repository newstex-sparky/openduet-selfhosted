import { expect, test } from "bun:test";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createStallGuard } from "../src/channels/stall-guard";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { localThreadPlatform } from "../src/local-mode";
import { testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * A delegation's scratch Thread, in the only mode this fork has.
 *
 * The lock used to be Intelligence's, and the addressed Bot's Learning assignment was handed to the
 * platform so it could attach a container. Local mode has no Learning containers: the lock creates
 * the thread in this deployment's Postgres and takes that thread's lock row. What is asserted here
 * is that the thread exists before the lock is held, that it belongs to the person who asked for
 * it, and that a second run in the same conversation is refused rather than queued.
 */
test("delegation creates its scratch Thread before locking, then refuses a second run", async () => {
  const guard = createStallGuard({ stallMs: 0 });
  const config = loadConfig(
    testEnvironment({
      OPENDUET_LOCAL_MODE: undefined,
      DATABASE_URL: testDatabaseUrl(),
    }),
  );
  const threadId = `learning-handoff-scratch-${crypto.randomUUID()}`;
  try {
    const runtime = mountCopilotRuntime(
      config,
      createActorAgentResolver({
        model: { provider: "openai", defaultModel: "unused" },
        loadAgents: async () => [],
        resolveModelApiKey: async () => null,
        stallGuard: guard,
      }),
      async () => ({ id: "person", name: "Person" }),
      async () => ({ id: "person", role: "user" }),
    );

    expect(
      await runtime.threadLock.acquire({
        threadId,
        runId: "delegation-run",
        userId: "person",
        agentId: "specialist",
      }),
    ).toEqual({ runId: "delegation-run" });

    // The thread the lock was taken on is real, and it belongs to the person the hop was made for.
    expect(
      await localThreadPlatform(config).getThread({
        threadId,
        userId: "person",
      }),
    ).toMatchObject({
      id: threadId,
      agentId: "specialist",
      createdById: "person",
    });

    // A second run in the same conversation is refused rather than queued.
    expect(
      await runtime.threadLock.acquire({
        threadId,
        runId: "second-run",
        userId: "person",
        agentId: "specialist",
      }),
    ).toBeNull();

    await runtime.threadLock.release({
      threadId,
      runId: "delegation-run",
    });
  } finally {
    guard.stop();
  }
});
