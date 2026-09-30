import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { DESKTOP_MODES, MOBILE_MODES } from "../../.storybook/modes";
import { AuthForm, AuthHint, AuthProviders, AuthShell, AuthSubmit, AuthSwitch, StepDots } from "~/components/auth-shell";
import { ProviderGlyph } from "~/components/provider-glyph";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";

const meta = {
  title: "Pages/Auth shell",
  component: AuthShell,
  parameters: { layout: "fullscreen", chromatic: { modes: { ...DESKTOP_MODES, ...MOBILE_MODES } } },
} satisfies Meta<typeof AuthShell>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignIn: Story = {
  args: {
    title: "Sign in",
    children: (
      <AuthForm noValidate>
        <Field label="Email">
          <Input placeholder="you@example.com" type="email" />
        </Field>
        <Field label="Passphrase">
          <Input placeholder="At least 8 characters" type="password" />
        </Field>
        <AuthHint>
          <Button variant="link">Forgot passphrase?</Button>
        </AuthHint>
        <AuthSubmit type="submit">Continue</AuthSubmit>
      </AuthForm>
    ),
    aside: (
      <AuthProviders>
        <Button variant="secondary">
          <ProviderGlyph provider="google" />
          Continue with Google
        </Button>
        <Button variant="secondary">
          <ProviderGlyph provider="microsoft" />
          Continue with Microsoft
        </Button>
      </AuthProviders>
    ),
    footer: (
      <AuthSwitch action="Create one" onAction={() => undefined}>
        New to this server?
      </AuthSwitch>
    ),
  },
};

export const OnboardingStep: Story = {
  args: {
    progress: <StepDots step={2} total={3} />,
    title: "Your calendar",
    children: (
      <form className="flex min-h-64 flex-col gap-5">
        <Field label="Calendar name">
          <Input defaultValue="Personal" />
        </Field>
        <div className="mt-auto flex items-center justify-between gap-3 pt-2">
          <Button variant="ghost">Back</Button>
          <Button type="submit">Continue</Button>
        </div>
      </form>
    ),
  },
};
