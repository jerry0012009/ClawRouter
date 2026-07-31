import { createHash } from "node:crypto";
import { estimateVisibleTokens } from "../acu/judge.js";

export type JudgeContextPolicy = "full_native" | "loss_aware_compacted";
export type CompactedContextItem = {
  originalType: string;
  role?: string;
  toolName?: string;
  status?: string;
  originalBytes: number;
  sha256: string;
  head?: string;
  tail?: string;
};
export type JudgeContextBuildResult = {
  policy: JudgeContextPolicy;
  body: string;
  originalTokenEstimate: number;
  submittedTokenEstimate: number;
  compacted: boolean;
  compactedItemCount: number;
};

function compactString(value: string, item: CompactedContextItem): CompactedContextItem {
  const head = value.slice(0, 2_000);
  const tail = value.slice(-2_000);
  return { ...item, head, tail };
}

function shouldCompact(key: string, value: string, status?: string): boolean {
  if (status && /error|failed|rejected|timeout|test_failure/i.test(status)) return false;
  return value.length > 12_000 && /content|output|result|stdout|stderr|body|text/i.test(key);
}

function compactValue(value: unknown, key: string, role: string | undefined, items: CompactedContextItem[], status?: string): unknown {
  if (typeof value === "string" && shouldCompact(key, value, status) && !["user", "developer", "system"].includes(role ?? "")) {
    items.push(compactString(value, {
      originalType: key,
      role,
      originalBytes: Buffer.byteLength(value, "utf8"),
      sha256: createHash("sha256").update(value).digest("hex"),
    }));
    return `[COMPACTED_CONTEXT_ITEM sha256=${items.at(-1)!.sha256} head/tail retained]`;
  }
  if (Array.isArray(value)) return value.map((entry) => compactValue(entry, key, role, items, status));
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const nextRole = typeof object.role === "string" ? object.role : role;
  const nextStatus = typeof object.status === "string" ? object.status : status;
  return Object.fromEntries(Object.entries(object).map(([childKey, childValue]) => [
    childKey, compactValue(childValue, childKey, nextRole, items, nextStatus),
  ]));
}

export function buildJudgeNativeContext(input: {
  rawRequest: string;
  policy?: JudgeContextPolicy;
  compactThresholdTokens?: number;
}): JudgeContextBuildResult {
  const policy = input.policy ?? (process.env.ACU_JUDGE_CONTEXT_POLICY as JudgeContextPolicy | undefined) ?? "full_native";
  const originalTokenEstimate = estimateVisibleTokens(input.rawRequest);
  if (policy !== "loss_aware_compacted"
    || originalTokenEstimate < (input.compactThresholdTokens ?? Number(process.env.ACU_JUDGE_COMPACT_THRESHOLD_TOKENS ?? 100_000))) {
    return { policy: "full_native", body: input.rawRequest, originalTokenEstimate, submittedTokenEstimate: originalTokenEstimate, compacted: false, compactedItemCount: 0 };
  }
  try {
    const parsed = JSON.parse(input.rawRequest) as unknown;
    const items: CompactedContextItem[] = [];
    const compacted = compactValue(parsed, "root", undefined, items);
    const body = JSON.stringify(compacted);
    return { policy, body, originalTokenEstimate, submittedTokenEstimate: estimateVisibleTokens(body), compacted: items.length > 0, compactedItemCount: items.length };
  } catch {
    return { policy: "full_native", body: input.rawRequest, originalTokenEstimate, submittedTokenEstimate: originalTokenEstimate, compacted: false, compactedItemCount: 0 };
  }
}
