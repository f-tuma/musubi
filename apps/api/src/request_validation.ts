import { BadRequestError } from "@musubi/types";

// PostgreSQL's uuid input accepts all UUID versions; require the canonical
// hyphenated representation before a value reaches a query.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUUID(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new BadRequestError(`${field} must be a valid UUID.`);
  }
  return value;
}

export function optionalDateQuery(value: unknown, field: string): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestError(`${field} must be a valid timestamp.`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestError(`${field} must be a valid timestamp.`);
  }
  return parsed;
}
