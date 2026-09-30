import type { Decorator, Preview } from "@storybook/tanstack-react";
import { useLayoutEffect, type ReactNode } from "react";
import { useFocusMode } from "../src/design/focus-mode";
import "../src/design/app.css";
import "./preview.css";

type ThemeFrameProps = {
  children: ReactNode;
  theme: "dark" | "light";
};

function ThemeFrame({ children, theme }: ThemeFrameProps) {
  useFocusMode();

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return <div className="sb-page">{children}</div>;
}

const withMusubiTheme: Decorator = (Story, context) => {
  const theme = context.globals.theme === "dark" ? "dark" : "light";

  return (
    <ThemeFrame theme={theme}>
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
