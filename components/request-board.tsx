"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { FeatureRequest, FieldErrors } from "../lib/requests";
import { filterRequests } from "../lib/search";
import { IntelligenceStatus, RequestIntelligencePanel, useIntelligence } from "./request-intelligence";

type LoadState = "loading" | "ready" | "error";
type SupportFailure = { message: string; desired: boolean };

function ArrowIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 18 18 6M6 6h12v12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function SignalMark({ small = false }: { small?: boolean }) {
  return <span className={`signal-mark${small ? " signal-mark-small" : ""}`} aria-hidden="true"><i /><i /><i /></span>;
}

function RequestCard({ request, pending, failure, onSupport, requests, intelligence, onNavigate }: {
  request: FeatureRequest;
  pending: boolean;
  failure?: SupportFailure;
  onSupport: (request: FeatureRequest, desired: boolean) => void;
  requests: FeatureRequest[];
  intelligence: ReturnType<typeof useIntelligence>;
  onNavigate: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = request.description.length > 260 || request.description.split("\n").length > 4;
  const date = new Date(request.createdAt);

  return (
    <article className="request-card" id={`request-${request.id}`} tabIndex={-1}>
      <div className="request-card-top"><span className="request-kind"><span className="status-dot" />Feature request</span><time dateTime={request.createdAt}>{date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</time></div>
      <h3>{request.title}</h3>
      <p id={`description-${request.id}`} className={`request-description${canExpand && !expanded ? " is-collapsed" : ""}`}>{request.description}</p>
      {canExpand && <button className="text-button" type="button" aria-expanded={expanded} aria-controls={`description-${request.id}`} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Read more"}<span aria-hidden="true">{expanded ? "−" : "+"}</span></button>}
      <div className="request-card-actions">
        <button
          type="button"
          className={`support-button${request.supportedByViewer ? " is-supported" : ""}`}
          aria-pressed={request.supportedByViewer}
          aria-label={request.supportedByViewer ? `Remove support for ${request.title}` : `Support ${request.title}`}
          title={request.supportedByViewer ? "Click to remove your support" : "Support this request"}
          disabled={pending}
          onClick={() => onSupport(request, failure?.desired ?? !request.supportedByViewer)}
        >
          {pending ? <span className="loading-spinner" /> : <span aria-hidden="true">{request.supportedByViewer ? "✓" : "+"}</span>}
          {pending ? "Saving…" : request.supportedByViewer ? "Supported" : "Support"}
        </button>
        <span className="support-count">{request.supportCount} {request.supportCount === 1 ? "supporter" : "supporters"}</span>
      </div>
      {failure && (
        <div className="support-error" role="alert">
          <p>{failure.message}</p>
          <button className="text-button" type="button" disabled={pending} onClick={() => onSupport(request, failure.desired)}>
            Retry {failure.desired ? "support" : "removal"}<span aria-hidden="true">↻</span>
          </button>
        </div>
      )}
      <RequestIntelligencePanel request={request} requests={requests} intelligence={intelligence} onNavigate={onNavigate} />
    </article>
  );
}

export function RequestBoard() {
  const [requests, setRequests] = useState<FeatureRequest[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const intelligence = useIntelligence(loadState === "ready");
  const [navigationTarget, setNavigationTarget] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pendingSupport, setPendingSupport] = useState<Set<string>>(new Set());
  const [supportErrors, setSupportErrors] = useState<Record<string, SupportFailure>>({});
  const [supportAnnouncement, setSupportAnnouncement] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const descriptionInput = useRef<HTMLTextAreaElement>(null);
  const submitLock = useRef(false);
  const supportLocks = useRef(new Set<string>());
  const loadStateRef = useRef<LoadState>("loading");
  const searchInput = useRef<HTMLInputElement>(null);
  const loadController = useRef<AbortController | null>(null);

  const loadRequests = useCallback(async () => {
    // A list fetched during a mutation could overwrite its confirmed result.
    if (submitLock.current || supportLocks.current.size > 0) return;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    loadStateRef.current = "loading";
    setLoadState("loading");
    try {
      const response = await fetch("/api/requests", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Could not load requests");
      const data = await response.json();
      if (!Array.isArray(data.requests)) throw new Error("Unexpected response");
      if (!controller.signal.aborted) {
        setRequests(data.requests);
        setSupportErrors({});
        loadStateRef.current = "ready";
        setLoadState("ready");
      }
    } catch {
      if (!controller.signal.aborted) {
        loadStateRef.current = "error";
        setLoadState("error");
      }
    }
  }, []);

  useEffect(() => {
    void loadRequests();
    return () => loadController.current?.abort();
  }, [loadRequests]);

  useEffect(() => {
    if (success && !submitting) titleInput.current?.focus();
  }, [success, submitting]);

  useEffect(() => {
    if (!navigationTarget) return;
    const target = document.getElementById(`request-${navigationTarget}`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      target.focus({ preventScroll: true });
    }
    setNavigationTarget(null);
  }, [navigationTarget, query]);

  function navigateToRequest(id: string) {
    setQuery("");
    setNavigationTarget(id);
  }

  async function updateSupport(request: FeatureRequest, desired: boolean) {
    if (supportLocks.current.has(request.id) || loadStateRef.current !== "ready") return;
    supportLocks.current.add(request.id);
    setPendingSupport(new Set(supportLocks.current));
    setSupportAnnouncement("");
    setSupportErrors((current) => {
      const next = { ...current };
      delete next[request.id];
      return next;
    });

    try {
      const response = await fetch(`/api/requests/${encodeURIComponent(request.id)}/support`, {
        // Explicit desired state makes retries safe after a lost response.
        method: desired ? "PUT" : "DELETE",
      });
      const data = await response.json();
      if (!response.ok) {
        setSupportErrors((current) => ({
          ...current,
          [request.id]: { desired, message: data.error ?? "We couldn't update your support. Please try again." },
        }));
        return;
      }
      const updated: FeatureRequest = data.request;
      if (updated?.id !== request.id || typeof updated.supportCount !== "number"
          || typeof updated.supportedByViewer !== "boolean") {
        throw new Error("Unexpected response");
      }
      setRequests((current) => current.map((item) => item.id === updated.id ? updated : item));
      setSupportAnnouncement(`Support ${updated.supportedByViewer ? "added to" : "removed from"} ${updated.title}. ${updated.supportCount} ${updated.supportCount === 1 ? "supporter" : "supporters"}.`);
    } catch {
      setSupportErrors((current) => ({
        ...current,
        [request.id]: {
          desired,
          message: "We couldn't confirm the update. Retry to check and finish the same action.",
        },
      }));
    } finally {
      supportLocks.current.delete(request.id);
      setPendingSupport(new Set(supportLocks.current));
    }
  }

  const visibleRequests = filterRequests(requests, query);
  const hasQuery = query.normalize("NFKC").trim().length > 0;

  function clearSearch() {
    setQuery("");
    searchInput.current?.focus();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLock.current || loadStateRef.current !== "ready") return;
    setSuccess("");
    setFormError("");
    const errors: FieldErrors = {};
    if (!title.trim()) errors.title = "Give your request a title.";
    else if (title.trim().length > 120) errors.title = "Keep the title to 120 characters or fewer.";
    if (!description.trim()) errors.description = "Describe the problem you want to solve.";
    else if (description.trim().length > 4000) errors.description = "Keep the description to 4,000 characters or fewer.";
    setFieldErrors(errors);
    if (Object.keys(errors).length) {
      (errors.title ? titleInput : descriptionInput).current?.focus();
      return;
    }

    submitLock.current = true;
    setSubmitting(true);
    try {
      const response = await fetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), description: description.trim() }),
      });
      const data = await response.json();
      if (!response.ok) {
        setFieldErrors(data.fieldErrors ?? {});
        setFormError(data.error ?? "Your request couldn’t be saved. Please try again.");
        return;
      }
      if (!data.request?.id) throw new Error("Unexpected response");
      setRequests((current) => [data.request, ...current]);
      setQuery("");
      setTitle("");
      setDescription("");
      setFieldErrors({});
      setSuccess(hasQuery ? "Request added. Search cleared so you can see it at the top of the board." : "Request added. You’ll find it at the top of the board.");
      if (intelligence.overview?.available) void intelligence.analyze(data.request.id);
    } catch {
      setFormError("We couldn’t confirm that your request was saved. Refresh the board before trying again; your draft is still here.");
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href="/" aria-label="Signal home"><SignalMark /><span>signal<span className="brand-period">.</span></span></a>
          <div className="workspace-label"><span className="header-divider" /><span>Product workspace</span></div>
          <span className="current-view"><span className="nav-dot" />Request board</span>
        </div>
      </header>

      <main id="main-content" className="workspace">
        <section className="intro" aria-labelledby="page-heading">
          <div>
            <p className="eyebrow"><span />THE START OF SOMETHING BETTER</p>
            <h1 id="page-heading">Every request starts<br />with a <em>problem.</em></h1>
            <p className="intro-description">Capture what’s missing, what’s getting in the way,<br className="desktop-break" /> and what could make the product better.</p>
          </div>
          <div className="intro-aside" aria-hidden="true"><span className="aside-rule" /><p>A little feedback.<br />A better direction.</p><svg width="42" height="31" viewBox="0 0 42 31" fill="none"><path d="M2 3c14 0 22 7 24 24m-8-6 8 7 8-8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></div>
        </section>

        <IntelligenceStatus intelligence={intelligence} />
        <p className="visually-hidden" role="status" aria-live="polite">{intelligence.announcement}</p>

        <div className="board-layout">
          <section className="board" aria-labelledby="board-heading" aria-busy={loadState === "loading"}>
            <div className="section-heading">
              <div className="section-title"><h2 id="board-heading">The request board</h2>{loadState === "ready" && <span className="count-badge" aria-label={`${requests.length} requests`}>{requests.length}</span>}</div>
              <span className="sort-label"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 3h10M3 8h7M3 13h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>Newest first</span>
            </div>

            <div className="board-search" role="search" aria-label="Find requests">
              <label className="visually-hidden" htmlFor="request-search">Search requests</label>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.5" /><path d="m16 16 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              <input
                ref={searchInput}
                id="request-search"
                type="search"
                placeholder="Search titles and descriptions"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-describedby="search-results"
              />
              {query.length > 0 && <button type="button" className="clear-search" onClick={clearSearch} aria-label="Clear search">×</button>}
            </div>
            <div className="board-context">
              <p id="search-results" role="status" aria-live="polite">
                {loadState === "ready" ? hasQuery
                  ? `${visibleRequests.length} of ${requests.length} requests match`
                  : `${requests.length} ${requests.length === 1 ? "request" : "requests"}`
                  : "Search titles and descriptions"}
              </p>
              <p>One support per browser. Click again to remove it.</p>
            </div>
            <p className="visually-hidden" role="status" aria-live="polite">{supportAnnouncement}</p>

            {loadState === "loading" && <div className="loading-panel" role="status"><span className="loading-spinner" />Loading requests…</div>}

            {loadState === "error" && <div className="board-message" role="alert"><div className="message-symbol">!</div><h3>The board couldn’t load.</h3><p>Your requests may still be saved. Try loading them again.</p><button className="secondary-button" type="button" onClick={() => void loadRequests()}>Try again <span aria-hidden="true">↻</span></button></div>}

            {loadState === "ready" && requests.length === 0 && <div className="empty-board">
              <div className="empty-illustration" aria-hidden="true"><div className="illustration-card back-card" /><div className="illustration-card front-card"><span className="illustration-dot" /><span className="illustration-line long" /><span className="illustration-line" /><span className="illustration-line short" /></div><span className="illustration-plus">+</span></div>
              <p className="empty-overline">A CLEAN SLATE</p><h3>Good ideas need a place to land.</h3><p>What’s one thing you wish worked better?<br />Add the first request and start the conversation.</p><button className="text-button empty-action" type="button" onClick={() => { titleInput.current?.scrollIntoView({ behavior: "smooth", block: "center" }); titleInput.current?.focus({ preventScroll: true }); }}>Write the first request <ArrowIcon /></button>
              <div className="empty-footer"><span />Small frustrations count, too.</div>
            </div>}

            {loadState === "ready" && requests.length > 0 && visibleRequests.length === 0 && (
              <div className="no-results">
                <span className="no-results-icon" aria-hidden="true">⌕</span>
                <h3>No requests match that search.</h3>
                <p>Try a different word, or clear the search to see every request.</p>
                <button className="secondary-button" type="button" onClick={clearSearch}>Show all requests <span aria-hidden="true">↗</span></button>
              </div>
            )}

            {loadState === "ready" && visibleRequests.length > 0 && (
              <div className="request-list">
                {visibleRequests.map((request) => (
                  <RequestCard
                    key={request.id}
                    request={request}
                    pending={pendingSupport.has(request.id)}
                    failure={supportErrors[request.id]}
                    onSupport={(item, desired) => void updateSupport(item, desired)}
                    requests={requests}
                    intelligence={intelligence}
                    onNavigate={navigateToRequest}
                  />
                ))}
              </div>
            )}
          </section>

          <aside className="compose-column" aria-labelledby="compose-heading">
            <div className="compose-card">
              <div className="compose-heading"><span className="compose-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="m14 5 5 5M4 20l5-1 11-11a2.1 2.1 0 0 0-5-5L4 15l-1 6 6-2" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /></svg></span><span className="compose-kicker">HAVE SOMETHING IN MIND?</span></div>
              <h2 id="compose-heading">Make a request.</h2><p className="compose-description">Tell us what would make a difference.</p>

              <form onSubmit={handleSubmit} noValidate aria-busy={submitting}>
                <div className="form-field"><div className="label-row"><label htmlFor="request-title">Title</label><span className="field-count" aria-hidden="true">{title.length}/120</span></div><input ref={titleInput} id="request-title" name="title" placeholder="e.g. Schedule a weekly report" value={title} maxLength={120} required disabled={submitting} aria-invalid={Boolean(fieldErrors.title)} aria-describedby={fieldErrors.title ? "title-error" : undefined} onChange={(event) => { setTitle(event.target.value); setFieldErrors((current) => ({ ...current, title: undefined })); setSuccess(""); }} />{fieldErrors.title && <p className="field-error" id="title-error">{fieldErrors.title}</p>}</div>
                <div className="form-field"><div className="label-row"><label htmlFor="request-description">What problem would this solve?</label></div><textarea ref={descriptionInput} id="request-description" name="description" placeholder="What are you trying to do? What gets in the way? A real example helps." value={description} maxLength={4000} required disabled={submitting} aria-invalid={Boolean(fieldErrors.description)} aria-describedby={`description-hint${fieldErrors.description ? " description-error" : ""}`} onChange={(event) => { setDescription(event.target.value); setFieldErrors((current) => ({ ...current, description: undefined })); setSuccess(""); }} /><div className="description-meta"><span id="description-hint">A few specific details go a long way.</span><span aria-hidden="true">{description.length.toLocaleString()}/4,000</span></div>{fieldErrors.description && <p className="field-error" id="description-error">{fieldErrors.description}</p>}</div>
                {formError && <div className="form-error" role="alert"><p>{formError}</p><button type="button" className="text-button" disabled={submitting || pendingSupport.size > 0} onClick={() => void loadRequests()}>Refresh board <span aria-hidden="true">↻</span></button></div>}
                <button className="submit-button" type="submit" disabled={submitting || loadState !== "ready"}>{submitting ? <><span className="loading-spinner" />Saving request…</> : <>Submit request <ArrowIcon /></>}</button>
                <div className="success-message" role="status" aria-live="polite">{success && <><span aria-hidden="true">✓</span>{success}</>}</div>
              </form>
            </div>
            <div className="writing-note"><span className="note-mark" aria-hidden="true">↳</span><p><strong>Start with the why.</strong><br />The best requests explain the problem.<br />The solution can come later.</p></div>
          </aside>
        </div>
        <footer className="workspace-footer"><span><SignalMark small />Less noise. More understanding.</span><span>Built around the people using your product.</span></footer>
      </main>
    </>
  );
}
