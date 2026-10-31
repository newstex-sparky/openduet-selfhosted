import { mock } from "bun:test";
import { useContext, useState } from "react";
import * as agui from "@/lib/agui";
import { CopilotChat as AppCopilotChat } from "@/lib/agui/chat";
import { CopilotKitContext } from "@/lib/agui/context";

/**
 * The chat the `/bot` route draws, replaced by something these tests can read.
 *
 * The route hands `CopilotChat` two strings — the agent and the thread — and that hand-over is
 * what the route tests assert, through the two data attributes and the draft box below. Drawing
 * the app's real chat to check it would need a runtime, a provider and a stubbed stream, which is
 * that chat's own test file's job, not this one's.
 *
 * WHY THIS DOUBLE STEPS ASIDE WHEN A PROVIDER IS MOUNTED. A module mock is not this file's to
 * keep: bun cannot take one back off, so this replacement stands in for `@/lib/agui` in every file
 * walked into the same process afterwards. A file that mounts the real provider is asking for the
 * real chat, and handing it the markup below would have it assert on a double it never chose. So
 * the double answers only where there is no provider — which is exactly how these route tests
 * draw the route — and delegates everywhere else. The real module is spread in so that no other
 * export goes missing for those later files.
 */
function CopilotChatForRoutes({
  agentId,
  threadId,
}: {
  agentId: string;
  threadId?: string;
}) {
  const provider = useContext(CopilotKitContext);
  if (provider) {
    return <AppCopilotChat agentId={agentId} threadId={threadId} />;
  }
  return (
    <div
      data-agent-id={agentId}
      data-thread-id={threadId}
      data-testid="copilot-chat"
    >
      <textarea aria-label="Chat draft" />
    </div>
  );
}

mock.module("@/lib/agui", () => ({
  ...agui,
  CopilotChat: CopilotChatForRoutes,
}));

/*
 * `@/lib/copilot/active-bot` IS NOT MOCKED, though the route calls `useActiveBot`. Drawn without an
 * `ActiveBotProvider`, as these tests draw it, the real hook finds no holder and does nothing — which
 * is all the mock that used to be here did. And a module mock is not this file's to keep: bun cannot
 * take one back off, so a replacement exporting only `useActiveBot` stood in for the whole module in
 * every file walked into the same process, and `useDeclaredBotId` — the app-access card's fallback
 * for a refusal that names no Bot — stopped existing there.
 */

mock.module("@/lib/copilot/bot-thread", () => ({
  useBotThread: (agentId: string) => {
    const [revision, setRevision] = useState(0);
    return {
      history: "ready",
      startNew: () => setRevision((value) => value + 1),
      threadId: `thread-${agentId}-${revision}`,
    };
  },
}));

mock.module("@/lib/copilot/stopped-turn", () => ({
  useStoppedTurn: () => null,
}));
