import { Request, Response } from "express";


// A Set per user — one user can stream from several devices at once, and a
// single-Response map would let a new connection silently evict the old one.
const clients = new Map<string, Set<Response>>();


export async function handlerStream(req: Request, res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const userID = req.user!.id;
  let connections = clients.get(userID);
  if (!connections) {
    connections = new Set();
    clients.set(userID, connections);
  }
  connections.add(res);

  req.on('close', () => {
    connections.delete(res);
    if (connections.size === 0) clients.delete(userID);
  });
}

export function notifyCalendarMembers(memberIDs: string[], type: string, payload: Record<string, any>) {
  for (const memberID of memberIDs) {
    for (const res of clients.get(memberID) ?? []) {
      res.write(`data: ${JSON.stringify({ type, payload })}\n\n`);
    }
  }
}
