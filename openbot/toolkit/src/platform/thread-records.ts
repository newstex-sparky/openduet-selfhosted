/**
 * The two record shapes a thread platform answers in, and the conversions between them and AG-UI's.
 *
 * Intelligence's REST answers use these, every reader in `server/src/copilot.ts` and
 * `toolkit/src/run-turn.ts` reads them, and the runtime's local thread endpoints wrap them again for
 * the browser. Keeping them here rather than in one platform means the in-memory one and the
 * Postgres one cannot disagree about what a message row looks like — which is the whole point of
 * being able to swap one for the other.
 */
import type { BaseEvent, Message } from "@ag-ui/client";

/** The thread summary Intelligence returns, restated: the same fields the server reads. */
export type LocalThreadSummary = {
  id: string;
  name: string | null;
  agentId: string;
  organizationId: string;
  createdById: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

/** One row of history in Intelligence's shape (`ThreadMessage`), which every reader here expects. */
export type LocalThreadMessage = {
  id: string;
  role: string;
  content?: unknown;
  toolCalls?: { id: string; name: string; args: string }[];
  toolCallId?: string;
};

/**
 * AG-UI's message, in the platform's history shape: tool calls flattened, as the runtime does.
 *
 * The flattening is not cosmetic. `{ function: { name, arguments } }` is AG-UI's transport shape;
 * Intelligence stores `{ name, args }`, and both the history readers and the runtime's own
 * `/threads/:id/messages` mapping are written against that. Converting once, here, keeps every
 * caller from having to know which of the two it is looking at.
 */
export function toPlatformMessage(message: Message): LocalThreadMessage {
  const base = { id: message.id, role: message.role };
  if (message.role === "assistant") {
    const calls = message.toolCalls ?? [];
    return {
      ...base,
      ...(message.content !== undefined ? { content: message.content } : {}),
      ...(calls.length > 0
        ? {
            toolCalls: calls.map((call) => ({
              id: call.id,
              name: call.function.name,
              args: call.function.arguments,
            })),
          }
        : {}),
    };
  }
  if (message.role === "tool")
    return {
      ...base,
      content: message.content,
      toolCallId: message.toolCallId,
    };
  return {
    ...base,
    ...("content" in message && message.content !== undefined
      ? { content: message.content }
      : {}),
  };
}

/**
 * The same row back the other way, as an AG-UI message.
 *
 * Cast rather than narrowed exhaustively, for the reason `run-turn.ts` gives at its own boundary:
 * the platform is the authority on its own history and there is nothing here to narrow against. The
 * fields it is missing are the ones AG-UI allows to be absent.
 */
export function toAgentMessage(message: LocalThreadMessage): Message {
  return {
    id: message.id,
    role: message.role,
    content: message.content ?? "",
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.args },
          })),
        }
      : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
  } as Message;
}

/**
 * The message an event belongs to, when it belongs to one.
 *
 * Used to keep a replay from showing the same message twice: the log is replayed and then tailed, so
 * a reader that caught up mid-stream would otherwise see the message it already rendered again.
 */
export function messageIdOf(event: BaseEvent): string | undefined {
  const id = (event as { messageId?: unknown }).messageId;
  return typeof id === "string" ? id : undefined;
}
