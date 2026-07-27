export type ThinkingMode = "disabled" | "enabled" | "default";

export type ExecutionProfile = {
  executionProfileId: string;
  thinkingMode: ThinkingMode;
  requestParameterApplied: boolean;
};

export function executionProfileFor(modelId: string, enableThinking: unknown): ExecutionProfile {
  if (modelId === "qwen3.6-plus") {
    const disabled = enableThinking === false;
    return {
      executionProfileId: `${modelId}:${disabled ? "non-thinking" : "thinking"}`,
      thinkingMode: disabled ? "disabled" : "enabled",
      requestParameterApplied: typeof enableThinking === "boolean",
    };
  }
  return {
    executionProfileId: `${modelId}:default`,
    thinkingMode: "default",
    requestParameterApplied: false,
  };
}
