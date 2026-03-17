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

export interface ServiceUnavailableDetails {
  endpointState: string;
}

export class ServiceUnavailableError extends Error {
  public readonly details: ServiceUnavailableDetails;
  constructor(message: string, details: ServiceUnavailableDetails) {
    super(message);
    this.name = "ServiceUnavailableError";
    this.details = details;
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
  if (err instanceof ServiceUnavailableError) {
    return c.json(
      { error: err.message, endpointState: err.details.endpointState },
      503,
    );
  }
  if (
    err instanceof HTTPException ||
    (err instanceof Error && "status" in err && "getResponse" in err)
  ) {
    const status = (err as HTTPException).status ?? 500;
    return c.json({ error: err.message }, status as 400);
  }
  console.error("Unexpected error:", err);
  return c.json({ error: "Internal server error" }, 500);
}
