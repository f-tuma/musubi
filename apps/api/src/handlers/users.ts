import { Request, Response } from "express";
import { getUserAvatar, resetUsers, setUserAvatar } from '@musubi/db';
import { config } from "@musubi/config";
import { auth } from "@musubi/auth";
import { BadRequestError, NotFoundError } from "@musubi/types";


export async function handlerDeleteUser(req: Request, res: Response) {
  const result = await auth.api.deleteUser({
    headers: new Headers(req.headers as Record<string, string>),
    body: {},
  });

  if (!result.success) {
    throw new Error(result.message);
  }
  res.sendStatus(200);
}


// DEV ONLY

export async function handlerResetUsers(req: Request, res: Response) {
  if (config.api.environment === "dev") {
    await resetUsers();
    res.sendStatus(205);
  } else {
    res.sendStatus(403);
  }
}

// Avatars: stored in Postgres (see schema note) — tiny after client-side
// optimization. Validation here is the trust boundary: size cap + magic bytes.
const AVATAR_MAX_BYTES = 256 * 1024;

function sniffImageMime(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export async function handlerUploadAvatar(req: Request, res: Response) {
  const data = req.body?.data as string | undefined;
  if (!data) throw new BadRequestError("data (base64 image) is required...");

  let buf: Buffer;
  try { buf = Buffer.from(data, "base64"); } catch { throw new BadRequestError("Invalid base64 data..."); }
  if (buf.length === 0 || buf.length > AVATAR_MAX_BYTES) {
    throw new BadRequestError(`Avatar must be a non-empty image up to ${AVATAR_MAX_BYTES / 1024} KB.`);
  }
  const mime = sniffImageMime(buf);
  if (!mime) throw new BadRequestError("Avatar must be a JPEG, PNG or WebP image.");

  await setUserAvatar(req.user!.id, buf, mime);
  // versioned URL → immutable caching; client saves it into user.image
  const url = `${config.api.url}/api/v1/users/${req.user!.id}/avatar?v=${Date.now()}`;
  res.status(200).json({ url });
}

// Public on purpose (like Gravatar): plain <Image uri> can't send auth headers,
// and other members need to see each other's avatars.
export async function handlerGetAvatar(req: Request, res: Response) {
  const row = await getUserAvatar(req.params.userId as string);
  if (!row) throw new NotFoundError("Avatar not found...");
  res.set("Content-Type", row.mimeType);
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.send(row.data);
}
