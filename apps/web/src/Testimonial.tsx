import { useEffect, useState } from "react";
import { TESTIMONIAL_QUOTE_MAX, TESTIMONIAL_QUOTE_MIN, type TestimonialRequestView } from "@zinkpress/shared";
import { api, ApiError } from "./api";

/** /testimonial?token=... : two sentences after launch, shown publicly only with consent and your approval. */
export function Testimonial({ token }: { token: string }) {
  const [view, setView] = useState<TestimonialRequestView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [authorRole, setAuthorRole] = useState("");
  const [company, setCompany] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [consent, setConsent] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    api
      .testimonial(token)
      .then((v) => {
        setView(v);
        setAuthorName(v.suggestedName ?? "");
        setCompany(v.clientName);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "We couldn't reach the server. Try again in a minute."));
  }, [token]);

  async function submit() {
    setBusy(true);
    try {
      await api.submitTestimonial(token, { quote, authorName, authorRole, company, linkUrl, consent });
      setSent(true);
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fields).length) setFields(e.fields);
      else setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="card center">
        <p className="eyebrow">Testimonial</p>
        <h1>We can't open this link</h1>
        <p className="muted">{error}</p>
      </div>
    );
  }
  if (!view) return <div className="card center muted">Loading…</div>;
  if (sent || view.status !== "REQUESTED") {
    return (
      <div className="card center">
        <span className="pill">Thank you</span>
        <h1>That means a lot.</h1>
        <p className="muted">We'll only show it with your name and company, the way you wrote it.</p>
      </div>
    );
  }

  const err = (k: string) => (fields[k] ? <span className="error">{fields[k]}</span> : null);
  return (
    <div className="card">
      <p className="eyebrow">{view.agencyName} · {view.projectId}</p>
      <h1>Two sentences about your build?</h1>
      <p className="muted">
        What changed for {view.clientName} after the {view.businessDays}-business-day sprint? A time or money saved is perfect.
      </p>
      <label className={`field ${fields.quote ? "has-error" : ""}`}>
        <span className="label">Your words</span>
        <textarea rows={4} maxLength={TESTIMONIAL_QUOTE_MAX} value={quote} onChange={(e) => setQuote(e.target.value)} />
        {err("quote") ?? (
          <span className="muted small">
            {quote.trim().length} / {TESTIMONIAL_QUOTE_MAX} characters (at least {TESTIMONIAL_QUOTE_MIN})
          </span>
        )}
      </label>
      <div className="row">
        <label className={`field ${fields.authorName ? "has-error" : ""}`}>
          <span className="label">Name to show</span>
          <input value={authorName} onChange={(e) => setAuthorName(e.target.value)} />
          {err("authorName")}
        </label>
        <label className="field">
          <span className="label">Role (optional)</span>
          <input value={authorRole} placeholder="Owner" onChange={(e) => setAuthorRole(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span className="label">Company</span>
        <input value={company} onChange={(e) => setCompany(e.target.value)} />
      </label>
      <label className={`field ${fields.linkUrl ? "has-error" : ""}`}>
        <span className="label">Review link (optional, e.g. Senja or Google)</span>
        <input value={linkUrl} placeholder="https://" onChange={(e) => setLinkUrl(e.target.value)} />
        {err("linkUrl")}
      </label>
      <div className={`check ${fields.consent ? "has-error" : ""}`}>
        <label>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>{view.agencyName} may show these words with my name and company on its website.</span>
        </label>
        {err("consent")}
      </div>
      <button className="primary big" disabled={busy} onClick={submit}>
        {busy ? "Sending…" : "Send"}
      </button>
    </div>
  );
}
