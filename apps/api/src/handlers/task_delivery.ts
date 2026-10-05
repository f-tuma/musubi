import type { Request, Response } from "express";
import { BadRequestError } from "@musubi/types";
import { getTaskDeliveryInbox, getTaskDeliveryStatus, requestTaskDeliveryRetry, TaskDeliveryRetryError } from "@musubi/db";
import { requireUUID } from "../request_validation";
import { deliverTaskOutbox } from "../sync/engine";

export async function handlerGetTaskDeliveryInbox(req: Request, res: Response) {
  if (Object.keys(req.query).some(key => key !== "cursor")) throw new BadRequestError("Only a cursor may be supplied.");
  const cursor = req.query.cursor === undefined ? undefined : requireUUID(req.query.cursor, "cursor");
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await getTaskDeliveryInbox(req.user!.id, cursor));
}
export async function handlerGetTaskDelivery(req: Request, res: Response) {
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await getTaskDeliveryStatus(req.user!.id, requireUUID(req.params.taskId, "taskId")));
}
export async function handlerRetryTaskDelivery(req: Request, res: Response) {
  if (req.body != null && (typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length))
    throw new BadRequestError("Retry does not accept changes to the saved operation.");
  const taskID = requireUUID(req.params.taskId, "taskId"), operationID = requireUUID(req.params.operationId, "operationId");
  try { await requestTaskDeliveryRetry(req.user!.id, taskID, operationID); }
  catch (error) {
    if (!(error instanceof TaskDeliveryRetryError)) throw error;
    return res.status(409).json({ error: error.message, code: error.code });
  }
  void deliverTaskOutbox(operationID).catch(() => undefined);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(202).json(await getTaskDeliveryStatus(req.user!.id, taskID));
}
