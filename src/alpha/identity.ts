import { canonicalHash } from "./protocol/common.js";
import type { CanonicalEnvelope } from "./protocol/types.js";

export type SessionContinuityRecord = {
  sessionId: string;
  newapiUserId: string;
  protocol: CanonicalEnvelope["protocol"];
  history: unknown[];
  lastToolCallIds: string[];
  clientSessionCandidate?: string;
};

export type SessionContinuityEvidence = {
  newapiUserId: string;
  envelope: CanonicalEnvelope;
  clientSessionCandidate?: string;
};

export type SessionMatch = {
  sessionId?: string;
  confidence: "strong" | "none";
  reasons: string[];
  previousHistoryLength: number;
};

export function isExactHistoryPrefix(previous: unknown[], current: unknown[]): boolean {
  if (previous.length > current.length) return false;
  return previous.every((item, index) => canonicalHash(item) === canonicalHash(current[index]));
}

export function matchSession(
  candidates: SessionContinuityRecord[],
  evidence: SessionContinuityEvidence,
): SessionMatch {
  const eligible = candidates.filter((candidate) => (
    candidate.newapiUserId === evidence.newapiUserId
    && candidate.protocol === evidence.envelope.protocol
  ));
  const matches = eligible.flatMap((candidate) => {
    const reasons: string[] = [];
    if (isExactHistoryPrefix(candidate.history, evidence.envelope.history)) reasons.push("exact_history_prefix");
    const resultIds = new Set(evidence.envelope.toolResults.map((result) => result.toolCallId));
    if (candidate.lastToolCallIds.some((id) => resultIds.has(id))) reasons.push("tool_call_result_causality");
    if (candidate.clientSessionCandidate && evidence.clientSessionCandidate
      && candidate.clientSessionCandidate === evidence.clientSessionCandidate) {
      reasons.push("versioned_client_session_candidate");
    }
    const strong = reasons.includes("exact_history_prefix") || reasons.includes("tool_call_result_causality");
    return strong ? [{ candidate, reasons }] : [];
  });
  if (matches.length !== 1) {
    return { confidence: "none", reasons: matches.length > 1 ? ["ambiguous_strong_matches"] : [], previousHistoryLength: 0 };
  }
  return {
    sessionId: matches[0].candidate.sessionId,
    confidence: "strong",
    reasons: matches[0].reasons,
    previousHistoryLength: matches[0].candidate.history.length,
  };
}
