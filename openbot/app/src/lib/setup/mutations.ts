import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type SetupChecklist, setupKeys } from "./queries";

/**
 * "Check again": the server asks the model provider again, then answers the checklist, which
 * replaces the one on screen. Asking it is the server's job, and it holds the key; the browser only
 * says when.
 */
export function recheckSetupMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (): Promise<SetupChecklist> =>
      client("/api/openduet/setup/check", "checklist", {
        method: "POST",
        fallback: "Couldn't check your setup.",
      }),
    onSuccess: (checklist) =>
      queryClient.setQueryData(setupKeys.checklist(), checklist),
  });
}
