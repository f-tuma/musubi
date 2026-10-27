import { z } from "zod";
import { WireEmailSchema } from "./wire_primitives";

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: WireEmailSchema,
  image: z.string().nullish(),
});

export type User = z.infer<typeof UserSchema>;
