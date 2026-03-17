import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { handle } from "hono/aws-lambda";
import { handleError } from "./lib/errors";
import { jobsRoutes } from "./routes/jobs";
import { statusRoutes } from "./routes/status";

const app = new OpenAPIHono();

app.route("/jobs", jobsRoutes);
app.route("/status", statusRoutes);

app.doc("/doc", {
  openapi: "3.0.3",
  info: {
    title: "YomiToku OCR Worker API",
    version: "1.0.0",
    description:
      "S3 に PDF をアップロードすると、YomiToku-Pro (SageMaker) で OCR を実行し、結果を JSON で返すサーバーレス API",
  },
});

app.get("/ui", swaggerUI({ url: "/doc" }));

app.onError(handleError);

export const handler = handle(app);
