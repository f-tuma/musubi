import {
  getUserSettings,
  patchUserSettings,
  saveUserSettings,
} from "@musubi/db";
import {
  BadRequestError,
  PatchSettingsRequestSchema,
  Settings,
  SettingsSchema,
  type SettingsDocument,
} from "@musubi/types";
import { Request, Response } from "express";
import { notifyCalendarMembers } from "./stream";
import { withProjectNewsReadMarker, type ProjectNewsReader } from "../project-news";

function settingsDocument(
  row: Awaited<ReturnType<typeof getUserSettings>>,
): SettingsDocument {
  return {
    revision: row.revision,
    updatedAt: row.updatedAt,
    value: SettingsSchema.parse(row),
  };
}

export async function handlerGetSettings(req: Request, res: Response) {
  const result = await getUserSettings(req.user!.id);

  res.status(200).json(result);
}

export async function handlerGetSettingsDocument(
  req: Request,
  res: Response,
) {
  const result = await getUserSettings(req.user!.id);
  res.status(200).json(settingsDocument(result));
}

export function createSaveSettingsHandler(dependencies: {
  getSettings?: typeof getUserSettings;
  save?: typeof saveUserSettings;
  readNews?: ProjectNewsReader;
  notify?: typeof notifyCalendarMembers;
} = {}) {
  return async function saveSettings(req: Request, res: Response) {
  let settings: Settings;

  try {
    settings = SettingsSchema.parse(req.body);
  } catch (err) {
    throw new BadRequestError("Request is missing valid settings data...");
  }

  const values = await withProjectNewsReadMarker(settings, {
    getSettings: () => (dependencies.getSettings ?? getUserSettings)(req.user!.id), read: dependencies.readNews,
  });
  const result = await (dependencies.save ?? saveUserSettings)(req.user!.id, values);
  (dependencies.notify ?? notifyCalendarMembers)([req.user!.id], "settings_updated", {
    revision: result.revision,
  });

  res.status(200).json(result);
  };
}
export const handlerSaveSettings = createSaveSettingsHandler();

export function createPatchSettingsHandler(
  dependencies: {
    notify?: typeof notifyCalendarMembers;
    patch?: typeof patchUserSettings;
    getSettings?: typeof getUserSettings;
    readNews?: ProjectNewsReader;
  } = {},
) {
  const notify = dependencies.notify ?? notifyCalendarMembers;
  const patch = dependencies.patch ?? patchUserSettings;

  return async function patchSettings(req: Request, res: Response) {
    const parsed = PatchSettingsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(
        "Request is missing a valid settings patch.",
      );
    }

    const values = await withProjectNewsReadMarker(parsed.data.patch, {
      getSettings: () => (dependencies.getSettings ?? getUserSettings)(req.user!.id),
      read: dependencies.readNews,
    });
    const result = await patch(
      req.user!.id,
      parsed.data.baseRevision,
      values,
    );
    const current = settingsDocument(result.settings);

    if (result.conflict) {
      return res.status(409).json({
        current,
        error: "SettingsConflict",
        message: "Settings changed on another device.",
        requestId: req.requestId,
      });
    }

    notify([req.user!.id], "settings_updated", {
      revision: current.revision,
    });
    return res.status(200).json(current);
  };
}

export const handlerPatchSettings = createPatchSettingsHandler();
