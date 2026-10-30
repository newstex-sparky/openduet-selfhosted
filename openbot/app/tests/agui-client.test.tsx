import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { z } from "zod";
import {
  CopilotKit,
  CopilotKitProvider,
  agentKey,
  useAgent,
  useAttachments,
  useCopilotKit,
  useFrontendTool,
  useRenderTool,
  useRenderToolCall,
  type ToolCall,
} from "@/lib/agui";
import { settleReactWork } from "./settle-react-work";

/**
 * The first-party client, exercised against a stub runtime rather than read.
 *
 * Everything here is the real code: the real `RuntimeAgent` against a real `fetch` that answers
 * with a real SSE stream, the real registry, the real hooks under the real provider. What is not
 * real is the server — which is the point, because these are the three things a mistake in this
 * layer would break silently: the request it puts on the wire, the events it applies, and the
 * browser-side tool it runs between two runs.
 */

let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

type RecordedRequest = {
  url: string;
  init: RequestInit;
  body: RunAgentInputBody;
};

type RunAgentInputBody = {
  threadId: string;
  runId: string;
  messages: Message[];
  tools: { name: string; description: string; parameters?: unknown }[];
};

/** One SSE frame. */
function frame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** A turn that writes one reply and finishes. */
function textTurn(text: string, ids = { run: "run-1", message: "msg-1" }): string {
  return [
    frame({
      type: "RUN_STARTED",
      threadId: "thread-1",
      runId: ids.run,
    }),
    frame({
      type: "TEXT_MESSAGE_START",
      messageId: ids.message,
      role: "assistant",
    }),
    frame({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: ids.message,
      delta: text,
    }),
    frame({ type: "TEXT_MESSAGE_END", messageId: ids.message }),
    frame({
      type: "RUN_FINISHED",
      threadId: "thread-1",
      runId: ids.run,
      outcome: { type: "success" },
    }),
  ].join("");
}

/** A turn that calls one tool and finishes with the call unanswered. */
function toolTurn(call: {
  id: string;
  name: string;
  args: string;
}): string {
  return [
    frame({ type: "RUN_STARTED", threadId: "thread-1", runId: "run-tool" }),
    frame({
      type: "TOOL_CALL_START",
      toolCallId: call.id,
      toolCallName: call.name,
    }),
    frame({
      type: "TOOL_CALL_ARGS",
      toolCallId: call.id,
      delta: call.args,
    }),
    frame({ type: "TOOL_CALL_END", toolCallId: call.id }),
    frame({
      type: "RUN_FINISHED",
      threadId: "thread-1",
      runId: "run-tool",
      outcome: { type: "success" },
    }),
  ].join("");
}

/** Answer every request with the next scripted stream, and keep what was sent. */
function stubRuntime(scripts: string[]): RecordedRequest[] {
  const recorded: RecordedRequest[] = [];
  let index = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as RunAgentInputBody;
    recorded.push({ url: String(url), init: init ?? {}, body });
    const script = scripts[Math.min(index, scripts.length - 1)];
    index += 1;
    return new Response(script, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof globalThis.fetch;
  return recorded;
}

describe("the registry", () => {
  test("keys an agent by its runtime id and thread", () => {
    expect(agentKey({ agentId: "bot", threadId: "t1" })).toBe("bot#t1");
    expect(agentKey({ agentId: "bot" })).toBe("bot");
    expect(
      agentKey({ agentId: "local", runtimeAgentId: "remote", threadId: "t1" }),
    ).toBe("remote#t1");
  });

  test("gives a threadless lookup and a threaded one the same agent, in either order", () => {
    const kit = new CopilotKit({ runtimeUrl: "/api/copilotkit" });
    const threaded = kit.agentFor({ agentId: "bot", threadId: "t1" });
    expect(kit.agentFor({ agentId: "bot" })).toBe(threaded);

    const fresh = new CopilotKit({ runtimeUrl: "/api/copilotkit" });
    const bare = fresh.agentFor({ agentId: "bot" });
    expect(fresh.agentFor({ agentId: "bot", threadId: "t1" })).toBe(bare);
  });

  test("never writes a second thread over the first", () => {
    const kit = new CopilotKit({ runtimeUrl: "/api/copilotkit" });
    const first = kit.agentFor({ agentId: "bot", threadId: "t1" });
    const second = kit.agentFor({ agentId: "bot", threadId: "t2" });
    expect(second).not.toBe(first);
    expect(first.threadId).toBe("t1");
    expect(second.threadId).toBe("t2");
  });

  test("offers the model a JSON Schema built from the tool's zod schema", () => {
    const kit = new CopilotKit({ runtimeUrl: "/api/copilotkit" });
    kit.registerTool({
      name: "read_file",
      description: "Read one file.",
      parameters: z.object({ path: z.string() }),
      handler: async () => "ok",
    });
    kit.registerTool({
      name: "revoked",
      description: "Not offered right now.",
      parameters: z.object({}),
      available: false,
      handler: async () => "ok",
    });
    const agent = kit.agentFor({ agentId: "bot" });
    const offered = kit.toolsFor(agent);
    expect(offered.map((tool) => tool.name)).toEqual(["read_file"]);
    expect(offered[0]?.parameters).toMatchObject({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
  });

  test("tells a subscriber when a card is registered, and stops when it is gone", () => {
    const kit = new CopilotKit({ runtimeUrl: "/api/copilotkit" });
    const seen: number[] = [];
    const subscription = kit.subscribe({
      onRenderToolCallsChanged: () => seen.push(kit.renderToolCalls.length),
    });
    const remove = kit.addHookRenderToolCall({
      name: "card",
      render: () => null,
    });
    expect(kit.rendererFor("card", undefined)?.name).toBe("card");
    remove();
    expect(kit.rendererFor("card", undefined)).toBeUndefined();
    expect(seen).toEqual([1, 0]);
    subscription.unsubscribe();
  });
});

describe("the agent on the wire", () => {
  test("starts a run at the agent's own endpoint, with the session cookie", async () => {
    const kit = new CopilotKit({ runtimeUrl: "/api/copilotkit/" });
    const recorded = stubRuntime([textTurn("Hello there.")]);
    const agent = kit.agentFor({ agentId: "bot", threadId: "thread-1" });

    await kit.runAgent({ agent });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.url).toBe("/api/copilotkit/agent/bot/run");
    expect(recorded[0]?.init.method).toBe("POST");
    expect(recorded[0]?.init.credentials).toBe("include");
    expect(
      new Headers(recorded[0]?.init.headers).get("accept"),
    ).toBe("text/event-stream");
    expect(recorded[0]?.body.threadId).toBe("thread-1");
    expect(agent.messages.map((message) => message.content)).toEqual([
      "Hello there.",
    ]);
  });

  test("attaches to a thread at the connect endpoint, and replays it", async () => {
    const kit = new CopilotKit({ runtimeUrl: "/api/copilotkit" });
    const recorded = stubRuntime([textTurn("Replayed.")]);
    const agent = kit.agentFor({ agentId: "bot", threadId: "thread-1" });

    await kit.connectAgent({ agent });

    expect(recorded[0]?.url).toBe("/api/copilotkit/agent/bot/connect");
    expect(recorded[0]?.init.credentials).toBe("include");
    expect(agent.messages.map((message) => message.content)).toEqual([
      "Replayed.",
    ]);
  });

  test("runs a browser-side tool between two runs and sends its answer back", async () => {
    const kit = new CopilotKit({ runtimeUrl: "/api/copilotkit" });
    const recorded = stubRuntime([
      toolTurn({ id: "call-1", name: "read_file", args: '{"path":"/a"}' }),
      textTurn("The file says a.", { run: "run-2", message: "msg-2" }),
    ]);
    const seen: unknown[] = [];
    kit.registerTool({
      name: "read_file",
      description: "Read one file.",
      parameters: z.object({ path: z.string() }),
      handler: async (args) => {
        seen.push(args);
        return "a";
      },
    });
    const agent = kit.agentFor({ agentId: "bot", threadId: "thread-1" });

    await kit.runAgent({ agent });

    expect(seen).toEqual([{ path: "/a" }]);
    expect(recorded).toHaveLength(2);
    const tool = agent.messages.find((message) => message.role === "tool");
    expect(tool).toMatchObject({ toolCallId: "call-1", content: "a" });
    // The second run carries the answer, or the provider refuses to start it.
    expect(
      recorded[1]?.body.messages.some((message) => message.role === "tool"),
    ).toBe(true);
    expect(agent.messages.at(-1)?.content).toBe("The file says a.");
  });

  test("keeps the sentence a failed run reported", async () => {
    const kit = new CopilotKit({ runtimeUrl: "/api/copilotkit" });
    stubRuntime([
      [
        frame({ type: "RUN_STARTED", threadId: "thread-1", runId: "run-1" }),
        frame({
          type: "RUN_ERROR",
          message: "The Bot's stream stopped.",
          code: "stalled",
        }),
      ].join(""),
    ]);
    const agent = kit.agentFor({ agentId: "bot", threadId: "thread-1" });
    await kit.runAgent({ agent }).catch(() => undefined);
    expect(agent.error?.message).toBe("The Bot's stream stopped.");
  });

  test("stops the run, and stops answering a tool still in flight", async () => {
    const kit = new CopilotKit({ runtimeUrl: "/api/copilotkit" });
    stubRuntime([toolTurn({ id: "call-1", name: "slow", args: "{}" })]);
    let started: () => void = () => {};
    const handlerRan = new Promise<void>((resolve) => {
      started = resolve;
    });
    kit.registerTool({
      name: "slow",
      description: "Never finishes on its own.",
      parameters: z.object({}),
      handler: () => {
        started();
        return new Promise((resolve) => setTimeout(() => resolve("late"), 50));
      },
    });
    const agent = kit.agentFor({ agentId: "bot", threadId: "thread-1" });
    const turn = kit.runAgent({ agent });
    await handlerRan;
    kit.stopAgent({ agent });
    await turn;
    expect(
      agent.messages.some((message) => message.role === "tool"),
    ).toBe(false);
  });
});

describe("the hooks", () => {
  test("draws a tool call with the card registered for it", async () => {
    const toolCall: ToolCall = {
      id: "call-1",
      type: "function",
      function: { name: "weather", arguments: '{"city":"Paris"}' },
    };
    function Surface() {
      useRenderTool({
        name: "weather",
        parameters: z.object({ city: z.string() }),
        render: ({ status, parameters }) => (
          <span>
            {status}:{parameters.city}
          </span>
        ),
      });
      const draw = useRenderToolCall();
      return <div>{draw({ toolCall })}</div>;
    }
    const screen = render(
      <CopilotKitProvider runtimeUrl="/api/copilotkit">
        <Surface />
      </CopilotKitProvider>,
    );
    await waitFor(() =>
      expect(screen.container.textContent).toBe("executing:Paris"),
    );
  });

  test("binds the packaged chat's agent, so a threadless surface sees its runs", async () => {
    const seen: unknown[] = [];
    function Surface() {
      const threaded = useAgent({ agentId: "bot", threadId: "thread-1" });
      const bare = useAgent({ agentId: "bot" });
      seen.push(threaded.agent === bare.agent);
      return null;
    }
    render(
      <CopilotKitProvider runtimeUrl="/api/copilotkit">
        <Surface />
      </CopilotKitProvider>,
    );
    await waitFor(() => expect(seen.at(-1)).toBe(true));
  });

  test("offers the model a tool a component registered", async () => {
    const recorded = stubRuntime([textTurn("done")]);
    function Surface() {
      useFrontendTool({
        name: "say_hi",
        description: "Say hello.",
        parameters: z.object({}),
        handler: async () => "hi",
      });
      return null;
    }
    function Send() {
      const { copilotkit } = useCopilotKit();
      const { agent } = useAgent({ agentId: "bot", threadId: "thread-1" });
      return (
        <button type="button" onClick={() => void copilotkit.runAgent({ agent })}>
          send
        </button>
      );
    }
    const screen = render(
      <CopilotKitProvider runtimeUrl="/api/copilotkit">
        <Surface />
        <Send />
      </CopilotKitProvider>,
    );
    await waitFor(() => expect(screen.getByText("send")).toBeTruthy());
    fireEvent.click(screen.getByText("send"));
    await waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0]?.body.tools.map((tool) => tool.name)).toEqual(["say_hi"]);
  });

  test("uploads a file, and hands the composer the reference it will send", async () => {
    function Composer() {
      const { attachments, processFiles } = useAttachments({
        config: {
          enabled: true,
          onUpload: async (file) => ({
            type: "url",
            value: `/api/attachments/${file.name}`,
            mimeType: file.type,
            metadata: { attachmentId: file.name },
          }),
        },
      });
      return (
        <button
          type="button"
          onClick={() =>
            void processFiles([
              new File(["bytes"], "shot.png", { type: "image/png" }),
            ])
          }
        >
          {attachments.map((attachment) => (
            <span key={attachment.id}>
              {attachment.status}:{attachment.source.value}
            </span>
          ))}
        </button>
      );
    }
    const screen = render(
      <CopilotKitProvider runtimeUrl="/api/copilotkit">
        <Composer />
      </CopilotKitProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(screen.getByRole("button").textContent).toBe(
        "ready:/api/attachments/shot.png",
      ),
    );
  });
});
