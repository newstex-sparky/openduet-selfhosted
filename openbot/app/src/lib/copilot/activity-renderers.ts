/**
 * The activity renderers a provider registers, by capability.
 *
 * An activity is a message the runtime draws nothing for: the browser has to know its type and
 * bring a renderer. There are two here, and they are registered together because one deployment
 * capability turns both halves on — `DeploymentCapabilities.generativeUi` enables the server's
 * middleware and this list at the same time. Registering one without the other leaves Bots writing
 * surfaces that never appear.
 *
 * The order is the tie-break order the registry searches in, so it is kept stable: A2UI first, then
 * the interface the Bot writes itself. Neither claims `*`, so neither can shadow the other.
 */
import type { CopilotKitProviderProps } from "@/lib/agui";
import { generativeUIActivityRenderers } from "@/lib/agui";
import { a2uiActivityRenderers } from "./a2ui";

/** The `renderActivityMessages` prop for a deployment with generative UI on or off. */
export function activityRenderers(
  enabled: boolean | undefined,
): NonNullable<CopilotKitProviderProps["renderActivityMessages"]> {
  return [
    ...a2uiActivityRenderers(enabled),
    ...generativeUIActivityRenderers(enabled),
  ];
}
