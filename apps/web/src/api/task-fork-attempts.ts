import { TaskForkAttempts } from "@musubi/calendar";

/** App-lifetime intent identities survive closing a task or leaving its route.
 * Scope keys isolate servers and actors; no task content is retained. */
export const taskForkAttempts = new TaskForkAttempts(() => crypto.randomUUID());
