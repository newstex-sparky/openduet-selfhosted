/**
 * What a finished run reports about the model that answered it: the terminal metadata and the
 * token counts, as AG-UI's `RUN_FINISHED` carries them.
 *
 * Ported from `@copilotkit/runtime` 1.77.0 `dist/agent/converters/usage.mjs` (MIT).
 *
 * WHY A COUNT IS ABSENT RATHER THAN ZERO. A provider that omits a token count is saying it does
 * not know, and a run that reports `0` for it is reporting a measurement nobody made. Only a
 * safe, non-negative integer is kept; every other value is dropped, so the field is missing and
 * the reader can tell the difference.
 */

export const tokenCountKeys = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "cachedInputTokens",
] as const;

export type TokenCountKey = (typeof tokenCountKeys)[number];

export type RunUsageEntry = {
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
};

export type RunFinishedDetails = {
  metadata?: Record<string, unknown>;
  usage?: RunUsageEntry[];
};

/** Returns a token count only when it is a safe, non-negative integer. */
export function getTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Adds usage entries to a run, grouping and summing matching identities. */
export function aggregateRunUsage(
  details: RunFinishedDetails,
  entries: readonly RunUsageEntry[],
): void {
  for (const entry of entries) {
    if (!tokenCountKeys.some((key) => entry[key] !== undefined)) continue;
    details.usage ??= [];
    const existing = details.usage.find(
      (candidate) =>
        candidate.provider === entry.provider &&
        candidate.model === entry.model,
    );
    if (!existing) {
      details.usage.push({ ...entry });
      continue;
    }
    for (const key of tokenCountKeys) {
      const value = entry[key];
      if (value === undefined) continue;
      const sum = (existing[key] ?? 0) + value;
      if (Number.isSafeInteger(sum)) existing[key] = sum;
    }
  }
}

/** Keeps terminal metadata and the last supplied string reason; accumulates usage. */
export function collectStandardRunFinishedDetails(
  event: { metadata?: unknown; usage?: unknown },
  details: RunFinishedDetails,
  fallbackIdentity: { provider?: string; model?: string } = {},
): void {
  const previousFinishReason = details.metadata?.finishReason;
  if (isRecord(event.metadata)) details.metadata = { ...event.metadata };
  else delete details.metadata;
  if (
    typeof details.metadata?.finishReason !== "string" &&
    typeof previousFinishReason === "string"
  )
    details.metadata = {
      ...details.metadata,
      finishReason: previousFinishReason,
    };
  if (!Array.isArray(event.usage)) return;
  aggregateRunUsage(
    details,
    event.usage.flatMap((entry: unknown) => {
      if (!isRecord(entry)) return [];
      const normalized: RunUsageEntry = {
        provider:
          getNonEmptyString(entry.provider) ?? fallbackIdentity.provider,
        model: getNonEmptyString(entry.model) ?? fallbackIdentity.model,
      };
      for (const key of tokenCountKeys)
        normalized[key] = getTokenCount(entry[key]);
      return [normalized];
    }),
  );
}

/** Narrows an unknown value to a string-keyed object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Returns a non-empty string identity without changing its value. */
export function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
