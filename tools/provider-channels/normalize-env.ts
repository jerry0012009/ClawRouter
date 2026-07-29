#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type ParsedChannelSecret = {
  originalVariable: string;
  providerId: "lucen" | "blackai";
  routingGroupName: string;
  routingGroupSlug: string;
  apiKey: string;
  fingerprint: string;
  duplicate: boolean;
  primaryBaseUrl: string;
  networkFallbackBaseUrls: string[];
  observedBillingMultiplier: number | null;
  protocolCandidates: string[];
};

export type ParsedEnvInventory = {
  preservedAssignments: Array<{ name: string; value: string }>;
  channels: ParsedChannelSecret[];
  needsMapping: Array<{ originalVariable: string; fingerprint: string; reason: string }>;
};

const SECRET = /sk-[A-Za-z0-9._-]{12,}/g;
const RAW_SECRET = /^[A-Za-z0-9_+./-]{40,}={0,2}$/;

export const GROUP_SLUGS: Record<string, string> = {
  "codex混合渠道--低价1x": "codex_mix_low",
  "纯pro渠道1.4x": "pro_1_4",
  "claude-code逆向1x": "claude_reverse",
  "grok 1x": "grok",
  "生图 1.4x": "image",
  "codex混合渠道_现在暂时pro兜底，其他渠道挂了 1x": "codex_mix_pro_fallback",
  "国产只能生图-3毛一张 0.1x": "cn_image_010",
  "国模-非官方-有k3-0.15x": "cn_models_k3_015",
  "稳定grok-020-0.2x": "grok_020",
  "只能api生图分组-3分一张-0.03x": "image_003",
  "只能api生图分组-6分一张-0.06x": "image_006",
  "只能api生图分组-高质量-8分一张-0.08x": "image_008",
  "cc-高仿山寨0.2": "claude_clone_020",
  "cc-cursur-逆向-0.3x": "claude_cursor_reverse_030",
  "cx003-低价": "cx003_low",
  "cx004-低价独立线路-0.04x": "cx004_low_dedicated",
  "cx006-性价比-动态调价-0.06x": "cx006_value_dynamic",
  "cx-006-plus-0.06x": "cx006_plus",
  "cx008-plus-独立线路-0.08x": "cx008_plus_dedicated",
  "cx010-plus-极速-0.1x": "cx010_plus_fast",
  "cx012-pro-0.12x": "cx012_pro",
  "cx014-pro-保不断-0.14x": "cx014_pro_stable",
  "cx017-pro-保首字,不断-0.17x": "cx017_pro_first_token",
  "cx025-pro-尊享-0.25x": "cx025_pro_premium",
  "gemini生图-1/4k-0.08x": "gemini_image_008",
  "gemeni生图1k/2k-0.07x": "gemini_image_007",
  "no.11-cc-aws逆向-0.4": "claude_aws_reverse_040",
  "no.12-ccmax-0.9": "claude_max_090",
  "no.13-cc-anti反重力逆向-0.4": "claude_antigravity_reverse_040",
  "gemini-低道德-0.3x-openai协议": "gemini_openai_030",
  "no.15-主流国产-cc协议-0.3x": "mainstream_cn_claude_030",
  "grok-openai协议-0.06": "grok_openai_006",
  "kiro高缓存-玄学-cc协议-0.15x": "kiro_cache_claude_015",
  "glm官方key专线-cc协议-0.3": "glm_official_claude_030",
  "glm官方key-openai协议-0.3x": "glm_official_openai_030",
  "qwen官方key专线-cc协议-0.1x": "qwen_official_claude_010",
  "qwen官方key-openai协议-0.1x": "qwen_official_openai_010",
  "grok-0.06": "grok_006",
  "deepseek-openai协议-0.5": "deepseek_openai_050",
  "deepseek-cc协议-0.5": "deepseek_claude_050",
  "kimi-k3专线-cc协议-0.4": "kimi_k3_claude_040",
  "kimi-k3-openai协议-0.4x": "kimi_k3_openai_040",
  "cc协议-kiro缓存90%-0.06x": "kiro_cache90_claude_006",
  "cc协议-kiro-70%缓存-0.06": "kiro_cache70_claude_006",
  "ccmax-不限-检测双100-1x": "claude_max_unlimited_100",
  "gemini逆向-gemini协议-0.3": "gemini_reverse_native_030"
};

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function inferProtocolCandidates(group: string): string[] {
  const lower = group.toLowerCase();
  if (lower.includes("生图")) return ["images"];
  if (lower.includes("gemini") && !lower.includes("openai")) return ["gemini_native"];
  if (lower.includes("claude") || lower.includes("cc") || lower.includes("专线")) return ["messages"];
  return ["responses"];
}

export function inferMultiplier(group: string): number | null {
  const explicit = [...group.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*x\b/gi)];
  if (explicit.length) return Number(explicit.at(-1)![1]);
  const trailing = /[- _]([0-9]+(?:\.[0-9]+)?)$/.exec(group);
  return trailing ? Number(trailing[1]) : null;
}

function cleanLine(line: string): string {
  return line.trim().replace(/^[“”]+|[“”]+$/g, "").trim();
}

function assignment(line: string): { name: string; value: string } | undefined {
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(cleanLine(line));
  if (!match) return undefined;
  let value = match[2].trim();
  const comment = value.indexOf(" #");
  if (comment >= 0) value = value.slice(0, comment).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { name: match[1], value };
}

function hostProvider(line: string): "lucen" | "blackai" | undefined {
  if (/lucen\.cc/i.test(line)) return "lucen";
  if (/blackaicoding\.com|vangularcode\.asia/i.test(line)) return "blackai";
  return undefined;
}

function secretsInLine(line: string, parsed?: { name: string; value: string }): string[] {
  const secrets = line.match(SECRET) ?? [];
  if (parsed && /(api.?key|auth.?token|secret)/i.test(parsed.name)
    && parsed.value.length >= 24 && !secrets.includes(parsed.value)) {
    secrets.push(parsed.value);
  }
  if (!parsed && RAW_SECRET.test(line) && !secrets.includes(line)) secrets.push(line);
  return secrets;
}

export function parseProviderEnv(text: string): ParsedEnvInventory {
  const preservedAssignments: Array<{ name: string; value: string }> = [];
  const channels: ParsedChannelSecret[] = [];
  const needsMapping: ParsedEnvInventory["needsMapping"] = [];
  const seenFingerprints = new Set<string>();
  let provider: "lucen" | "blackai" | undefined;
  let pendingGroup: string | undefined;
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = cleanLine(rawLine);
    if (!line || line.startsWith("#")) continue;
    provider = hostProvider(line) ?? provider;
    const parsedAssignment = assignment(line);
    const secrets = secretsInLine(line, parsedAssignment);
    if (secrets.length === 0) {
      if (parsedAssignment) {
        const isProviderSetting = /^(?:GOOGLE_GEMINI_BASE_URL|ANTHROPIC_BASE_URL|GEMINI_MODEL|CLAUDE_CODE_)/.test(parsedAssignment.name)
          || ["model_provider", "model", "review_model", "model_reasoning_effort", "disable_response_storage", "network_access", "windows_wsl_setup_acknowledged", "name", "base_url", "wire_api", "requires_openai_auth", "goals", "default", "web_search", "api_backend", "context_window", "supports_backend_search"].includes(parsedAssignment.name);
        if (!isProviderSetting && index < 6) preservedAssignments.push(parsedAssignment);
      } else if (!line.startsWith("[") && !/^https?:\/\//i.test(line)) {
        pendingGroup = line;
      }
      continue;
    }
    for (const apiKey of secrets) {
      const keyFingerprint = fingerprint(apiKey);
      if (seenFingerprints.has(keyFingerprint)) continue;
      seenFingerprints.add(keyFingerprint);
      const originalVariable = parsedAssignment?.name ?? `UNNAMED_LINE_${index + 1}`;
      const groupSlug = pendingGroup ? GROUP_SLUGS[pendingGroup] : undefined;
      if (!provider || !pendingGroup || !groupSlug) {
        needsMapping.push({ originalVariable, fingerprint: keyFingerprint, reason: "provider_or_group_not_reliably_mapped" });
        if (parsedAssignment && !preservedAssignments.some((item) => item.name === parsedAssignment.name)) {
          preservedAssignments.push(parsedAssignment);
        }
        continue;
      }
      channels.push({
        originalVariable,
        providerId: provider,
        routingGroupName: pendingGroup,
        routingGroupSlug: groupSlug,
        apiKey,
        fingerprint: keyFingerprint,
        duplicate: false,
        primaryBaseUrl: provider === "lucen" ? "https://lucen.cc" : "https://blackaicoding.com",
        networkFallbackBaseUrls: provider === "blackai"
          ? ["https://hello.vangularcode.asia/v1", "https://www.blackaicoding.com"]
          : [],
        observedBillingMultiplier: inferMultiplier(pendingGroup),
        protocolCandidates: inferProtocolCandidates(pendingGroup),
      });
    }
  }
  return { preservedAssignments, channels, needsMapping };
}

function envPrefix(channel: ParsedChannelSecret): string {
  return `ACU_CHANNEL_${channel.providerId.toUpperCase()}_${channel.routingGroupSlug.toUpperCase()}`;
}

export function normalizedEnv(inventory: ParsedEnvInventory): string {
  const lines = ["# Normalized by tools/provider-channels/normalize-env.ts. Secrets stay local."];
  for (const item of inventory.preservedAssignments) lines.push(`${item.name}=${item.value}`);
  for (const channel of inventory.channels) {
    const prefix = envPrefix(channel);
    lines.push("", `# ${channel.providerId}: ${channel.routingGroupName} (${channel.fingerprint})`);
    lines.push(`${prefix}_API_KEY=${channel.apiKey}`);
    lines.push(`${prefix}_BASE_URL=${channel.primaryBaseUrl}`);
    channel.networkFallbackBaseUrls.forEach((url, index) => lines.push(`${prefix}_FALLBACK_${index + 1}_BASE_URL=${url}`));
  }
  return `${lines.join("\n")}\n`;
}

export function validateDotenv(text: string): void {
  const names = new Set<string>();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parsed = assignment(line);
    if (!parsed || !/^[A-Z][A-Z0-9_]*$/.test(parsed.name) || parsed.value.length === 0) {
      throw new Error(`Invalid dotenv syntax at line ${index + 1}`);
    }
    if (names.has(parsed.name)) throw new Error(`Duplicate dotenv variable ${parsed.name}`);
    names.add(parsed.name);
  }
}

export async function normalizeEnvFile(path: string): Promise<ParsedEnvInventory> {
  const original = await readFile(path, "utf8");
  const inventory = parseProviderEnv(original);
  const output = normalizedEnv(inventory);
  validateDotenv(output);
  const temp = join(dirname(path), `.${basename(path)}.normalize-${process.pid}`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(output, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600);
  return inventory;
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: normalize-env.ts <dotenv-path>");
  const before = await stat(path);
  if (!before.isFile()) throw new Error("dotenv path is not a file");
  const inventory = await normalizeEnvFile(path);
  console.log(JSON.stringify({
    channelCount: inventory.channels.length,
    needsMappingCount: inventory.needsMapping.length,
    channels: inventory.channels.map((item) => ({
      originalVariable: item.originalVariable,
      provider: item.providerId,
      group: item.routingGroupName,
      baseUrlHost: new URL(item.primaryBaseUrl).host,
      fingerprint: item.fingerprint,
      duplicate: item.duplicate,
      clearlyMapped: true,
      needsMapping: false,
    })),
    needsMapping: inventory.needsMapping,
  }, null, 2));
}

if (process.argv[1]?.endsWith("normalize-env.ts")) {
  main().catch(async (error) => {
    const temp = process.argv[2] ? join(dirname(process.argv[2]), `.${basename(process.argv[2])}.normalize-${process.pid}`) : undefined;
    if (temp) await unlink(temp).catch(() => undefined);
    console.error(error instanceof Error ? error.message : "Normalization failed");
    process.exitCode = 1;
  });
}
