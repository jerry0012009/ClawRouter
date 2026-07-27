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
  const format = responseFormat && typeof responseFormat === "object"
    ? responseFormat as { type?: unknown } : undefined;
  if (format?.type === "json_object" || format?.type === "json_schema" || expectedSchema) return true;
  const prompt = messages
    .filter((message) => message.role === "user")
    .map((message) => textFromContent(message.content)).join("\n").toLowerCase();
  if (/不要\s*(输出|返回)?\s*json|do\s+not\s+(output|return)\s+json|no\s+json/.test(prompt)) return false;
  const explicitJson = /(?:只|请)?\s*(?:返回|输出|生成|提供|响应(?:为|成)?)\s*(?:严格|合法|有效)?\s*json\b|\bjson\s*(?:格式|对象|数组|输出|响应)|(?:return|output|respond\s+with|produce|generate)\s+(?:only\s+|valid\s+)?json\b/i.test(prompt);
  const structuredFieldExtraction = /(?:提取|抽取)[\s\S]{0,120}(?:字段(?:包括|包含|为|：|:)|字段列表)[\s\S]{0,120}(?:结构化(?:输出|结果)|按结构输出)|(?:字段(?:包括|包含|为|：|:)|字段列表)[\s\S]{0,120}(?:提取|抽取)[\s\S]{0,120}(?:结构化(?:输出|结果)|按结构输出)|(?:extract|parse)[\s\S]{0,120}(?:fields?\s*(?:include|:)|field list)[\s\S]{0,120}structured\s+output/i.test(prompt);
  return explicitJson || structuredFieldExtraction;
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
    return {
      result: "fail",
      validator: requiredFields.length > 0 ? "schema_validator" : "json_validator",
      reason: "未找到JSON对象或数组",
    };
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
    return { result: "pass", validator: "schema_validator", reason: "Valid JSON matching required schema" };
  }

  return { result: "pass", validator: "json_validator", reason: "Valid JSON" };
}
