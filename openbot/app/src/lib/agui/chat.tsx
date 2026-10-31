/**
 * A conversation surface built from what the app already draws.
 *
 * This is deliberately thin: the transcript and the composer are the app's own components and this
 * only binds them to an agent and a thread. Rebuilding either here would be a second chat surface
 * to keep in step with the first.
 *
 * IT IS BOUND BY TWO STRINGS. `agentId` and `threadId` are all `bot.tsx` passes, and everything the
 * chat knows about the agent — its messages, whether it is running, what a tool call is drawing —
 * is read back from `useAgent` on the agent this component itself binds. A route that had to find
 * and hand over an agent object would be a route keeping a second copy of the run's state.
 */
import { useCallback, useEffect } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { Composer } from "@/components/channels/composer";
import { newId } from "@/lib/new-id";
import { useCopilotKit } from "./context";
import { useAgent } from "./hooks";
import type { Message } from "./types";

export interface CopilotChatProps {
  /** The agent to talk to. Inside a channel this is the channel's own name for its Bot. */
  agentId: string;
  /** The thread to run in. Absent, the runtime mints one on the first run. */
  threadId?: string;
  /** The agent at the runtime, when the browser-side name differs. */
  runtimeAgentId?: string;
  placeholder?: string;
  className?: string;
}

/**
 * One conversation, with the composer under it.
 *
 * The send is the whole of it: the person's message joins the transcript, the run starts, and the
 * reply arrives through the same event stream every other surface reads. A run that fails is said
 * out loud by the screen around this component, which watches the same agent (`useStoppedTurn` in
 * `bot.tsx`), so nothing is thrown from here: the composer clears itself on submit, and a throw
 * would leave the words nowhere.
 */
export function CopilotChat({
  agentId,
  threadId,
  runtimeAgentId,
  placeholder = "Ask anything",
  className,
}: CopilotChatProps) {
  const { copilotkit } = useCopilotKit();
  const { agent, isReady } = useAgent({
    agentId,
    runtimeAgentId: runtimeAgentId ?? agentId,
    threadId,
  });

  /*
   * A THREAD THE ROUTE NAMED IS ONE THIS TAB MAY NEVER HAVE SEEN. `bot.tsx` mints the id and
   * remembers it across reloads, so opening the screen again lands in a conversation whose
   * messages live at the runtime and not in this tab; without joining it the transcript starts
   * empty and the Bot answers as though nothing had been said. `connect` replays the thread and
   * then follows its live run, which is why it is also what makes a reload mid-turn pick the
   * answer back up.
   *
   * STARTED AFTER THE MOUNTING RENDER, not on it, and only once. `isReady` is false on the render
   * that mounts this component, so an effect that can start there runs a second time under
   * StrictMode, and two concurrent joins on one agent replay the thread twice. A send that arrives
   * before the join has finished is held by the composer — `agent.isRunning` is true for the whole
   * replay — so nothing typed lands in the wrong order.
   *
   * A thread with no id to name is not joined: there is nothing at the runtime to attach to yet,
   * and the first send mints one (see the `threadId` prop).
   */
  useEffect(() => {
    if (!isReady || threadId === undefined) return;
    void copilotkit.connectAgent({ agent }).catch(() => undefined);
  }, [agent, copilotkit, isReady, threadId]);

  const send = useCallback(
    async (draft: { text: string }) => {
      const text = draft.text.trim();
      if (!text) return;
      const message: Message = {
        /*
         * `newId` rather than `crypto.randomUUID`, which is ABSENT outside a secure context: on a
         * deployment reached over plain `http://<address>` the throw lands inside a submit handler,
         * React's event boundary swallows it, and the send does nothing at all with nothing said.
         * The composer's own files use the same helper for the same reason.
         */
        id: `user-${newId()}`,
        role: "user",
        content: text,
      };
      // Appended before the run so the person's words are on screen while the Bot thinks.
      agent.setMessages([...agent.messages, message]);
      await copilotkit.runAgent({ agent });
    },
    [agent, copilotkit],
  );

  const stop = useCallback(() => {
    copilotkit.stopAgent({ agent });
  }, [agent, copilotkit]);

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className ?? ""}`}>
      <ChatTranscript busy={agent.isRunning} messages={agent.messages} />
      <Composer
        onSubmit={send}
        onStop={stop}
        pending={agent.isRunning}
        stoppable={agent.isRunning}
        placeholder={placeholder}
      />
    </div>
  );
}
