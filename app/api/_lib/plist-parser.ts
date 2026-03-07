/**
 * macOS plist XML parser.
 *
 * Extracted from services/route.ts for testability.
 */

/** Parse a plist XML string into a flat key-value map. */
export function parsePlist(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  let lastKey = "";

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const keyMatch = lines[i].match(/<key>([^<]+)<\/key>/);
    if (keyMatch) {
      lastKey = keyMatch[1];
      const nextLine = lines[i + 1]?.trim() ?? "";
      const strMatch = nextLine.match(/<string>([^<]*)<\/string>/);
      const intMatch = nextLine.match(/<integer>([^<]+)<\/integer>/);
      if (strMatch) {
        result[lastKey] = strMatch[1];
      } else if (intMatch) {
        result[lastKey] = intMatch[1];
      } else if (nextLine === "<true/>") {
        result[lastKey] = "true";
      } else if (nextLine === "<false/>") {
        result[lastKey] = "false";
      }
    }
  }
  return result;
}
