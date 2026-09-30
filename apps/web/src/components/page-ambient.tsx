/** The faint 結 behind full-page states. Decoration only; it never carries meaning. */
export function PageAmbient() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -right-2 -bottom-40 -z-10 font-kanji text-ambient leading-none text-foreground opacity-3 select-none"
    >
      結
    </span>
  );
}
