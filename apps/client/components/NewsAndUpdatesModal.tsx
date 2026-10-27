import {
  announcementParagraphs,
  newestAnnouncementId,
  pendingAnnouncements,
  type Announcement,
} from "@musubi/types";
import Constants from "expo-constants";
import { useEffect, useState } from "react";
import { Linking, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Btn } from "@/components/ui/Btn";
import { ModalPortal } from "@/components/ui/ModalPortal";
import { colors, fonts, styles } from "@/constants/theme";
import { useApi } from "@/services/api";
import { queueSettingsPatch } from "@/services/settingsSync";

/** Co tenhle build je. Stejný zdroj jako UpdateRequiredModal. */
const buildVersion = Constants.expoConfig?.version ?? "0.0.0";

function Body({ body }: { body: string }) {
  return (
    <>
      {announcementParagraphs(body).map((segments, index) => (
        <Text
          key={index}
          style={{
            color: colors.fg2,
            fontFamily: fonts.sans,
            fontSize: 14,
            lineHeight: 22,
            marginTop: index === 0 ? 0 : 12,
          }}
        >
          {segments.map((segment, segmentIndex) =>
            segment.type === "link" ? (
              <Text
                accessibilityRole="link"
                key={segmentIndex}
                onPress={() => void Linking.openURL(segment.url)}
                style={{ color: colors.accent, textDecorationLine: "underline" }}
              >
                {segment.value}
              </Text>
            ) : (
              <Text key={segmentIndex}>{segment.value}</Text>
            ),
          )}
        </Text>
      ))}
    </>
  );
}

/**
 * Ukáže, co je nového — jednou.
 *
 * Server už odfiltroval, co uživatel viděl. `minVersion` dořeší tenhle build:
 * server neví, jaká verze se ho ptá. Co tady vypadne, zůstane nevyřízené a
 * vyskočí po aktualizaci ze storu.
 */
export default function NewsAndUpdatesModal() {
  const api = useApi();
  const insets = useSafeAreaInsets();
  const [pending, setPending] = useState<Announcement[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const data = await api.getAnnouncements();
        if (cancelled) return;

        // První pohled: nic se neukazuje, jen se posune značka. Bez toho by
        // nový účet (a v den nasazení každý stávající) dostal celou historii.
        if (data.markTo) {
          queueSettingsPatch(api, { lastSeenProjectNews: data.markTo, lastSeenAnnouncement: data.markTo });
          return;
        }

        const eligible = pendingAnnouncements(data.announcements, buildVersion);
        if (eligible.length === 0) return;
        setPending(eligible);
        setOpen(true);
      } catch {
        // Novinky nejsou důvod obtěžovat. Síťová chyba nezobrazí nic a nikde
        // nekřičí; příští spuštění to zkusí znovu.
      }
    })();

    return () => {
      cancelled = true;
    };
    // Jednou za spuštění appky. Zpráva, která dorazí uprostřed práce, počká na
    // příští start — vyskočit lidem pod rukama je horší než počkat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function close() {
    setOpen(false);
    const newest = newestAnnouncementId(pending);
    // Značka se posouvá jen na to, co se OPRAVDU ukázalo. `queueSettingsPatch`
    // si revizi řeší sám, takže se tu žádné baseRevision neshromažďuje.
    if (newest) queueSettingsPatch(api, { lastSeenProjectNews: newest, lastSeenAnnouncement: newest });
  }

  return (
    <ModalPortal onRequestClose={close} visible={open}>
      <View
        style={[
          styles.modalOverlay,
          {
            alignItems: "center",
            justifyContent: "center",
            padding: 32,
            paddingBottom: 32 + insets.bottom,
          },
        ]}
      >
        <View
          style={{
            backgroundColor: colors.bg2,
            borderColor: colors.line2,
            borderRadius: 16,
            borderWidth: 1,
            gap: 16,
            maxHeight: "80%",
            paddingBottom: 20,
            paddingHorizontal: 28,
            paddingTop: 28,
            width: "100%",
          }}
        >
          <Text
            style={{ color: colors.fg, fontFamily: fonts.serif, fontSize: 22 }}
          >
            News and updates
          </Text>

          <ScrollView>
            {pending.map((announcement, index) => (
              <View
                key={announcement.id}
                style={{ marginTop: index === 0 ? 0 : 20 }}
              >
                <Text
                  style={{
                    color: colors.fg,
                    fontFamily: fonts.sans,
                    fontSize: 16,
                    marginBottom: 6,
                  }}
                >
                  {announcement.title}
                </Text>
                <Body body={announcement.body} />
              </View>
            ))}
          </ScrollView>

          <Btn label="Got it" onPress={close} />
        </View>
      </View>
    </ModalPortal>
  );
}
