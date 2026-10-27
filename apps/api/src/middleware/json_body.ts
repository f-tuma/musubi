import express from "express";

/** Shared by API startup and isolated HTTP boundary scenarios. */
export function createJsonBodyParser(): express.RequestHandler {
  return express.json({ limit: "512kb" }); // avatars arrive as base64 JSON
}
