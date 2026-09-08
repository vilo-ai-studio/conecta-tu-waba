import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { database } from "./client.server";
import { getSessionUser } from "./session.server";

export const requireDatabaseAuth = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const request = getRequest();
    if (!request) throw new Error("Unauthorized: request unavailable");
    const user = await getSessionUser(request);
    if (!user) throw new Error("Unauthorized: invalid or expired session");
    return next({
      context: {
        database,
        userId: user.id,
        user,
      },
    });
  },
);
