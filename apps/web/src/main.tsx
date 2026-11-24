import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SessionView } from "@zinkpress/shared";
import { api, ApiError } from "./api";
import { Receipt, Wizard } from "./Wizard";
import "./styles.css";

const TOKEN_KEY = "zp-intake-token";

/**
 * Read ?token= once, keep it in this tab only, and remove it from the address bar
 * so it isn't left in browser history or shared by accident in a screenshot.
 */
function takeToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      /* private mode: keep it in memory only */
    }
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    return fromUrl;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function App() {
  const [token] = useState(takeToken);
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(token ? null : "Open this page from the link in your email.");

  useEffect(() => {
    if (!token) return;
    api
      .session(token)
      .then(setSession)
      .catch((e) => setError(e instanceof ApiError ? e.message : "We couldn't reach the server. Try again in a minute."));
  }, [token]);

  if (error) {
    return (
      <main className="shell">
        <div className="card center">
          <p className="eyebrow">Project intake</p>
          <h1>We can't open your form</h1>
          <p className="muted">{error}</p>
        </div>
      </main>
    );
  }
  if (!session || !token) {
    return (
      <main className="shell">
        <div className="card center muted">Loading your project…</div>
      </main>
    );
  }
  if (session.status !== "AWAITING_CREDENTIALS" && session.clockStartedAt && session.guaranteedDeadline) {
    return (
      <main className="shell">
        <Receipt
          session={session}
          result={{ clockStartedAt: session.clockStartedAt, guaranteedDeadline: session.guaranteedDeadline }}
        />
      </main>
    );
  }
  return (
    <main className="shell">
      <Wizard token={token} session={session} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
