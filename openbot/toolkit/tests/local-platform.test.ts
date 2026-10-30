import { describe, expect, test } from "bun:test";
import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import { AbstractAgent, EventType } from "@ag-ui/client";
import { Observable } from "rxjs";
import {
  createLocalThreadPlatform,
  currentLocalUser,
  runAsLocalUser,
} from "../src/copilotkit/local-platform";
import { createThreadLock } from "../src/copilotkit/thread-lock";
import { isLockConflict } from "../src/lease";
import { createTurnRunner } from "../src/run-turn";
import { historyOrEmpty, isMissingThread } from "../src/thread-history";

/**
 * Local mode's thread platform: the in-process stand-in for CopilotKit Intelligence.
 *
 * The properties that matter are the ones the rest of the server leans on without knowing which
 * platform it has: a run streams and is remembered, a thread belongs to the person who started it,
 * the lock refuses with the platform's own 409, a missing thread reads as the platform's 404, and a
 * headless turn (`createTurnRunner`) runs end to end against it with no gateway at all.
 */

/** A Bot that says `reply` (or fails, or waits to be stopped) through the real AG-UI pipeline. */
class ScriptedAgent extends AbstractAgent {
  constructor(
    private readonly script: {
      reply?: string;
      fail?: string;
      hang?: boolean;
    } = {},
  ) {
    super({ agentId: "helper" });
  }

  /** Ends a hung run, as a real agent's abort ends its stream. */
  private finishHung?: () => void;

  override abortRun(): void {
    this.finishHung?.();
    super.abortRun();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      if (this.script.fail) {
        subscriber.error(new Error(this.script.fail));
        return;
      }
      if (this.script.hang) {
        this.finishHung = () => subscriber.complete();
        return;
      }
      const messageId = `assistant-${input.runId}`;
      subscriber.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: this.script.reply ?? "Hello.",
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_END,
        messageId,
      } as BaseEvent);
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.complete();
    });
  }
}

function userMessage(id: string, content: string): Message {
  return { id, role: "user", content } as Message;
}

/** Drive the runner the way the runtime's SSE handler does: set the conversation, then run. */
function runInput(
  threadId: string,
  runId: string,
  messages: Message[],
): RunAgentInput {
  return {
    threadId,
    runId,
    messages,
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
}

function collect(observable: Observable<BaseEvent>): Promise<BaseEvent[]> {
  return new Promise((resolve, reject) => {
    const events: BaseEvent[] = [];
    observable.subscribe({
      next: (event) => events.push(event),
      error: reject,
      complete: () => resolve(events),
    });
  });
}

function agentFor(messages: Message[], script = {}) {
  const agent = new ScriptedAgent(script);
  agent.setMessages(messages);
  return agent;
}

describe("local thread platform", () => {
  test("a run streams its events, is remembered, and replays on connect", async () => {
    const platform = createLocalThreadPlatform();
    const first = [userMessage("u1", "Hi")];
    const events = await runAsLocalUser("alice", () =>
      collect(
        platform.runner.run({
          threadId: "t1",
          agent: agentFor(first, { reply: "Hello, Alice." }),
          input: runInput("t1", "r1", first),
        }),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);

    const history = await platform.getThreadMessages({
      threadId: "t1",
      userId: "alice",
    });
    expect(history.messages).toEqual([
      { id: "u1", role: "user", content: "Hi" },
      { id: "assistant-r1", role: "assistant", content: "Hello, Alice." },
    ]);

    const replay = await runAsLocalUser("alice", () =>
      collect(platform.runner.connect({ threadId: "t1" })),
    );
    expect(replay.map((event) => event.type)).toContain(
      EventType.TEXT_MESSAGE_CONTENT,
    );
    expect(await platform.runner.isRunning({ threadId: "t1" })).toBe(false);
  });

  test("a second run's RUN_STARTED carries only the new messages, so a replay shows each once", async () => {
    const platform = createLocalThreadPlatform();
    const first = [userMessage("u1", "Hi")];
    await runAsLocalUser("alice", () =>
      collect(
        platform.runner.run({
          threadId: "t1",
          agent: agentFor(first),
          input: runInput("t1", "r1", first),
        }),
      ),
    );
    const prior = (
      await platform.getThreadMessages({ threadId: "t1", userId: "alice" })
    ).messages as Message[];
    const second = [...prior, userMessage("u2", "And again")];
    const events = await runAsLocalUser("alice", () =>
      collect(
        platform.runner.run({
          threadId: "t1",
          agent: agentFor(second),
          input: runInput("t1", "r2", second),
        }),
      ),
    );
    const started = events[0] as BaseEvent & { input?: RunAgentInput };
    expect(started.input?.messages.map((message) => message.id)).toEqual([
      "u2",
    ]);
  });

  test("a thread belongs to whoever started it; anybody else gets the missing-thread answer", async () => {
    const platform = createLocalThreadPlatform();
    const first = [userMessage("u1", "Private")];
    await runAsLocalUser("alice", () =>
      collect(
        platform.runner.run({
          threadId: "t1",
          agent: agentFor(first),
          input: runInput("t1", "r1", first),
        }),
      ),
    );

    // Running into it as somebody else is refused before anything is streamed.
    expect(() =>
      runAsLocalUser("mallory", () =>
        platform.runner.run({
          threadId: "t1",
          agent: agentFor(first),
          input: runInput("t1", "r2", first),
        }),
      ),
    ).toThrow();
    // And nothing about it is readable.
    expect(
      await runAsLocalUser("mallory", () =>
        collect(platform.runner.connect({ threadId: "t1" })),
      ),
    ).toEqual([]);
    expect(
      runAsLocalUser("mallory", () => platform.runner.listThreads()),
    ).toEqual([]);
    expect(
      runAsLocalUser("mallory", () => platform.runner.getThreadMessages("t1")),
    ).toEqual([]);
    const refused = await platform
      .getThread({ threadId: "t1", userId: "mallory" })
      .catch((error: unknown) => error);
    expect(isMissingThread(refused)).toBe(true);

    // The owner still sees it, and no request user at all (the runtime asking for itself) sees none.
    expect(
      runAsLocalUser("alice", () => platform.runner.listThreads()).map(
        (thread) => thread.id,
      ),
    ).toEqual(["t1"]);
    expect(platform.runner.listThreads()).toEqual([]);
  });

  test("clearing threads clears only the caller's own", async () => {
    const platform = createLocalThreadPlatform();
    for (const [user, thread] of [
      ["alice", "ta"],
      ["bob", "tb"],
    ] as const) {
      const messages = [userMessage(`${thread}-u`, "Hi")];
      await runAsLocalUser(user, () =>
        collect(
          platform.runner.run({
            threadId: thread,
            agent: agentFor(messages),
            input: runInput(thread, `${thread}-r`, messages),
          }),
        ),
      );
    }
    runAsLocalUser("alice", () => platform.runner.clearThreads());
    expect(
      runAsLocalUser("bob", () => platform.runner.listThreads()).map(
        (thread) => thread.id,
      ),
    ).toEqual(["tb"]);
    expect(
      runAsLocalUser("alice", () => platform.runner.listThreads()),
    ).toEqual([]);
  });

  test("a missing thread reads as the platform's 404, so historyOrEmpty answers empty", async () => {
    const platform = createLocalThreadPlatform();
    expect(
      await historyOrEmpty(
        () => platform.getThreadMessages({ threadId: "nope", userId: "alice" }),
        { messages: [] },
      ),
    ).toEqual({ messages: [] });
  });

  test("the lock refuses a second run with the platform's 409 and is released by cleanup", async () => {
    let clock = 1_000;
    const platform = createLocalThreadPlatform({ now: () => clock });
    const lock = {
      threadId: "t1",
      userId: "alice",
      agentId: "helper",
      ttlSeconds: 60,
    };
    await platform.ɵacquireThreadLock({ ...lock, runId: "held" });
    const conflict = await platform
      .ɵacquireThreadLock({ ...lock, runId: "other" })
      .catch((error: unknown) => error);
    expect(isLockConflict(conflict)).toBe(true);

    // A browser run with a different run id is refused while the lock is held …
    const messages = [userMessage("u1", "Hi")];
    expect(() =>
      runAsLocalUser("alice", () =>
        platform.runner.run({
          threadId: "t1",
          agent: agentFor(messages),
          input: runInput("t1", "browser-run", messages),
        }),
      ),
    ).toThrow();
    // … and renewing somebody else's lock is a conflict too.
    expect(
      isLockConflict(
        await platform
          .ɵrenewThreadLock({ threadId: "t1", runId: "other", ttlSeconds: 60 })
          .catch((error: unknown) => error),
      ),
    ).toBe(true);

    await platform.ɵcleanupThreadLock({ threadId: "t1", runId: "held" });
    await platform.ɵacquireThreadLock({ ...lock, runId: "other" });

    // A lock nobody renewed lapses on its own, as the platform's TTL does.
    clock += 61_000;
    await platform.ɵacquireThreadLock({ ...lock, runId: "third" });
  });

  test("the shared thread lock adapter drives the local platform exactly as it drives Intelligence", async () => {
    const platform = createLocalThreadPlatform();
    const busy: boolean[] = [];
    const lock = createThreadLock({
      client: platform,
      onRunBusy: ({ busy: value }) => {
        busy.push(value);
      },
    });
    const input = {
      threadId: "t1",
      runId: "hop",
      userId: "alice",
      agentId: "helper",
    };
    expect(await lock.acquire(input)).toEqual({ runId: "hop" });
    expect(await lock.acquire({ ...input, runId: "second" })).toBeNull();
    await lock.release({ threadId: "t1", runId: "hop" });
    expect(await lock.acquire({ ...input, runId: "second" })).toEqual({
      runId: "second",
    });
    expect(busy).toEqual([true, false, true]);
  });

  test("a failing agent ends its run with RUN_ERROR and completes rather than erroring the stream", async () => {
    const platform = createLocalThreadPlatform();
    const messages = [userMessage("u1", "Hi")];
    const events = await runAsLocalUser("alice", () =>
      collect(
        platform.runner.run({
          threadId: "t1",
          agent: agentFor(messages, { fail: "model unavailable" }),
          input: runInput("t1", "r1", messages),
        }),
      ),
    );
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
    });
    expect(await platform.runner.isRunning({ threadId: "t1" })).toBe(false);
  });

  test("stop aborts the run in progress and the thread is free again", async () => {
    const platform = createLocalThreadPlatform();
    const messages = [userMessage("u1", "Hi")];
    const agent = agentFor(messages, { hang: true });
    const stream = runAsLocalUser("alice", () =>
      platform.runner.run({
        threadId: "t1",
        agent,
        input: runInput("t1", "r1", messages),
      }),
    );
    // Wait until the agent is actually running (it has said RUN_STARTED) before stopping it.
    const startedRun = new Promise<void>((resolve) => {
      stream.subscribe({
        next: (event) => {
          if (event.type === EventType.RUN_STARTED) resolve();
        },
      });
    });
    const done = collect(stream);
    await startedRun;
    expect(await platform.runner.isRunning({ threadId: "t1" })).toBe(true);
    expect(await platform.runner.stop({ threadId: "t1", runId: "other" })).toBe(
      false,
    );
    expect(await platform.runner.stop({ threadId: "t1", runId: "r1" })).toBe(
      true,
    );
    const events = await done;
    expect(
      events.some(
        (event) =>
          event.type === EventType.RUN_FINISHED ||
          event.type === EventType.RUN_ERROR,
      ),
    ).toBe(true);
    expect(await platform.runner.isRunning({ threadId: "t1" })).toBe(false);
  });

  test("the request scope is visible inside it and gone outside it", () => {
    expect(currentLocalUser()).toBeUndefined();
    expect(runAsLocalUser("alice", () => currentLocalUser())).toBe("alice");
    expect(currentLocalUser()).toBeUndefined();
  });
});

describe("a headless turn in local mode", () => {
  test("createTurnRunner runs end to end against the local platform: reply, history, lock released", async () => {
    const platform = createLocalThreadPlatform();
    const runTurn = createTurnRunner({
      intelligence: platform,
      runner: platform.runner,
      admission: async ({ signal }) => signal ?? new AbortController().signal,
      buildAgentFor: async () =>
        new ScriptedAgent({ reply: "The standup is posted." }),
      heartbeatMs: 60_000,
    });

    const result = await runTurn({
      ownerUserId: "alice",
      routineId: "routine-standup",
      agentId: "helper",
      threadId: "routine-thread",
      instruction: "Post the standup.",
    });
    expect(result.replyText).toBe("The standup is posted.");

    // The reply landed in the conversation the person opens, and is theirs alone.
    const history = await platform.getThreadMessages({
      threadId: "routine-thread",
      userId: "alice",
    });
    expect(history.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(
      runAsLocalUser("alice", () => platform.runner.listThreads()).map(
        (thread) => thread.id,
      ),
    ).toEqual(["routine-thread"]);
    expect(platform.stats()).toMatchObject({ running: 0, locks: 0 });

    // And a second firing reads the first one back as history.
    await runTurn({
      ownerUserId: "alice",
      routineId: "routine-standup",
      agentId: "helper",
      threadId: "routine-thread",
      instruction: "Post the standup.",
    });
    expect(
      (
        await platform.getThreadMessages({
          threadId: "routine-thread",
          userId: "alice",
        })
      ).messages.map((message) => message.role),
    ).toEqual(["user", "assistant", "user", "assistant"]);
  });
});
