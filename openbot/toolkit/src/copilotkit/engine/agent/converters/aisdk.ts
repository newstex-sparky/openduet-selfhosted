/**
 * The AI SDK stream parts a built-in Bot's answer is read from.
 *
 * Ported from `@copilotkit/runtime` 1.77.0 `dist/agent/converters/aisdk.mjs` (MIT). The vendor's
 * `convertAISDKStream` — the whole-stream converter used by its `type:"aisdk"` factory — is not
 * here: this fork's agent runs on the classic model path and on `type:"custom"`, so the converter
 * had no caller. What a classic run does use is kept: the finish part's usage, a tool error's
 * message, and the message id rule below.
 */
import {
  getTokenCount,
  type RunFinishedDetails,
  tokenCountKeys,
} from "./usage";

/**
 * Reads aggregate usage from an AI SDK finish part without inventing values when a provider omits
 * a token count.
 */
export function getAISDKRunFinishedDetails(
  part: { finishReason?: unknown; totalUsage?: unknown },
  identity: { provider?: string; model?: string } = {},
): RunFinishedDetails {
  const details: RunFinishedDetails = {};
  if (typeof part.finishReason === "string")
    details.metadata = { finishReason: part.finishReason };
  if (
    part.totalUsage === null ||
    typeof part.totalUsage !== "object" ||
    Array.isArray(part.totalUsage)
  )
    return details;
  const totalUsage = part.totalUsage as Record<string, unknown>;
  const counts: Record<string, number> = {};
  for (const key of tokenCountKeys) {
    const value = getTokenCount(totalUsage[key]);
    if (value !== undefined) counts[key] = value;
  }
  addUsage(details, { ...identity, ...counts });
  return details;
}

/** One usage entry, grouped and summed by identity the way a run's totals are. */
function addUsage(
  details: RunFinishedDetails,
  entry: Record<string, number | string | undefined>,
): void {
  if (!tokenCountKeys.some((key) => entry[key] !== undefined)) return;
  details.usage ??= [];
  const existing = details.usage.find(
    (candidate) =>
      candidate.provider === entry.provider && candidate.model === entry.model,
  );
  if (!existing) {
    details.usage.push({ ...entry });
    return;
  }
  for (const key of tokenCountKeys) {
    const value = entry[key];
    if (typeof value !== "number") continue;
    const sum = (existing[key] ?? 0) + value;
    if (Number.isSafeInteger(sum)) existing[key] = sum;
  }
}

export function formatToolError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  )
    return (error as { message: string }).message;
  if (typeof error === "string") return error;
  if (error === undefined || error === null) return "Unknown tool error";
  try {
    const serialized = JSON.stringify(error);
    return serialized === undefined ? String(error) : serialized;
  } catch {
    return String(error);
  }
}

/**
 * Returns the AG-UI message id for an AI SDK `text-start` / `reasoning-start` part.
 *
 * Several providers number stream parts per response instead of giving them a unique id:
 * `@ai-sdk/anthropic` and `@ai-sdk/google` use a block counter ("0", "1", …) and
 * `@ai-sdk/openai-compatible` always uses "txt-0" / "reasoning-0". Those ids repeat on every step
 * and every run, so reusing them would append later replies to an earlier message. Only ids that
 * look unique are kept.
 */
export function resolveStreamPartMessageId(providedId: unknown): string {
  if (
    typeof providedId !== "string" ||
    providedId === "" ||
    /^(\d+|(txt|reasoning|msg)-0)$/.test(providedId)
  )
    return crypto.randomUUID();
  return providedId;
}
