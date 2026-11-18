/**
 * Minimal browser-safe parser for the Neuro SAN / Open Agentic Web HOCON subset.
 * Supports:
 * - JSON objects, arrays, numbers, booleans, null
 * - `#` and `//` line comments outside string literals
 * - Triple-quoted multi-line strings (`"""..."""`)
 * - Optional trailing commas
 * - Single-pass expansion of `commondefs.replacement_strings` `{placeholder}` tokens
 *
 * Intentionally rejects unsupported server-side `include` or `${ENV}` substitutions
 * per MVP Profile 0.2 Section 2.
 */

export class HoconParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoconParseError";
  }
}

export function stripHoconCommentsAndNormalize(source: string): string {
  const out: string[] = [];
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source[i];
    const next = source[i + 1];

    // Triple-quoted string -> standard JSON string
    if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      if (end === -1) {
        throw new HoconParseError("Unterminated triple-quoted string.");
      }
      const raw = source.slice(i + 3, end);
      out.push(JSON.stringify(raw));
      i = end + 3;
      continue;
    }

    // Standard double-quoted string
    if (ch === '"') {
      out.push(ch);
      i += 1;
      while (i < len) {
        const sc = source[i];
        out.push(sc);
        if (sc === "\\") {
          if (i + 1 < len) {
            out.push(source[i + 1]);
            i += 2;
            continue;
          }
        }
        i += 1;
        if (sc === '"') {
          break;
        }
      }
      continue;
    }

    // Line comments `#` or `//`
    if (ch === "#" || (ch === "/" && next === "/")) {
      while (i < len && source[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    out.push(ch);
    i += 1;
  }

  // Strip trailing commas before `}` or `]` outside strings
  const joined = out.join("");
  const cleaned: string[] = [];
  let j = 0;
  while (j < joined.length) {
    const c = joined[j];
    if (c === '"') {
      cleaned.push(c);
      j += 1;
      while (j < joined.length) {
        const sc = joined[j];
        cleaned.push(sc);
        if (sc === "\\" && j + 1 < joined.length) {
          cleaned.push(joined[j + 1]);
          j += 2;
          continue;
        }
        j += 1;
        if (sc === '"') break;
      }
      continue;
    }
    if (c === ",") {
      let look = j + 1;
      while (look < joined.length && /\s/.test(joined[look])) {
        look += 1;
      }
      if (joined[look] === "}" || joined[look] === "]") {
        j += 1;
        continue;
      }
    }
    cleaned.push(c);
    j += 1;
  }

  return cleaned.join("");
}

export function parseHoconOrJson(source: string): unknown {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new HoconParseError("Input document is empty.");
  }

  // Reject unexpanded server-side HOCON directives before parsing
  if (/^\s*include\s+/m.test(trimmed)) {
    throw new HoconParseError(
      "Server-side HOCON `include` directives are forbidden in published MVP 0.2 artifacts."
    );
  }

  // Fast path if valid strict JSON
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to HOCON subset normalization
  }

  const normalized = stripHoconCommentsAndNormalize(trimmed);
  try {
    return JSON.parse(normalized);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HoconParseError(`Invalid JSON/HOCON syntax: ${msg}`);
  }
}

export function expandReplacementStrings<T>(obj: T): T {
  if (!obj || typeof obj !== "object") {
    return obj;
  }
  const record = obj as Record<string, unknown>;
  const commondefs = record.commondefs as Record<string, unknown> | undefined;
  const replacements = commondefs?.replacement_strings as
    | Record<string, string>
    | undefined;
  if (!replacements || typeof replacements !== "object") {
    return obj;
  }

  const expandText = (value: string): string => {
    return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (full, key: string) => {
      return Object.prototype.hasOwnProperty.call(replacements, key)
        ? String(replacements[key])
        : full;
    });
  };

  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === "string") {
      return expandText(node);
    }
    if (Array.isArray(node)) {
      return node.map((item) => walk(item, depth + 1));
    }
    if (node && typeof node === "object") {
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (depth === 0 && k === "commondefs") {
          continue;
        }
        next[k] = walk(v, depth + 1);
      }
      return next;
    }
    return node;
  };

  return walk(obj, 0) as T;
}
