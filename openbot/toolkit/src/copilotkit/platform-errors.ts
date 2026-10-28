/**
 * The error a thread platform answers with, named the way the callers already look for it.
 *
 * `isLockConflict` (`toolkit/src/lease.ts`) and `isMissingThread` (`toolkit/src/thread-history.ts`)
 * recognise the platform's refusals by `name` and `status`, not by class: one is "not now" and the
 * other is "no such conversation". A local or Postgres-backed platform has to answer with the same
 * pair or every caller reads a busy thread as a broken one, so both implementations raise this.
 *
 * Shared rather than defined twice so the two can never drift: they are the same contract over
 * different storage.
 */
export class PlatformRequestError extends Error {
  override name = "PlatformRequestError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A conversation that is not there, or is not the caller's. The two read the same on purpose. */
export const missingThread = (threadId: string) =>
  new PlatformRequestError(`Thread ${threadId} not found`, 404);

/** Somebody else's run is working in this conversation, so this one is not happening now. */
export const threadBusy = (threadId: string) =>
  new PlatformRequestError(`Thread ${threadId} is already running`, 409);
