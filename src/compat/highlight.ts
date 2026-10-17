/** Highlight colours and the emoji that selects each one at the start of `==…==`. */
export const HIGHLIGHT_MARKERS: Record<string, string> = { red: "🔴", orange: "🟠", yellow: "🟡", green: "🟢", blue: "🔵", purple: "🟣" };
const COLORS: Record<string, string> = { "🔴": "red", "🟥": "red", "🟠": "orange", "🟧": "orange", "🟡": "yellow", "🟨": "yellow", "🟢": "green", "🟩": "green", "🔵": "blue", "🟦": "blue", "🟣": "purple", "🟪": "purple" };

/** Colour named by the marker at `at`, with the marker's length in UTF-16 units (0 when there is none). */
export function highlightColor(text: string, at = 0): { color: string; length: number } {
  const point = text.codePointAt(at), marker = point === undefined ? "" : String.fromCodePoint(point);
  const color = COLORS[marker] ?? "";
  return { color, length: color ? marker.length : 0 };
}
