import { createFileRoute } from "@tanstack/react-router";
import { downloadInboundImageEndpoint } from "@/lib/inbound-image.server";

export const Route = createFileRoute("/api/public/whatsapp/download-image")({
  server: { handlers: { POST: ({ request }) => downloadInboundImageEndpoint(request) } },
});
