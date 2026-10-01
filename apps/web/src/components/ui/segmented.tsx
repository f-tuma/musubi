import {
  type KeyboardEvent,
  type ReactNode,
  useRef,
  useLayoutEffect,
} from "react";
import { cn } from "~/lib/utils";

export type SegmentedOption<Value extends string> = {
  disabled?: boolean;
  label: ReactNode;
  value: Value;
};

export type SegmentedSize = "compact" | "control";

export type SegmentedProps<Value extends string> = {
  className?: string;
  disabled?: boolean;
  label: string;
  onChange: (value: Value) => void;
  options: ReadonlyArray<SegmentedOption<Value>>;
  size?: SegmentedSize;
  value: Value;
};

function enabledIndex<Value extends string>(
  options: ReadonlyArray<SegmentedOption<Value>>,
  from: number,
  direction: 1 | -1,
) {
  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (from + direction * offset + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return from;
}

/**
 * A short, visible choice set: two to four options that fit on one line.
 * Longer or dynamic lists are a Select. Selection follows focus for arrow navigation,
 * matching native radio groups and avoiding a second confirmation step.
 */
export function Segmented<Value extends string>({
  className,
  disabled = false,
  label,
  onChange,
  options,
  size = "compact",
  value,
}: SegmentedProps<Value>) {
  const groupRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const fallbackIndex = options.findIndex((option) => !option.disabled);
  const selectedOption = options[selectedIndex];
  const tabbableIndex =
    selectedIndex >= 0 && !selectedOption?.disabled
      ? selectedIndex
      : fallbackIndex;

  useLayoutEffect(() => {
    const group = groupRef.current;
    const indicator = indicatorRef.current;
    const selected = optionRefs.current[selectedIndex];
    if (!group || !indicator) return;
    if (!selected) { delete group.dataset.indicatorReady; return; }
    const measure = () => {
      indicator.style.transform = `translate(${selected.offsetLeft}px, ${selected.offsetTop}px)`;
      indicator.style.width = `${selected.offsetWidth}px`;
      indicator.style.height = `${selected.offsetHeight}px`;
      group.dataset.indicatorReady = "true";
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    optionRefs.current.forEach(option => { if (option) observer.observe(option); });
    return () => observer.disconnect();
  }, [selectedIndex, options]);

  function choose(index: number) {
    const option = options[index];
    if (!option || disabled || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    optionRefs.current[index]?.focus();
  }

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let nextIndex: number | undefined;

    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = enabledIndex(options, index, -1);
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = enabledIndex(options, index, 1);
    } else if (event.key === "Home") {
      nextIndex = options.findIndex((option) => !option.disabled);
    } else if (event.key === "End") {
      nextIndex = options.findLastIndex((option) => !option.disabled);
    }

    if (nextIndex === undefined || nextIndex < 0) return;
    event.preventDefault();
    choose(nextIndex);
  }

  return (
    <div
      ref={groupRef}
      aria-disabled={disabled || undefined}
      aria-label={label}
      aria-orientation="horizontal"
      className={cn(
        "group/segmented relative inline-flex min-w-0 rounded-full border border-border bg-panel p-0.5",
        size === "control" ? "h-control" : "h-control-compact",
        className,
      )}
      role="radiogroup"
    >
      <span ref={indicatorRef} aria-hidden="true" className="pointer-events-none absolute top-0 left-0 invisible rounded-full bg-primary group-data-[indicator-ready]/segmented:visible group-data-[indicator-ready]/segmented:transition-all group-data-[indicator-ready]/segmented:duration-standard group-data-[indicator-ready]/segmented:ease-out data-[disabled]:opacity-50 motion-reduce:transition-none" data-disabled={disabled || selectedOption?.disabled || undefined} />
      {options.map((option, index) => {
        const selected = option.value === value;

        return (
          <button
            aria-checked={selected}
            className="relative z-10 inline-flex min-w-0 flex-auto cursor-pointer items-center justify-center overflow-hidden rounded-full px-3 text-12 text-foreground-secondary transition-colors duration-fast hover:enabled:text-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-checked:text-primary-foreground hover:enabled:aria-checked:text-primary-foreground group-not-data-[indicator-ready]/segmented:aria-checked:bg-primary motion-reduce:transition-none"
            disabled={disabled || option.disabled}
            key={option.value}
            ref={(node) => {
              optionRefs.current[index] = node;
            }}
            role="radio"
            tabIndex={index === tabbableIndex ? 0 : -1}
            type="button"
            onClick={() => choose(index)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            <span className="truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
