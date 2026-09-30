import { MUSUBI_CALENDAR_COLORS } from "@musubi/types";
import { spacing, typeSizes } from "@musubi/design-system";
import type { Meta, StoryObj } from "@storybook/tanstack-react";
import type { CSSProperties, ReactNode } from "react";
import { getReadableEventTextColor } from "~/calendar/event-color";
import { DESKTOP_MODES, MOBILE_MODES } from "../../.storybook/modes";
import { SectionLabel } from "~/components/ui/section-label";
import { cn } from "~/lib/utils";

const SURFACE_TOKENS = [
  "--surface-canvas",
  "--surface-panel",
  "--surface-raised",
  "--surface-overlay",
] as const;

const TEXT_TOKENS = [
  "--text-primary",
  "--text-secondary",
  "--text-muted",
  "--text-faint",
] as const;

const ACTION_TOKENS = [
  "--accent-primary",
  "--accent-on-primary",
  "--control-fill",
  "--control-on-fill",
  "--draft-fill",
] as const;

const BORDER_TOKENS = [
  "--border-subtle",
  "--border-medium",
  "--border-strong",
] as const;

const TYPE_SCALE = Object.values(typeSizes);

const FONT_FAMILIES = [
  { label: "Interface", token: "--font-sans", sample: "Plan the week" },
  { label: "Editorial", token: "--font-serif", sample: "August 2026" },
  { label: "Kanji accent", token: "--font-kanji", sample: "結び" },
  { label: "Technical", token: "--font-mono", sample: "2026-08-01 09:30" },
] as const;

const SPACING_SCALE = Object.keys(spacing);

const RADIUS_TOKENS = [
  "--radius-sm",
  "--event-radius",
  "--radius-chip",
  "--radius-md",
  "--radius-control",
  "--radius-lg",
  "--radius-card",
  "--radius-sheet",
  "--radius-pill",
] as const;

const MOTION_TOKENS = [
  "--motion-fast",
  "--motion-standard",
  "--motion-slow",
] as const;

const DIMENSION_TOKENS = [
  "--compact-control-height",
  "--control-height",
  "--row-min-height",
] as const;

const BREAKPOINTS = [
  {
    description: "Overlay navigation, FAB, and sheet adaptations.",
    label: "Narrow",
    range: "≤599 px",
  },
  {
    description: "Compact navigation and constrained workspace chrome.",
    label: "Compact",
    range: "600–1023 px",
  },
  {
    description: "Permanent sidebar with compact desktop controls.",
    label: "Desktop",
    range: "1024–1439 px",
  },
  {
    description: "Full calendar shell and comfortable content rhythm.",
    label: "Wide",
    range: "≥1440 px",
  },
] as const;

type TokenStyle = CSSProperties & Record<`--story-${string}`, string>;

const card = "grid min-w-0 gap-1 overflow-hidden rounded-card border border-border-subtle bg-panel p-3";
const tokenName = "font-mono text-11 break-all text-foreground-secondary";

function Page({ children, title }: { children: ReactNode; title: string }) {
  return (
    <main className="mx-auto grid w-full max-w-wide gap-8 px-4 py-10 sm:px-8">
      <h1 className="font-serif text-26 font-normal text-foreground">{title}</h1>
      {children}
    </main>
  );
}

function Section({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="grid gap-4 border-t border-border-subtle pt-6">
      <SectionLabel>{title}</SectionLabel>
      {children}
    </section>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">{children}</div>;
}

function SwatchGrid({ tokens }: { tokens: readonly string[] }) {
  return (
    <Grid>
      {tokens.map((token) => (
        <article className={cn(card, "p-0")} key={token}>
          <div className="h-24 border-b border-border-subtle bg-(--story-token)" style={{ "--story-token": `var(${token})` } as TokenStyle} />
          <code className={cn(tokenName, "px-3 py-2")}>{token}</code>
        </article>
      ))}
    </Grid>
  );
}

function ColorsStory() {
  return (
    <Page title="Color and surfaces">
      <Section title="Surfaces">
        <SwatchGrid tokens={SURFACE_TOKENS} />
      </Section>
      <Section title="Text">
        <SwatchGrid tokens={TEXT_TOKENS} />
      </Section>
      <Section title="Actions and state">
        <SwatchGrid tokens={ACTION_TOKENS} />
      </Section>
      <Section title="Borders">
        <SwatchGrid tokens={BORDER_TOKENS} />
      </Section>
      <Section title="Calendar pigments">
        <Grid>
          {MUSUBI_CALENDAR_COLORS.map((color) => (
            <article
              className="grid min-h-32 content-between rounded-card bg-pigment p-3 text-(color:--story-foreground)"
              key={color.hex}
              style={{ "--pigment": color.hex, "--story-foreground": getReadableEventTextColor(color.hex) } as TokenStyle}
            >
              <strong className="font-medium">{color.name}</strong>
              <span className="font-mono text-11">{color.hex}</span>
            </article>
          ))}
        </Grid>
      </Section>
    </Page>
  );
}

function TypographyStory() {
  return (
    <Page title="Typography">
      <Section title="Families">
        <Grid>
          {FONT_FAMILIES.map((font) => (
            <article className={card} key={font.token}>
              <span className="font-mono text-11 text-muted-foreground">{font.label}</span>
              <p className="mt-2 font-(family-name:--story-font) text-19 leading-tight" style={{ "--story-font": `var(${font.token})` } as TokenStyle}>
                {font.sample}
              </p>
              <code className={tokenName}>{font.token}</code>
            </article>
          ))}
        </Grid>
      </Section>
      <Section title="Type scale">
        <Grid>
          {TYPE_SCALE.map((size) => {
            const token = `--text-${size}`;
            return (
              <article className={card} key={token}>
                <p className="mt-2 text-(length:--story-size) leading-tight" style={{ "--story-size": `var(${token})` } as TokenStyle}>
                  Week planning
                </p>
                <code className={tokenName}>{token}</code>
              </article>
            );
          })}
        </Grid>
      </Section>
    </Page>
  );
}

function Metric({ children, token }: { children: ReactNode; token: string }) {
  return (
    <article className={card}>
      <div className="flex min-h-control items-center gap-3">
        {children}
        <code className={tokenName}>{token}</code>
      </div>
    </article>
  );
}

function SpacingStory() {
  return (
    <Page title="Spacing and geometry">
      <Section title="Spacing">
        <Grid>
          {SPACING_SCALE.map((step) => {
            const token = `--space-${step}`;
            return (
              <Metric key={token} token={token}>
                <span className="h-3 w-(--story-size) min-w-px rounded-full bg-primary" style={{ "--story-size": `var(${token})` } as TokenStyle} />
              </Metric>
            );
          })}
        </Grid>
      </Section>
      <Section title="Radii">
        <Grid>
          {RADIUS_TOKENS.map((token) => (
            <Metric key={token} token={token}>
              <span
                className="size-16 flex-none rounded-(--story-radius) border border-border-strong bg-raised"
                style={{ "--story-radius": `var(${token})` } as TokenStyle}
              />
            </Metric>
          ))}
        </Grid>
      </Section>
      <Section title="Control geometry">
        <Grid>
          {DIMENSION_TOKENS.map((token) => (
            <Metric key={token} token={token}>
              <span className="h-(--story-size) w-6 flex-none rounded-control bg-primary" style={{ "--story-size": `var(${token})` } as TokenStyle} />
            </Metric>
          ))}
        </Grid>
      </Section>
      <Section title="Elevation">
        <div className="h-24 w-full rounded-card bg-overlay shadow-overlay" />
      </Section>
    </Page>
  );
}

function MotionStory() {
  return (
    <Page title="Motion">
      <Section title="Duration scale">
        <Grid>
          {MOTION_TOKENS.map((token) => (
            <article className={card} key={token}>
              <div
                aria-label={`${token} sample`}
                className="group/motion grid min-h-20 place-items-center rounded-card border border-border-subtle bg-canvas"
                role="img"
                style={{ "--story-duration": `var(${token})` } as TokenStyle}
                tabIndex={0}
              >
                <span className="size-7 rounded-full bg-primary transition-transform duration-(--story-duration) group-hover/motion:translate-x-7 group-focus-visible/motion:translate-x-7" />
              </div>
              <code className={tokenName}>{token}</code>
            </article>
          ))}
        </Grid>
      </Section>
    </Page>
  );
}

function ResponsiveStory() {
  return (
    <Page title="Responsive contract">
      <Section title="Breakpoint ladder">
        <Grid>
          {BREAKPOINTS.map((breakpoint) => (
            <article className={cn(card, "min-h-32 content-start")} key={breakpoint.label}>
              <span className="font-mono text-11 text-shu">{breakpoint.range}</span>
              <strong className="font-serif text-19 font-normal text-foreground">{breakpoint.label}</strong>
              <p className="text-13 leading-normal text-muted-foreground">{breakpoint.description}</p>
            </article>
          ))}
        </Grid>
      </Section>
    </Page>
  );
}

const meta = {
  parameters: {
    layout: "fullscreen",
  },
  title: "Design system/Foundations",
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Colors: Story = {
  parameters: {
    chromatic: {
      modes: { ...DESKTOP_MODES, ...MOBILE_MODES },
    },
  },
  render: () => <ColorsStory />,
};
export const Typography: Story = { render: () => <TypographyStory /> };
export const SpacingAndShape: Story = { render: () => <SpacingStory /> };
export const Motion: Story = { render: () => <MotionStory /> };
export const Responsive: Story = { render: () => <ResponsiveStory /> };
