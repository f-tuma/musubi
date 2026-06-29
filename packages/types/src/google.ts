import { z } from "zod";

export const GoogleCheck = z.object({
  isLinked: z.boolean(),
  calendarConnected: z.boolean(),
});

export type GoogleCheck = z.infer<typeof GoogleCheck>;
