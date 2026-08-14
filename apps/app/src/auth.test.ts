import { describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken } from "./auth.js";

describe("session tokens", () => {
  it("accepts an intact token for the current password hash", () => {
    const token = createSessionToken("hash-a", "s".repeat(32));
    expect(verifySessionToken(token, "hash-a", "s".repeat(32))).toBe(true);
  });

  it("invalidates sessions when the password hash changes", () => {
    const token = createSessionToken("hash-a", "s".repeat(32));
    expect(verifySessionToken(token, "hash-b", "s".repeat(32))).toBe(false);
  });

  it("rejects tampered tokens", () => {
    const token = createSessionToken("hash-a", "s".repeat(32));
    expect(verifySessionToken(`${token}x`, "hash-a", "s".repeat(32))).toBe(false);
  });
});

