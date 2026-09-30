import type { Decorator, Preview } from "@storybook/tanstack-react";
import { useLayoutEffect, type ReactNode } from "react";
import { useFocusMode } from "../src/design/focus-mode";
import "../src/design/app.css";
import "./preview.css";

type ThemeFrameProps = {
  children: ReactNode;
  fullscreen: boolean;
  theme: "dark" | "light";
};

function ThemeFrame({ children, fullscreen, theme }: ThemeFrameProps) {
  useFocusMode();

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Fullscreen stories are whole pages and own their own layout.
  if (fullscreen) return <>{children}</>;
  return <div className="grid min-h-dvh place-items-center p-8">{children}</div>;
}

const withMusubiTheme: Decorator = (Story, context) => {
  const theme = context.globals.theme === "dark" ? "dark" : "light";

  return (
    <ThemeFrame fullscreen={context.parameters.layout === "fullscreen"} theme={theme}>
      <Story />
    </ThemeFrame>
  );
};

const preview: Preview = {
  decorators: [withMusubiTheme],
  globalTypes: {
    theme: {
      description: "Musubi component theme",
      toolbar: {
        dynamicTitle: true,
        icon: "paintbrush",
        items: [
          { title: "Light", value: "light" },
          { title: "Dark", value: "dark" },
        ],
        title: "Theme",
      },
    },
  },
  initialGlobals: {
    theme: "light",
  },
  parameters: {
    a11y: {
      test: "error",
    },
    chromatic: {
      pauseAnimationAtEnd: true,
      prefersReducedMotion: "reduce",
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    layout: "centered",
    options: {
      storySort: {
        order: ["Foundations", "Primitives", "Patterns", "Calendar", "Screens"],
      },
    },
  },
};

export default preview;
