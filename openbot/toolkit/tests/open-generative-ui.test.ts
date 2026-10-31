import { describe, expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { firstValueFrom, Observable, toArray } from "rxjs";
import {
  ArgsParser,
  OpenGenerativeUIMiddleware,
} from "../src/copilotkit/engine/open-generative-ui";

/** A Bot that replays a fixed event list, so the middleware sees exactly what a model streamed. */
class ReplayAgent extends AbstractAgent {
  constructor(private readonly events: BaseEvent[]) {
    super({ agentId: "replay" });
  }

  run(_input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      for (const event of this.events) subscriber.next(event);
      subscriber.complete();
    });
  }
}

const input: RunAgentInput = {
  threadId: "thread-1",
  runId: "run-1",
  state: {},
  messages: [],
  tools: [],
  context: [],
  forwardedProps: {},
};

function runThrough(events: BaseEvent[]): Promise<BaseEvent[]> {
  return firstValueFrom(
    new OpenGenerativeUIMiddleware()
      .run(input, new ReplayAgent(events))
      .pipe(toArray()),
  );
}

const start = {
  type: EventType.RUN_STARTED,
  threadId: "thread-1",
  runId: "run-1",
} as BaseEvent;
const finish = {
  type: EventType.RUN_FINISHED,
  threadId: "thread-1",
  runId: "run-1",
} as BaseEvent;

describe("OpenGenerativeUIMiddleware (in-repo port)", () => {
  test("a streamed generateSandboxedUi call becomes an activity snapshot and ordered deltas", async () => {
    const args = JSON.stringify({
      initialHeight: 240,
      placeholderMessages: ["Drawing"],
      css: "p{color:red}",
      html: "<p>hi</p>",
      jsExpressions: ["1+1"],
    });
    const events = await runThrough([
      start,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call-1",
        toolCallName: "generateSandboxedUi",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "call-1",
        delta: args.slice(0, 25),
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "call-1",
        delta: args.slice(25),
      } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "call-1" } as BaseEvent,
      finish,
    ]);

    const types = events.map((event) => event.type);
    // The snapshot precedes every delta, and the held tool-call start follows the first activity event.
    expect(types.indexOf(EventType.ACTIVITY_SNAPSHOT)).toBe(1);
    expect(types.indexOf(EventType.TOOL_CALL_START)).toBe(2);
    expect(types.at(-1)).toBe(EventType.RUN_FINISHED);
    expect(
      types.filter((type) => type === EventType.TOOL_CALL_ARGS),
    ).toHaveLength(2);
    expect(
      types.filter((type) => type === EventType.TOOL_CALL_END),
    ).toHaveLength(1);

    const snapshot = events[1] as BaseEvent & {
      messageId: string;
      activityType: string;
      content: unknown;
    };
    expect({
      messageId: snapshot.messageId,
      activityType: snapshot.activityType,
      content: snapshot.content,
    }).toEqual({
      messageId: "call-1-activity",
      activityType: "open-generative-ui",
      content: { initialHeight: 240, generating: true },
    });

    const patches = events
      .filter((event) => event.type === EventType.ACTIVITY_DELTA)
      .flatMap((event) => (event as BaseEvent & { patch: unknown[] }).patch);
    expect(patches).toContainEqual({
      op: "add",
      path: "/placeholderMessages/-",
      value: "Drawing",
    });
    expect(patches).toContainEqual({
      op: "add",
      path: "/css",
      value: "p{color:red}",
    });
    expect(patches).toContainEqual({
      op: "add",
      path: "/htmlComplete",
      value: true,
    });
    expect(patches).toContainEqual({
      op: "add",
      path: "/jsExpressions/-",
      value: "1+1",
    });
    expect(patches).toContainEqual({
      op: "add",
      path: "/jsExpressionsComplete",
      value: true,
    });
    expect(patches.at(-1)).toEqual({
      op: "add",
      path: "/generating",
      value: false,
    });
    const html = patches
      .filter((patch) => (patch as { path: string }).path === "/html/-")
      .map((patch) => (patch as { value: string }).value)
      .join("");
    expect(html).toBe("<p>hi</p>");
  });

  test("other tool calls and text pass through untouched and in order", async () => {
    const passthrough: BaseEvent[] = [
      start,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call-2",
        toolCallName: "search",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "call-2",
        delta: "{}",
      } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "call-2" } as BaseEvent,
      finish,
    ];
    const events = await runThrough(passthrough);
    expect(events.map((event) => event.type)).toEqual(
      passthrough.map((event) => event.type),
    );
  });

  test("the args parser emits a snapshot before the first delta whatever the key order", () => {
    const seen: BaseEvent[] = [];
    const parser = new ArgsParser("call-3", (event) => seen.push(event));
    parser.write('{"css":"a{}","initialHeight":10}');
    expect(seen[0]?.type).toBe(EventType.ACTIVITY_SNAPSHOT);
    expect(parser.params).toEqual({ css: "a{}", initialHeight: 10 });
  });
});
