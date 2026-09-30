import { HelpTooltip } from "~/components/ui/help-tooltip";
import type { Event, Settings } from "@musubi/types";
import { DatePicker } from "~/ui/DatePicker";
import { allDayAdditionalDate, setAllDayAdditionalDate, allDayExclusionDates, restoreAllDayExclusion } from "@musubi/calendar";
import { Row } from "~/components/ui/row";
import {
	buildRRule,
	describeAdvanced,
	isEditableRRule,
	joinRecurrence,
	parseAdvanced,
	parseRRule,
	splitRecurrence,
	type AdvancedEndType,
	type AdvancedFreq,
	type AdvancedRRuleConfig,
	type RecurrenceOption,
} from "@musubi/calendar/rrule-editor";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Segmented } from "~/components/ui/segmented";
import { Select } from "~/components/ui/select";

const WEEKDAYS = [
	{ day: 1, label: "M", name: "Monday" },
	{ day: 2, label: "T", name: "Tuesday" },
	{ day: 3, label: "W", name: "Wednesday" },
	{ day: 4, label: "T", name: "Thursday" },
	{ day: 5, label: "F", name: "Friday" },
	{ day: 6, label: "S", name: "Saturday" },
	{ day: 0, label: "S", name: "Sunday" },
] as const;

const FREQUENCIES = [
	{ label: "Day", value: "DAILY" },
	{ label: "Week", value: "WEEKLY" },
	{ label: "Month", value: "MONTHLY" },
	{ label: "Year", value: "YEARLY" },
] as const;

const OPTIONS = [
	{ label: "Does not repeat", value: "none" },
	{ label: "Every day", value: "daily" },
	{ label: "Every week", value: "weekly" },
	{ label: "Every weekday", value: "weekdays" },
	{ label: "Every month", value: "monthly" },
	{ label: "Every year", value: "yearly" },
	{ label: "Custom recurrence", value: "custom" },
] as const;

type RecurrenceEditorProps = {
	/** Wired by a surrounding Field to the Repeat select. */
	id?: string;
	"aria-describedby"?: string;
	followStartDate?: boolean;
	rdateMaster?: Event;
	weekStartsOn?: Settings["weekStartsOn"];
	allDay?: boolean;
	date: string;
	disabled: boolean;
	onChange: (recurrence: string) => void;
	value: string;
};

function dateAtNoon(date: string) {
	return new Date(`${date}T12:00:00`);
}

export function RecurrenceEditor({
	id,
	"aria-describedby": describedBy,
	followStartDate = true,
	rdateMaster,
	weekStartsOn = "monday",
	allDay = false,
	date,
	disabled,
	onChange,
	value,
}: RecurrenceEditorProps) {
	const { extras, rrule } = splitRecurrence(value);
	const [dateError, setDateError] = useState("");
	let additional: ReturnType<typeof allDayAdditionalDate> | undefined;
	try { if (allDay && rdateMaster) additional = allDayAdditionalDate({ ...rdateMaster, recurrence: value }); } catch { /* Unsupported drafts keep existing recurrence controls. */ }
	function changeAdditionalDate(date: string | null) {
		try {
			const recurrence = setAllDayAdditionalDate({ ...rdateMaster!, recurrence: value }, date);
			setDateError(""); restoreFocus.current = true; emit(recurrence);
		} catch { setDateError("Choose one date outside the regular occurrences, within two years of the series start."); }
	}

	const root = useRef<HTMLDivElement>(null);
	const restoreFocus = useRef(false);
	useEffect(() => { if (restoreFocus.current) { restoreFocus.current = false; root.current?.querySelector<HTMLButtonElement>('[role="combobox"]')?.focus(); } }, [value]);
	const startDate = dateAtNoon(date);
	const initialOption = parseRRule(rrule);
	// A custom rule can simplify to the same RRULE as a preset. Keep the user's
	// chosen editing mode so a later date change never rewrites custom weekdays.
	const [option, setOption] = useState<RecurrenceOption>(initialOption);
	const previousDate = useRef(date);
	const intervalId = useId();
	const unsupported =
		option === "custom" && Boolean(rrule) && !isEditableRRule(rrule);
	const advanced = parseAdvanced(rrule, startDate.getDay());
	const [intervalInput, setIntervalInput] = useState(String(advanced.interval));
	const [countInput, setCountInput] = useState(String(advanced.count));
	const [syncedValue, setSyncedValue] = useState(value);

	// Internal writes already updated their visible inputs. Only a different
	// controlled value should replace them; do it before the next paint.
	if (syncedValue !== value) {
		setSyncedValue(value);
		if (
			option !== "weekly" ||
			!/^FREQ=WEEKLY;BYDAY=(SU|MO|TU|WE|TH|FR|SA);UNTIL=\d{8}T\d{6}Z$/.test(
				rrule,
			)
		) {
			setOption(initialOption);
		}
		setIntervalInput(String(advanced.interval));
		setCountInput(String(advanced.count));
	}

	useEffect(() => {
		if (previousDate.current === date) return;
		previousDate.current = date;
		if (!followStartDate || option !== "weekly") return;
		let rule = buildRRule("weekly", startDate, advanced);
		if (rule && advanced.until) rule += `;UNTIL=${advanced.until}`;
		onChange(joinRecurrence(rule, extras) ?? "");
	}, [advanced, date, extras, followStartDate, onChange, option, startDate]);

	function emit(nextValue: string) {
		setSyncedValue(nextValue);
		onChange(nextValue);
	}

	function choose(next: string) {
		const nextOption = next as RecurrenceOption;
		setOption(nextOption);
		if (nextOption === "none") {
			emit("");
			return;
		}
		if (nextOption === "custom") {
			if (option === "custom") return;
			const custom = parseAdvanced(null, startDate.getDay());
			setIntervalInput(String(custom.interval));
			setCountInput(String(custom.count));
			emit(
				joinRecurrence(buildRRule("custom", startDate, custom), extras) ?? "",
			);
			return;
		}
		let rule = buildRRule(nextOption, startDate, advanced);
		if (rule && advanced.until) rule += `;UNTIL=${advanced.until}`;
		emit(joinRecurrence(rule, extras) ?? "");
	}

	function updateAdvanced(next: AdvancedRRuleConfig) {
		emit(joinRecurrence(buildRRule("custom", startDate, next), extras) ?? "");
	}

	function replaceUnsupported() {
		const replacement = parseAdvanced(null, startDate.getDay());
		setOption("custom");
		setIntervalInput(String(replacement.interval));
		setCountInput(String(replacement.count));
		emit(
			joinRecurrence(buildRRule("custom", startDate, replacement), extras) ??
				"",
		);
	}

	function boundedNumber(raw: string, maximum: number, fallback: number) {
		if (!raw) return fallback;
		return Math.min(maximum, Math.max(1, Number.parseInt(raw, 10) || fallback));
	}

	function changeBoundedNumber(
		raw: string,
		maximum: number,
		setInput: (value: string) => void,
		commit: (value: number) => void,
	) {
		setInput(raw);
		if (!raw) return;
		const next = boundedNumber(raw, maximum, 1);
		setInput(String(next));
		commit(next);
	}

	function restoreBoundedNumber(
		raw: string,
		maximum: number,
		fallback: number,
		setInput: (value: string) => void,
		commit: (value: number) => void,
	) {
		const next = boundedNumber(raw, maximum, fallback);
		setInput(String(next));
		commit(next);
	}

	const day = startDate.getDate();
	const monthly =
		option === "monthly" ||
		(option === "custom" && !unsupported && advanced.freq === "MONTHLY");
	const leapDay =
		option === "yearly" && startDate.getMonth() === 1 && day === 29;

	return (
		<div ref={root} className="grid min-w-0 gap-2">
			<Select
				aria-describedby={describedBy}
				id={id}
				disabled={disabled}
				label="Repeat"
				options={OPTIONS}
				value={option}
				onChange={choose}
			/>

			{allDay && allDayExclusionDates(value)?.map(date => <Row key={date} size="compact" label={date} detail="Excluded from this series" trailing={<Button type="button" disabled={disabled} size="compact" variant="ghost" aria-label={`Restore ${date}`} onClick={() => { restoreFocus.current = true; emit(restoreAllDayExclusion(value, date)); }}>Restore</Button>} />)}

			{additional ? <div className="grid min-w-0 gap-2">
				<Row label={<>Additional series date<HelpTooltip label="About additional series dates">Adds one occurrence. The regular repeat count stays unchanged.</HelpTooltip></>} size="compact" trailing={additional.date ? <Button type="button" disabled={disabled} size="compact" variant="ghost" onClick={() => changeAdditionalDate(null)}>Remove additional date</Button> : undefined} />
				<DatePicker label="Additional series date" value={additional.date ?? ""} disabled={disabled || !!additional.date} min={rdateMaster!.start.toISOString().slice(0,10)} max={additional.limit} weekStartsOn={weekStartsOn} onChange={changeAdditionalDate} />
				{dateError ? <p role="alert" className="text-12 leading-snug text-shu">{dateError}</p> : null}
			</div> : null}

			{unsupported ? (
				<div className="grid justify-items-start gap-3 rounded-control border border-border-subtle border-l-shu bg-raised/50 p-3" role="note">
					<p className="text-12 leading-snug text-foreground-secondary">
						This imported rule uses options Musubi cannot safely change, so
						it is kept as it is.
					</p>
					<Button
						disabled={disabled}
						size="compact"
						variant="secondary"
						onClick={replaceUnsupported}
					>
						Replace with editable rule
					</Button>
				</div>
			) : option === "custom" ? (
				<div className="grid gap-3 rounded-control border border-border-subtle bg-raised/50 p-3">
					<div className="flex items-center gap-2 text-12 text-foreground-secondary">
						<label htmlFor={intervalId}>Every</label>
						<Input
							aria-label="Recurrence interval"
							className="w-16"
							disabled={disabled}
							id={intervalId}
							max={99}
							min={1}
							type="number"
							value={intervalInput}
							onBlur={() =>
								restoreBoundedNumber(
									intervalInput,
									99,
									advanced.interval,
									setIntervalInput,
									(interval) => updateAdvanced({ ...advanced, interval }),
								)
							}
							onChange={(event) =>
								changeBoundedNumber(
									event.target.value,
									99,
									setIntervalInput,
									(interval) => updateAdvanced({ ...advanced, interval }),
								)
							}
						/>
						<Select
							disabled={disabled}
							label="Recurrence frequency"
							options={FREQUENCIES}
							size="compact"
							value={advanced.freq}
							onChange={(frequency) =>
								updateAdvanced({
									...advanced,
									freq: frequency as AdvancedFreq,
								})
							}
						/>
					</div>

					{advanced.freq === "WEEKLY" ? (
						<fieldset className="m-0 grid gap-2 border-0 p-0">
							<legend className="mb-2 p-0 text-12 text-foreground-secondary">On</legend>
							<div className="grid grid-cols-7 gap-1">
								{WEEKDAYS.map(({ day: weekday, label, name }) => {
									const selected = advanced.days.has(weekday);
									return (
										<Button
											aria-label={name}
											className="w-full"
											size="icon-compact"
											variant={selected ? "primary" : "secondary"}
											aria-pressed={selected}
											disabled={
												disabled || (selected && advanced.days.size === 1)
											}
											key={name}
											onClick={() => {
												const days = new Set(advanced.days);
												if (selected) days.delete(weekday);
												else days.add(weekday);
												updateAdvanced({ ...advanced, days });
											}}
										>
											{label}
										</Button>
									);
								})}
							</div>
						</fieldset>
					) : null}

					<div className="flex flex-wrap items-center gap-2 text-12 text-foreground-secondary">
						<span>Ends</span>
						<Segmented<AdvancedEndType | "until">
							disabled={disabled}
							label="Recurrence ending"
							options={[
								{ label: "Never", value: "never" },
								{ label: "After", value: "count" },
								...(advanced.until
									? [
											{
												disabled: true,
												label: "On date",
												value: "until" as const,
											},
										]
									: []),
							]}
							value={advanced.until ? "until" : advanced.endType}
							onChange={(endType) => {
								const count = boundedNumber(countInput, 999, advanced.count);
								setCountInput(String(count));
								updateAdvanced({
									...advanced,
									count,
									endType: endType as AdvancedEndType,
									until: undefined,
								});
							}}
						/>
						{advanced.endType === "count" ? (
							<label className="flex items-center gap-2">
								<span className="sr-only">Occurrence count</span>
								<Input
									aria-label="Occurrence count"
									className="w-16"
									disabled={disabled}
									max={999}
									min={1}
									type="number"
									value={countInput}
									onBlur={() =>
										restoreBoundedNumber(
											countInput,
											999,
											advanced.count,
											setCountInput,
											(count) =>
												updateAdvanced({
													...advanced,
													count,
													until: undefined,
												}),
										)
									}
									onChange={(event) =>
										changeBoundedNumber(
											event.target.value,
											999,
											setCountInput,
											(count) =>
												updateAdvanced({
													...advanced,
													count,
													until: undefined,
												}),
										)
									}
								/>
								<span>{advanced.count === 1 ? "time" : "times"}</span>
							</label>
						) : null}
					</div>

					{advanced.until ? (
						<p className="border-l-2 border-shu pl-2 text-12 leading-snug text-foreground-secondary">
							This series currently ends on {advanced.until.slice(0, 4)}-
							{advanced.until.slice(4, 6)}-{advanced.until.slice(6, 8)}. Choose
							Never or After to replace that ending.
						</p>
					) : null}
					<p className="text-12 text-muted-foreground">
						{describeAdvanced(advanced)}
					</p>
				</div>
			) : null}

			{monthly && day >= 29 ? (
				<p className="text-12 text-muted-foreground">
					Repeats on day {day}; months without it are skipped.
				</p>
			) : leapDay ? (
				<p className="text-12 text-muted-foreground">
					February 29 only repeats in leap years.
				</p>
			) : null}
		</div>
	);
}
