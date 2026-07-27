import { describe, expect, it } from "vitest";
import { validateAssistantOutput } from "../src/validator/index.js";

describe("validator intent gating", () => {
  it("does not infer JSON from a generic Quality Contract during Python repair", () => {
    const result = validateAssistantOutput({
      messages: [
        { role: "system", content: "若存在结构化格式要求，尽量严格遵守；字段和 schema 仅在用户要求时使用。" },
        { role: "user", content: "修复 Python：def avg(xs): return sum(xs) / len(xs)；avg([]) 会报错。" },
      ],
      assistantText: "应处理空列表，再执行除法。",
    });
    expect(result).toEqual({ result: "not_applicable", validator: "none" });
  });

  it("does not infer JSON for ordinary email writing", () => {
    expect(validateAssistantOutput({
      messages: [{ role: "user", content: "写一封礼貌的项目延期邮件。" }],
      assistantText: "您好，项目需要延期一周。",
    }).result).toBe("not_applicable");
  });

  it("runs JSON validation for an explicit user JSON request", () => {
    expect(validateAssistantOutput({
      messages: [{ role: "user", content: "只返回合法JSON。" }], assistantText: "not json",
    })).toMatchObject({ result: "fail", validator: "json_validator", reason: "未找到JSON对象或数组" });
  });

  it("runs JSON validation for response_format=json_object", () => {
    expect(validateAssistantOutput({
      messages: [{ role: "user", content: "回答问题。" }], assistantText: "not json",
      responseFormat: { type: "json_object" },
    })).toMatchObject({ result: "fail", validator: "json_validator" });
  });

  it("runs schema validation for expected_schema", () => {
    expect(validateAssistantOutput({
      messages: [{ role: "user", content: "回答问题。" }], assistantText: "not json",
      expectedSchema: { type: "object", required: ["name"] },
    })).toMatchObject({ result: "fail", validator: "schema_validator" });
  });
});
