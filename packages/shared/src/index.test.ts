import { describe, expect, it } from "vitest";
import { maxSnowflake } from "./index.js";

describe("maxSnowflake", () => {
  it("compares snowflakes without losing integer precision", () => {
    expect(maxSnowflake("999999999999999999", "1000000000000000000"))
      .toBe("1000000000000000000");
  });
});
