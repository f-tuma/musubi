import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";
import { getAppliedTheme, subscribeToTheme, toggleTheme, type AppliedTheme } from "~/design/theme";

export function ThemeToggleButton({ theme, onToggle }: { theme: AppliedTheme; onToggle: () => void }) {
  const label = `Use ${theme === "dark" ? "light" : "dark"} theme`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button aria-label={label} size="icon" variant="ghost" onClick={onToggle}>
            {theme === "dark" ? (
              <Sun aria-hidden="true" strokeWidth={1.6} />
            ) : (
              <Moon aria-hidden="true" strokeWidth={1.6} />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeToTheme, getAppliedTheme, (): AppliedTheme => "light");

  return <ThemeToggleButton theme={theme} onToggle={toggleTheme} />;
}
