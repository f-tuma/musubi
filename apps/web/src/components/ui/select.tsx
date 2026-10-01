import { Check, ChevronDown } from "lucide-react";
import {
	forwardRef,
	type ButtonHTMLAttributes,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { cn } from "~/lib/utils";
import { Input } from "~/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";

export type SelectOption = {
	description?: ReactNode;
	disabled?: boolean;
	icon?: ReactNode;
	label: ReactNode;
	/** Plain text used for keyboard typeahead and the closed trigger. */
	textValue?: string;
	value: string;
};

export type SelectProps = Omit<
	ButtonHTMLAttributes<HTMLButtonElement>,
	"children" | "defaultValue" | "onChange" | "value"
> & {
	label: string;
	/** Show only the selected option icon while keeping the accessible label. */
	iconOnly?: boolean;
	searchable?: boolean;
	onChange: (value: string) => void;
	options: readonly SelectOption[];
	placeholder?: string;
	size?: "compact" | "default";
	value: string;
};

function optionText(option: SelectOption) {
	if (option.textValue) return option.textValue;
	return typeof option.label === "string" ? option.label : option.value;
}

/**
 * A select-only combobox with one consistent Musubi surface on every platform.
 * Focus moves into the list while it is open, which keeps arrow navigation and
 * typeahead predictable for keyboard and screen-reader users.
 */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(
	function Select(
		{
			className,
			disabled = false,
			label,
			searchable = false,
            iconOnly = false,
			onChange,
			options,
			placeholder = "Choose an option",
			size = "default",
			value,
			...triggerProps
		},
		forwardedRef,
	) {
		const generatedId = useId();
		const triggerRef = useRef<HTMLButtonElement | null>(null);
		const returnFocusAfterChoice = useRef(false);
		const optionRefs = useRef(new Map<string, HTMLButtonElement>());
		const typeahead = useRef({ at: 0, query: "" });
		const [open, setOpen] = useState(false);
		const [activeValue, setActiveValue] = useState(value);
		const [query, setQuery] = useState("");
		const searchRef = useRef<HTMLInputElement>(null);
		const filteredOptions = options.filter(option => !searchable || (optionText(option) + " " + option.value).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
		const enabledOptions = filteredOptions.filter((option) => !option.disabled);
		const selectedOption = options.find((option) => option.value === value);
		const initialValue =
			(selectedOption && !selectedOption.disabled
				? selectedOption.value
				: enabledOptions[0]?.value) ?? "";
		const listboxId = `${generatedId}-listbox`;
		const titleId = `${generatedId}-title`;

		// Saving a preference may disable its trigger before the list closes.
		// Keep that focus destination until saving ends, unless the person has
		// already moved to another control or the select has been removed.
		useEffect(() => {
			if (open || !returnFocusAfterChoice.current) return;
			const trigger = triggerRef.current;
			if (!trigger) return;
			const doc = trigger.ownerDocument;
			const cancelIfMoved = (event: FocusEvent) => {
				if (event.target !== doc.body && event.target !== trigger) {
					returnFocusAfterChoice.current = false;
				}
			};
			doc.addEventListener("focusin", cancelIfMoved);
			const frame = requestAnimationFrame(() => {
				if (trigger.disabled || !returnFocusAfterChoice.current) return;
				returnFocusAfterChoice.current = false;
				if (doc.activeElement === doc.body || doc.activeElement === trigger) {
					trigger.focus();
				}
			});
			return () => {
				cancelAnimationFrame(frame);
				doc.removeEventListener("focusin", cancelIfMoved);
			};
		}, [disabled, open]);

		function setTriggerRef(node: HTMLButtonElement | null) {
			triggerRef.current = node;
			if (typeof forwardedRef === "function") forwardedRef(node);
			else if (forwardedRef) forwardedRef.current = node;
		}

		function focusOption(nextValue: string) {
			setActiveValue(nextValue);
			requestAnimationFrame(() => {
				const option = optionRefs.current.get(nextValue);
				option?.focus();
				option?.scrollIntoView?.({ block: "nearest" });
			});
		}

		function beginOpen(nextValue = initialValue) {
			setQuery("");
			setActiveValue(nextValue);
			setOpen(true);
		}

		function choose(nextValue: string) {
			const option = options.find((item) => item.value === nextValue);
			if (!option || option.disabled) return;
			returnFocusAfterChoice.current = true;
			onChange(nextValue);
			setActiveValue(nextValue);
			setOpen(false);
		}

		function moveActive(key: "ArrowDown" | "ArrowUp" | "End" | "Home") {
			if (enabledOptions.length === 0) return;
			const currentIndex = enabledOptions.findIndex(
				(option) => option.value === activeValue,
			);
			const lastIndex = enabledOptions.length - 1;
			let nextIndex: number;

			if (key === "Home") nextIndex = 0;
			else if (key === "End") nextIndex = lastIndex;
			else if (key === "ArrowDown") {
				nextIndex =
					currentIndex < 0 ? 0 : Math.min(lastIndex, currentIndex + 1);
			} else {
				nextIndex =
					currentIndex < 0 ? lastIndex : Math.max(0, currentIndex - 1);
			}

			focusOption(enabledOptions[nextIndex]!.value);
		}

		function matchTypeahead(character: string) {
			const now = Date.now();
			const previous = typeahead.current;
			const query =
				now - previous.at < 700 ? `${previous.query}${character}` : character;
			typeahead.current = { at: now, query };

			const startIndex = Math.max(
				0,
				enabledOptions.findIndex((option) => option.value === activeValue) + 1,
			);
			const ordered = [
				...enabledOptions.slice(startIndex),
				...enabledOptions.slice(0, startIndex),
			];
			const normalized = query.toLocaleLowerCase();
			const match =
				ordered.find((option) =>
					optionText(option).toLocaleLowerCase().startsWith(normalized),
				) ??
				(query.length > 1 && new Set(query).size === 1
					? ordered.find((option) =>
							optionText(option)
								.toLocaleLowerCase()
								.startsWith(character.toLocaleLowerCase()),
						)
					: undefined);

			if (match) {
				if (!open) beginOpen(match.value);
				else focusOption(match.value);
			}
		}

		function handleTypeahead(event: KeyboardEvent) {
			if (
				event.ctrlKey ||
				event.metaKey ||
				event.altKey ||
				event.key.length !== 1 ||
				event.key === " "
			) {
				return false;
			}
			event.preventDefault();
			matchTypeahead(event.key);
			return true;
		}

		return (
			<Popover
				open={open}
				onOpenChange={(nextOpen) => {
					if (nextOpen) beginOpen();
					else setOpen(false);
				}}
			>
				<PopoverTrigger asChild>
					<button
						{...triggerProps}
                        value={value}
						aria-controls={listboxId}
						aria-expanded={open}
						aria-haspopup="listbox"
						aria-label={triggerProps["aria-label"] ?? label}
						className={cn(
							"flex w-full cursor-pointer items-center justify-between gap-2 rounded-control border border-border bg-raised text-left font-sans text-foreground transition-colors duration-fast hover:enabled:border-border-strong disabled:cursor-not-allowed disabled:opacity-50",
							size === "compact" ? "h-control-compact w-auto px-2 text-12" : "h-control px-3 text-14",
							iconOnly && "w-auto justify-center",
							className,
						)}
						disabled={disabled}
						ref={setTriggerRef}
						role="combobox"
						type="button"
						onKeyDown={(event) => {
							triggerProps.onKeyDown?.(event);
							if (event.defaultPrevented) return;

							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault();
								beginOpen();
							} else if (event.key === "Home" || event.key === "End") {
								event.preventDefault();
								beginOpen(
									event.key === "Home"
										? (enabledOptions[0]?.value ?? "")
										: (enabledOptions.at(-1)?.value ?? ""),
								);
							} else {
								handleTypeahead(event);
							}
						}}
					>
						<span className="flex min-w-0 items-center gap-2">
							{selectedOption?.icon ? (
								<span aria-hidden="true" className="grid flex-none place-content-center text-muted-foreground">
									{selectedOption.icon}
								</span>
							) : null}
							<span className={iconOnly ? "sr-only" : "truncate"}>
								{selectedOption ? optionText(selectedOption) : placeholder}
							</span>
						</span>
						{!iconOnly ? <ChevronDown
							aria-hidden="true"
							className="flex-none text-muted-foreground transition-transform duration-fast in-aria-expanded:rotate-180"
							size={16}
							strokeWidth={1.5}
						/> : null}
					</button>
				</PopoverTrigger>
				{open ? (
					<PopoverContent
						align="start"
						aria-labelledby={titleId}
						className="w-auto min-w-(--radix-popover-trigger-width) max-w-(--radix-popover-content-available-width)"
                        data-searchable={searchable || undefined}
						side="bottom"
						sideOffset={6}
						onOpenAutoFocus={(event) => {
							event.preventDefault();
							requestAnimationFrame(() =>
								searchable ? searchRef.current?.focus() : optionRefs.current.get(activeValue || initialValue)?.focus(),
							);
						}}
					>
						<h2 className="sr-only" id={titleId}>
							{label}
						</h2>
                        {searchable ? <div className="border-b border-border-subtle p-2"><Input ref={searchRef} aria-label={`Search ${label}`} placeholder="Search city or time zone" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
                          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const option = event.key === "ArrowDown" ? enabledOptions[0] : enabledOptions.at(-1); if (option) focusOption(option.value); }
                          if (event.key === "Enter") { event.preventDefault(); if (enabledOptions.length === 1) choose(enabledOptions[0]!.value); }
                        }} /></div> : null}
						<div
							aria-label={`${label} options`}
							className={cn(
								"max-h-96 touch-pan-y overflow-y-auto overscroll-contain p-1",
								options.length > 8 && "h-96 overflow-y-scroll",
							)}
							id={listboxId}
							role="listbox"
							onWheel={(event) => {
								event.currentTarget.scrollTop += event.deltaY;
								event.preventDefault();
							}}
						>
							{searchable && !filteredOptions.length ? <p className="px-3 py-4 text-13 text-muted-foreground" role="status">No time zones found</p> : null}
							{filteredOptions.map((option) => {
								const selected = option.value === value;
								const active = option.value === activeValue;

								return (
									<button
										aria-selected={selected}
										className="group/option flex min-h-control-compact w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-foreground-secondary focus-inset hover:enabled:bg-raised hover:enabled:text-foreground disabled:cursor-not-allowed disabled:opacity-50 data-[active]:bg-raised data-[active]:text-foreground"
										data-active={active ? "" : undefined}
										disabled={option.disabled}
										key={option.value}
										ref={(node) => {
											if (node) optionRefs.current.set(option.value, node);
											else optionRefs.current.delete(option.value);
										}}
										role="option"
										tabIndex={active ? 0 : -1}
										type="button"
										onClick={() => choose(option.value)}
										onFocus={() => setActiveValue(option.value)}
										onKeyDown={(event) => {
											if (
												event.key === "ArrowDown" ||
												event.key === "ArrowUp" ||
												event.key === "Home" ||
												event.key === "End"
											) {
												event.preventDefault();
												moveActive(event.key);
											} else if (event.key === "Enter" || event.key === " ") {
												event.preventDefault();
												choose(option.value);
											} else {
												handleTypeahead(event);
											}
										}}
									>
										<span
											aria-hidden={!option.icon || undefined}
											className="grid w-5 flex-none place-content-center text-muted-foreground"
										>
											{option.icon}
										</span>
										<span className="grid min-w-0 flex-1 gap-0.5">
											<span className="truncate text-13">{option.label}</span>
											{option.description ? (
												<small className="text-11 leading-snug text-muted-foreground">{option.description}</small>
											) : null}
										</span>
										<Check
											aria-hidden="true"
											className="invisible w-5 flex-none text-shu group-aria-selected/option:visible"
											size={16}
											strokeWidth={1.8}
										/>
									</button>
								);
							})}
						</div>
					</PopoverContent>
				) : null}
			</Popover>
		);
	},
);
