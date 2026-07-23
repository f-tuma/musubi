import { colors, fonts } from "@/constants/theme";
import { Tap } from "@/components/ui/Tap";
import { Feather } from "@expo/vector-icons";
import { ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";

type CalMode = "day" | "week" | "month";

type Props = {
  mode: string;                       // current mode (checkmark)
  onChange: (m: CalMode) => void;
  /** The tap target — gets the open state for the chevron. */
  trigger: (open: boolean) => ReactNode;
};

// Musubi-style view switcher: the trigger opens a small paper card with
// Day/Week/Month. Parent must sit above its siblings (zIndex) so the card
// isn't buried under whatever renders below.
export function ModeSwitch({ mode, onChange, trigger }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <View>
      <Tap
        onPress={() => setOpen(o => !o)}
        scaleTo={0.98}
        style={{ minHeight: 44, justifyContent: "center" }}
        accessibilityLabel={`Calendar view, ${mode}`}
        accessibilityHint="Opens the day, week, and month view choices"
        accessibilityState={{ expanded: open }}
      >
        {trigger(open)}
      </Tap>

      {open && (
        <>
          {/* invisible backdrop — tap anywhere else to close */}
          <Pressable
            onPress={() => setOpen(false)}
            accessible={false}
            style={{ position: "absolute", top: -200, left: -1000, width: 4000, height: 4000 }}
          />
          <Animated.View
            entering={FadeInDown.duration(150)}
            exiting={FadeOut.duration(100)}
            style={{
              position: "absolute", top: 40, left: 0, minWidth: 150,
              backgroundColor: colors.bg1,
              borderWidth: 1, borderColor: colors.line2,
              borderRadius: 14, borderCurve: "continuous",
              paddingVertical: 6,
              shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 16, shadowOffset: { width: 0, height: 6 },
              elevation: 8,
            }}
          >
            {(["day", "week", "month"] as CalMode[]).map(m => (
              <Tap
                key={m}
                onPress={() => { setOpen(false); onChange(m); }}
                accessibilityRole="radio"
                accessibilityLabel={`${m} view`}
                accessibilityState={{ checked: m === mode }}
                style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 11 }}
              >
                <Text style={{
                  fontFamily: m === mode ? fonts.sansMedium : fonts.sans,
                  fontSize: 14, color: m === mode ? colors.fg : colors.fg2,
                }}>
                  {m.charAt(0).toUpperCase() + m.slice(1)}
                </Text>
                {m === mode && <Feather name="check" size={14} color={colors.accent} />}
              </Tap>
            ))}
          </Animated.View>
        </>
      )}
    </View>
  );
}
