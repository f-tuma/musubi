import { getUserSettings, initializeProjectNewsReadMarker } from "@musubi/db";
import { createProjectNewsHandler, getProjectNews } from "../project-news";

/** Compatibility route for shipped clients; content is exclusively the shared project feed. */
export function createGetAnnouncementsHandler(dependencies: Partial<Parameters<typeof createProjectNewsHandler>[0]> = {}) {
  return createProjectNewsHandler({
    getSettings: dependencies.getSettings ?? getUserSettings,
    initialize: dependencies.initialize ?? initializeProjectNewsReadMarker,
    read: dependencies.read ?? getProjectNews,
  });
}

export const handlerGetAnnouncements = createGetAnnouncementsHandler();
