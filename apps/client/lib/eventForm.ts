// Pure validation for the event composer. Mirrors the checks that used to live
// inline in AddEventModal's save handler. Callers apply every returned error
// unconditionally, so a field that now passes clears its previous error.

export type EventFormInput = {
  title: string;
  calendarCount: number;
  start: Date;
  end: Date;
  url: string;
};

export type EventFormErrors = {
  name: string;
  calendars: string;
  start: string;
  end: string;
  url: string;
};

export function validateEventForm(input: EventFormInput): { ok: boolean; errors: EventFormErrors } {
  const errors: EventFormErrors = { name: "", calendars: "", start: "", end: "", url: "" };
  let ok = true;

  if (input.title.length === 0) {
    errors.name = "I mean... At least one letter please...";
    ok = false;
  }
  if (input.calendarCount === 0) {
    errors.calendars = "Event needs some cozy place... Give it atleast one...";
    ok = false;
  }
  if (input.start.getTime() > input.end.getTime()) {
    errors.start = "I don't think so...";
    errors.end = "I should probably be the one in front...";
    ok = false;
  }
  if (input.url) {
    try {
      const { protocol } = new URL(input.url);
      if (protocol !== "http:" && protocol !== "https:") {
        errors.url = "Invalid URL protocol...";
        ok = false;
      }
    } catch {
      errors.url = "Invalid URL...";
      ok = false;
    }
  }

  return { ok, errors };
}
