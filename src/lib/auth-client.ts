type User = { id: string; email: string; name: string | null };
type AuthEvent = "SIGNED_IN" | "SIGNED_OUT" | "USER_UPDATED";
type Listener = (event: AuthEvent) => void;

const listeners = new Set<Listener>();

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

function emit(event: AuthEvent) {
  listeners.forEach((listener) => listener(event));
}

export const authClient = {
  auth: {
    async getSession() {
      try {
        const data = await request<{ user: User | null }>("/api/auth/session");
        return { data: { session: data.user ? { user: data.user } : null }, error: null };
      } catch (error) {
        return { data: { session: null }, error };
      }
    },
    async getUser() {
      try {
        const data = await request<{ user: User | null }>("/api/auth/session");
        return { data: { user: data.user }, error: data.user ? null : new Error("Unauthorized") };
      } catch (error) {
        return { data: { user: null }, error };
      }
    },
    async signInWithPassword(credentials: { email: string; password: string }) {
      try {
        const data = await request<{ user: User }>("/api/auth/login", {
          method: "POST",
          body: JSON.stringify(credentials),
        });
        emit("SIGNED_IN");
        return { data, error: null };
      } catch (error) {
        return { data: null, error: error as Error };
      }
    },
    async signOut() {
      try {
        await request("/api/auth/logout", { method: "POST", body: "{}" });
        emit("SIGNED_OUT");
        return { error: null };
      } catch (error) {
        return { error: error as Error };
      }
    },
    onAuthStateChange(listener: Listener) {
      listeners.add(listener);
      return {
        data: {
          subscription: {
            unsubscribe: () => {
              listeners.delete(listener);
            },
          },
        },
      };
    },
  },
};
