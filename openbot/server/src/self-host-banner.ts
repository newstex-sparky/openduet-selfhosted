/**
 * The self-host banner: one operator switch and nothing else.
 *
 * There used to be an entitlement read here. The banner hid itself for deployments that paid for
 * CopilotKit Intelligence, so it asked Intelligence on every page load and cached the answer. This
 * fork has no Intelligence and no paid plan to detect, so the switch the operator sets is the whole
 * of the decision: `OPENBOT_SELF_HOST_BANNER` on shows it, off hides it.
 */
export type SelfHostBanner = {
  /** Whether to offer help self-hosting. Never throws and never waits. */
  shown: () => Promise<boolean>;
};

export function createSelfHostBanner(options: {
  enabled: boolean;
}): SelfHostBanner {
  return {
    async shown() {
      return options.enabled;
    },
  };
}
