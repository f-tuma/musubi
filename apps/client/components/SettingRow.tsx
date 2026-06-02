import { colors } from "@/constants/theme";
import { Feather } from "@expo/vector-icons";
import { useState } from "react";
import { Switch, View, Text, Pressable } from "react-native";
import { Mode } from "@musubi/calendar";


type ToggleProps = {
  label: string;
  toggle: boolean;
  onToggle: () => void;
  danger?: boolean;
}

type OptionsProps = {
  label: string;
  value: string;
  options: string[];
  onChange: (value: Mode) => void;
}

export function SettingRowToggle({ label, toggle, onToggle, danger }: ToggleProps) {


  return (
    <Pressable
      onPress={onToggle}
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderColor: colors.line,
        minHeight: 62,
      }}
    >
      <Text style={{ fontSize: 16, color: colors.fg2 }}>
        {label}
      </Text>
      <Switch
        style={{}}
        thumbColor={toggle ? colors.accent : colors.bg3}
        trackColor={{
          false: colors.line,
          true: colors.line3,
        }}
        onValueChange={onToggle}
        value={toggle}
      />
    </Pressable>
  );
}

export function SettingRowOptions({ label, value, options, onChange }: OptionsProps) {
  const [listVisible, setListVisible] = useState<boolean>(false);


  return (
    <View>
      <Pressable
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderColor: colors.line,
          minHeight: 62,
        }}
        onPress={() => setListVisible(listVisible ? false : true)}
      >
        <Text style={{ fontSize: 16, color: colors.fg2 }}>
          {label}
        </Text>
        <View
          style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
        >
          <Text style={{ fontSize: 16, color: colors.fg2 }}>
            {value[0].toUpperCase() + value.slice(1)}
          </Text>
          <Feather size={16} name={listVisible ? "chevron-down" : "chevron-right"} color={colors.fg3} />
        </View>
      </Pressable>
      {
        listVisible &&
        <View>
          {
            options?.map(o => (
              <Pressable
                key={o}
                onPress={() => {
                  onChange!(o as Mode);
                  setListVisible(false);
                }}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  borderBottomWidth: 1,
                  borderColor: colors.line,
                }}
              >
                <Text style={{ fontSize: 16, color: o === value ? colors.fg2 : colors.fg3 }}>
                  {o[0].toUpperCase() + o.slice(1)}
                </Text>
              </Pressable>
            ))
          }
        </View>
      }
    </View>
  );
}
