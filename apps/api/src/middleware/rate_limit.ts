import { NextFunction, Request, Response } from "express";

// Fixed-window in-memory rate limiter for the public endpoints (invite preview,
// federation accept) — they take unauthenticated input, so cap the guessing rate.
// ponytail: per-process memory — resets on restart and is per-instance behind a
// load balancer; move to Redis if Musubi ever runs multi-instance.
export function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; start: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    // bounded memory: drop expired windows once the map gets big
    if (hits.size > 10_000) {
      for (const [k, h] of hits) if (now - h.start > windowMs) hits.delete(k);
    }
    const key = req.ip ?? "?";
    const h = hits.get(key);
    if (!h || now - h.start > windowMs) {
      hits.set(key, { count: 1, start: now });
      return next();
    }
    if (++h.count > max) {
      res.status(429).json({ error: "Too many requests. Try again later." });
      return;
    }
    next();
  };
}
