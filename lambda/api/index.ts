import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { handleError } from "./lib/errors";
import { jobsRoutes } from "./routes/jobs";

const app = new Hono();

app.route("/jobs", jobsRoutes);
app.onError(handleError);

export const handler = handle(app);
