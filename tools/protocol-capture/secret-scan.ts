import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

export type SecretFinding = { file: string; rule: string; line: number };

const RULES: Array<[string, RegExp]> = [
  ["common-sk-key", /\bsk-[A-Za-z0-9_-]{8,}\b/],
  ["authorization-bearer", /Authorization["']?\s*[:=]\s*["']?Bearer\s+(?!<REDACTED_)[^\s"']+/i],
  ["x-api-key", /x-api-key["']?\s*[:=]\s*["']?(?!<REDACTED_)[^\s,"'}]+/i],
  ["cookie", /(?:^|["'\s])(?:Cookie|Set-Cookie)["']?\s*[:=]\s*["']?(?!<REDACTED_)[^\n"']+/i],
  ["credentialed-git-url", /https?:\/\/(?!<REDACTED_)[^\s/@:]+:[^\s/@]+@/i],
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
];

export function scanTextForSecrets(text: string, file = "<memory>"): SecretFinding[] {
  const findings: SecretFinding[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const [rule, pattern] of RULES) {
      if (pattern.test(line)) findings.push({ file, rule, line: index + 1 });
    }
  });
  return findings;
}

async function filesBelow(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(path));
    else result.push(path);
  }
  return result;
}

export async function scanFixtureDirectory(root: string): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];
  for (const file of await filesBelow(root)) {
    if (/^\.env(?:\.|$)/.test(file.split("/").at(-1) ?? "")) {
      findings.push({ file, rule: "env-file", line: 1 });
      continue;
    }
    if (![".json", ".md", ".sse", ".txt"].includes(extname(file))) continue;
    findings.push(...scanTextForSecrets(await readFile(file, "utf8"), file));
  }
  return findings;
}
