"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  IntelligenceOverview,
  RequestIntelligence,
  ReviewDecision,
} from "../lib/analysis-types";
import type { FeatureRequest } from "../lib/requests";

type ReviewInput = {
  analysisId: string;
  relatedRequestId: string;
  decision: "accepted" | "rejected";
};

export function useIntelligence(enabled: boolean) {
  const [overview, setOverview] = useState<IntelligenceOverview | null>(null);
  const [overviewError, setOverviewError] = useState("");
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [pendingAnalyses, setPendingAnalyses] = useState<Set<string>>(new Set());
  const [pendingReviews, setPendingReviews] = useState<Set<string>>(new Set());
  const [analysisErrors, setAnalysisErrors] = useState<Record<string, string>>({});
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");
  const analysisLocks = useRef(new Set<string>());
  const reviewLocks = useRef(new Set<string>());
  const overviewController = useRef<AbortController | null>(null);
  const overviewInFlight = useRef(false);
  const revision = useRef(0);
  const mounted = useRef(true);

  const refreshOverview = useCallback(async () => {
    // A slow status read should finish or time out, not be cancelled by every
    // polling tick. Mutations explicitly invalidate reads that may be stale.
    if (overviewInFlight.current) return;
    const controller = new AbortController();
    overviewController.current = controller;
    overviewInFlight.current = true;
    const requestedRevision = revision.current;
    setOverviewLoading(true);
    try {
      const response = await fetch("/api/analysis", {
        cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
      });
      if (!response.ok) throw new Error("Could not load analysis status");
      const data: IntelligenceOverview = await response.json();
      if (typeof data.available !== "boolean" || !data.byRequest || typeof data.byRequest !== "object") {
        throw new Error("Unexpected analysis status");
      }
      if (mounted.current && !controller.signal.aborted && requestedRevision === revision.current) {
        setOverview(data);
        setOverviewError("");
        setAnalysisErrors(current => Object.fromEntries(Object.entries(current)
          .filter(([id]) => data.byRequest[id]?.analysis?.status !== "completed")));
      }
    } catch {
      if (mounted.current && !controller.signal.aborted && requestedRevision === revision.current) {
        setOverviewError("We couldn't load the analysis status. Your requests are still available.");
      }
    } finally {
      if (overviewController.current === controller) {
        overviewInFlight.current = false;
        if (mounted.current) setOverviewLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      overviewController.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (enabled) void refreshOverview();
  }, [enabled, refreshOverview]);

  const hasRunning = pendingAnalyses.size > 0
    || Object.values(overview?.byRequest ?? {}).some(value => value.analysis?.status === "running");

  useEffect(() => {
    if (!enabled || !hasRunning) return;
    const interval = window.setInterval(() => void refreshOverview(), 2_000);
    return () => window.clearInterval(interval);
  }, [enabled, hasRunning, refreshOverview]);

  function invalidateOverview() {
    revision.current++;
    overviewController.current?.abort();
    overviewInFlight.current = false;
  }

  function updateSnapshot(requestId: string, intelligence: RequestIntelligence) {
    invalidateOverview();
    setOverview(current => current ? {
      ...current,
      byRequest: { ...current.byRequest, [requestId]: intelligence },
    } : current);
  }

  async function analyze(requestId: string, force = false) {
    if (!enabled || !overview?.available || analysisLocks.current.has(requestId)) return;
    analysisLocks.current.add(requestId);
    invalidateOverview();
    setPendingAnalyses(new Set(analysisLocks.current));
    setAnalysisErrors(current => ({ ...current, [requestId]: "" }));
    setAnnouncement("");
    try {
      const response = await fetch(`/api/requests/${encodeURIComponent(requestId)}/analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
        signal: AbortSignal.timeout(65_000),
      });
      const data = await response.json();
      if (!mounted.current) return;
      if (data.intelligence) updateSnapshot(requestId, data.intelligence);
      if (!response.ok) {
        setAnalysisErrors(current => ({
          ...current,
          [requestId]: data.error ?? "We couldn't finish the analysis. Your request is saved; try again.",
        }));
      } else if (!data.intelligence) {
        throw new Error("Unexpected analysis response");
      } else if (data.intelligence.analysis?.status === "completed") {
        setAnnouncement("Analysis is ready. Review the evidence before linking requests.");
      }
    } catch {
      if (mounted.current) {
        setAnalysisErrors(current => ({
          ...current,
          [requestId]: "We couldn't confirm the analysis finished. Check its status or retry; your request is saved.",
        }));
      }
    } finally {
      analysisLocks.current.delete(requestId);
      if (mounted.current) {
        setPendingAnalyses(new Set(analysisLocks.current));
        void refreshOverview();
      }
    }
  }

  async function review(requestId: string, input: ReviewInput) {
    const key = `${requestId}:${input.relatedRequestId}`;
    if (reviewLocks.current.has(key)) return;
    reviewLocks.current.add(key);
    invalidateOverview();
    setPendingReviews(new Set(reviewLocks.current));
    setReviewErrors(current => ({ ...current, [requestId]: "" }));
    setAnnouncement("");
    try {
      const response = await fetch(`/api/requests/${encodeURIComponent(requestId)}/review`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(12_000),
      });
      const data = await response.json();
      if (!mounted.current) return;
      if (!response.ok) {
        setReviewErrors(current => ({
          ...current,
          [requestId]: response.status === 409
            ? "This analysis changed. Check the latest suggestions before reviewing again."
            : data.error ?? "We couldn't save your decision. Please try again.",
        }));
      } else if (data.intelligence) {
        updateSnapshot(requestId, data.intelligence);
        setAnnouncement(input.decision === "accepted"
          ? "Requests linked. Their original text and support stay separate."
          : "Suggestion dismissed. Your decision has been saved.");
      } else {
        throw new Error("Unexpected review response");
      }
    } catch {
      if (mounted.current) {
        setReviewErrors(current => ({
          ...current,
          [requestId]: "We couldn't confirm that decision was saved. Check the latest status before trying again.",
        }));
      }
    } finally {
      reviewLocks.current.delete(key);
      if (mounted.current) {
        setPendingReviews(new Set(reviewLocks.current));
        void refreshOverview();
      }
    }
  }

  async function unlink(requestId: string, decision: ReviewDecision) {
    const key = `${requestId}:${decision.relatedRequestId}`;
    if (reviewLocks.current.has(key)) return;
    reviewLocks.current.add(key);
    invalidateOverview();
    setPendingReviews(new Set(reviewLocks.current));
    setReviewErrors(current => ({ ...current, [requestId]: "" }));
    setAnnouncement("");
    try {
      const response = await fetch(`/api/requests/${encodeURIComponent(requestId)}/links/${encodeURIComponent(decision.relatedRequestId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysisId: decision.analysisId }),
        signal: AbortSignal.timeout(12_000),
      });
      const data = await response.json();
      if (!mounted.current) return;
      if (!response.ok) {
        setReviewErrors(current => ({
          ...current,
          [requestId]: response.status === 409
            ? "This link changed. Check its latest status before removing it."
            : data.error ?? "We couldn't remove the link. Please try again.",
        }));
      } else if (data.intelligence) {
        updateSnapshot(requestId, data.intelligence);
        setAnnouncement("Link removed. Both original requests are unchanged.");
      } else {
        throw new Error("Unexpected unlink response");
      }
    } catch {
      if (mounted.current) setReviewErrors(current => ({
        ...current,
        [requestId]: "We couldn't confirm that the link was removed. Check its status before trying again.",
      }));
    } finally {
      reviewLocks.current.delete(key);
      if (mounted.current) {
        setPendingReviews(new Set(reviewLocks.current));
        void refreshOverview();
      }
    }
  }

  return {
    overview, overviewError, overviewLoading, pendingAnalyses, pendingReviews,
    analysisErrors, reviewErrors, announcement, refreshOverview, analyze, review, unlink,
  };
}

type IntelligenceControls = ReturnType<typeof useIntelligence>;

export function IntelligenceStatus({ intelligence }: { intelligence: IntelligenceControls }) {
  const { overview, overviewError, overviewLoading, refreshOverview } = intelligence;
  return (
    <div className={`intelligence-status${overview?.available ? " is-connected" : ""}`}>
      <span className="intelligence-symbol" aria-hidden="true">↗</span>
      <div>
        <strong>From feedback to understanding</strong>
        {overviewError ? <p role="alert">{overviewError}</p>
          : !overview ? <p role="status">Checking AI analysis availability…</p>
          : overview.available
            ? <p>AI suggests the connections. You review the evidence and decide what belongs together.</p>
            : <p>AI analysis is not connected yet. Requests are still saved.</p>}
      </div>
      {(overviewError || (overview && !overview.available)) && (
        <button type="button" className="text-button" disabled={overviewLoading} onClick={() => void refreshOverview()}>
          {overviewLoading ? "Checking…" : "Check status"}
        </button>
      )}
    </div>
  );
}

function ReviewedLabel({ review }: { review?: ReviewDecision }) {
  if (!review) return <span className="review-label">Needs review</span>;
  return <span className={`review-label is-${review.decision}`}>
    {review.decision === "accepted" ? "Linked" : "Dismissed"}
  </span>;
}

export function RequestIntelligencePanel({ request, requests, intelligence, onNavigate }: {
  request: FeatureRequest;
  requests: FeatureRequest[];
  intelligence: IntelligenceControls;
  onNavigate: (id: string) => void;
}) {
  const item = intelligence.overview?.byRequest[request.id];
  const run = item?.analysis;
  const result = run?.status === "completed" ? run.result : null;
  const running = intelligence.pendingAnalyses.has(request.id) || run?.status === "running";
  const available = intelligence.overview?.available === true;
  const error = intelligence.analysisErrors[request.id] || (run?.status === "failed" ? run.error : null);
  const [expanded, setExpanded] = useState(false);
  const wasRunning = useRef(false);
  const accepted = (item?.reviews ?? []).filter(review => review.decision === "accepted");

  useEffect(() => {
    if (wasRunning.current && !running && run?.status === "completed") setExpanded(true);
    wasRunning.current = running;
  }, [running, run?.status]);

  return (
    <section className="request-intelligence" aria-label={`Analysis for ${request.title}`}>
      <div className="intelligence-toolbar">
        <span className="intelligence-heading"><span aria-hidden="true">↗</span>Request insight</span>
        {result && <span className="theme-label">{result.theme}</span>}
        <button
          type="button"
          className="text-button analyze-button"
          disabled={!available || running}
          onClick={() => void intelligence.analyze(request.id, Boolean(result))}
        >
          {running ? <><span className="loading-spinner" />Analyzing…</>
            : run?.status === "failed" || error ? "Retry analysis"
              : result ? "Analyze again" : "Analyze request"}
        </button>
      </div>
      {running && <p className="analysis-note" role="status">Reading the request and checking related feedback. You can keep using the board.</p>}
      {!running && !result && !error && <p className="analysis-note">
        {available ? "Find the underlying need and possible connections to other requests."
          : intelligence.overview ? "Analysis will be available once AI is connected."
            : intelligence.overviewError ? "Analysis status is unavailable. Check the connection above."
              : "Checking analysis status…"}
      </p>}
      {error && !running && (
        <div className="analysis-error" role="alert">
          <p>{error}</p>
          <button type="button" className="text-button" onClick={() => void intelligence.refreshOverview()}>Check analysis status</button>
        </div>
      )}
      {result && (
        <>
          <button type="button" className="insight-summary" aria-expanded={expanded}
            aria-controls={`insight-${request.id}`} onClick={() => setExpanded(current => !current)}>
            <span>{result.problem}</span><span aria-hidden="true">{expanded ? "−" : "+"}</span>
          </button>
          {expanded && <div id={`insight-${request.id}`} className="insight-detail">
            <p className="evidence-label">From this request</p>
            <blockquote>{result.problemEvidence}</blockquote>
            {result.unknowns.length > 0 && <div className="missing-context">
              <h4>Still worth asking</h4>
              <ul>{result.unknowns.map((unknown, index) => <li key={index}>{unknown}</li>)}</ul>
            </div>}
            <div className="suggestion-heading"><h4>Suggested connections</h4><span>Review required</span></div>
            {result.suggestions.length === 0 && <p className="analysis-note">No clear connection was found among the requests reviewed.</p>}
            {result.suggestions.map(suggestion => {
              const target = requests.find(candidate => candidate.id === suggestion.requestId);
              const review = item?.reviews.find(decision => decision.relatedRequestId === suggestion.requestId);
              const pending = intelligence.pendingReviews.has(`${request.id}:${suggestion.requestId}`);
              return <div className="suggestion-card" key={suggestion.requestId}>
                <div className="suggestion-meta">
                  <span>{suggestion.relationship === "duplicate" ? "Possible duplicate" : "Related problem"}</span>
                  <ReviewedLabel review={review} />
                </div>
                <button type="button" className="related-title" disabled={!target} onClick={() => onNavigate(suggestion.requestId)}>
                  {target?.title ?? "Related request is unavailable"}<span aria-hidden="true">↗</span>
                </button>
                <p className="suggestion-reason">{suggestion.reason}</p>
                <details className="suggestion-evidence">
                  <summary>Compare the evidence</summary>
                  <p className="evidence-label">This request</p><blockquote>{suggestion.sourceEvidence}</blockquote>
                  <p className="evidence-label">Related request</p><blockquote>{suggestion.targetEvidence}</blockquote>
                </details>
                <div className="review-actions">
                  <button type="button" className="review-accept" disabled={pending || !target || review?.decision === "accepted"}
                    onClick={() => void intelligence.review(request.id, { analysisId: run!.id, relatedRequestId: suggestion.requestId, decision: "accepted" })}>
                    {pending ? "Saving…" : review?.decision === "accepted" ? "Linked" : "Link requests"}
                  </button>
                  <button type="button" className="review-dismiss" disabled={pending || !target || review?.decision === "rejected"}
                    onClick={() => void intelligence.review(request.id, { analysisId: run!.id, relatedRequestId: suggestion.requestId, decision: "rejected" })}>
                    {review?.decision === "rejected" ? "Dismissed" : review?.decision === "accepted" ? "Remove link" : "Dismiss suggestion"}
                  </button>
                </div>
              </div>;
            })}
            <p className="analysis-provenance">{run!.candidateCount} other {run!.candidateCount === 1 ? "request" : "requests"} reviewed. Suggestions are not product decisions.</p>
          </div>}
        </>
      )}
      {intelligence.reviewErrors[request.id] && <div className="analysis-error" role="alert">
        <p>{intelligence.reviewErrors[request.id]}</p>
        <button type="button" className="text-button" onClick={() => void intelligence.refreshOverview()}>Refresh analysis</button>
      </div>}
      {accepted.length > 0 && <div className="accepted-links">
        <h4>Linked by review</h4>
        <ul>{accepted.map(review => {
          const target = requests.find(candidate => candidate.id === review.relatedRequestId);
          const pending = intelligence.pendingReviews.has(`${request.id}:${review.relatedRequestId}`);
          return <li key={review.relatedRequestId}>
            <button type="button" disabled={!target} onClick={() => onNavigate(review.relatedRequestId)}>
              {target?.title ?? "Request unavailable"}<span aria-hidden="true">↗</span>
            </button>
            <button type="button" className="unlink-button" disabled={pending}
              aria-label={`Unlink ${target?.title ?? "request"}`}
              onClick={() => void intelligence.unlink(request.id, review)}>
              {pending ? "Saving…" : "Unlink"}
            </button>
          </li>;
        })}</ul>
        <p>Original requests and support counts stay separate.</p>
      </div>}
    </section>
  );
}
