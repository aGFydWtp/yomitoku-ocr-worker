import { createRoute, z } from "@hono/zod-openapi";
import {
  CancelJobResponseSchema,
  CreateJobBodySchema,
  CreateJobResponseSchema,
  ErrorResponseSchema,
  JOB_STATUSES,
  JobDetailResponseSchema,
  JobListResponseSchema,
  ServiceUnavailableSchema,
  VisualizationsQuerySchema,
  VisualizationsResponseSchema,
} from "../schemas";

export const createJobRoute = createRoute({
  method: "post",
  path: "/",
  summary: "ジョブ作成",
  description:
    "PDF の OCR ジョブを作成し、S3 アップロード用の署名付き URL を取得します。エンドポイント未起動時は 503 を返し、裏で起動を開始します。",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateJobBodySchema } },
    },
  },
  responses: {
    201: {
      description: "ジョブ作成成功",
      content: { "application/json": { schema: CreateJobResponseSchema } },
    },
    400: {
      description: "バリデーションエラー",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    503: {
      description: "エンドポイント未起動",
      content: { "application/json": { schema: ServiceUnavailableSchema } },
    },
  },
});

export const listJobsRoute = createRoute({
  method: "get",
  path: "/",
  summary: "ジョブ一覧取得",
  description:
    "ステータスでフィルタし、ページネーション付きでジョブを取得します。",
  request: {
    query: z.object({
      status: z.enum(JOB_STATUSES, {
        error:
          "status must be one of: PENDING, PROCESSING, COMPLETED, FAILED, CANCELLED",
      }),
      limit: z.coerce
        .number({
          error: "limit must be an integer between 1 and 100",
        })
        .int("limit must be an integer between 1 and 100")
        .min(1, "limit must be an integer between 1 and 100")
        .max(100, "limit must be an integer between 1 and 100")
        .default(20)
        .optional(),
      cursor: z.string().optional(),
      basePath: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "ジョブ一覧",
      content: { "application/json": { schema: JobListResponseSchema } },
    },
    400: {
      description: "バリデーションエラー",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const jobIdParams = z.object({
  jobId: z.string().uuid(),
});

export const getJobRoute = createRoute({
  method: "get",
  path: "/{jobId}",
  summary: "ジョブ状態取得",
  request: {
    params: jobIdParams,
  },
  responses: {
    200: {
      description: "ジョブ詳細",
      content: { "application/json": { schema: JobDetailResponseSchema } },
    },
    400: {
      description: "不正な jobId 形式",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "ジョブが見つからない",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

export const getVisualizationsRoute = createRoute({
  method: "get",
  path: "/{jobId}/visualizations",
  summary: "可視化画像 URL 取得",
  description:
    "COMPLETED ジョブのレイアウト/OCR 可視化画像の署名付き URL を返します。mode / page で絞り込み可能。",
  request: {
    params: jobIdParams,
    query: VisualizationsQuerySchema,
  },
  responses: {
    200: {
      description: "可視化画像 URL 一覧",
      content: {
        "application/json": { schema: VisualizationsResponseSchema },
      },
    },
    400: {
      description: "不正なパラメーター",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "ジョブが見つからない、または可視化データなし",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

export const cancelJobRoute = createRoute({
  method: "delete",
  path: "/{jobId}",
  summary: "ジョブキャンセル",
  description: "PENDING 状態のジョブのみキャンセルできます。",
  request: {
    params: jobIdParams,
  },
  responses: {
    200: {
      description: "キャンセル成功",
      content: { "application/json": { schema: CancelJobResponseSchema } },
    },
    400: {
      description: "不正な jobId 形式",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "ジョブが見つからない",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "PENDING 以外のステータスのためキャンセル不可",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
