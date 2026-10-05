/**
 * Office readers: ONE error type for "refuse this file, with a message a person can act on". Every parser throws it
 * (never a raw Error); readOfficeFile catches it and returns {ok:false, status, reason, message}. Anything else that is
 * thrown (a bug, an out-of-memory) is also caught at the top and reported as a generic 422, so a hostile file can never
 * crash the caller.
 */
export class OfficeError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.name = "OfficeError";
    this.status = status;
    this.reason = reason;
  }
}

/** Wall-clock budget shared by every loop of one read. check() is cheap; call it every few thousand iterations. */
export function makeClock(ms, now = Date.now) {
  const deadline = now() + ms;
  return {
    deadline,
    check() {
      if (now() > deadline) {
        throw new OfficeError(413, "timeout",
          "This file is too large or too complex to read in time. Split it into smaller files (or save a simpler copy) and upload again.");
      }
    },
  };
}
