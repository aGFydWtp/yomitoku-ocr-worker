import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { handleError } from "./lib/errors";
import { jobsRoutes } from "./routes/jobs";
import { statusRoutes } from "./routes/status";

const app = new Hono();

app.route("/jobs", jobsRoutes);
app.route("/status", statusRoutes);
app.onError(handleError);

export const handler = handle(app);
