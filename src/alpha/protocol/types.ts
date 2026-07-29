import type { AlphaProtocol } from "../repository.js";

export type CanonicalToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type CanonicalToolResult = {
  toolCallId: string;
  content: unknown;
  isError: boolean;
};

export type CanonicalHumanCandidate = {
  text: string;
  sourceIndex: number;
  confidence: "high" | "candidate";
};

export type PlanningSignals = {
  started: boolean;
  finished: boolean;
  updated: boolean;
  signalFamily?: string;
  fingerprintVersion?: string;
  evidence: string[];
};

export type CanonicalEnvelope = {
  protocol: AlphaProtocol;
  requestedModel: string;
  stream: boolean;
  instructions: unknown;
  history: unknown[];
  tools: unknown[];
  humanCandidates: CanonicalHumanCandidate[];
  toolCalls: CanonicalToolCall[];
  toolResults: CanonicalToolResult[];
  planning: PlanningSignals;
  containsThinking: boolean;
  thinkingSignatures: string[];
  historyHash: string;
  raw: Record<string, unknown>;
};

export type NativeRequestHeaders = Record<string, string | string[] | undefined>;
