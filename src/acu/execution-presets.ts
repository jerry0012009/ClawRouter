import type { CanonicalReasoningEffort } from "../alpha/reasoning-capability.js";

export type AcuExecutionPreset = {
  presetId: string;
  candidateId: string;
  modelId: string;
  displayName: string;
  canonicalReasoningEffort: CanonicalReasoningEffort;
  qualityLogitShift: number;
  expectedOutputTokenMultiplier: number;
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
  enabled: true,
  calibrationStatus: "provisional",
  source: "acu-execution-preset-v1",
}];

export function enabledExecutionPresets(): AcuExecutionPreset[] {
  const featureEnabled = process.env.ACU_LUNA_MAX_PRESET_ENABLED?.toLowerCase() !== "false";
  return featureEnabled ? ACU_EXECUTION_PRESETS.filter((preset) => preset.enabled) : [];
}
