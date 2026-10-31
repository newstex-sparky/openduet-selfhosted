import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createSelfHostBanner } from "../src/self-host-banner";
import { testEnvironment } from "./support/environment";

/**
 * The banner is one operator switch now.
 *
 * It used to hide itself for a deployment that paid for CopilotKit Intelligence, so it asked
 * Intelligence on every page load. This fork has no Intelligence to ask, so what is pinned here is
 * that the operator's switch alone decides, that nothing is asked over the network, and that a page
 * load is never held back waiting for a service.
 */

describe("the self-host banner", () => {
  test("is off when the operator switched it off", async () => {
    const banner = createSelfHostBanner({ enabled: false });
    expect(await banner.shown()).toBe(false);
    expect(await banner.shown()).toBe(false);
  });

  test("is on when the operator switched it on", async () => {
    const banner = createSelfHostBanner({ enabled: true });
    expect(await banner.shown()).toBe(true);
    expect(await banner.shown()).toBe(true);
  });

  test("answers from the switch alone, so page loads that arrive together all settle", async () => {
    const banner = createSelfHostBanner({ enabled: true });
    const answers = await Promise.all([
      banner.shown(),
      banner.shown(),
      banner.shown(),
    ]);
    expect(answers).toEqual([true, true, true]);
  });
});

describe("the capabilities endpoint", () => {
  const config = loadConfig(testEnvironment());

  // createApp takes its services positionally. The banner is the 36th, followed by the identity
  // store and the GitHub sign-in callback, so it is no longer the last of them.
  const SELF_HOST_BANNER_ARG = 35;
  function appWith(banner: ReturnType<typeof createSelfHostBanner>) {
    const args: unknown[] = new Array(createApp.length).fill(undefined);
    args[0] = config;
    args[SELF_HOST_BANNER_ARG] = banner;
    return (createApp as (...input: unknown[]) => ReturnType<typeof createApp>)(
      ...args,
    );
  }

  test("hides the banner when the operator switched it off", async () => {
    const app = appWith(createSelfHostBanner({ enabled: false }));
    const response = await app.request("/api/capabilities");
    expect((await response.json()).selfHostBanner).toBe(false);
  });

  test("shows it when the operator switched it on", async () => {
    const app = appWith(createSelfHostBanner({ enabled: true }));
    const response = await app.request("/api/capabilities");
    expect((await response.json()).selfHostBanner).toBe(true);
  });
});
