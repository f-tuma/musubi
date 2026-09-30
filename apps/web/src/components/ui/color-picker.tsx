import {
  MICROSOFT_CALENDAR_COLORS,
  MUSUBI_CALENDAR_COLORS,
  nearestMicrosoftCalendarColor,
} from "@musubi/types";
import { Check, Plus } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  useId,
  useRef,
  useState,
} from "react";
import { getReadableEventTextColor } from "~/calendar/event-color";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";

const option =
  "group/option grid min-h-16 min-w-0 cursor-pointer place-items-center content-center gap-1.5 rounded-chip border border-transparent px-1 py-1.5 text-11 text-foreground-secondary transition-colors duration-fast hover:border-border hover:bg-raised focus-visible:border-border focus-visible:bg-raised aria-selected:font-medium aria-selected:text-foreground max-sm:min-h-20";
const swatch = "grid size-9 place-content-center rounded-full";

type PaletteColor = {
  hex: string;
  name: string;
};

export type ColorPickerProps = {
  className?: string;
  disabled?: boolean;
  label: string;
  onChange: (value: string) => void;
  provider?: string | null;
  value: string;
};

export function normalizeHexColor(value: string): string | null {
  const match = /^#?([\da-f]{6})$/i.exec(value.trim());
  return match ? `#${match[1]!.toUpperCase()}` : null;
}

function displayName(name: string) {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}

function matches(left: string, right: string) {
  return left.toLocaleLowerCase() === right.toLocaleLowerCase();
}

/**
 * A compact, named palette for quick recognition with an explicit custom hex
 * path. The value remains a plain #RRGGBB string for existing form contracts.
 */
export function ColorPicker({
  className,
  disabled = false,
  label,
  onChange,
  provider,
  value,
}: ColorPickerProps) {
  const id = useId();
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const customInputRef = useRef<HTMLInputElement>(null);
  const microsoft = provider === "microsoft";
  const palette: readonly PaletteColor[] = microsoft
    ? MICROSOFT_CALENDAR_COLORS
    : MUSUBI_CALENDAR_COLORS;
  const normalizedValue = normalizeHexColor(value);
  const matchedPaletteColor = microsoft
    ? nearestMicrosoftCalendarColor(value).hex
    : palette.find((color) => matches(color.hex, value))?.hex;
  const customSelected =
    !microsoft &&
    Boolean(
      normalizedValue &&
        !palette.some((color) => matches(color.hex, normalizedValue)),
    );
  const selectedKey = customSelected
    ? "custom"
    : (matchedPaletteColor ?? palette[0]!.hex);
  const [open, setOpen] = useState(false);
  const [activeKey, setActiveKey] = useState(selectedKey);
  const [customOpen, setCustomOpen] = useState(customSelected);
  const [customDraft, setCustomDraft] = useState(
    normalizedValue ?? value,
  );
  const [customDirty, setCustomDirty] = useState(false);
  const validCustom = normalizeHexColor(customDraft);
  const optionKeys = [
    ...palette.map((color) => color.hex),
    ...(!microsoft ? ["custom"] : []),
  ];
  const columns = 3;

  function beginOpen() {
    const nextCustomSelected =
      !microsoft &&
      Boolean(
        normalizedValue &&
          !palette.some((color) =>
            matches(color.hex, normalizedValue),
          ),
      );
    const nextKey = nextCustomSelected
      ? "custom"
      : (matchedPaletteColor ?? palette[0]!.hex);
    setActiveKey(nextKey);
    setCustomOpen(nextCustomSelected);
    setCustomDraft(normalizedValue ?? value);
    setCustomDirty(false);
    setOpen(true);
  }

  function choose(hex: string) {
    onChange(hex);
    setOpen(false);
  }

  function focusOption(key: string) {
    setActiveKey(key);
    optionRefs.current.get(key)?.focus();
  }

  function moveFocus(event: KeyboardEvent, currentKey: string) {
    const currentIndex = optionKeys.indexOf(currentKey);
    if (currentIndex < 0) return;

    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") nextIndex += 1;
    else if (event.key === "ArrowLeft") nextIndex -= 1;
    else if (event.key === "ArrowDown") nextIndex += columns;
    else if (event.key === "ArrowUp") nextIndex -= columns;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = optionKeys.length - 1;
    else return;

    event.preventDefault();
    nextIndex = Math.max(0, Math.min(optionKeys.length - 1, nextIndex));
    focusOption(optionKeys[nextIndex]!);
  }

  function openCustom() {
    setActiveKey("custom");
    setCustomOpen(true);
    setCustomDraft(normalizedValue ?? value);
    setCustomDirty(false);
    requestAnimationFrame(() => {
      customInputRef.current?.focus();
      customInputRef.current?.select();
    });
  }

  const triggerColor = microsoft
    ? nearestMicrosoftCalendarColor(value).hex
    : (normalizedValue ?? palette[0]!.hex);

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
          aria-label={`${label}: ${triggerColor}`}
          data-slot="color-picker"
          className={cn("inline-grid size-control flex-none cursor-pointer place-content-center rounded-control border border-border bg-raised transition-colors duration-fast hover:enabled:border-border-strong disabled:cursor-not-allowed disabled:opacity-50", className)}
          disabled={disabled}
          style={{ "--pigment": triggerColor } as CSSProperties}
          type="button"
        >
          <span aria-hidden="true" className="size-6 rounded-full border border-foreground/15 bg-pigment" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-ui="color-picker-popover"
        align="center"
        aria-labelledby={`${id}-title`}
        className="w-80"
        side="bottom"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() =>
            optionRefs.current.get(activeKey)?.focus(),
          );
        }}
      >
        <div className="px-4 pt-4 max-sm:pt-6">
          <h2 className="font-serif text-19 leading-tight font-normal text-foreground" id={`${id}-title`}>
            Choose color
          </h2>
          {/* Why the palette is short, and nothing more: the swatches explain themselves. */}
          {microsoft ? <p className="mt-1 text-12 leading-snug text-muted-foreground">Outlook supports these colors.</p> : null}
        </div>
        <div
          aria-label={`${label} options`}
          className="grid grid-cols-3 gap-2 p-4 max-sm:py-5"
          data-provider={microsoft ? "microsoft" : "musubi"}
          role="listbox"
        >
          {palette.map((color) => {
            const selected = matches(color.hex, selectedKey);
            const foreground = getReadableEventTextColor(color.hex);

            return (
              <button
                aria-label={`${displayName(color.name)}, ${color.hex}`}
                aria-selected={selected}
                className={option}
                key={color.hex}
                ref={(node) => {
                  if (node) optionRefs.current.set(color.hex, node);
                  else optionRefs.current.delete(color.hex);
                }}
                role="option"
                tabIndex={activeKey === color.hex ? 0 : -1}
                type="button"
                onClick={() => choose(color.hex)}
                onFocus={() => setActiveKey(color.hex)}
                onKeyDown={(event) => moveFocus(event, color.hex)}
              >
                <span
                  aria-hidden="true"
                  className={cn(swatch, "border border-foreground/15 bg-pigment text-(color:--pigment-foreground)")}
                  style={
                    {
                      "--pigment": color.hex,
                      "--pigment-foreground": foreground,
                    } as CSSProperties
                  }
                >
                  {selected ? <Check size={18} strokeWidth={2} /> : null}
                </span>
                <span>{displayName(color.name)}</span>
              </button>
            );
          })}
          {!microsoft ? (
            <button
              aria-label="Custom color"
              aria-selected={customSelected}
              className={option}
              ref={(node) => {
                if (node) optionRefs.current.set("custom", node);
                else optionRefs.current.delete("custom");
              }}
              role="option"
              tabIndex={activeKey === "custom" ? 0 : -1}
              type="button"
              onClick={openCustom}
              onFocus={() => setActiveKey("custom")}
              onKeyDown={(event) => moveFocus(event, "custom")}
            >
              <span
                aria-hidden="true"
                className={cn(swatch, "border border-dashed border-border-strong bg-raised text-foreground-secondary group-aria-selected/option:border-solid group-aria-selected/option:border-primary")}
              >
                <Plus size={18} strokeWidth={1.5} />
              </span>
              <span>Custom</span>
            </button>
          ) : null}
        </div>
        {customOpen ? (
          <div className="flex flex-wrap items-end gap-2 border-t border-border-subtle px-4 py-3">
            <span
              aria-hidden="true"
              className="size-control flex-none rounded-control border border-foreground/15 bg-pigment"
              style={
                {
                  "--pigment":
                    validCustom ?? normalizedValue ?? palette[0]!.hex,
                } as CSSProperties
              }
            />
            <label className="grid min-w-0 flex-1 gap-1 text-12 text-muted-foreground">
              <span>Hex color</span>
              <Input
                className="font-mono text-13 uppercase"
                aria-describedby={`${id}-custom-hint`}
                aria-invalid={customDirty && !validCustom}
                autoCapitalize="characters"
                autoComplete="off"
                maxLength={7}
                placeholder="#B3A48A"
                ref={customInputRef}
                spellCheck={false}
                value={customDraft}
                onChange={(event) => {
                  const nextDraft = event.target.value;
                  const normalized = normalizeHexColor(nextDraft);
                  setCustomDraft(nextDraft);
                  setCustomDirty(true);
                  if (normalized) onChange(normalized);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && validCustom) {
                    event.preventDefault();
                    setOpen(false);
                  }
                }}
              />
            </label>
            <Button disabled={!validCustom} variant="secondary" onClick={() => setOpen(false)}>
              Done
            </Button>
            {/* Only when it is wrong: the preview is the feedback while it is
                right. */}
            {customDirty && !validCustom ? (
              <p className="basis-full text-11 text-shu" id={`${id}-custom-hint`} role="alert">
                Enter six hexadecimal characters.
              </p>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
