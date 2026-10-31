/**
 * Which vendor a model specifier will actually reach, as a closed vocabulary.
 *
 * Ported from `@copilotkit/shared` 1.77.0 `dist/telemetry/model-host.mjs` (MIT), which this
 * repository stops depending on in Phase 6. `resolveModel` is the only place that builds a
 * provider, so it is the only place that knows the endpoint. Once built, the endpoint is gone: an
 * AI SDK model reports `provider: "openai.responses"` whether it points at api.openai.com, Azure,
 * OpenRouter or a laptop, and its base URL survives only inside a closure the public
 * `LanguageModelV3` type does not expose.
 *
 * `other` means a host we observed and did not recognize; `unknown` means we never saw a host at
 * all. The two are not interchangeable — one is an unrecognized answer, the other a missing one.
 */

export const MODEL_HOST_CLASSES = [
  "openai",
  "azure",
  "openrouter",
  "anthropic",
  "google",
  "vertex",
  "bedrock",
  "groq",
  "unify",
  "minimax",
  "local",
  "other",
  "unknown",
] as const;

export type ModelHostClass = (typeof MODEL_HOST_CLASSES)[number];

/** Host suffixes mapped to their vendor. Matched on label boundaries, never as substrings, so
 * `myresource.openai.azure.com.attacker.test` does not read as Azure. */
const HOST_SUFFIXES: readonly (readonly [string, ModelHostClass])[] = [
  ["openai.azure.com", "azure"],
  ["services.ai.azure.com", "azure"],
  ["cognitiveservices.azure.com", "azure"],
  ["azure-api.net", "azure"],
  ["api.openai.com", "openai"],
  ["openrouter.ai", "openrouter"],
  ["api.anthropic.com", "anthropic"],
  ["generativelanguage.googleapis.com", "google"],
  ["aiplatform.googleapis.com", "vertex"],
  ["api.groq.com", "groq"],
  ["api.unify.ai", "unify"],
  ["api.minimax.io", "minimax"],
  ["api.minimaxi.com", "minimax"],
];

/** Suffixes that mean the model runs on the same machine or private network. */
const LOCAL_SUFFIXES = ["localhost", "local", "internal", "docker.internal"];

/** Matches `<region>-aiplatform.googleapis.com` and the Bedrock regional hosts. */
const REGIONAL_HOST_PATTERNS: readonly (readonly [RegExp, ModelHostClass])[] = [
  [/^[a-z0-9-]+-aiplatform\.googleapis\.com$/, "vertex"],
  [/^bedrock[a-z0-9.-]*\.[a-z0-9-]+\.amazonaws\.com$/, "bedrock"],
];

/** True when `host` equals `suffix` or sits directly beneath it. */
function matchesSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** True for loopback, unspecified, and RFC 1918 private addresses. */
function isPrivateAddress(host: string): boolean {
  if (host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const privateClassB = /^172\.(\d{1,3})\./.exec(host);
  if (privateClassB) {
    const secondOctet = Number(privateClassB[1]);
    return secondOctet >= 16 && secondOctet <= 31;
  }
  return false;
}

/**
 * Reduce a model endpoint to one of {@link MODEL_HOST_CLASSES}.
 *
 * @param baseUrl The endpoint the provider was configured with. Absent when the provider was left
 *   on its own default, which is why `providerDefault` exists: "no base URL, provider is openai"
 *   means api.openai.com.
 * @param providerDefault What to report when no base URL was supplied. Callers that genuinely
 *   cannot observe a host — a pre-built LanguageModel handed in by the developer — leave this
 *   alone and get `unknown`.
 */
export function classifyModelHost(
  baseUrl: string | undefined,
  providerDefault: ModelHostClass = "unknown",
): ModelHostClass {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return providerDefault;
  let host: string;
  try {
    host = new URL(trimmed).hostname.toLowerCase();
  } catch {
    return "other";
  }
  host = host.replace(/^\[|\]$/g, "");
  if (!host) return "other";
  if (isPrivateAddress(host)) return "local";
  for (const suffix of LOCAL_SUFFIXES)
    if (matchesSuffix(host, suffix)) return "local";
  for (const [suffix, hostClass] of HOST_SUFFIXES)
    if (matchesSuffix(host, suffix)) return hostClass;
  for (const [pattern, hostClass] of REGIONAL_HOST_PATTERNS)
    if (pattern.test(host)) return hostClass;
  return "other";
}
