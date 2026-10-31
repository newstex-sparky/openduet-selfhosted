import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { CopilotChat, CopilotKitProvider } from "@/lib/agui";
import { settleReactWork } from "./settle-react-work";
/**
 * `CopilotChat`, the Bot screen's conversation, driven through the real provider, the real
 * `RuntimeAgent` and a stub runtime.
 *
 * WHAT THIS FILE IS FOR is the one claim the Bot route makes about the chat it draws: that it is
 * THIS APP'S transcript and composer, bound to a Bot and a thread, and not a packaged chat surface
 * of its own. So nothing about the chat is mocked here — the transcript's `role="log"` and the
 * composer's own `Send message` button are what these tests reach for, and a swap back to a
 * vendor surface would fail them by name rather than by pixels.
 *
 * THE ROUTE HANDS OVER TWO STRINGS AND NOTHING ELSE. `agentId` and `threadId` are the whole
 * contract (see `bot.tsx`), and everything the chat knows about the agent — its messages, whether
 * it is running, the sentence a failed run left — is read back through `useAgent` on the agent the
 * chat itself binds. The join case below is the one that would silently regress if the chat ever
 * went back to needing an agent object from the route.
 *
 * The harness matches this repository's: `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup`
 * in `afterEach`, and `settleReactWork` before unregistering the document.
 */

const BOT = "bot";
const THREAD = "thread-1";

/**
 * How long a drawn thing is given to appear.
 *
 * These waits settle in tens of milliseconds on a quiet machine, but the file runs inside the
 * whole suite: under that load the default one-second budget can expire while the assertions
 * are still true of the tree a moment later. The budget is widened the way this repository's
 * other loaded waits are (channel-history-refresh, sign-in-card, task-thread). Nothing the
 * tests assert is relaxed. It is kept under bun's five-second per-test budget so a real failure
 * still reports the missing element rather than a bare timeout.
 */
const DRAWN = { timeout: 3_000 };

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
  method: string;
  body: Record<string, unknown> | null;
};

/** One SSE frame. */
function frame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** A turn that writes one reply and finishes. */
function textTurn(text: string): string {
  return [
    frame({ type: "RUN_STARTED", threadId: THREAD, runId: "run-1" }),
    frame({
      type: "TEXT_MESSAGE_START",
      messageId: "msg-1",
      role: "assistant",
    }),
    frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1", delta: text }),
    frame({ type: "TEXT_MESSAGE_END", messageId: "msg-1" }),
    frame({
      type: "RUN_FINISHED",
      threadId: THREAD,
      runId: "run-1",
      outcome: { type: "success" },
    }),
  ].join("");
}

/** A join that replays what the thread already holds, then follows nothing. */
function replayTurn(messages: Message[]): string {
  return [
    frame({ type: "RUN_STARTED", threadId: THREAD, runId: "join-1" }),
    frame({ type: "MESSAGES_SNAPSHOT", messages }),
    frame({
      type: "RUN_FINISHED",
      threadId: THREAD,
      runId: "join-1",
      outcome: { type: "success" },
    }),
  ].join("");
}

/**
 * Answer the chat endpoints from a script, and keep every request.
 *
 * `connect` and `run` are answered from separate scripts so a test can say what the thread
 * already held and what the next turn says. Everything else the surfaces around the chat ask for
 * (the approval inbox, who is signed in) is answered as absent, which is what an unconfigured
 * deployment looks like and is what the transcript already tolerates.
 */
function stubRuntime(scripts: {
  connect?: string;
  run?: string;
}): RecordedRequest[] {
  const recorded: RecordedRequest[] = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const pathname = new URL(url, "http://localhost").pathname;
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null;
      recorded.push({ url: pathname, method, body });

      if (pathname.endsWith("/connect")) {
        return new Response(scripts.connect ?? replayTurn([]), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (pathname.endsWith("/run")) {
        return new Response(scripts.run ?? textTurn("Done."), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (pathname.includes("/stop/")) {
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  ) as unknown as typeof globalThis.fetch;
  return recorded;
}

/** A join that never finishes, the way a thread with a live run holds one open. */
function heldJoin(recorded: RecordedRequest[]): {
  release(messages: Message[]): void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(opened) {
      controller = opened;
    },
  });
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const pathname = new URL(url, "http://localhost").pathname;
      const method = init?.method ?? "GET";
      recorded.push({
        url: pathname,
        method,
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : null,
      });
      if (pathname.endsWith("/connect")) {
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (pathname.includes("/stop/")) {
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  ) as unknown as typeof globalThis.fetch;
  return {
    release(messages) {
      controller?.enqueue(
        encoder.encode(
          [
            frame({ type: "RUN_STARTED", threadId: THREAD, runId: "join-1" }),
            frame({ type: "MESSAGES_SNAPSHOT", messages }),
            frame({
              type: "RUN_FINISHED",
              threadId: THREAD,
              runId: "join-1",
              outcome: { type: "success" },
            }),
          ].join(""),
        ),
      );
      controller?.close();
    },
  };
}

/** Type into the composer the way its own tests do: a text paste at the caret. */
function typeInto(container: HTMLElement, words: string): void {
  const editor = container.querySelector("[contenteditable]") as HTMLElement;
  editor.focus();
  const caret = document.createRange();
  caret.selectNodeContents(editor);
  caret.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(caret);
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      items: [],
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? words : ""),
    },
  });
}

/** The chat alone, under the provider the app mounts once for the whole screen. */
function mount(): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CopilotKitProvider runtimeUrl="/api/copilotkit">
        <CopilotChat agentId={BOT} threadId={THREAD} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

test("draws this app's own transcript and composer, from a name and a thread", async () => {
  stubRuntime({ connect: replayTurn([]) });
  const view = mount();

  // The transcript's log and the composer's editor and send control, from the app's components.
  await waitFor(() => expect(view.getByRole("log")).toBeTruthy(), DRAWN);
  expect(view.container.querySelector("[contenteditable]")).toBeTruthy();
  expect(view.getByLabelText("Send message")).toBeTruthy();
  // No chat surface of the vendor's is drawn over it: the log holds the app's own structure.
  await waitFor(() => expect(view.getByRole("log").tagName).toBe("DIV"), DRAWN);
});

test("joins the thread the route named, and draws what was already said in it", async () => {
  const recorded = stubRuntime({
    connect: replayTurn([
      { id: "u1", role: "user", content: "Where did we leave it?" },
      { id: "a1", role: "assistant", content: "On the second clause." },
    ]),
  });
  const view = mount();

  await waitFor(
    () => expect(view.getByText("On the second clause.")).toBeTruthy(),
    DRAWN,
  );
  expect(view.getByText("Where did we leave it?")).toBeTruthy();
  const join = recorded.find((request) => request.url.endsWith("/connect"));
  expect(join?.url).toBe(`/api/copilotkit/agent/${BOT}/connect`);
  expect(join?.body?.threadId).toBe(THREAD);
});

test("sends the person's words into that thread, and draws the reply as it arrives", async () => {
  const recorded = stubRuntime({
    connect: replayTurn([]),
    run: textTurn("The page is open."),
  });
  const view = mount();
  await waitFor(() => expect(view.getByRole("log")).toBeTruthy(), DRAWN);

  await act(async () => typeInto(view.container, "open the dashboard"));
  await act(async () => {
    fireEvent.click(view.getByLabelText("Send message"));
  });

  await waitFor(
    () => expect(view.getByText("The page is open.")).toBeTruthy(),
    DRAWN,
  );
  expect(view.getByText("open the dashboard")).toBeTruthy();

  const run = recorded.find((request) => request.url.endsWith("/run"));
  expect(run?.url).toBe(`/api/copilotkit/agent/${BOT}/run`);
  expect(run?.method).toBe("POST");
  expect(run?.body?.threadId).toBe(THREAD);
  const sent = run?.body?.messages as Message[];
  expect(sent.map((message) => message.content)).toEqual([
    "open the dashboard",
  ]);
});

test("stops the turn at the runtime, not only in this tab", async () => {
  const recorded: RecordedRequest[] = [];
  const join = heldJoin(recorded);
  const view = mount();

  await waitFor(() => expect(view.getByRole("log")).toBeTruthy(), DRAWN);
  await waitFor(
    () => expect(view.getByTestId("composer-stop")).toBeTruthy(),
    DRAWN,
  );

  await act(async () => {
    fireEvent.click(view.getByTestId("composer-stop"));
  });
  join.release([]);

  await waitFor(
    () =>
      expect(
        recorded.some(
          (request) =>
            request.url === `/api/copilotkit/agent/${BOT}/stop/${THREAD}` &&
            request.method === "POST",
        ),
      ).toBe(true),
    DRAWN,
  );
});
