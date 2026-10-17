/**
 * Nepal-time behavior is device-timezone independent: display always
 * renders Asia/Kathmandu and admin input always means +05:45, no matter
 * what the device clock zone is.
 */
import { describe, expect, it } from "vitest";
import {
  NEPAL_LABEL,
  formatNepal,
  nepalInputFromTimestamp,
  nepalInputToTimestamp,
} from "./datetime";

describe.each(["America/New_York", "Pacific/Kiritimati", "UTC"])(
  "under device zone %s",
  (zone) => {
    it("formats instants in Nepal time", () => {
      process.env.TZ = zone;
      expect(formatNepal("2030-01-01T10:00:00Z")).toBe("01 Jan 2030, 15:45");
      expect(NEPAL_LABEL).toContain("UTC+05:45");
    });

    it("round-trips admin input through Nepal wall time", () => {
      process.env.TZ = zone;
      expect(nepalInputToTimestamp("2030-06-01T10:00")).toBe("2030-06-01T10:00:00+05:45");
      expect(nepalInputFromTimestamp("2030-06-01T00:00:00Z")).toBe("2030-06-01T05:45");
    });
  },
);

describe("admin input conversion", () => {
  it("keeps explicit seconds and trims", () => {
    expect(nepalInputToTimestamp("2030-06-01T10:00:30")).toBe("2030-06-01T10:00:30+05:45");
  });

  it("rejects wrong shapes for the backend to refuse as well", () => {
    for (const bad of ["", "tomorrow", "2030-06-01", "10:00"]) {
      expect(nepalInputToTimestamp(bad)).toBeNull();
    }
    // Syntactically shaped but impossible dates pass conversion untouched;
    // the backend refuses them (covered by backend validation tests).
    expect(nepalInputToTimestamp("2030-13-40T99:99")).toBe("2030-13-40T99:99:00+05:45");
  });
});
