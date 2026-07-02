/**
 * ACU Validator
 *
 * Lightweight quality gates for first-demo routing.
 */

export type ValidatorResult = {
  result: "pass" | "fail" | "not_applicable";
  validator: "json_validator" | "schema_validator" | "none";
  reason?: string;
  qualityScore?: number;
};

type ChatMessage = { role: string; content: unknown };

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join(" ");
}

export function promptNeedsJsonValidation(
  messages: ChatMessage[],
  responseFormat?: unknown,
  expectedSchema?: unknown,
): boolean {
  if (responseFormat || expectedSchema) return true;
  const prompt = messages.map((message) => textFromContent(message.content)).join("\n").toLowerCase();
  return /\bjson\b|schema|structured|fields?|字段|结构化|表格|提取/.test(prompt);
}

function extractJsonCandidate(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) return fenced;
  const firstObject = text.indexOf("{");
  const lastObject = text.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) return text.slice(firstObject, lastObject + 1);
  const firstArray = text.indexOf("[");
  const lastArray = text.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) return text.slice(firstArray, lastArray + 1);
  return undefined;
}

function requiredFieldsFromSchema(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const required = (schema as { required?: unknown }).required;
  return Array.isArray(required) ? required.filter((field): field is string => typeof field === "string") : [];
}

export function validateAssistantOutput(args: {
  messages: ChatMessage[];
  assistantText: string;
  responseFormat?: unknown;
  expectedSchema?: unknown;
}): ValidatorResult {
  const requiredFields = requiredFieldsFromSchema(args.expectedSchema);
  const needsJson = promptNeedsJsonValidation(args.messages, args.responseFormat, args.expectedSchema);

  if (!needsJson && requiredFields.length === 0) {
    return { result: "not_applicable", validator: "none" };
  }

  const candidate = extractJsonCandidate(args.assistantText);
  if (!candidate) {
    return { result: "fail", validator: "json_validator", reason: "No JSON object or array found" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return {
      result: "fail",
      validator: "json_validator",
      reason: err instanceof Error ? err.message : "Invalid JSON",
    };
  }

  if (requiredFields.length > 0) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { result: "fail", validator: "schema_validator", reason: "JSON root is not an object" };
    }
    const parsedObject = parsed as Record<string, unknown>;
    const missing = requiredFields.filter((field) => !(field in parsedObject));
    if (missing.length > 0) {
      return {
        result: "fail",
        validator: "schema_validator",
        reason: `Missing required fields: ${missing.join(", ")}`,
      };
    }
    return { result: "pass", validator: "schema_validator" };
  }

  return { result: "pass", validator: "json_validator" };
}
