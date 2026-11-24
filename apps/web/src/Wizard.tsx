import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  buildIntakeSchema,
  flattenIssues,
  isValidGithubName,
  REGISTRARS,
  SECRET_KEY_RE,
  STEP_FIELDS,
  TIER_LABELS,
  type SessionView,
  type SubmitResult,
} from "@zinkpress/shared";
import { api, ApiError } from "./api";

type Step = 1 | 2 | 3 | 4;
const STEPS: { n: Step; title: string }[] = [
  { n: 1, title: "Access" },
  { n: 2, title: "Brand & copy" },
  { n: 3, title: "Integrations" },
  { n: 4, title: "Approver" },
];

interface FormState {
  registrarProvider: string;
  registrarDelegatedConfirmed: boolean;
  cloudflareAdminConfirmed: boolean;
  githubTarget: string;
  logoKey: string;
  logoName: string;
  assetKeys: { key: string; name: string }[];
  primaryHex: string;
  secondaryHex: string;
  fontMode: "system" | "google";
  fontFamily: string;
  copyMode: "link" | "fields";
  copyUrl: string;
  heroHeadline: string;
  subheadline: string;
  services: [string, string, string];
  contactInfo: string;
  copyFinalizedConfirmed: boolean;
  secrets: Record<string, string>;
  extraSecrets: { name: string; value: string }[];
  adminEmails: string;
  spocName: string;
  spocEmail: string;
}

const EMPTY: FormState = {
  registrarProvider: "",
  registrarDelegatedConfirmed: false,
  cloudflareAdminConfirmed: false,
  githubTarget: "",
  logoKey: "",
  logoName: "",
  assetKeys: [],
  primaryHex: "",
  secondaryHex: "",
  fontMode: "system",
  fontFamily: "",
  copyMode: "link",
  copyUrl: "",
  heroHeadline: "",
  subheadline: "",
  services: ["", "", ""],
  contactInfo: "",
  copyFinalizedConfirmed: false,
  secrets: {},
  extraSecrets: [],
  adminEmails: "",
  spocName: "",
  spocEmail: "",
};

/** Turns the form into exactly what the shared schema (and the Worker) expects. */
function toPayload(f: FormState, tierNeedsIntegrations: boolean) {
  const secrets: Record<string, string> = {};
  if (tierNeedsIntegrations) {
    for (const [k, v] of Object.entries(f.secrets)) if (v.trim()) secrets[k] = v;
    for (const { name, value } of f.extraSecrets) {
      const key = name.trim().toUpperCase();
      if (key || value.trim()) secrets[key || "UNNAMED_KEY"] = value;
    }
  }
  return {
    registrarProvider: f.registrarProvider || undefined,
    registrarDelegatedConfirmed: f.registrarDelegatedConfirmed,
    cloudflareAdminConfirmed: f.cloudflareAdminConfirmed,
    githubTarget: f.githubTarget,
    logoKey: f.logoKey,
    primaryHex: f.primaryHex,
    secondaryHex: f.secondaryHex,
    font: f.fontMode === "google" ? { mode: "google", family: f.fontFamily } : { mode: "system" },
    copy:
      f.copyMode === "link"
        ? { mode: "link", url: f.copyUrl }
        : {
            mode: "fields",
            heroHeadline: f.heroHeadline,
            subheadline: f.subheadline,
            services: f.services,
            contactInfo: f.contactInfo,
          },
    copyFinalizedConfirmed: f.copyFinalizedConfirmed,
    secrets,
    adminEmails: tierNeedsIntegrations
      ? f.adminEmails
          .split(/[\s,;]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    spocName: f.spocName,
    spocEmail: f.spocEmail,
    assetKeys: f.assetKeys.map((a) => a.key),
  };
}

function stepOf(errorKey: string): Step | null {
  const top = errorKey.split(".")[0];
  for (const s of [1, 2, 3, 4] as Step[]) if (STEP_FIELDS[s].includes(top)) return s;
  return null;
}

export function formatWhen(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

export function Wizard({ token, session }: { token: string; session: SessionView }) {
  const needsIntegrations = session.tier !== "TIER_1";
  const schema = useMemo(
    () => buildIntakeSchema({ tier: session.tier, requiredIntegrations: session.requiredIntegrations }),
    [session],
  );

  const [form, setForm] = useState<FormState>(() => ({
    ...EMPTY,
    secrets: Object.fromEntries(session.requiredIntegrations.map((k) => [k, ""])),
  }));
  const [step, setStep] = useState<Step>(1);
  const [visited, setVisited] = useState<Set<Step>>(new Set());
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [gh, setGh] = useState<{ state: "idle" | "checking" | "ok" | "missing" | "unverified"; label?: string }>({
    state: "idle",
  });

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setServerErrors((e) => {
      const next = { ...e };
      for (const key of Object.keys(next)) if (key === k || key.startsWith(`${String(k)}.`)) delete next[key];
      return next;
    });
  };

  const payload = toPayload(form, needsIntegrations);
  const parsed = schema.safeParse(payload);
  const clientErrors = parsed.success ? {} : flattenIssues(parsed.error.issues);
  if (gh.state === "missing") clientErrors.githubTarget = "GitHub doesn't have an account with that name.";
  if (needsIntegrations) {
    form.extraSecrets.forEach((row, i) => {
      if (!SECRET_KEY_RE.test(row.name.trim().toUpperCase())) {
        clientErrors[`extra.${i}`] = "Name each key in CAPITAL_LETTERS_AND_UNDERSCORES, like CRM_WEBHOOK_URL.";
      } else if (!row.value.trim()) {
        clientErrors[`extra.${i}`] = "Paste the value, or remove this row.";
      }
    });
  }
  const errors = { ...clientErrors, ...serverErrors };

  const stepErrors = (s: Step) =>
    Object.keys(errors).filter((k) => stepOf(k) === s || (s === 3 && k.startsWith("extra.")));
  const stepDone = (s: Step) => stepErrors(s).length === 0;
  const allDone = ([1, 2, 3, 4] as Step[]).every(stepDone) && gh.state !== "checking";

  const err = (key: string) => (visited.has(stepOf(key) ?? (key.startsWith("extra.") ? 3 : step)) ? errors[key] : undefined);

  const go = (s: Step) => {
    setVisited((v) => new Set(v).add(step));
    setStep(s);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  async function checkGithub() {
    const name = form.githubTarget.trim();
    if (!isValidGithubName(name)) return setGh({ state: "idle" });
    setGh({ state: "checking" });
    try {
      const r = await api.checkGithub(token, name);
      if (r.status === "exists") setGh({ state: "ok", label: `${r.type === "Organization" ? "Organization" : "User"} @${r.login}` });
      else if (r.status === "not_found") setGh({ state: "missing" });
      else setGh({ state: "unverified" });
    } catch {
      setGh({ state: "unverified" });
    }
  }

  async function submit() {
    setVisited(new Set([1, 2, 3, 4]));
    if (!allDone || !parsed.success) {
      const first = ([1, 2, 3, 4] as Step[]).find((s) => !stepDone(s));
      if (first) setStep(first);
      setBanner("A few answers still need fixing. They're marked in red.");
      return;
    }
    setSubmitting(true);
    setBanner(null);
    try {
      setResult(await api.submit(token, payload));
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fields).length) {
        setServerErrors(e.fields);
        const first = Object.keys(e.fields).map(stepOf).find(Boolean);
        if (first) setStep(first);
      }
      setBanner(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (result) return <Receipt session={session} result={result} />;

  return (
    <div className="card">
      <header className="topbar">
        <div>
          <p className="eyebrow">{session.agencyName} · Project intake</p>
          <h1>{session.clientName}</h1>
          <p className="muted small">
            {session.projectId} · {TIER_LABELS[session.tier]}
          </p>
        </div>
      </header>

      <div className="clock paused" role="status">
        <strong>Status: Clock paused.</strong> Finish all 4 steps to start your guaranteed delivery timer.
      </div>

      <nav className="steps" aria-label="Steps">
        {STEPS.map(({ n, title }) => (
          <button
            key={n}
            type="button"
            className={`step ${step === n ? "active" : ""} ${visited.has(n) ? (stepDone(n) ? "done" : "todo") : ""}`}
            onClick={() => go(n)}
            aria-current={step === n ? "step" : undefined}
          >
            <span className="num">{visited.has(n) && stepDone(n) ? "✓" : n}</span>
            {title}
          </button>
        ))}
      </nav>

      {banner && <div className="alert">{banner}</div>}

      {step === 1 && (
        <section>
          <h2>1. Infrastructure & DNS access</h2>
          <Field label="Where is your domain registered?" error={err("registrarProvider")}>
            <select value={form.registrarProvider} onChange={(e) => set("registrarProvider", e.target.value)}>
              <option value="">Choose one…</option>
              {REGISTRARS.map((r) => (
                <option key={r} value={r}>
                  {r === "Squarespace" ? "Squarespace (formerly Google Domains)" : r}
                </option>
              ))}
            </select>
          </Field>
          <Check
            checked={form.registrarDelegatedConfirmed}
            onChange={(v) => set("registrarDelegatedConfirmed", v)}
            error={err("registrarDelegatedConfirmed")}
          >
            I gave <strong>{session.agencyEmail}</strong> admin (delegate) access at my registrar.
          </Check>
          <Check
            checked={form.cloudflareAdminConfirmed}
            onChange={(v) => set("cloudflareAdminConfirmed", v)}
            error={err("cloudflareAdminConfirmed")}
          >
            I created a Cloudflare account and invited <strong>{session.agencyEmail}</strong> as an Administrator.{" "}
            <a href={session.cloudflareHelpUrl} target="_blank" rel="noreferrer">
              Show me where to click
            </a>
          </Check>
          <Field
            label="GitHub username or organization (where we'll hand over your code)"
            error={err("githubTarget")}
            hint={
              gh.state === "checking"
                ? "Checking GitHub…"
                : gh.state === "ok"
                  ? `Found on GitHub: ${gh.label}`
                  : gh.state === "unverified"
                    ? "We couldn't reach GitHub right now. We'll double-check it ourselves."
                    : undefined
            }
          >
            <input
              value={form.githubTarget}
              placeholder="e.g. acme-studio"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => {
                set("githubTarget", e.target.value);
                setGh({ state: "idle" });
              }}
              onBlur={checkGithub}
            />
          </Field>
        </section>
      )}

      {step === 2 && (
        <section>
          <h2>2. Brand & final copy</h2>
          <p className="muted small">Zero placeholder policy: we build with exactly what you send here.</p>
          <LogoUpload
            token={token}
            current={form.logoName}
            error={err("logoKey")}
            onUploaded={(key, name) => {
              set("logoKey", key);
              set("logoName", name);
            }}
          />
          <ExtraFiles
            token={token}
            files={form.assetKeys}
            onChange={(files) => set("assetKeys", files)}
          />
          <div className="row">
            <ColorField label="Primary brand color" value={form.primaryHex} onChange={(v) => set("primaryHex", v)} error={err("primaryHex")} />
            <ColorField label="Secondary brand color" value={form.secondaryHex} onChange={(v) => set("secondaryHex", v)} error={err("secondaryHex")} />
          </div>
          <Field label="Fonts" error={err("font.family")}>
            <div className="choice">
              <label>
                <input type="radio" checked={form.fontMode === "system"} onChange={() => set("fontMode", "system")} /> Fast system
                fonts (recommended)
              </label>
              <label>
                <input type="radio" checked={form.fontMode === "google"} onChange={() => set("fontMode", "google")} /> A Google Font
              </label>
            </div>
            {form.fontMode === "google" && (
              <input value={form.fontFamily} placeholder="Font name, e.g. Inter" onChange={(e) => set("fontFamily", e.target.value)} />
            )}
          </Field>

          <Field label="Your final, proofread copy">
            <div className="choice">
              <label>
                <input type="radio" checked={form.copyMode === "link"} onChange={() => set("copyMode", "link")} /> Link to a Google Doc
                or Notion page
              </label>
              <label>
                <input type="radio" checked={form.copyMode === "fields"} onChange={() => set("copyMode", "fields")} /> Type it here
              </label>
            </div>
          </Field>
          {form.copyMode === "link" ? (
            <Field
              label="Link (make sure anyone with the link can view it)"
              error={err("copy.url")}
            >
              <input
                type="url"
                value={form.copyUrl}
                placeholder="https://docs.google.com/document/d/…"
                onChange={(e) => set("copyUrl", e.target.value)}
              />
            </Field>
          ) : (
            <>
              <Field label="Hero headline" error={err("copy.heroHeadline")}>
                <input value={form.heroHeadline} onChange={(e) => set("heroHeadline", e.target.value)} />
              </Field>
              <Field label="Subheadline" error={err("copy.subheadline")}>
                <input value={form.subheadline} onChange={(e) => set("subheadline", e.target.value)} />
              </Field>
              {[0, 1, 2].map((i) => (
                <Field key={i} label={`Core service ${i + 1}`} error={err(`copy.services.${i}`)}>
                  <textarea
                    rows={2}
                    value={form.services[i]}
                    onChange={(e) => {
                      const s = [...form.services] as [string, string, string];
                      s[i] = e.target.value;
                      set("services", s);
                    }}
                  />
                </Field>
              ))}
              <Field label="Contact info for the site (phone, email, address, hours)" error={err("copy.contactInfo")}>
                <textarea rows={3} value={form.contactInfo} onChange={(e) => set("contactInfo", e.target.value)} />
              </Field>
            </>
          )}
          <Check
            checked={form.copyFinalizedConfirmed}
            onChange={(v) => set("copyFinalizedConfirmed", v)}
            error={err("copyFinalizedConfirmed")}
          >
            I confirm this copy is final and proofread. Changes after I submit count toward my one consolidated revision pass.
          </Check>
        </section>
      )}

      {step === 3 && (
        <section>
          <h2>3. Integrations</h2>
          {!needsIntegrations ? (
            <p className="muted">Your plan doesn't need any API keys. Go on to step 4.</p>
          ) : (
            <>
              <p className="muted small">
                Keys are encrypted the moment they reach us and deleted shortly after launch. Use test keys if you'd
                rather we switch to live ones together.
              </p>
              {session.requiredIntegrations.map((k) => (
                <Field key={k} label={k} error={err(`secrets.${k}`)}>
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={form.secrets[k] ?? ""}
                    onChange={(e) => set("secrets", { ...form.secrets, [k]: e.target.value })}
                  />
                </Field>
              ))}
              {form.extraSecrets.map((row, i) => (
                <div className="row" key={i}>
                  <Field label="Key name" error={err(`extra.${i}`)}>
                    <input
                      value={row.name}
                      placeholder="CRM_WEBHOOK_URL"
                      onChange={(e) => {
                        const next = [...form.extraSecrets];
                        next[i] = { ...row, name: e.target.value.toUpperCase() };
                        set("extraSecrets", next);
                      }}
                    />
                  </Field>
                  <Field label="Value">
                    <input
                      type="password"
                      autoComplete="off"
                      value={row.value}
                      onChange={(e) => {
                        const next = [...form.extraSecrets];
                        next[i] = { ...row, value: e.target.value };
                        set("extraSecrets", next);
                      }}
                    />
                  </Field>
                  <button type="button" className="link" onClick={() => set("extraSecrets", form.extraSecrets.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </div>
              ))}
              <button type="button" className="ghost" onClick={() => set("extraSecrets", [...form.extraSecrets, { name: "", value: "" }])}>
                + Add another key
              </button>
              {err("secrets") && <p className="error">{err("secrets")}</p>}
              <Field
                label="Admin emails for your portal (one per line)"
                error={err("adminEmails") ?? Object.entries(errors).find(([k]) => k.startsWith("adminEmails."))?.[1]}
              >
                <textarea rows={3} value={form.adminEmails} onChange={(e) => set("adminEmails", e.target.value)} />
              </Field>
            </>
          )}
        </section>
      )}

      {step === 4 && (
        <section>
          <h2>4. Your approver and sprint start</h2>
          <p className="muted small">One person gathers everyone's feedback and approves staging. We take direction from them only.</p>
          <Field label="Approver's full name" error={err("spocName")}>
            <input value={form.spocName} autoComplete="name" onChange={(e) => set("spocName", e.target.value)} />
          </Field>
          <Field label="Approver's email" error={err("spocEmail")}>
            <input type="email" value={form.spocEmail} autoComplete="email" onChange={(e) => set("spocEmail", e.target.value)} />
          </Field>

          <ul className="summary">
            {STEPS.map(({ n, title }) => (
              <li key={n} className={stepDone(n) ? "ok" : "no"}>
                {stepDone(n) ? "✓" : "•"} Step {n}: {title} {stepDone(n) ? "complete" : `(${stepErrors(n).length} to fix)`}
              </li>
            ))}
          </ul>

          <button type="button" className="primary big" disabled={!allDone || submitting} onClick={submit}>
            {submitting
              ? "Encrypting and starting your sprint…"
              : allDone
                ? "Verify assets & start sprint clock"
                : "Finish every step to unlock your sprint clock"}
          </button>
        </section>
      )}

      <footer className="nav">
        <button type="button" className="ghost" disabled={step === 1} onClick={() => go((step - 1) as Step)}>
          Back
        </button>
        {step < 4 && (
          <button type="button" className="primary" onClick={() => go((step + 1) as Step)}>
            Next
          </button>
        )}
      </footer>
      <p className="muted small center">
        Link works until {formatWhen(session.tokenExpiresAt, session.timeZone)}. Questions? {session.agencyEmail}
      </p>
    </div>
  );
}

export function Receipt({ session, result }: { session: SessionView; result: SubmitResult }) {
  return (
    <div className="card">
      <span className="pill">Sprint clock active</span>
      <h1>Assets verified. We're building.</h1>
      <p className="muted">
        Project <strong>{session.projectId}</strong> ({session.clientName}) is in the {session.agencyName} build queue. A copy of
        this receipt is on its way to your email.
      </p>
      <dl className="receipt">
        <dt>Official kickoff</dt>
        <dd>{formatWhen(result.clockStartedAt, session.timeZone)}</dd>
        <dt>Guaranteed staging delivery</dt>
        <dd>{formatWhen(result.guaranteedDeadline, session.timeZone)}</dd>
      </dl>
      <p className="muted small">Business days are Monday to Friday. Questions? {session.agencyEmail}</p>
    </div>
  );
}

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <label className={`field ${error ? "has-error" : ""}`}>
      <span className="label">{label}</span>
      {children}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

function Check({
  checked,
  onChange,
  error,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className={`check ${error ? "has-error" : ""}`}>
      <label>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>{children}</span>
      </label>
      {error && <span className="error">{error}</span>}
    </div>
  );
}

function ColorField({ label, value, onChange, error }: { label: string; value: string; onChange: (v: string) => void; error?: string }) {
  const valid = /^#[0-9A-Fa-f]{6}$/.test(value);
  return (
    <Field label={label} error={error}>
      <div className="color">
        <input type="color" value={valid ? value : "#000000"} onChange={(e) => onChange(e.target.value.toUpperCase())} aria-label={`${label} picker`} />
        <input value={value} placeholder="#1E293B" maxLength={7} onChange={(e) => onChange(e.target.value.trim())} />
      </div>
    </Field>
  );
}

function LogoUpload({
  token,
  current,
  error,
  onUploaded,
}: {
  token: string;
  current: string;
  error?: string;
  onUploaded: (key: string, name: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function handle(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.upload(token, file, "logo");
      onUploaded(r.key, file.name);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`field ${error || msg ? "has-error" : ""}`}>
      <span className="label">Logo (.SVG, .EPS, or transparent .PNG at least 1000px wide)</span>
      <div
        className={`drop ${drag ? "drag" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          handle(e.dataTransfer.files[0]);
        }}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
      >
        {busy ? "Checking and uploading…" : current ? `✓ ${current} (click to replace)` : "Drop your logo here, or click to choose"}
        <input
          ref={input}
          type="file"
          hidden
          accept=".svg,.eps,.png,image/svg+xml,image/png,application/postscript"
          onChange={(e) => handle(e.target.files?.[0])}
        />
      </div>
      {(msg || error) && <span className="error">{msg || error}</span>}
    </div>
  );
}

function ExtraFiles({
  token,
  files,
  onChange,
}: {
  token: string;
  files: { key: string; name: string }[];
  onChange: (f: { key: string; name: string }[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function handle(list: FileList | null) {
    if (!list?.length) return;
    setBusy(true);
    setMsg(null);
    const added: { key: string; name: string }[] = [];
    for (const file of Array.from(list)) {
      try {
        const r = await api.upload(token, file, "asset");
        added.push({ key: r.key, name: file.name });
      } catch (e) {
        setMsg(`${file.name}: ${e instanceof Error ? e.message : "upload failed"}`);
      }
    }
    onChange([...files, ...added]);
    setBusy(false);
  }

  return (
    <div className={`field ${msg ? "has-error" : ""}`}>
      <span className="label">Other brand files (optional: photos, brand guide, ZIP)</span>
      <input type="file" multiple accept=".svg,.eps,.png,.jpg,.jpeg,.zip" disabled={busy} onChange={(e) => handle(e.target.files)} />
      {files.length > 0 && <span className="hint">Uploaded: {files.map((f) => f.name).join(", ")}</span>}
      {msg && <span className="error">{msg}</span>}
    </div>
  );
}
