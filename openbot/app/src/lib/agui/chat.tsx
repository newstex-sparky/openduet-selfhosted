/**
 * A conversation surface built from what the app already draws.
 *
 * This is deliberately thin: the transcript and the composer are the app's own components and this
 * only binds them to an agent and a thread. Rebuilding either here would be a second chat surface
 * to keep in step with the first.
 */
import { useCallback, useState } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { Composer } from "@/components/channels/composer";
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
 * reply arrives through the same event stream every other surface reads. A failed turn is said
 * under the transcript rather than thrown, because the composer clears itself on submit and
 * throwing would leave the words nowhere.
 */
export function CopilotChat({
  agentId,
  threadId,
  runtimeAgentId,
  placeholder = "Ask anything",
  className,
}: CopilotChatProps) {
  const { copilotkit } = useCopilotKit();
  const { agent } = useAgent({
    agentId,
    runtimeAgentId: runtimeAgentId ?? agentId,
    threadId,
  });
  const [stopped, setStopped] = useState<string | null>(null);

  const send = useCallback(
    async (draft: { text: string }) => {
      const text = draft.text.trim();
      if (!text) return;
      setStopped(null);
      const message: Message = {
        id: `user-${crypto.randomUUID()}`,
        role: "user",
        content: text,
      };
      // Appended before the run so the person's words are on screen while the Bot thinks.
      agent.setMessages([...agent.messages, message]);
      try {
        await copilotkit.runAgent({ agent });
      } catch (error) {
        setStopped(
          error instanceof Error
            ? error.message
            : "The turn could not be completed.",
        );
      }
    },
    [agent, copilotkit],
  );

  const stop = useCallback(() => {
    copilotkit.stopAgent({ agent });
  }, [agent, copilotkit]);

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className ?? ""}`}>
      <ChatTranscript
        busy={agent.isRunning}
        messages={agent.messages}
        stopped={stopped ?? undefined}
      />
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
