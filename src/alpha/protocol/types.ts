import type { AlphaProtocol } from "../repository.js";
import type { ToolCapability } from "../routing.js";

export type CanonicalToolCall = {
  id: string;
  name: string;
  input: unknown;
  sourceIndex: number;
};

export type CanonicalToolResult = {
  toolCallId: string;
  content: unknown;
  isError: boolean;
  sourceIndex: number;
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

export type WebIntent = "required" | "likely" | "not_required";

export type CanonicalEnvelope = {
  protocol: AlphaProtocol;
  requestedModel: string;
  stream: boolean;
  instructions: unknown;
  history: unknown[];
  tools: unknown[];
  requiredToolTypes: ToolCapability[];
  clientDeclaredWebTool: boolean;
  webIntent: WebIntent;
  webActuallyInvoked: boolean;
  humanCandidates: CanonicalHumanCandidate[];
  toolCalls: CanonicalToolCall[];
  toolResults: CanonicalToolResult[];
  planning: PlanningSignals;
  reasoningEffort?: string;
  containsThinking: boolean;
  thinkingSignatures: string[];
  historyHash: string;
  raw: Record<string, unknown>;
};

export type NativeRequestHeaders = Record<string, string | string[] | undefined>;
