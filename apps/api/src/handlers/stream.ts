import { Request, Response } from "express";


const clients = new Map<string, Response>();


export async function handlerStream(req: Request, res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  clients.set(req.user!.id, res);

  req.on('close', () => {
    clients.delete(req.user!.id);
  });
}

export function notifyCalendarMembers(memberIDs: string[], type: string, payload: Record<string, any>) {
  for (const memberID of memberIDs) {
    const res = clients.get(memberID);
    if (res) {
      res.write(`data: ${JSON.stringify({ type, payload })}\n\n`);
    }
  }
}
