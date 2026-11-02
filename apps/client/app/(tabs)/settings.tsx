import EventDeliveryModal from "@/components/calendar/EventDeliveryModal";
import {
  SettingRowAction,
  SettingRowOptions,
  SettingRowToggle,
} from "@/components/SettingRow";
import InputModal from "@/components/TextInputModal";
import { colors, fonts, styles } from "@/constants/theme";
import {
  allDayValue,
  CalendarView,
  DEFAULT_NOTIFICATION_EMAILS,
  DEFAULT_REMINDER_RULE,
  NotificationEmails,
  optionsFor,
  ReminderRule,
  SettingsPatch,
  isSilentRule,
  timedValue,
  withAllDay,
  withTimed,
} from "@musubi/types";
import { useServer } from "@/contexts/ServerContext";
import { useApi } from "@/services/api";
import { useSettingsStore } from "@/store/useSettingsStore";
import { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Share,
  StyleSheet,
  Linking,
  Platform,
} from "react-native";
import { useRefreshData } from "@/hooks/useRefreshData";
import { Btn } from "@/components/ui/Btn";
import { Tap } from "@/components/ui/Tap";
import { success, warn } from "@/lib/haptics";
import { Avatar } from "@/components/Avatar";
import { pickAvatarBase64 } from "@/lib/avatar";
import { Feather } from "@expo/vector-icons";
import { signOutAndReset } from "@/lib/signOut";
import { showToast } from "@/components/ui/Toast";
import { fetchWithTimeout, userFacingError } from "@/lib/network";
import Constants from "expo-constants";
import { queueSettingsPatch } from "@/services/settingsSync";
import { getServerDiagnostics } from "@/lib/serverDiagnostics";
import { requestEventNotificationPermission } from "@/services/notifications";
import { buildReport, collectDebugSnapshot } from "@/services/debugReport";
import {
  developerModeEnabled,
  setDeveloperMode,
} from "@/services/developerMode";
import { registerTap, type TapState } from "@/lib/developerMode";
import { formatChecks, summarise } from "@/lib/healthChecks";
import { router } from "expo-router";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { OptionPicker, type PickerOption } from "@/components/ui/OptionPicker";

const SUPPORT_EMAIL = "hello@f-tuma.dev";
const FEEDBACK_URL = "https://feedback.musubi.pro/";
const KOFI_URL = "https://ko-fi.com/frgtn";
const PRIVACY_URL = "https://musubi.pro/privacy/";
const TERMS_URL = "https://musubi.pro/terms/";

/** What the row shows on the right: whatever is stored, in the shared wording. */
function reminderLabel(rule: ReminderRule, kind: "allDay" | "timed") {
  const value = kind === "timed" ? timedValue(rule) : allDayValue(rule);
  return (
    optionsFor(rule, kind).find((option) => option.value === value)?.label ??
    "Off"
  );
}

export default function SettingsTab() {
  const [deliveryVisible, setDeliveryVisible] = useState(false);
  const api = useApi();
  const { authClient, apiUrl } = useServer();
  const calendars = useCalendarsStore((state) => state.calendars);
  const settingsDocument = useSettingsStore((state) => state.settingsDocument);
  const [picker, setPicker] = useState<{
    apply: (value: string) => void;
    choices: PickerOption[];
    title: string;
    value: string;
  } | null>(null);
  const {
    defaultCalendarView,
    setDefaultCalendarView,
    weekStartsOn,
    setWeekStartsOn,
    timeFormat,
    setTimeFormat,
    dateFormat,
    setDateFormat,
    theme,
    setTheme,
    tabBarLabels,
    setTabBarLabels,
  } = useSettingsStore();

  const [confrimDeleteVisible, setConfirmDeleteVisible] = useState(false);
  // In-app deletion is email-confirmed, so it needs the server to send email.
  // Assume it can until told otherwise (old servers omit the flag).
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [emailModalVisible, setEmailModalVisible] = useState(false);
  useEffect(() => {
    if (!apiUrl) return;
    fetchWithTimeout(`${apiUrl}/api/v1/server`)
      .then((r) => r.json())
      .then(({ email }) => setEmailEnabled(email !== false))
      .catch(() => {});
  }, [apiUrl]);
  const [nameModalVisible, setNameModalVisible] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const userSession = authClient.useSession();
  const appVersion =
    Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? "unknown";
  const appBuild =
    Constants.nativeBuildVersion ??
    String(
      Platform.OS === "android"
        ? (Constants.expoConfig?.android?.versionCode ?? "dev")
        : "dev",
    );

  const openExternal = async (url: string, fallback: string) => {
    try {
      await Linking.openURL(url);
    } catch (error) {
      warn();
      console.warn("Could not open external link:", error);
      showToast({ message: fallback });
    }
  };

  /**
   * Hand the whole report to the share sheet.
   *
   * It used to be a `mailto:` with the diagnostics in the body, and a body is
   * part of a URL — clients truncate long ones without saying so, which is the
   * worst possible failure for a bug report: it arrives, it looks complete, and
   * the half that named the problem is gone.
   *
   * The share sheet has no length limit, shows the person exactly what they are
   * sending before it leaves the device, and lets them pick where it goes. Mail
   * is still one of those choices, with our address offered below it.
   *
   * The check verdicts lead, because they are the part that says which of the
   * silent failures this is.
   */
  const openProblemReport = async () => {
    const snapshot = await collectDebugSnapshot({
      apiUrl,
      getSession: () => authClient.getSession(),
    }).catch(() => null);

    const report = [
      "What happened, and what did you expect instead?",
      "",
      "",
      "---",
      ...(snapshot
        ? [
            `Checks: ${summarise(snapshot.checks)}`,
            "",
            formatChecks(snapshot.checks),
            "",
            buildReport(snapshot),
          ]
        : [
            // A report that cannot be filed because the checks failed is worse
            // than one without them.
            "Checks: could not be run.",
            `Musubi ${appVersion} (${appBuild})`,
            `${Platform.OS} ${String(Platform.Version)}`,
            `Server: ${apiUrl ?? "unknown"}`,
            "Requests:",
            getServerDiagnostics(),
          ]),
      "",
      `Calendars: ${calendars.length}`,
      ...calendars.map(
        (calendar) =>
          `- ${calendar.name}: ${calendar.serverUrl ?? "home"} (${calendar.provider ?? "musubi"})`,
      ),
      "",
      `Send to ${SUPPORT_EMAIL}`,
    ].join("\n");

    try {
      await Share.share({ message: report, title: "Musubi problem report" });
    } catch {
      warn();
      showToast({
        message: `Could not open sharing. Email us at ${SUPPORT_EMAIL}.`,
      });
    }
  };

  const changeAvatar = async () => {
    setAvatarBusy(true);
    try {
      const base64 = await pickAvatarBase64();
      if (!base64) return; // cancelled
      const url = await api.uploadAvatar(base64);
      await authClient.updateUser({ image: url });
      success();
    } catch (e) {
      warn();
      console.error("Avatar upload failed:", e);
      showToast({
        message: userFacingError(e, "Could not update your photo."),
      });
    } finally {
      setAvatarBusy(false);
    }
  };

  const changeName = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === userSession.data?.user.name) return;
    try {
      await authClient.updateUser({ name: trimmed });
      success();
    } catch (e) {
      warn();
      console.error("Name update failed:", e);
      showToast({ message: userFacingError(e, "Could not update your name.") });
    }
  };

  const changeEmail = async (value: string) => {
    const next = value.trim().toLowerCase();
    const current = userSession.data?.user.email;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) {
      showToast({ message: "That does not look like an email address." });
      return;
    }
    if (!current || next === current.toLowerCase()) return;
    try {
      const { error } = await authClient.changeEmail({ newEmail: next });
      if (error) throw new Error(error.message);
      success();
      // Which inbox to check is the whole answer. A verified address approves
      // the move itself, so a stolen session cannot take the account somewhere
      // its owner can no longer reach; an unverified one proves the new address
      // instead. The wording never says whether the new address already exists —
      // the server answers the same either way, on purpose.
      showToast({
        message: userSession.data?.user.emailVerified
          ? `Check ${current} — approve the change from there.`
          : `Check ${next} for a link to confirm the new address.`,
      });
    } catch (e) {
      warn();
      console.error("Email change failed:", e);
      showToast({
        message: userFacingError(e, "Could not start the email change."),
      });
    }
  };

  const refresh = useRefreshData();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async function runRefresh() {
    setRefreshing(true);
    try {
      await refresh();
    } catch (e) {
      console.error(e);
      showToast({
        message: userFacingError(e, "Could not refresh settings."),
        actionLabel: "Retry",
        onAction: () =>
          setTimeout(() => {
            void runRefresh();
          }, 320),
      });
    } finally {
      setRefreshing(false);
    }
  };

  // Autosave: settings persist the moment they change — no Save button to forget.
  // `patch` carries the just-changed value (store reads here would be stale).
  // The bottom of the reminder chain is always a concrete rule, so an account
  // whose settings predate the field still gives the pills something to show.
  const defaultReminder =
    settingsDocument?.value.defaultReminder ?? DEFAULT_REMINDER_RULE;

  const notificationEmails =
    settingsDocument?.value.notificationEmails ?? DEFAULT_NOTIFICATION_EMAILS;

  const saveNotificationEmails = (patch: Partial<NotificationEmails>) => {
    save({ notificationEmails: { ...notificationEmails, ...patch } });
  };

  /**
   * Open the picker for one reminder row.
   *
   * A row of pills only holds three choices before it squashes, and reminders
   * have more — plus one extra whenever a rule set on another device has no
   * button here. So `SettingRowAction` shows what is set and this opens the
   * list, in the app's own dressing rather than a platform sheet.
   */
  const pickReminder = (
    title: string,
    choices: PickerOption[],
    value: string,
    apply: (next: string) => void,
  ) => {
    setPicker({ apply, choices, title, value });
  };

  /**
   * Save the rule, and make sure the OS will actually let it ring.
   *
   * Permission used to be asked for in exactly one place — saving an event with
   * a reminder in the event form. Someone who set their reminders here and
   * never opened that form was never asked, so every reminder this rule
   * produced was scheduled, recorded, and then dropped by the OS in silence.
   *
   * Setting a rule is the honest moment to ask: it is the user saying they want
   * to be reminded. A silent rule asks for nothing, because it will never ring.
   */
  const saveDefaultReminder = (rule: ReminderRule) => {
    save({ defaultReminder: rule });
    if (isSilentRule(rule)) return;
    void requestEventNotificationPermission().then((granted) => {
      if (granted) return;
      showToast({
        message:
          "Reminders are saved, but this device blocks notifications for Musubi. Turn them on in system settings.",
      });
    });
  };

  /**
   * Ten taps on the version row show the diagnostics row; ten more hide it.
   *
   * A toggle rather than a shortcut straight into the screen, because the
   * screen is somewhere you go back to — once a report is being gathered, the
   * gesture stops being a way in and starts being an obstacle. Hidden by
   * default all the same: a "Diagnostics" row in a calendar app is a row every
   * user has to read past forever, for a screen almost none of them want.
   *
   * Read synchronously from the local blob so the row is already in its right
   * state on the first frame.
   */
  const [developer, setDeveloper] = useState(developerModeEnabled);
  const taps = useRef<TapState>({ count: 0, lastAt: 0 });

  const tapVersion = () => {
    const next = registerTap(taps.current, Date.now(), developer);
    taps.current = { count: next.count, lastAt: next.lastAt };
    if (next.toggled === null) return;

    success();
    setDeveloper(next.toggled);
    void setDeveloperMode(next.toggled).catch((e) => {
      console.warn("Developer mode could not be saved:", e);
    });
    showToast({
      message: next.toggled
        ? "Developer mode on. Diagnostics is below."
        : "Developer mode off.",
    });
  };

  const save = (patch: SettingsPatch) => {
    queueSettingsPatch(api, patch).catch((e) => {
      warn();
      console.error("Settings save failed:", e);
      showToast({
        message: userFacingError(e, "This setting could not be saved."),
      });
    });
  };

  const handleSignOut = () => signOutAndReset(authClient);

  const handleUserDelete = async () => {
    // Deletion is confirmed by email: this authenticated request only triggers
    // the confirmation link. The account is removed when the user opens it, so
    // we keep them signed in until then rather than claiming it's already gone.
    try {
      await api.deleteUser();
    } catch (error) {
      warn();
      throw new Error(
        userFacingError(error, "Your account could not be deleted."),
      );
    }

    success();
    showToast({
      message:
        "Check your email — open the link we sent to permanently delete your account.",
    });
  };

  const testDeleteConfirm = async (v: string) => {
    if (v === userSession.data?.user.name!) {
      return { ok: true, error: "" };
    }
    return { ok: false, error: "Name does not match..." };
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.screenTitle}>Settings</Text>
      </View>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {/* Who you are — tap the avatar to change the photo, tap the name to rename. */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 14,
            padding: 20,
            borderBottomWidth: 1,
            borderColor: colors.line,
          }}
        >
          <Tap
            onPress={changeAvatar}
            disabled={avatarBusy}
            scaleTo={0.95}
            accessibilityLabel="Change profile photo"
          >
            <View style={{ opacity: avatarBusy ? 0.5 : 1 }}>
              <Avatar
                name={userSession.data?.user.name ?? "?"}
                image={userSession.data?.user.image}
                size={52}
              />
              <View
                style={{
                  position: "absolute",
                  right: -3,
                  bottom: -3,
                  width: 20,
                  height: 20,
                  borderRadius: 10,
                  backgroundColor: colors.fill,
                  alignItems: "center",
                  justifyContent: "center",
                  borderWidth: 2,
                  borderColor: colors.bg1,
                }}
              >
                <Feather name="camera" size={10} color={colors.onFill} />
              </View>
            </View>
          </Tap>
          <Tap
            onPress={() => setNameModalVisible(true)}
            scaleTo={1}
            style={{ flex: 1, gap: 2 }}
            accessibilityLabel={`Change display name. Current name ${userSession.data?.user.name ?? "unknown"}`}
          >
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
            >
              <Text
                style={{
                  fontFamily: fonts.serif,
                  fontSize: 19,
                  color: colors.fg,
                }}
              >
                {userSession.data?.user.name}
              </Text>
              <Feather name="edit-2" size={12} color={colors.fg4} />
            </View>
            <Text
              style={{
                fontFamily: fonts.sans,
                fontSize: 12,
                color: colors.fg3,
              }}
            >
              {userSession.data?.user.email}
            </Text>
            <Text
              style={{
                fontFamily: fonts.sans,
                fontSize: 11,
                color: colors.fg4,
              }}
            >
              {apiUrl?.slice(8)}
            </Text>
          </Tap>
        </View>

        <Text style={[styles.sectionLabel, local.sectionHeading]}>
          Appearance
        </Text>
        <SettingRowOptions
          label="Theme"
          value={theme}
          options={["system", "dark", "light"]}
          onChange={(v) => {
            setTheme(v as "system" | "dark" | "light");
            save({ theme: v as "system" | "dark" | "light" });
          }}
        />
        <SettingRowToggle
          label="Tab Labels"
          toggle={tabBarLabels}
          onToggle={() => {
            setTabBarLabels(!tabBarLabels);
            save({ tabBarLabels: !tabBarLabels });
          }}
        />
        <SettingRowOptions
          label="Default View"
          value={defaultCalendarView}
          options={["day", "week", "month", "schedule"]}
          labels={{ schedule: "Agenda" }}
          onChange={(v) => {
            const next = v as CalendarView;
            setDefaultCalendarView(next);
            save({ defaultCalendarView: next });
          }}
        />
        <SettingRowOptions
          label="Week Starts on"
          value={weekStartsOn}
          options={["sunday", "monday"]}
          onChange={(v) => {
            setWeekStartsOn(v as "monday" | "sunday");
            save({ weekStartsOn: v as "monday" | "sunday" });
          }}
        />
        <SettingRowOptions
          label="Time Format"
          value={timeFormat}
          options={["24h", "12h"]}
          onChange={(v) => {
            setTimeFormat(v as "12h" | "24h");
            save({ timeFormat: v as "12h" | "24h" });
          }}
        />
        <SettingRowOptions
          label="Date Format"
          value={dateFormat}
          options={["dmy", "mdy", "ymd"]}
          labels={{ dmy: "D/M/Y", mdy: "M/D/Y", ymd: "Y-M-D" }}
          onChange={(v) => {
            setDateFormat(v as "dmy" | "mdy" | "ymd");
            save({ dateFormat: v as "dmy" | "mdy" | "ymd" });
          }}
        />

        <Text style={[styles.sectionLabel, local.sectionHeading]}>
          Reminders
        </Text>
        <SettingRowAction
          label="Timed Events"
          detail="Meetings and anything with a time"
          value={reminderLabel(defaultReminder, "timed")}
          onPress={() =>
            pickReminder(
              "Timed events",
              optionsFor(defaultReminder, "timed"),
              timedValue(defaultReminder),
              (value) => saveDefaultReminder(withTimed(defaultReminder, value)),
            )
          }
        />
        <SettingRowAction
          label="All-day Events"
          detail="Birthdays, holidays, anything without a time"
          value={reminderLabel(defaultReminder, "allDay")}
          onPress={() =>
            pickReminder(
              "All-day events",
              optionsFor(defaultReminder, "allDay"),
              allDayValue(defaultReminder),
              (value) =>
                saveDefaultReminder(withAllDay(defaultReminder, value)),
            )
          }
        />

        <Text style={[styles.sectionLabel, local.sectionHeading]}>
          Email Me When
        </Text>
        <SettingRowToggle
          label="An Event Moves or Is Cancelled"
          toggle={notificationEmails.eventChanged}
          onToggle={() =>
            saveNotificationEmails({
              eventChanged: !notificationEmails.eventChanged,
            })
          }
        />

        <Text style={[styles.sectionLabel, local.sectionHeading]}>
          Help & About
        </Text>
        <SettingRowAction
          label="Feedback & Roadmap"
          detail="Suggest ideas, vote, and see what is planned"
          external
          onPress={() =>
            void openExternal(
              FEEDBACK_URL,
              "Feedback is available at feedback.musubi.pro.",
            )
          }
        />
        <SettingRowAction
          label="Report a Problem"
          detail="Shows you the diagnostics, then you choose where to send them"
          onPress={() => void openProblemReport()}
        />
        <SettingRowAction
          label="Support Us"
          detail="Buy us a coffee on Ko-fi"
          external
          onPress={() =>
            void openExternal(KOFI_URL, "Support us at ko-fi.com/frgtn.")
          }
        />
        <SettingRowAction
          label="Privacy Policy"
          external
          onPress={() =>
            void openExternal(
              PRIVACY_URL,
              "Privacy policy is available at musubi.pro/privacy.",
            )
          }
        />
        <SettingRowAction
          label="Terms of Service"
          external
          onPress={() =>
            void openExternal(
              TERMS_URL,
              "Terms are available at musubi.pro/terms.",
            )
          }
        />
        <SettingRowAction
          label="Version"
          value={`${appVersion} (${appBuild})`}
          onPress={tapVersion}
          secret
        />
        {developer ? (
          <SettingRowAction
            label="Diagnostics"
            detail="Checks this device, this server, and reminder delivery"
            onPress={() => router.push("/debug")}
          />
        ) : null}

        <Text style={[styles.sectionLabel, local.sectionHeading]}>Sync & delivery</Text>
        <SettingRowAction label="Delivery status" detail="All pending deliveries, failures, and provider confirmations" onPress={() => setDeliveryVisible(true)} />

        <Text style={[styles.sectionLabel, local.sectionHeading]}>Account</Text>
        <View style={{ paddingHorizontal: 16, paddingBottom: 32, gap: 10 }}>
          <Btn
            label="Change Email"
            variant="secondary"
            onPress={() =>
              emailEnabled
                ? setEmailModalVisible(true)
                : showToast({
                    message:
                      "This server can't send email, so a change can't be confirmed here. Ask your server's administrator.",
                  })
            }
          />
          <Btn label="Sign Out" variant="secondary" onPress={handleSignOut} />
          <Btn
            label="Delete Account"
            variant="destructive"
            onPress={() =>
              emailEnabled
                ? setConfirmDeleteVisible(true)
                : showToast({
                    message:
                      "This server can't send email, so deletion can't be confirmed here. Ask your server's administrator to remove your account.",
                  })
            }
          />
        </View>
      </ScrollView>
      <EventDeliveryModal visible={deliveryVisible} onClose={() => setDeliveryVisible(false)} />
      <InputModal
        visible={emailModalVisible}
        title="New email address"
        placeholder={userSession.data?.user.email ?? "you@example.com"}
        onClose={() => setEmailModalVisible(false)}
        onConfirm={changeEmail}
      />
      <InputModal
        visible={nameModalVisible}
        title="Display name"
        placeholder={userSession.data?.user.name ?? "Your name"}
        onClose={() => setNameModalVisible(false)}
        onConfirm={changeName}
      />
      <InputModal
        visible={confrimDeleteVisible}
        isDelete
        title="Type your exact display name to delete your account"
        placeholder={userSession.data?.user.name!}
        onClose={() => setConfirmDeleteVisible(false)}
        onTest={(value) => testDeleteConfirm(value)}
        onConfirm={handleUserDelete}
      />
      <OptionPicker
        visible={picker !== null}
        title={picker?.title ?? ""}
        options={picker?.choices ?? []}
        value={picker?.value}
        onSelect={(value) => picker?.apply(value)}
        onClose={() => setPicker(null)}
      />
    </View>
  );
}

const local = StyleSheet.create({
  sectionHeading: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 8,
  },
});
