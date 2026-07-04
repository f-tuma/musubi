import { memo, useEffect, useState } from "react";
import { colors, fonts } from "@/constants/theme";
import { View, ScrollView, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Tap } from "@/components/ui/Tap";
import { tap, thump } from "@/lib/haptics";
import { providerFlavor } from "@musubi/types";

type Calendar = { id: string; name: string; color: string; provider?: string | null; serverUrl?: string | null };

type Props = {
  calendars: Calendar[];
  activeCals: Set<string>;
  soloCalId: string | null;
  onToggle: (id: string) => void;
  onSolo: (id: string) => void;
};

export const CalendarFilterBar = memo(function CalendarFilterBar({
  calendars,
  activeCals,
  soloCalId,
  onToggle,
  onSolo,
}: Props) {
  // Optimistic local state so pills repaint before the expensive event
  // filtering pipeline catches up.
  const [display, setDisplay] = useState(() => new Set(activeCals));
  const [localSoloId, setLocalSoloId] = useState(soloCalId);

  // Sync from outside (initial load, solo from another tab, etc.)
  useEffect(() => { setDisplay(new Set(activeCals)); }, [activeCals]);
  useEffect(() => { setLocalSoloId(soloCalId); }, [soloCalId]);

  const handleToggle = (id: string) => {
    // Paint immediately
    setDisplay(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    tap();
    // Let the pill's paint commit this frame; run the store update (and the
    // filtering it triggers) on the next frame so the tap feels instant.
    // startTransition can't help here — zustand uses useSyncExternalStore,
    // whose updates are always urgent and can't be deferred by a transition.
    requestAnimationFrame(() => onToggle(id));
  };

  const handleSolo = (id: string) => {
    thump();
    const newSoloId = localSoloId === id ? null : id;
    setLocalSoloId(newSoloId);
    setDisplay(
      newSoloId === null
        ? new Set(calendars.map(c => c.id))
        : new Set([id]),
    );
    requestAnimationFrame(() => onSolo(id));
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{
        flexShrink: 0, flexDirection: "row",
        backgroundColor: colors.bg1,
        borderBottomWidth: 1, borderBottomColor: colors.line,
        maxHeight: 52,
      }}
      contentContainerStyle={{ padding: 10, gap: 6, alignItems: "center" }}
    >
      {calendars.map((cal) => {
        const active = display.has(cal.id);
        const soloed = localSoloId === cal.id;
        return (
          <Tap
            key={cal.id}
            haptic={false}
            onPress={() => handleToggle(cal.id)}
            onLongPress={() => handleSolo(cal.id)}
            delayLongPress={350}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              paddingHorizontal: 12, paddingVertical: 6,
              borderRadius: 999, borderCurve: 'continuous',
              borderWidth: soloed ? 1.5 : 1,
              borderColor: soloed
                ? colors.fg
                : active ? colors.line3 : colors.line,
              backgroundColor: active ? colors.bg2 : colors.line,
            }}
          >
            {cal.provider === "google" ? (
              <Ionicons name="logo-google" size={12} color={cal.color} style={{ opacity: active ? 1 : 0.5 }} />
            ) : providerFlavor(cal) === "apple" ? (
              <Ionicons name="logo-apple" size={13} color={cal.color} style={{ opacity: active ? 1 : 0.5 }} />
            ) : cal.provider === "caldav" ? (
              <Ionicons name="cloud" size={13} color={cal.color} style={{ opacity: active ? 1 : 0.5 }} />
            ) : (
              <View style={{
                width: 7, height: 7, borderRadius: 4,
                backgroundColor: cal.color,
                opacity: active ? 1 : 0.5,
              }} />
            )}
            <Text style={{
              fontFamily: fonts.sans, fontSize: 12,
              color: active ? colors.fg : colors.fg3,
            }}>
              {cal.name}
            </Text>
          </Tap>
        );
      })}
    </ScrollView>
  );
});
