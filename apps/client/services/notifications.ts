import * as Notifications from "expo-notifications";
import { Platform } from 'react-native';
import { db } from "./db";
import { notificationsTable } from "@/db/schema";
import { eq } from "drizzle-orm";
// import Constants from 'expo-constants';


Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function scheduleEventPushNotification(title: string, body: string, date: Date) {
  const identifier = await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date,
    },
  });

  return identifier;
}

export async function registerForPushNotificationsAsync() {
  // let token;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("musubiChannel", {
      name: "Musubi Notifications",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#FF231F7C",
    });
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (finalStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== "granted") {
    alert("Failed to get push token for push notification!");
    return;

  }

  // try {
  //   const projectId =
  //     Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
  //   if (!projectId) {
  //     throw new Error('Project ID not found');
  //   }
  //   token = (
  //     await Notifications.getExpoPushTokenAsync({
  //       projectId,
  //     })
  //   ).data;
  //   console.log(token);
  // } catch (e) {
  //   console.error(`${e}`);
  // }
}


export async function storeNotification(identifier: string, eventID: string, triggerDate: Date) {
  db.insert(notificationsTable).values({
    identifier,
    eventID,
    trigerDate: String(triggerDate),
  })
}

export async function updateNotificationTriggerDate(eventID: string, trigerDate: string) {
  db.update(notificationsTable).set({ trigerDate }).where(eq(notificationsTable.eventID, eventID));
}

export async function getEventsNotificationIdentifier(eventID: string) {
  const result = await db
    .select({ identifier: notificationsTable.identifier })
    .from(notificationsTable)
    .where(eq(notificationsTable.eventID, eventID))
    .limit(1);

  return result[0]?.identifier ?? null;
}
