import { timeZoneOptions } from "@musubi/calendar";
import { Select } from "~/components/ui/select";

export function TimeZonePicker({ value, disabled, onChange, id, "aria-describedby": describedBy, "aria-invalid": invalid }: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  /** Wired by a surrounding Field. */
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "false" | "true";
}) {
  return <Select id={id} aria-describedby={describedBy} aria-invalid={invalid} label="Event time zone" searchable value={value} disabled={disabled} placeholder="Choose time zone" options={timeZoneOptions(value)} onChange={onChange} />;
}
