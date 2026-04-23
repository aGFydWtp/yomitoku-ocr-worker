import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export function handleError(err: unknown, c: Context) {
  if (err instanceof ValidationError) {
    return c.json({ error: err.message }, 400);
  }
  if (err instanceof NotFoundError) {
    return c.json({ error: err.message }, 404);
  }
  if (err instanceof ConflictError) {
    return c.json({ error: err.message }, 409);
  }
  if (err instanceof HTTPException) {
    const status = err.status;
    const message = status >= 500 ? "Internal server error" : err.message;
    return c.json({ error: message }, status as 400);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error("Unexpected error:", {
    name: err instanceof Error ? err.name : "UnknownError",
    message,
  });
  return c.json({ error: "Internal server error" }, 500);
}
