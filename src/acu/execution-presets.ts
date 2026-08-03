import type { CanonicalReasoningEffort } from "../alpha/reasoning-capability.js";

export type AcuExecutionPreset = {
  presetId: string;
  candidateId: string;
  modelId: string;
  displayName: string;
  canonicalReasoningEffort: CanonicalReasoningEffort;
  qualityLogitShift: number;
  expectedOutputTokenMultiplier: number;
  featureFlagEnv: string;
  enabled: boolean;
  calibrationStatus: "provisional" | "observed";
  source: string;
};

export const ACU_EXECUTION_PRESETS: readonly AcuExecutionPreset[] = [{
  presetId: "gpt-5.6-luna:max",
  candidateId: "gpt-5.6-luna@max",
  modelId: "gpt-5.6-luna",
  displayName: "GPT-5.6 Luna · Max",
  canonicalReasoningEffort: "max",
  qualityLogitShift: 0.22,
  expectedOutputTokenMultiplier: 1.6,
  featureFlagEnv: "ACU_LUNA_MAX_PRESET_ENABLED",
  enabled: true,
  calibrationStatus: "provisional",
  source: "acu-execution-preset-v1",
}, {
  presetId: "gpt-5.6-sol:high",
  candidateId: "gpt-5.6-sol@high",
  modelId: "gpt-5.6-sol",
  displayName: "GPT-5.6 Sol · High",
  canonicalReasoningEffort: "high",
  qualityLogitShift: 0.081,
  expectedOutputTokenMultiplier: 1.75,
  featureFlagEnv: "ACU_SOL_HIGH_PRESET_ENABLED",
  enabled: true,
  calibrationStatus: "provisional",
  source: "artificial-analysis-v4.1-sol-medium-to-high",
}, {
  presetId: "gpt-5.6-sol:xhigh",
  candidateId: "gpt-5.6-sol@xhigh",
  modelId: "gpt-5.6-sol",
  displayName: "GPT-5.6 Sol · XHigh",
  canonicalReasoningEffort: "xhigh",
  qualityLogitShift: 0.162,
  expectedOutputTokenMultiplier: 35 / 12,
  featureFlagEnv: "ACU_SOL_XHIGH_PRESET_ENABLED",
  enabled: true,
  calibrationStatus: "provisional",
  source: "artificial-analysis-v4.1-sol-medium-to-xhigh",
}, {
  presetId: "gpt-5.6-terra:max",
  candidateId: "gpt-5.6-terra@max",
  modelId: "gpt-5.6-terra",
  displayName: "GPT-5.6 Terra · Max",
  canonicalReasoningEffort: "max",
  qualityLogitShift: 0.361,
  expectedOutputTokenMultiplier: 9.6,
  featureFlagEnv: "ACU_TERRA_MAX_PRESET_ENABLED",
  enabled: true,
  calibrationStatus: "provisional",
  source: "artificial-analysis-v4.1-terra-medium-to-max",
}];

export function enabledExecutionPresets(): AcuExecutionPreset[] {
  return ACU_EXECUTION_PRESETS.filter((preset) => preset.enabled
    && process.env[preset.featureFlagEnv]?.toLowerCase() !== "false");
}
