/**
 * An AG-UI event stream as an SSE response, kept open while the model is quiet.
 *
 * Ported from `@copilotkit/runtime` 1.77.0 `handlers/shared/sse-response.mjs` and
 * `handlers/shared/sse-keep-alive.mjs` (MIT). The wire format itself is not ours: `@ag-ui/encoder`
 * encodes each event, and that package stays a dependency. What this module owns is the response
 * around it — the `text/event-stream` headers, the writer, and the keep-alive.
 *
 * THE KEEP-ALIVE IS NOT COSMETIC. `Bun.serve` closes a connection that has sent nothing for ten
 * seconds (`BUN_IDLE_TIMEOUT_MS` in `server/src/delivery/opentag.ts`). A run whose model says
 * nothing for longer than that used to have its stream cut after RUN_STARTED: the run still
 * finished and was stored, but the browser never saw the reply. An SSE comment resets that timer
 * and is dropped by every AG-UI parser, so a quiet wire gains bytes and no events.
 */
import type { BaseEvent } from "@ag-ui/client";
import { EventEncoder } from "@ag-ui/encoder";
import type { Observable } from "rxjs";

/**
 * Default silence, in seconds, before a keep-alive comment is written.
 *
 * Matches the vendor default, and sits under the tightest common proxy idle timeout. Callers that
 * mount under Bun pass a smaller one; see the note above.
 */
const DEFAULT_SSE_KEEP_ALIVE_INTERVAL_SECONDS = 15;

/**
 * Longest interval a timer can honour. Timers take a signed 32-bit millisecond delay, so anything
 * larger is silently replaced with 1 ms — which would turn a keep-alive into a flood.
 */
const MAX_SSE_KEEP_ALIVE_INTERVAL_SECONDS = (2 ** 31 - 1) / 1000;

/** Validate the configured interval once, so every stream reads one checked value. */
export function resolveSseKeepAliveIntervalSeconds(value?: number): number {
  const seconds = value ?? DEFAULT_SSE_KEEP_ALIVE_INTERVAL_SECONDS;
  if (
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > MAX_SSE_KEEP_ALIVE_INTERVAL_SECONDS
  )
    throw new RangeError(
      `sseKeepAliveIntervalSeconds must be between 0 and ${MAX_SSE_KEEP_ALIVE_INTERVAL_SECONDS}, got ${String(value)}`,
    );
  return seconds;
}

/**
 * An SSE comment frame, as the HTML specification's authoring notes describe it.
 *
 * Parsers drop comment lines, so this invents no event: the verifier, the history writer and every
 * middleware downstream never see it.
 */
const KEEP_ALIVE_FRAME = new TextEncoder().encode(": keep-alive\n\n");

/**
 * Write a comment after `idleMs` of silence, resetting the clock on every byte the source sends.
 *
 * A back-pressured reader skips the tick instead of queueing frames, and the timer stops when the
 * pipe settles — which covers both the source completing and the reader cancelling.
 */
export function keepAliveSse(
  source: ReadableStream<Uint8Array>,
  idleMs: number,
): ReadableStream<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const arm = (controller: TransformStreamDefaultController<Uint8Array>) => {
    stop();
    timer = setTimeout(() => {
      if (controller.desiredSize === 1) controller.enqueue(KEEP_ALIVE_FRAME);
      arm(controller);
    }, idleMs);
    timer.unref?.();
  };
  const transform = new TransformStream<Uint8Array, Uint8Array>(
    {
      start: arm,
      transform(chunk, controller) {
        controller.enqueue(chunk);
        arm(controller);
      },
      flush: stop,
    },
    undefined,
    { highWaterMark: 1 },
  );
  source
    .pipeTo(transform.writable)
    .catch(() => {})
    .finally(stop);
  return transform.readable;
}

/** The SSE headers every event stream answers with. */
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

function logError(error: unknown): void {
  console.error("Error running agent:", error);
  console.error(
    "Error stack:",
    error instanceof Error ? error.stack : "No stack trace",
  );
  console.error("Error details:", {
    name: error instanceof Error ? error.name : "Unknown",
    message: error instanceof Error ? error.message : String(error),
    cause: error instanceof Error ? error.cause : undefined,
  });
}

/**
 * Answer with `observableFactory()`'s events, encoded and kept alive.
 *
 * `observableFactory` is called inside the stream rather than before it, so a runner that refuses a
 * run (a lost lock, a missing thread) refuses before this Response exists where the caller can see
 * it. The factory's rejection therefore closes this stream, exactly as the vendor's did: the caller
 * of the route, not this function, decides what a refusal looks like on the wire.
 */
export function createSseEventResponse(input: {
  request: Request;
  observableFactory: () => Promise<Observable<BaseEvent>> | Observable<BaseEvent>;
  keepAliveIntervalSeconds?: number;
}): Response {
  const keepAliveSeconds = resolveSseKeepAliveIntervalSeconds(
    input.keepAliveIntervalSeconds,
  );
  const { request } = input;
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const encoder = new EventEncoder();
  let streamClosed = false;

  const closeStream = async () => {
    if (streamClosed) return;
    try {
      await writer.close();
      streamClosed = true;
    } catch {
      // A cancelled reader is not an error worth reporting: nobody is listening.
    }
  };

  let subscription: { unsubscribe(): void } | undefined;
  let agentErrorReported = false;
  const reportAgentError = (error: unknown) => {
    if (agentErrorReported) return;
    agentErrorReported = true;
    logError(error);
  };

  void (async () => {
    const observable = await input.observableFactory();
    subscription = observable.subscribe({
      next: (event: BaseEvent) => {
        void (async () => {
          if (event.type === "RUN_ERROR") {
            const message = (event as { message?: unknown }).message;
            reportAgentError(
              new Error(
                typeof message === "string"
                  ? message
                  : "Runner reported a run error",
              ),
            );
          }
          if (request.signal.aborted || streamClosed) return;
          try {
            await writer.write(encoder.encodeBinary(event));
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError")
              streamClosed = true;
            else {
              logError(error);
              streamClosed = true;
            }
          }
        })();
      },
      error: (error: unknown) => {
        void (async () => {
          reportAgentError(error);
          await closeStream();
        })();
      },
      complete: () => {
        void closeStream();
      },
    });
    if (request.signal.aborted) subscription.unsubscribe();
  })().catch(async (error: unknown) => {
    reportAgentError(error);
    await closeStream();
  });

  request.signal.addEventListener("abort", () => {
    subscription?.unsubscribe();
  });

  const body =
    keepAliveSeconds > 0
      ? keepAliveSse(stream.readable, keepAliveSeconds * 1000)
      : stream.readable;
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}
