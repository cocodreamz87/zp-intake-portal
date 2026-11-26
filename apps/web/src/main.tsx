import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SessionView } from "@zinkpress/shared";
import { api, ApiError } from "./api";
import { Maintenance } from "./Maintenance";
import { Review } from "./Review";
import { Status } from "./Status";
import { Testimonial } from "./Testimonial";
import { Wizard } from "./Wizard";
import "./styles.css";

/** The intake and review pages share one link token; re-auth and testimonial links are separate tokens. */
const PAGE = window.location.pathname.replace(/\/$/, "") || "/";
const TOKEN_KEY = PAGE === "/maintenance" ? "zp-maintenance-token" : PAGE === "/testimonial" ? "zp-testimonial-token" : "zp-intake-token";

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
  const isReview = PAGE === "/review";
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(token ? null : "Open this page from the link in your email.");

  useEffect(() => {
    if (!token || PAGE !== "/") return;
    api
      .session(token)
      .then(setSession)
      .catch((e) => setError(e instanceof ApiError ? e.message : "We couldn't reach the server. Try again in a minute."));
  }, [token]);

  if (PAGE === "/maintenance" && token) {
    return (
      <main className="shell">
        <Maintenance token={token} />
      </main>
    );
  }
  if (PAGE === "/testimonial" && token) {
    return (
      <main className="shell">
        <Testimonial token={token} />
      </main>
    );
  }
  if (isReview && token) {
    return (
      <main className="shell">
        <Review token={token} />
      </main>
    );
  }
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
    // After submit the same private link becomes a read-only status page with a live countdown.
    return (
      <main className="shell">
        <Status token={token} />
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
