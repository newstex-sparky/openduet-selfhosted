/**
 * The self-host banner: one operator switch and nothing else.
 *
 * The switch the operator sets is the whole of the decision: `OPENBOT_SELF_HOST_BANNER` on shows it,
 * off hides it. There is no entitlement to read and no other service to ask, so `shown()` never
 * waits and never throws.
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
