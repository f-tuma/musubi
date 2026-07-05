import { z } from "zod";

export const InviteSchema = z.object({
  id: z.string(),
  calendarID: z.string().uuid(),
  expiresAt: z.coerce.date(),
  maxUses: z.number().nullable(),
});

export type Invite = z.infer<typeof InviteSchema>;
