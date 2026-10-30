import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { CopilotKitProvider } from "@/lib/agui";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import "./a2ui.css";
import { a2uiProviderOptions } from "./a2ui";
import { ActiveBotProvider } from "./active-bot";
import { BotTools } from "./bot-tools";
import { ComputerTools } from "./computer-tools";
import { EscalationTool } from "./escalation-tool";
import { GalleryTools } from "./gallery-tools";
import { HandoffTool } from "./handoff-tool";
import { MorningBriefTool } from "./morning-brief-tool";
import { OfferTaskTool } from "./offer-task-tool";
import { PageCardTool } from "./page-card-tool";
import { ReplyChipsTool } from "./reply-chips-tool";
import { SandboxedTools } from "./sandboxed-tools";
import { SignInTool } from "./sign-in-tool";
import { SkillTools } from "./skill-tools";
import { TaskCardTool } from "./task-card-tool";

/**
 * Whether CopilotKit's developer inspector is drawn over the app. Off unless a developer asks for it
 * with `VITE_COPILOTKIT_INSPECTOR=true` when starting the app.
 *
 * OFF BY DEFAULT BECAUSE THE VENDOR'S DEFAULT WAS WRONG FOR THIS PRODUCT. It turned the inspector on
 * for every development build served from localhost, and the README's own path (`start.sh`) serves
 * the app through Vite in development mode. So everybody who followed the README got a floating
 * button over the tab bar, plus the vendor's own promotional popover over the header and the page
 * titles. The button also sat on the New channel sheet's Create and on a page's "…". That is a
 * developer's tool drawn over a person's product.
 *
 * THE FIRST-PARTY PROVIDER DRAWS NO INSPECTOR, so there is no longer a switch for this to set: the
 * flag is read here and nowhere else, and it is kept only until the test that pins the variable's
 * meaning goes with the rest of the migration.
 */
export function inspectorEnabled(
  environment: Record<string, string | boolean | undefined> = import.meta.env,
): boolean {
  return environment.VITE_COPILOTKIT_INSPECTOR === "true";
}

/**
 * The client, wrapped once for the whole authenticated app.
 *
 * `credentials: "include"` is the load-bearing part, and it now lives in the agent every request is
 * made through rather than in a provider prop: OpenBot authenticates with a Better Auth session
 * cookie, and the runtime endpoint sits behind the same guard as every other API route, so without
 * it every run is rejected as anonymous while the rest of the app looks signed in.
 *
 * The URL is relative, like every other call in the app, so the Vite dev proxy and a single-origin
 * deployment both work without a build-time base URL to get wrong.
 *
 * There is no `publicApiKey`. The Intelligence key and licence token were deployment secrets held by
 * the server; a browser never sees them (see server/src/app.ts, where /api/capabilities projects the
 * runtime rather than returning it).
 *
 * THE VENDOR'S `enableInspector`, `openGenerativeUI` AND `a2ui` PROPS ARE GONE. None has an
 * equivalent here: this provider draws no inspector, and an interface the Bot writes is drawn from
 * the activity it sends by `OpenGenerativeUIActivityRenderer`, not from a prop that switches a whole
 * runtime middleware on for every deployment that passes it.
 */
export function CopilotProvider({ children }: { children: ReactNode }) {
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());

  /* The surfaces below ask the capability query what this deployment can do — a computer, voice,
   * A2UI — and hide what it cannot. `generativeUi` decides two halves at once: the server turning on
   * the middleware that emits a surface, and the browser registering the renderer that draws one.
   */
  return (
    <CopilotKitProvider
      runtimeUrl="/api/copilotkit"
      {...a2uiProviderOptions(capabilities?.generativeUi)}
    >
      {/* Computer tools target the Bot declared by the mounted surface. */}
      <ActiveBotProvider>
        <ComputerTools />
        {/* The private sign-in request: a card whose form posts to the server, never to the Bot. */}
        <SignInTool />
        {/*
          Draws a Bot bringing in another Bot. Registers no tool: `message_bot` runs on the server,
          where the grant and the caps are. A hop that happens off-screen is the thing to avoid.
        */}
        <HandoffTool />
        {/* The server's morning brief, drawn as the film's card. See morning-brief-tool.tsx. */}
        <MorningBriefTool />
        {/* The server's suggested replies, drawn as chips a tap sends. See reply-chips-tool.tsx. */}
        <ReplyChipsTool />
        {/* What the Bot made, drawn as a card that opens it. See page-card-tool.tsx. */}
        <PageCardTool />
        {/* A task a check-in offers, drawn as the card with Start and Hide. See offer-task-tool.tsx. */}
        <OfferTaskTool />
        {/* A task started from Chat, drawn as a card that opens it. See task-card-tool.tsx. */}
        <TaskCardTool />
        <EscalationTool />
        {/* Gallery tools are registered once; their handlers re-read the active Bot to avoid shadowing renderers. */}
        <GalleryTools />
        {/* Browser-authored components use the same component grants as the compiled gallery. */}
        <SandboxedTools />
        {/* Offered only on a Bot holding the skill-creator skill; see skill-tools.tsx. */}
        <SkillTools />
        {/*
          Making a coworker from a conversation. Registers nothing unless the declared Bot holds the
          `bot-creator` skill, so most runs are not offered these four tools at all.
        */}
        <BotTools />
        {children}
      </ActiveBotProvider>
    </CopilotKitProvider>
  );
}
