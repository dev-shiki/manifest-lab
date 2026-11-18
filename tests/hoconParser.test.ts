import { describe, expect, it } from "vitest";
import {
  expandReplacementStrings,
  HoconParseError,
  parseHoconOrJson,
} from "../src/core/hoconParser";

describe("hoconParser", () => {
  it("parses HOCON comments, triple-quoted strings, and trailing commas", () => {
    const source = `
      # Top-level comment
      {
        "metadata": {
          "description": "Test network", // inline comment
        },
        "commondefs": {
          "replacement_strings": {
            "rule": """Fact-only answers."""
          }
        },
        "tools": [
          {
            "name": "front",
            "instructions": "{rule}",
          },
        ],
      }
    `;
    const parsed = parseHoconOrJson(source) as Record<string, unknown>;
    const expanded = expandReplacementStrings(parsed) as {
      tools: Array<{ instructions: string }>;
      commondefs?: unknown;
    };

    expect(expanded.commondefs).toBeUndefined();
    expect(expanded.tools[0].instructions).toBe("Fact-only answers.");
  });

  it("rejects server-side include directives and empty input", () => {
    expect(() => parseHoconOrJson("")).toThrow(HoconParseError);
    expect(() => parseHoconOrJson('include "secrets.hocon"\n{}')).toThrow(
      /include/i
    );
  });

  it("rejects unterminated triple-quoted strings", () => {
    expect(() =>
      parseHoconOrJson('{"a": """unterminated}')
    ).toThrow(HoconParseError);
  });
});
