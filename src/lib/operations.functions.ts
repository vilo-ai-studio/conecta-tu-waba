import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireDatabaseAuth } from "@/integrations/database/auth-middleware";

export const getQueueMetrics = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .handler(async ({ context }) => {
    const operations = await import("@/lib/operations.server");
    await operations.assertOperationsAdmin(context.userId);
    return operations.buildQueueMetrics();
  });

export const getOperationsHealth = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .handler(async ({ context }) => {
    const operations = await import("@/lib/operations.server");
    await operations.assertOperationsAdmin(context.userId);
    return operations.buildOperationsHealth();
  });

export const listWebhookJobs = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .inputValidator(
    (input: { status?: string; clientId?: string; cursor?: string; limit?: number }) =>
      z
        .object({
          status: z.enum(["pending", "queued", "processing", "completed", "failed"]).optional(),
          clientId: z.string().uuid().optional(),
          cursor: z.string().datetime().optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .parse(input),
  )
  .handler(async ({ context, data }) => {
    const operations = await import("@/lib/operations.server");
    await operations.assertOperationsAdmin(context.userId);
    return operations.listStoredWebhookJobs(data);
  });

export const retryWebhookJob = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { jobId: string }) => z.object({ jobId: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const operations = await import("@/lib/operations.server");
    await operations.assertOperationsAdmin(context.userId);
    return operations.retryStoredWebhookJob(data.jobId);
  });
