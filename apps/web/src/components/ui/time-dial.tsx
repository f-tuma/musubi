import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { Button } from "~/components/ui/button";

type Phase = "hour" | "minute";
type Props = {
  hour: number;
  minute: number;
  format: "12h" | "24h";
  phase: Phase;
  hours: number[];
  minutes: number[];
  onPhase: (phase: Phase) => void;
  onPreview: (hour: number, minute: number) => void;
  onChoose: (hour: number, minute: number) => void;
};

/** The face is drawn on a 260-unit grid; the outer ring sits at 104, the inner at 64. */
const OUTER_REACH = 104;
const INNER_REACH = 64;

/**
 * Both the painted hand and the mask that inverts the numbers under it share
 * these classes, so the text flips exactly where the pigment is, including
 * between ticks. Minutes follow the pointer directly while dragging.
 */
const handMotion =
  "origin-(--dial-center) transition-transform duration-fast ease-out group-data-[dragging]/clock:ease-in-out group-data-[phase=minute]/clock:group-data-[dragging]/clock:transition-none motion-reduce:transition-none";

function ClockFace({ angle, inner, dragging, phase, children }: { angle: number; inner: boolean; dragging: boolean; phase: Phase; children: ReactNode }) {
  const id = useId();
  const ref = useRef<SVGSVGElement>(null);
  const previous = useRef(angle);
  useLayoutEffect(() => {
    // Turn the short way round, so 55 → 0 minutes moves forward one tick.
    const delta = ((((angle - previous.current + 540) % 360) + 360) % 360) - 180;
    previous.current += delta;
    ref.current?.style.setProperty("--angle", `${previous.current}deg`);
  }, [angle]);
  const silhouette = (
    <g className={`rotate-(--angle) ${handMotion}`}>
      <rect x="129" y={130 - OUTER_REACH} width="2" height={OUTER_REACH} className={`scale-y-(--reach-scale) ${handMotion}`} />
      <circle cx="130" cy={130 - OUTER_REACH} r="16" className={`translate-y-(--reach-offset) ${handMotion}`} />
      <circle cx="130" cy="130" r="3" />
    </g>
  );
  return (
    <svg
      ref={ref}
      aria-hidden="true"
      className="group/clock pointer-events-none block size-full"
      data-dragging={dragging || undefined}
      data-phase={phase}
      style={
        {
          "--dial-center": "130px 130px",
          "--reach-offset": `${OUTER_REACH - (inner ? INNER_REACH : OUTER_REACH)}px`,
          "--reach-scale": (inner ? INNER_REACH : OUTER_REACH) / OUTER_REACH,
        } as CSSProperties
      }
      viewBox="0 0 260 260"
    >
      <defs>
        <mask id={`${id}-clip`} className="mask-type-alpha" height="260" maskUnits="userSpaceOnUse" width="260" x="0" y="0">
          {silhouette}
        </mask>
      </defs>
      <g key={`${phase}-base`} className="duration-fast animate-in fade-in-0 motion-reduce:animate-none">
        {children}
      </g>
      <g className="fill-primary">{silhouette}</g>
      <g data-contrast="" mask={`url(#${id}-clip)`}>
        <g key={`${phase}-contrast`} className="duration-fast animate-in fade-in-0 motion-reduce:animate-none">
          {children}
        </g>
      </g>
    </svg>
  );
}

/** Clock geometry is normalized to a 260px face, independent of zoom. */
export function dialValue(x: number, y: number, phase: Phase, format: Props["format"], hour: number) {
  const angle = ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
  if (phase === "minute") return Math.round(angle / 6) % 60;
  const tick = Math.round(angle / 30) % 12;
  if (format === "12h") return tick + (hour >= 12 ? 12 : 0);
  return Math.hypot(x, y) < 82 ? (tick === 0 ? 0 : tick + 12) : tick || 12;
}

/** A clock face for pointer and keyboard: the hour narrows, the minute decides. */
export function TimeDial({ hour, minute, format, phase, hours, minutes, onPhase, onPreview, onChoose }: Props) {
  const pointer = useRef<number | null>(null);
  const [dragAngle, setDragAngle] = useState<number | null>(null);
  const current = phase === "hour" ? hour : minute;
  const available = phase === "hour" ? hours : minutes;
  const inner = phase === "hour" && format === "24h" && (hour === 0 || hour > 12);
  const angle = dragAngle ?? (phase === "hour" ? (hour % 12) * 30 : minute * 6);
  const labels =
    phase === "hour"
      ? format === "24h"
        ? Array.from({ length: 24 }, (_, i) => i)
        : Array.from({ length: 12 }, (_, i) => i + (hour >= 12 ? 12 : 0))
      : Array.from({ length: 12 }, (_, i) => i * 5);

  function position(event: PointerEvent<HTMLDivElement>, finish = false) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left - rect.width / 2) * 260) / rect.width;
    const y = ((event.clientY - rect.top - rect.height / 2) * 260) / rect.height;
    if (Math.hypot(x, y) < 18) return false;
    const next = dialValue(x, y, phase, format, hour);
    if (!available.includes(next)) return false;
    setDragAngle(finish ? null : phase === "hour" ? (next % 12) * 30 : ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360);
    if (phase === "hour") {
      onPreview(next, minute);
      if (finish) onPhase("minute");
    } else if (finish) onChoose(hour, next);
    else onPreview(hour, next);
    return true;
  }

  return (
    <div data-slot="time-dial" className="p-2">
      <div className="mb-3 flex items-center justify-center gap-1 tabular-nums">
        <Button
          aria-label="Choose hour"
          aria-pressed={phase === "hour"}
          className="min-w-16 text-24"
          variant={phase === "hour" ? "secondary" : "ghost"}
          onClick={() => onPhase("hour")}
        >
          {String(format === "12h" ? hour % 12 || 12 : hour).padStart(2, "0")}
        </Button>
        <span aria-hidden="true" className="text-24 text-muted-foreground">
          :
        </span>
        <Button
          aria-label="Choose minute"
          aria-pressed={phase === "minute"}
          className="min-w-16 text-24"
          variant={phase === "minute" ? "secondary" : "ghost"}
          onClick={() => onPhase("minute")}
        >
          {String(minute).padStart(2, "0")}
        </Button>
      </div>
      <div
        aria-label={phase === "hour" ? "Hour dial" : "Minute dial"}
        aria-valuemax={available.length ? Math.max(...available) : 0}
        aria-valuemin={available.length ? Math.min(...available) : 0}
        aria-valuenow={current}
        aria-valuetext={`${String(current).padStart(2, "0")} ${phase === "hour" ? "hours" : "minutes"}`}
        className="relative mx-auto size-64 cursor-crosshair touch-none rounded-full bg-raised select-none"
        role="slider"
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0 || pointer.current !== null) return;
          event.preventDefault();
          event.currentTarget.focus();
          pointer.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
          position(event);
        }}
        onPointerMove={(event) => {
          if (pointer.current === event.pointerId) position(event);
        }}
        onPointerUp={(event) => {
          if (pointer.current !== event.pointerId) return;
          pointer.current = null;
          setDragAngle(null);
          position(event, true);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          pointer.current = null;
          setDragAngle(null);
        }}
        onLostPointerCapture={() => {
          pointer.current = null;
          setDragAngle(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (phase === "hour") onPhase("minute");
            else onChoose(hour, minute);
            return;
          }
          const direction = ["ArrowUp", "ArrowRight"].includes(event.key) ? 1 : ["ArrowDown", "ArrowLeft"].includes(event.key) ? -1 : 0;
          if (!direction && event.key !== "Home" && event.key !== "End") return;
          event.preventDefault();
          const next =
            event.key === "Home"
              ? available[0]
              : event.key === "End"
                ? available.at(-1)
                : available[(available.indexOf(current) + direction + available.length) % available.length];
          if (next !== undefined) onPreview(phase === "hour" ? next : hour, phase === "minute" ? next : minute);
        }}
      >
        <ClockFace angle={angle} dragging={dragAngle !== null} inner={inner} phase={phase}>
          {labels.map((number) => {
            const isInner = phase === "hour" && format === "24h" && (number === 0 || number > 12);
            const radians = (((phase === "hour" ? (number % 12) * 30 : number * 6) * Math.PI) / 180);
            const radius = isInner ? INNER_REACH : OUTER_REACH;
            return (
              <text
                key={number}
                className="fill-foreground text-13 tabular-nums in-data-[contrast]:fill-primary-foreground data-[disabled]:opacity-30"
                data-disabled={!available.includes(number) || undefined}
                dominantBaseline="central"
                textAnchor="middle"
                x={130 + Math.sin(radians) * radius}
                y={130 - Math.cos(radians) * radius}
              >
                {phase === "hour" && format === "12h" ? number % 12 || 12 : String(number).padStart(2, "0")}
              </text>
            );
          })}
        </ClockFace>
      </div>
      <p aria-live="polite" className="mt-3 text-center text-11 text-foreground-secondary">
        {phase === "hour" ? "Choose hour" : "Choose minute"}
      </p>
    </div>
  );
}
