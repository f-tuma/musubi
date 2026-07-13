import { z } from "zod";

export const InviteSchema = z.object({
  id: z.string(),
  calendarID: z.string().uuid(),
  expiresAt: z.coerce.date().nullable(), // null = never expires
  maxUses: z.number().int().positive().nullable(), // null = unlimited
  uses: z.number().default(0), // consumed joins — server-maintained
});

export type Invite = z.infer<typeof InviteSchema>;
