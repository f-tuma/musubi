import ICAL from "ical.js";
import { SyncCodecError } from "./index";

const invalidResource = () =>
  new SyncCodecError("invalid-resource");

export function calendarLines(data: string) {
  const lines: { raw: string; unfolded: string }[] = [];
  for (const raw of data.match(/[^\r\n]*(?:\r\n|\n|$)/g) ?? []) {
    if (!raw) continue;
    const text = raw.replace(/\r?\n$/, "");
    if (/^[ \t]/.test(text)) {
      const last = lines[lines.length - 1];
      if (!last) throw invalidResource();
      last.raw += raw;
      last.unfolded += text.slice(1);
    } else {
      lines.push({ raw, unfolded: text });
    }
  }
  // Do not guess about malformed line endings that the span reader cannot cover.
  if (lines.map((line) => line.raw).join("") !== data) throw invalidResource();
  return lines;
}

/** Locate physical content-line spans only. ICAL owns grammar, component
 * selection and value encoding; untouched bytes never go through its serializer.
 * A normalized/projected calendar-query result is NOT a complete input here.
 */
export function replaceComponentPropertiesV1(
  data: string,
  masterIndex: number,
  replacements: Map<string, ICAL.Property[]>,
  componentName: "vevent" | "vtodo",
): string {
  const lines = calendarLines(data);
  const stack: string[] = [];
  let eventIndex = -1;
  let selected = false;
  let selectedEnd = -1;
  let rootCount = 0;
  const spans = new Map<string, number[]>();
  for (const [index, line] of lines.entries()) {
    const boundary = /^(BEGIN|END):([A-Z0-9-]+)$/i.exec(line.unfolded);
    if (boundary) {
      const name = boundary[2].toLowerCase();
      if (boundary[1].toUpperCase() === "BEGIN") {
        if (stack.length === 0 && (name !== "vcalendar" || ++rootCount !== 1))
          throw invalidResource();
        if (stack.length === 1 && name === componentName) {
          eventIndex++;
          selected = eventIndex === masterIndex;
        }
        stack.push(name);
      } else {
        if (stack[stack.length - 1] !== name) throw invalidResource();
        if (stack.length === 2 && name === componentName && selected) {
          selectedEnd = index;
          selected = false;
        }
        stack.pop();
      }
      continue;
    }
    if (!line.unfolded && !stack.length) continue;
    if (!stack.length) throw invalidResource();
    // Parsing each candidate also checks quoted parameters/colon boundaries;
    // nested alarms and all other components are intentionally excluded.
    if (selected && stack.length === 2) {
      const property = ICAL.Property.fromString(line.unfolded);
      if (replacements.has(property.name)) {
        spans.set(property.name, [...(spans.get(property.name) ?? []), index]);
      }
    }
  }
  if (stack.length || rootCount !== 1 || selectedEnd < 0)
    throw invalidResource();
  const edits = new Map<number, string>();
  const additions: string[] = [];
  const newline = data.includes("\r\n") ? "\r\n" : "\n";
  for (const [name, properties] of replacements) {
    const positions = spans.get(name) ?? [];
    const recurrence = ["rrule", "rdate", "exdate"].includes(name);
    if (!recurrence && positions.length > 1) throw invalidResource();
    const serialized = properties
      .map((property) => {
        const next = new ICAL.Property(structuredClone(property.toJSON()));
        if (!recurrence && positions.length === 1) {
          const original = ICAL.Property.fromString(
            lines[positions[0]].unfolded,
          );
          const parameters = structuredClone(original.toJSON()[1]);
          if (["dtstart", "dtend", "due", "completed", "recurrence-id"].includes(name)) {
            delete parameters.tzid;
            delete parameters.value;
          }
          // Preserve extension/LANGUAGE/etc parameters even on the edited field.
          Object.assign(next.toJSON()[1], {
            ...parameters,
            ...next.toJSON()[1],
          });
        }
        return next.toICALString().replace(/\r?\n/g, newline) + newline;
      })
      .join("");
    if (positions.length) {
      edits.set(positions[0], serialized);
      for (const position of positions.slice(1)) edits.set(position, "");
    } else {
      additions.push(serialized);
    }
  }
  const output = lines
    .map(
      (line, index) =>
        (index === selectedEnd ? additions.join("") : "") +
        (edits.get(index) ?? line.raw),
    )
    .join("");
  // Reject invalid generated input before any network mutation, without using
  // the parsed representation to serialize the resource.
  ICAL.parse(output);
  return output;
}
