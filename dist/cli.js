#!/usr/bin/env node
import { createRequire as __cjs_createRequire } from 'node:module'; const require = __cjs_createRequire(import.meta.url);

// src/proxy.ts
import { createServer } from "http";
import { createHash as createHash7, randomUUID as randomUUID2 } from "crypto";

// src/router/rules.ts
function scoreTokenCount(estimatedTokens, thresholds) {
  if (estimatedTokens < thresholds.simple) {
    return { name: "tokenCount", score: -1, signal: `short (${estimatedTokens} tokens)` };
  }
  if (estimatedTokens > thresholds.complex) {
    return { name: "tokenCount", score: 1, signal: `long (${estimatedTokens} tokens)` };
  }
  return { name: "tokenCount", score: 0, signal: null };
}
function scoreKeywordMatch(text, keywords, name, signalLabel, thresholds, scores) {
  const matches = keywords.filter((kw) => text.includes(kw.toLowerCase()));
  if (matches.length >= thresholds.high) {
    return {
      name,
      score: scores.high,
      signal: `${signalLabel} (${matches.slice(0, 3).join(", ")})`
    };
  }
  if (matches.length >= thresholds.low) {
    return {
      name,
      score: scores.low,
      signal: `${signalLabel} (${matches.slice(0, 3).join(", ")})`
    };
  }
  return { name, score: scores.none, signal: null };
}
function scoreMultiStep(text) {
  const patterns = [/first.*then/i, /step \d/i, /\d\.\s/];
  const hits = patterns.filter((p) => p.test(text));
  if (hits.length > 0) {
    return { name: "multiStepPatterns", score: 0.5, signal: "multi-step" };
  }
  return { name: "multiStepPatterns", score: 0, signal: null };
}
function scoreQuestionComplexity(prompt) {
  const count = (prompt.match(/\?/g) || []).length;
  if (count > 3) {
    return { name: "questionComplexity", score: 0.5, signal: `${count} questions` };
  }
  return { name: "questionComplexity", score: 0, signal: null };
}
function scoreAgenticTask(text, keywords) {
  let matchCount = 0;
  const signals = [];
  for (const keyword of keywords) {
    if (text.includes(keyword.toLowerCase())) {
      matchCount++;
      if (signals.length < 3) {
        signals.push(keyword);
      }
    }
  }
  if (matchCount >= 4) {
    return {
      dimensionScore: {
        name: "agenticTask",
        score: 1,
        signal: `agentic (${signals.join(", ")})`
      },
      agenticScore: 1
    };
  } else if (matchCount >= 3) {
    return {
      dimensionScore: {
        name: "agenticTask",
        score: 0.6,
        signal: `agentic (${signals.join(", ")})`
      },
      agenticScore: 0.6
    };
  } else if (matchCount >= 1) {
    return {
      dimensionScore: {
        name: "agenticTask",
        score: 0.2,
        signal: `agentic-light (${signals.join(", ")})`
      },
      agenticScore: 0.2
    };
  }
  return {
    dimensionScore: { name: "agenticTask", score: 0, signal: null },
    agenticScore: 0
  };
}
function classifyByRules(prompt, systemPrompt, estimatedTokens, config) {
  const userText = prompt.toLowerCase();
  const dimensions = [
    // Token count uses total estimated tokens (system + user) — context size matters for model selection
    scoreTokenCount(estimatedTokens, config.tokenCountThresholds),
    scoreKeywordMatch(
      userText,
      config.codeKeywords,
      "codePresence",
      "code",
      { low: 1, high: 2 },
      { none: 0, low: 0.5, high: 1 }
    ),
    scoreKeywordMatch(
      userText,
      config.reasoningKeywords,
      "reasoningMarkers",
      "reasoning",
      { low: 1, high: 2 },
      { none: 0, low: 0.7, high: 1 }
    ),
    scoreKeywordMatch(
      userText,
      config.technicalKeywords,
      "technicalTerms",
      "technical",
      { low: 2, high: 4 },
      { none: 0, low: 0.5, high: 1 }
    ),
    scoreKeywordMatch(
      userText,
      config.creativeKeywords,
      "creativeMarkers",
      "creative",
      { low: 1, high: 2 },
      { none: 0, low: 0.5, high: 0.7 }
    ),
    scoreKeywordMatch(
      userText,
      config.simpleKeywords,
      "simpleIndicators",
      "simple",
      { low: 1, high: 2 },
      { none: 0, low: -1, high: -1 }
    ),
    scoreMultiStep(userText),
    scoreQuestionComplexity(prompt),
    // 6 new dimensions
    scoreKeywordMatch(
      userText,
      config.imperativeVerbs,
      "imperativeVerbs",
      "imperative",
      { low: 1, high: 2 },
      { none: 0, low: 0.3, high: 0.5 }
    ),
    scoreKeywordMatch(
      userText,
      config.constraintIndicators,
      "constraintCount",
      "constraints",
      { low: 1, high: 3 },
      { none: 0, low: 0.3, high: 0.7 }
    ),
    scoreKeywordMatch(
      userText,
      config.outputFormatKeywords,
      "outputFormat",
      "format",
      { low: 1, high: 2 },
      { none: 0, low: 0.4, high: 0.7 }
    ),
    scoreKeywordMatch(
      userText,
      config.referenceKeywords,
      "referenceComplexity",
      "references",
      { low: 1, high: 2 },
      { none: 0, low: 0.3, high: 0.5 }
    ),
    scoreKeywordMatch(
      userText,
      config.negationKeywords,
      "negationComplexity",
      "negation",
      { low: 2, high: 3 },
      { none: 0, low: 0.3, high: 0.5 }
    ),
    scoreKeywordMatch(
      userText,
      config.domainSpecificKeywords,
      "domainSpecificity",
      "domain-specific",
      { low: 1, high: 2 },
      { none: 0, low: 0.5, high: 0.8 }
    )
  ];
  const agenticResult = scoreAgenticTask(userText, config.agenticTaskKeywords);
  dimensions.push(agenticResult.dimensionScore);
  const agenticScore = agenticResult.agenticScore;
  const signals = dimensions.filter((d) => d.signal !== null).map((d) => d.signal);
  const weights = config.dimensionWeights;
  let weightedScore = 0;
  for (const d of dimensions) {
    const w = weights[d.name] ?? 0;
    weightedScore += d.score * w;
  }
  const reasoningMatches = config.reasoningKeywords.filter(
    (kw) => userText.includes(kw.toLowerCase())
  );
  if (reasoningMatches.length >= 2) {
    const confidence2 = calibrateConfidence(
      Math.max(weightedScore, 0.3),
      // ensure positive for confidence calc
      config.confidenceSteepness
    );
    return {
      score: weightedScore,
      tier: "REASONING",
      confidence: Math.max(confidence2, 0.85),
      signals,
      agenticScore,
      dimensions
    };
  }
  const { simpleMedium, mediumComplex, complexReasoning } = config.tierBoundaries;
  let tier;
  let distanceFromBoundary;
  if (weightedScore < simpleMedium) {
    tier = "SIMPLE";
    distanceFromBoundary = simpleMedium - weightedScore;
  } else if (weightedScore < mediumComplex) {
    tier = "MEDIUM";
    distanceFromBoundary = Math.min(weightedScore - simpleMedium, mediumComplex - weightedScore);
  } else if (weightedScore < complexReasoning) {
    tier = "COMPLEX";
    distanceFromBoundary = Math.min(
      weightedScore - mediumComplex,
      complexReasoning - weightedScore
    );
  } else {
    tier = "REASONING";
    distanceFromBoundary = weightedScore - complexReasoning;
  }
  const confidence = calibrateConfidence(distanceFromBoundary, config.confidenceSteepness);
  if (confidence < config.confidenceThreshold) {
    return { score: weightedScore, tier: null, confidence, signals, agenticScore, dimensions };
  }
  return { score: weightedScore, tier, confidence, signals, agenticScore, dimensions };
}
function calibrateConfidence(distance, steepness) {
  return 1 / (1 + Math.exp(-steepness * distance));
}

// src/router/selector.ts
var DEFAULT_BASELINE_MODEL_ID = "claude-opus-4-7";
var BASELINE_INPUT_PRICE = 5;
var BASELINE_OUTPUT_PRICE = 25;
var DEFAULT_PLATFORM_MARKUP_PERCENT = 0;
function selectModel(tier, confidence, method, reasoning, tierConfigs, modelPricing, estimatedInputTokens, maxOutputTokens, routingProfile, agenticScore) {
  const tierConfig = tierConfigs[tier];
  const model = tierConfig.primary;
  const pricing = modelPricing.get(model);
  let costEstimate;
  if (pricing?.flatPrice !== void 0) {
    costEstimate = pricing.flatPrice;
  } else {
    const inputPrice = pricing?.inputPrice ?? 0;
    const outputPrice = pricing?.outputPrice ?? 0;
    costEstimate = estimatedInputTokens / 1e6 * inputPrice + maxOutputTokens / 1e6 * outputPrice;
  }
  const opusPricing = modelPricing.get(DEFAULT_BASELINE_MODEL_ID);
  const opusInputPrice = opusPricing?.inputPrice ?? BASELINE_INPUT_PRICE;
  const opusOutputPrice = opusPricing?.outputPrice ?? BASELINE_OUTPUT_PRICE;
  const baselineInput = estimatedInputTokens / 1e6 * opusInputPrice;
  const baselineOutput = maxOutputTokens / 1e6 * opusOutputPrice;
  const baselineCost = baselineInput + baselineOutput;
  const savings = routingProfile === "premium" ? 0 : baselineCost > 0 ? Math.max(0, (baselineCost - costEstimate) / baselineCost) : 0;
  return {
    model,
    tier,
    confidence,
    method,
    reasoning,
    costEstimate,
    baselineCost,
    savings,
    ...agenticScore !== void 0 && { agenticScore }
  };
}
function getFallbackChain(tier, tierConfigs) {
  const config = tierConfigs[tier];
  return [config.primary, ...config.fallback];
}
function calculateModelCost(model, modelPricing, estimatedInputTokens, maxOutputTokens, routingProfile, platformMarkupPercent = DEFAULT_PLATFORM_MARKUP_PERCENT) {
  const pricing = modelPricing.get(model);
  let costEstimate;
  if (pricing?.flatPrice !== void 0) {
    costEstimate = pricing.flatPrice;
  } else {
    const inputPrice = pricing?.inputPrice ?? 0;
    const outputPrice = pricing?.outputPrice ?? 0;
    const inputCost = estimatedInputTokens / 1e6 * inputPrice;
    const outputCost = maxOutputTokens / 1e6 * outputPrice;
    costEstimate = inputCost + outputCost;
  }
  costEstimate *= 1 + platformMarkupPercent / 100;
  const opusPricing = modelPricing.get(DEFAULT_BASELINE_MODEL_ID);
  const opusInputPrice = opusPricing?.inputPrice ?? BASELINE_INPUT_PRICE;
  const opusOutputPrice = opusPricing?.outputPrice ?? BASELINE_OUTPUT_PRICE;
  const baselineInput = estimatedInputTokens / 1e6 * opusInputPrice;
  const baselineOutput = maxOutputTokens / 1e6 * opusOutputPrice;
  const baselineCost = baselineInput + baselineOutput;
  const savings = routingProfile === "premium" ? 0 : baselineCost > 0 ? Math.max(0, (baselineCost - costEstimate) / baselineCost) : 0;
  return { costEstimate, baselineCost, savings };
}
function filterByToolCalling(models, hasTools, supportsToolCalling2) {
  if (!hasTools) return models;
  const filtered = models.filter(supportsToolCalling2);
  return filtered.length > 0 ? filtered : models;
}
function filterByVision(models, hasVision, supportsVision2) {
  if (!hasVision) return models;
  const filtered = models.filter(supportsVision2);
  return filtered.length > 0 ? filtered : models;
}
function filterByExcludeList(models, excludeList) {
  if (excludeList.size === 0) return models;
  const filtered = models.filter((m) => !excludeList.has(m));
  const excluded = models.filter((m) => excludeList.has(m));
  if (excluded.length > 0) {
    console.log(`[ClawRouter] Exclude filter: removed ${excluded.join(", ")}`);
  }
  return filtered.length > 0 ? filtered : models;
}
function getFallbackChainFiltered(tier, tierConfigs, estimatedTotalTokens, getContextWindow) {
  const fullChain = getFallbackChain(tier, tierConfigs);
  const filtered = fullChain.filter((modelId) => {
    const contextWindow = getContextWindow(modelId);
    if (contextWindow === void 0) {
      return true;
    }
    return contextWindow >= estimatedTotalTokens * 1.1;
  });
  if (filtered.length === 0) {
    return fullChain;
  }
  return filtered;
}

// src/router/strategy.ts
function applyPromotions(tierConfigs, promotions, profile, now = /* @__PURE__ */ new Date()) {
  if (!promotions || promotions.length === 0) return tierConfigs;
  let result = tierConfigs;
  for (const promo of promotions) {
    const start = new Date(promo.startDate);
    const end = new Date(promo.endDate);
    if (now < start || now >= end) continue;
    if (promo.profiles && !promo.profiles.includes(profile)) continue;
    if (result === tierConfigs) {
      result = { ...tierConfigs };
      for (const t of Object.keys(result)) {
        result[t] = { ...result[t] };
      }
    }
    for (const [tier, override] of Object.entries(promo.tierOverrides)) {
      if (!result[tier]) continue;
      if (override.primary) result[tier].primary = override.primary;
      if (override.fallback) result[tier].fallback = override.fallback;
    }
  }
  return result;
}
var RulesStrategy = class {
  name = "rules";
  route(prompt, systemPrompt, maxOutputTokens, options) {
    const { config, modelPricing } = options;
    const fullText = `${systemPrompt ?? ""} ${prompt}`;
    const estimatedTokens = Math.ceil(fullText.length / 4);
    const ruleResult = classifyByRules(prompt, systemPrompt, estimatedTokens, config.scoring);
    const { routingProfile } = options;
    let tierConfigs;
    let profileSuffix;
    let profile;
    if (routingProfile === "eco") {
      tierConfigs = config.ecoTiers ?? config.tiers;
      profileSuffix = config.ecoTiers ? " | eco" : " | eco (default tiers)";
      profile = "eco";
    } else if (routingProfile === "premium") {
      tierConfigs = config.premiumTiers ?? config.tiers;
      profileSuffix = config.premiumTiers ? " | premium" : " | premium (default tiers)";
      profile = "premium";
    } else {
      const agenticScore = ruleResult.agenticScore ?? 0;
      const isAutoAgentic = agenticScore >= 0.5;
      const agenticModeSetting = config.overrides.agenticMode;
      const hasToolsInRequest = options.hasTools ?? false;
      let useAgenticTiers;
      if (agenticModeSetting === false) {
        useAgenticTiers = false;
      } else if (agenticModeSetting === true) {
        useAgenticTiers = config.agenticTiers != null;
      } else {
        useAgenticTiers = (hasToolsInRequest || isAutoAgentic) && config.agenticTiers != null;
      }
      tierConfigs = useAgenticTiers ? config.agenticTiers : config.tiers;
      profileSuffix = useAgenticTiers ? ` | agentic${hasToolsInRequest ? " (tools)" : ""}` : "";
      profile = useAgenticTiers ? "agentic" : "auto";
    }
    tierConfigs = applyPromotions(tierConfigs, config.promotions, profile, options.now);
    const agenticScoreValue = ruleResult.agenticScore;
    if (estimatedTokens > config.overrides.maxTokensForceComplex) {
      const decision2 = selectModel(
        "COMPLEX",
        0.95,
        "rules",
        `Input exceeds ${config.overrides.maxTokensForceComplex} tokens${profileSuffix}`,
        tierConfigs,
        modelPricing,
        estimatedTokens,
        maxOutputTokens,
        routingProfile,
        agenticScoreValue
      );
      return { ...decision2, tierConfigs, profile };
    }
    const hasStructuredOutput = systemPrompt ? /json|structured|schema/i.test(systemPrompt) : false;
    let tier;
    let confidence;
    const method = "rules";
    let reasoning = `score=${ruleResult.score.toFixed(2)} | ${ruleResult.signals.join(", ")}`;
    if (ruleResult.tier !== null) {
      tier = ruleResult.tier;
      confidence = ruleResult.confidence;
    } else {
      tier = config.overrides.ambiguousDefaultTier;
      confidence = 0.5;
      reasoning += ` | ambiguous -> default: ${tier}`;
    }
    if (hasStructuredOutput) {
      const tierRank = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };
      const minTier = config.overrides.structuredOutputMinTier;
      if (tierRank[tier] < tierRank[minTier]) {
        reasoning += ` | upgraded to ${minTier} (structured output)`;
        tier = minTier;
      }
    }
    reasoning += profileSuffix;
    const decision = selectModel(
      tier,
      confidence,
      method,
      reasoning,
      tierConfigs,
      modelPricing,
      estimatedTokens,
      maxOutputTokens,
      routingProfile,
      agenticScoreValue
    );
    return { ...decision, tierConfigs, profile };
  }
};
var registry = /* @__PURE__ */ new Map();
registry.set("rules", new RulesStrategy());
function getStrategy(name) {
  const strategy = registry.get(name);
  if (!strategy) {
    throw new Error(`Unknown routing strategy: ${name}`);
  }
  return strategy;
}

// src/router/config.ts
var DEFAULT_ROUTING_CONFIG = {
  version: "2.0",
  classifier: {
    llmModel: "google/gemini-2.5-flash",
    llmMaxTokens: 10,
    llmTemperature: 0,
    promptTruncationChars: 500,
    cacheTtlMs: 36e5
    // 1 hour
  },
  scoring: {
    tokenCountThresholds: { simple: 50, complex: 500 },
    // Multilingual keywords: EN + ZH + JA + RU + DE + ES + PT + KO + AR
    codeKeywords: [
      // English
      "function",
      "class",
      "import",
      "def",
      "SELECT",
      "async",
      "await",
      "const",
      "let",
      "var",
      "return",
      "```",
      // Chinese
      "\u51FD\u6570",
      "\u7C7B",
      "\u5BFC\u5165",
      "\u5B9A\u4E49",
      "\u67E5\u8BE2",
      "\u5F02\u6B65",
      "\u7B49\u5F85",
      "\u5E38\u91CF",
      "\u53D8\u91CF",
      "\u8FD4\u56DE",
      // Japanese
      "\u95A2\u6570",
      "\u30AF\u30E9\u30B9",
      "\u30A4\u30F3\u30DD\u30FC\u30C8",
      "\u975E\u540C\u671F",
      "\u5B9A\u6570",
      "\u5909\u6570",
      // Russian
      "\u0444\u0443\u043D\u043A\u0446\u0438\u044F",
      "\u043A\u043B\u0430\u0441\u0441",
      "\u0438\u043C\u043F\u043E\u0440\u0442",
      "\u043E\u043F\u0440\u0435\u0434\u0435\u043B",
      "\u0437\u0430\u043F\u0440\u043E\u0441",
      "\u0430\u0441\u0438\u043D\u0445\u0440\u043E\u043D\u043D\u044B\u0439",
      "\u043E\u0436\u0438\u0434\u0430\u0442\u044C",
      "\u043A\u043E\u043D\u0441\u0442\u0430\u043D\u0442\u0430",
      "\u043F\u0435\u0440\u0435\u043C\u0435\u043D\u043D\u0430\u044F",
      "\u0432\u0435\u0440\u043D\u0443\u0442\u044C",
      // German
      "funktion",
      "klasse",
      "importieren",
      "definieren",
      "abfrage",
      "asynchron",
      "erwarten",
      "konstante",
      "variable",
      "zur\xFCckgeben",
      // Spanish
      "funci\xF3n",
      "clase",
      "importar",
      "definir",
      "consulta",
      "as\xEDncrono",
      "esperar",
      "constante",
      "variable",
      "retornar",
      // Portuguese
      "fun\xE7\xE3o",
      "classe",
      "importar",
      "definir",
      "consulta",
      "ass\xEDncrono",
      "aguardar",
      "constante",
      "vari\xE1vel",
      "retornar",
      // Korean
      "\uD568\uC218",
      "\uD074\uB798\uC2A4",
      "\uAC00\uC838\uC624\uAE30",
      "\uC815\uC758",
      "\uCFFC\uB9AC",
      "\uBE44\uB3D9\uAE30",
      "\uB300\uAE30",
      "\uC0C1\uC218",
      "\uBCC0\uC218",
      "\uBC18\uD658",
      // Arabic
      "\u062F\u0627\u0644\u0629",
      "\u0641\u0626\u0629",
      "\u0627\u0633\u062A\u064A\u0631\u0627\u062F",
      "\u062A\u0639\u0631\u064A\u0641",
      "\u0627\u0633\u062A\u0639\u0644\u0627\u0645",
      "\u063A\u064A\u0631 \u0645\u062A\u0632\u0627\u0645\u0646",
      "\u0627\u0646\u062A\u0638\u0627\u0631",
      "\u062B\u0627\u0628\u062A",
      "\u0645\u062A\u063A\u064A\u0631",
      "\u0625\u0631\u062C\u0627\u0639"
    ],
    reasoningKeywords: [
      // English
      "prove",
      "theorem",
      "derive",
      "step by step",
      "chain of thought",
      "formally",
      "mathematical",
      "proof",
      "logically",
      // Chinese
      "\u8BC1\u660E",
      "\u5B9A\u7406",
      "\u63A8\u5BFC",
      "\u9010\u6B65",
      "\u601D\u7EF4\u94FE",
      "\u5F62\u5F0F\u5316",
      "\u6570\u5B66",
      "\u903B\u8F91",
      // Japanese
      "\u8A3C\u660E",
      "\u5B9A\u7406",
      "\u5C0E\u51FA",
      "\u30B9\u30C6\u30C3\u30D7\u30D0\u30A4\u30B9\u30C6\u30C3\u30D7",
      "\u8AD6\u7406\u7684",
      // Russian
      "\u0434\u043E\u043A\u0430\u0437\u0430\u0442\u044C",
      "\u0434\u043E\u043A\u0430\u0436\u0438",
      "\u0434\u043E\u043A\u0430\u0437\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432",
      "\u0442\u0435\u043E\u0440\u0435\u043C\u0430",
      "\u0432\u044B\u0432\u0435\u0441\u0442\u0438",
      "\u0448\u0430\u0433 \u0437\u0430 \u0448\u0430\u0433\u043E\u043C",
      "\u043F\u043E\u0448\u0430\u0433\u043E\u0432\u043E",
      "\u043F\u043E\u044D\u0442\u0430\u043F\u043D\u043E",
      "\u0446\u0435\u043F\u043E\u0447\u043A\u0430 \u0440\u0430\u0441\u0441\u0443\u0436\u0434\u0435\u043D\u0438\u0439",
      "\u0440\u0430\u0441\u0441\u0443\u0436\u0434\u0435\u043D\u0438",
      "\u0444\u043E\u0440\u043C\u0430\u043B\u044C\u043D\u043E",
      "\u043C\u0430\u0442\u0435\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438",
      "\u043B\u043E\u0433\u0438\u0447\u0435\u0441\u043A\u0438",
      // German
      "beweisen",
      "beweis",
      "theorem",
      "ableiten",
      "schritt f\xFCr schritt",
      "gedankenkette",
      "formal",
      "mathematisch",
      "logisch",
      // Spanish
      "demostrar",
      "teorema",
      "derivar",
      "paso a paso",
      "cadena de pensamiento",
      "formalmente",
      "matem\xE1tico",
      "prueba",
      "l\xF3gicamente",
      // Portuguese
      "provar",
      "teorema",
      "derivar",
      "passo a passo",
      "cadeia de pensamento",
      "formalmente",
      "matem\xE1tico",
      "prova",
      "logicamente",
      // Korean
      "\uC99D\uBA85",
      "\uC815\uB9AC",
      "\uB3C4\uCD9C",
      "\uB2E8\uACC4\uBCC4",
      "\uC0AC\uACE0\uC758 \uC5F0\uC1C4",
      "\uD615\uC2DD\uC801",
      "\uC218\uD559\uC801",
      "\uB17C\uB9AC\uC801",
      // Arabic
      "\u0625\u062B\u0628\u0627\u062A",
      "\u0646\u0638\u0631\u064A\u0629",
      "\u0627\u0634\u062A\u0642\u0627\u0642",
      "\u062E\u0637\u0648\u0629 \u0628\u062E\u0637\u0648\u0629",
      "\u0633\u0644\u0633\u0644\u0629 \u0627\u0644\u062A\u0641\u0643\u064A\u0631",
      "\u0631\u0633\u0645\u064A\u0627\u064B",
      "\u0631\u064A\u0627\u0636\u064A",
      "\u0628\u0631\u0647\u0627\u0646",
      "\u0645\u0646\u0637\u0642\u064A\u0627\u064B"
    ],
    simpleKeywords: [
      // English
      "what is",
      "define",
      "translate",
      "hello",
      "yes or no",
      "capital of",
      "how old",
      "who is",
      "when was",
      // Chinese
      "\u4EC0\u4E48\u662F",
      "\u5B9A\u4E49",
      "\u7FFB\u8BD1",
      "\u4F60\u597D",
      "\u662F\u5426",
      "\u9996\u90FD",
      "\u591A\u5927",
      "\u8C01\u662F",
      "\u4F55\u65F6",
      // Japanese
      "\u3068\u306F",
      "\u5B9A\u7FA9",
      "\u7FFB\u8A33",
      "\u3053\u3093\u306B\u3061\u306F",
      "\u306F\u3044\u304B\u3044\u3044\u3048",
      "\u9996\u90FD",
      "\u8AB0",
      // Russian
      "\u0447\u0442\u043E \u0442\u0430\u043A\u043E\u0435",
      "\u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0435\u043D\u0438\u0435",
      "\u043F\u0435\u0440\u0435\u0432\u0435\u0441\u0442\u0438",
      "\u043F\u0435\u0440\u0435\u0432\u0435\u0434\u0438",
      "\u043F\u0440\u0438\u0432\u0435\u0442",
      "\u0434\u0430 \u0438\u043B\u0438 \u043D\u0435\u0442",
      "\u0441\u0442\u043E\u043B\u0438\u0446\u0430",
      "\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u043B\u0435\u0442",
      "\u043A\u0442\u043E \u0442\u0430\u043A\u043E\u0439",
      "\u043A\u043E\u0433\u0434\u0430",
      "\u043E\u0431\u044A\u044F\u0441\u043D\u0438",
      // German
      "was ist",
      "definiere",
      "\xFCbersetze",
      "hallo",
      "ja oder nein",
      "hauptstadt",
      "wie alt",
      "wer ist",
      "wann",
      "erkl\xE4re",
      // Spanish
      "qu\xE9 es",
      "definir",
      "traducir",
      "hola",
      "s\xED o no",
      "capital de",
      "cu\xE1ntos a\xF1os",
      "qui\xE9n es",
      "cu\xE1ndo",
      // Portuguese
      "o que \xE9",
      "definir",
      "traduzir",
      "ol\xE1",
      "sim ou n\xE3o",
      "capital de",
      "quantos anos",
      "quem \xE9",
      "quando",
      // Korean
      "\uBB34\uC5C7",
      "\uC815\uC758",
      "\uBC88\uC5ED",
      "\uC548\uB155\uD558\uC138\uC694",
      "\uC608 \uB610\uB294 \uC544\uB2C8\uC624",
      "\uC218\uB3C4",
      "\uB204\uAD6C",
      "\uC5B8\uC81C",
      // Arabic
      "\u0645\u0627 \u0647\u0648",
      "\u062A\u0639\u0631\u064A\u0641",
      "\u062A\u0631\u062C\u0645",
      "\u0645\u0631\u062D\u0628\u0627",
      "\u0646\u0639\u0645 \u0623\u0648 \u0644\u0627",
      "\u0639\u0627\u0635\u0645\u0629",
      "\u0645\u0646 \u0647\u0648",
      "\u0645\u062A\u0649"
    ],
    technicalKeywords: [
      // English
      "algorithm",
      "optimize",
      "architecture",
      "distributed",
      "kubernetes",
      "microservice",
      "database",
      "infrastructure",
      // Chinese
      "\u7B97\u6CD5",
      "\u4F18\u5316",
      "\u67B6\u6784",
      "\u5206\u5E03\u5F0F",
      "\u5FAE\u670D\u52A1",
      "\u6570\u636E\u5E93",
      "\u57FA\u7840\u8BBE\u65BD",
      // Japanese
      "\u30A2\u30EB\u30B4\u30EA\u30BA\u30E0",
      "\u6700\u9069\u5316",
      "\u30A2\u30FC\u30AD\u30C6\u30AF\u30C1\u30E3",
      "\u5206\u6563",
      "\u30DE\u30A4\u30AF\u30ED\u30B5\u30FC\u30D3\u30B9",
      "\u30C7\u30FC\u30BF\u30D9\u30FC\u30B9",
      // Russian
      "\u0430\u043B\u0433\u043E\u0440\u0438\u0442\u043C",
      "\u043E\u043F\u0442\u0438\u043C\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u0442\u044C",
      "\u043E\u043F\u0442\u0438\u043C\u0438\u0437\u0430\u0446\u0438",
      "\u043E\u043F\u0442\u0438\u043C\u0438\u0437\u0438\u0440\u0443\u0439",
      "\u0430\u0440\u0445\u0438\u0442\u0435\u043A\u0442\u0443\u0440\u0430",
      "\u0440\u0430\u0441\u043F\u0440\u0435\u0434\u0435\u043B\u0451\u043D\u043D\u044B\u0439",
      "\u043C\u0438\u043A\u0440\u043E\u0441\u0435\u0440\u0432\u0438\u0441",
      "\u0431\u0430\u0437\u0430 \u0434\u0430\u043D\u043D\u044B\u0445",
      "\u0438\u043D\u0444\u0440\u0430\u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0430",
      // German
      "algorithmus",
      "optimieren",
      "architektur",
      "verteilt",
      "kubernetes",
      "mikroservice",
      "datenbank",
      "infrastruktur",
      // Spanish
      "algoritmo",
      "optimizar",
      "arquitectura",
      "distribuido",
      "microservicio",
      "base de datos",
      "infraestructura",
      // Portuguese
      "algoritmo",
      "otimizar",
      "arquitetura",
      "distribu\xEDdo",
      "microsservi\xE7o",
      "banco de dados",
      "infraestrutura",
      // Korean
      "\uC54C\uACE0\uB9AC\uC998",
      "\uCD5C\uC801\uD654",
      "\uC544\uD0A4\uD14D\uCC98",
      "\uBD84\uC0B0",
      "\uB9C8\uC774\uD06C\uB85C\uC11C\uBE44\uC2A4",
      "\uB370\uC774\uD130\uBCA0\uC774\uC2A4",
      "\uC778\uD504\uB77C",
      // Arabic
      "\u062E\u0648\u0627\u0631\u0632\u0645\u064A\u0629",
      "\u062A\u062D\u0633\u064A\u0646",
      "\u0628\u0646\u064A\u0629",
      "\u0645\u0648\u0632\u0639",
      "\u062E\u062F\u0645\u0629 \u0645\u0635\u063A\u0631\u0629",
      "\u0642\u0627\u0639\u062F\u0629 \u0628\u064A\u0627\u0646\u0627\u062A",
      "\u0628\u0646\u064A\u0629 \u062A\u062D\u062A\u064A\u0629"
    ],
    creativeKeywords: [
      // English
      "story",
      "poem",
      "compose",
      "brainstorm",
      "creative",
      "imagine",
      "write a",
      // Chinese
      "\u6545\u4E8B",
      "\u8BD7",
      "\u521B\u4F5C",
      "\u5934\u8111\u98CE\u66B4",
      "\u521B\u610F",
      "\u60F3\u8C61",
      "\u5199\u4E00\u4E2A",
      // Japanese
      "\u7269\u8A9E",
      "\u8A69",
      "\u4F5C\u66F2",
      "\u30D6\u30EC\u30A4\u30F3\u30B9\u30C8\u30FC\u30E0",
      "\u5275\u9020\u7684",
      "\u60F3\u50CF",
      // Russian
      "\u0438\u0441\u0442\u043E\u0440\u0438\u044F",
      "\u0440\u0430\u0441\u0441\u043A\u0430\u0437",
      "\u0441\u0442\u0438\u0445\u043E\u0442\u0432\u043E\u0440\u0435\u043D\u0438\u0435",
      "\u0441\u043E\u0447\u0438\u043D\u0438\u0442\u044C",
      "\u0441\u043E\u0447\u0438\u043D\u0438",
      "\u043C\u043E\u0437\u0433\u043E\u0432\u043E\u0439 \u0448\u0442\u0443\u0440\u043C",
      "\u0442\u0432\u043E\u0440\u0447\u0435\u0441\u043A\u0438\u0439",
      "\u043F\u0440\u0435\u0434\u0441\u0442\u0430\u0432\u0438\u0442\u044C",
      "\u043F\u0440\u0438\u0434\u0443\u043C\u0430\u0439",
      "\u043D\u0430\u043F\u0438\u0448\u0438",
      // German
      "geschichte",
      "gedicht",
      "komponieren",
      "brainstorming",
      "kreativ",
      "vorstellen",
      "schreibe",
      "erz\xE4hlung",
      // Spanish
      "historia",
      "poema",
      "componer",
      "lluvia de ideas",
      "creativo",
      "imaginar",
      "escribe",
      // Portuguese
      "hist\xF3ria",
      "poema",
      "compor",
      "criativo",
      "imaginar",
      "escreva",
      // Korean
      "\uC774\uC57C\uAE30",
      "\uC2DC",
      "\uC791\uACE1",
      "\uBE0C\uB808\uC778\uC2A4\uD1A0\uBC0D",
      "\uCC3D\uC758\uC801",
      "\uC0C1\uC0C1",
      "\uC791\uC131",
      // Arabic
      "\u0642\u0635\u0629",
      "\u0642\u0635\u064A\u062F\u0629",
      "\u062A\u0623\u0644\u064A\u0641",
      "\u0639\u0635\u0641 \u0630\u0647\u0646\u064A",
      "\u0625\u0628\u062F\u0627\u0639\u064A",
      "\u062A\u062E\u064A\u0644",
      "\u0627\u0643\u062A\u0628"
    ],
    // New dimension keyword lists (multilingual)
    imperativeVerbs: [
      // English
      "build",
      "create",
      "implement",
      "design",
      "develop",
      "construct",
      "generate",
      "deploy",
      "configure",
      "set up",
      // Chinese
      "\u6784\u5EFA",
      "\u521B\u5EFA",
      "\u5B9E\u73B0",
      "\u8BBE\u8BA1",
      "\u5F00\u53D1",
      "\u751F\u6210",
      "\u90E8\u7F72",
      "\u914D\u7F6E",
      "\u8BBE\u7F6E",
      // Japanese
      "\u69CB\u7BC9",
      "\u4F5C\u6210",
      "\u5B9F\u88C5",
      "\u8A2D\u8A08",
      "\u958B\u767A",
      "\u751F\u6210",
      "\u30C7\u30D7\u30ED\u30A4",
      "\u8A2D\u5B9A",
      // Russian
      "\u043F\u043E\u0441\u0442\u0440\u043E\u0438\u0442\u044C",
      "\u043F\u043E\u0441\u0442\u0440\u043E\u0439",
      "\u0441\u043E\u0437\u0434\u0430\u0442\u044C",
      "\u0441\u043E\u0437\u0434\u0430\u0439",
      "\u0440\u0435\u0430\u043B\u0438\u0437\u043E\u0432\u0430\u0442\u044C",
      "\u0440\u0435\u0430\u043B\u0438\u0437\u0443\u0439",
      "\u0441\u043F\u0440\u043E\u0435\u043A\u0442\u0438\u0440\u043E\u0432\u0430\u0442\u044C",
      "\u0440\u0430\u0437\u0440\u0430\u0431\u043E\u0442\u0430\u0442\u044C",
      "\u0440\u0430\u0437\u0440\u0430\u0431\u043E\u0442\u0430\u0439",
      "\u0441\u043A\u043E\u043D\u0441\u0442\u0440\u0443\u0438\u0440\u043E\u0432\u0430\u0442\u044C",
      "\u0441\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C",
      "\u0441\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u0443\u0439",
      "\u0440\u0430\u0437\u0432\u0435\u0440\u043D\u0443\u0442\u044C",
      "\u0440\u0430\u0437\u0432\u0435\u0440\u043D\u0438",
      "\u043D\u0430\u0441\u0442\u0440\u043E\u0438\u0442\u044C",
      "\u043D\u0430\u0441\u0442\u0440\u043E\u0439",
      // German
      "erstellen",
      "bauen",
      "implementieren",
      "entwerfen",
      "entwickeln",
      "konstruieren",
      "generieren",
      "bereitstellen",
      "konfigurieren",
      "einrichten",
      // Spanish
      "construir",
      "crear",
      "implementar",
      "dise\xF1ar",
      "desarrollar",
      "generar",
      "desplegar",
      "configurar",
      // Portuguese
      "construir",
      "criar",
      "implementar",
      "projetar",
      "desenvolver",
      "gerar",
      "implantar",
      "configurar",
      // Korean
      "\uAD6C\uCD95",
      "\uC0DD\uC131",
      "\uAD6C\uD604",
      "\uC124\uACC4",
      "\uAC1C\uBC1C",
      "\uBC30\uD3EC",
      "\uC124\uC815",
      // Arabic
      "\u0628\u0646\u0627\u0621",
      "\u0625\u0646\u0634\u0627\u0621",
      "\u062A\u0646\u0641\u064A\u0630",
      "\u062A\u0635\u0645\u064A\u0645",
      "\u062A\u0637\u0648\u064A\u0631",
      "\u062A\u0648\u0644\u064A\u062F",
      "\u0646\u0634\u0631",
      "\u0625\u0639\u062F\u0627\u062F"
    ],
    constraintIndicators: [
      // English
      "under",
      "at most",
      "at least",
      "within",
      "no more than",
      "o(",
      "maximum",
      "minimum",
      "limit",
      "budget",
      // Chinese
      "\u4E0D\u8D85\u8FC7",
      "\u81F3\u5C11",
      "\u6700\u591A",
      "\u5728\u5185",
      "\u6700\u5927",
      "\u6700\u5C0F",
      "\u9650\u5236",
      "\u9884\u7B97",
      // Japanese
      "\u4EE5\u4E0B",
      "\u6700\u5927",
      "\u6700\u5C0F",
      "\u5236\u9650",
      "\u4E88\u7B97",
      // Russian
      "\u043D\u0435 \u0431\u043E\u043B\u0435\u0435",
      "\u043D\u0435 \u043C\u0435\u043D\u0435\u0435",
      "\u043A\u0430\u043A \u043C\u0438\u043D\u0438\u043C\u0443\u043C",
      "\u0432 \u043F\u0440\u0435\u0434\u0435\u043B\u0430\u0445",
      "\u043C\u0430\u043A\u0441\u0438\u043C\u0443\u043C",
      "\u043C\u0438\u043D\u0438\u043C\u0443\u043C",
      "\u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0435",
      "\u0431\u044E\u0434\u0436\u0435\u0442",
      // German
      "h\xF6chstens",
      "mindestens",
      "innerhalb",
      "nicht mehr als",
      "maximal",
      "minimal",
      "grenze",
      "budget",
      // Spanish
      "como m\xE1ximo",
      "al menos",
      "dentro de",
      "no m\xE1s de",
      "m\xE1ximo",
      "m\xEDnimo",
      "l\xEDmite",
      "presupuesto",
      // Portuguese
      "no m\xE1ximo",
      "pelo menos",
      "dentro de",
      "n\xE3o mais que",
      "m\xE1ximo",
      "m\xEDnimo",
      "limite",
      "or\xE7amento",
      // Korean
      "\uC774\uD558",
      "\uC774\uC0C1",
      "\uCD5C\uB300",
      "\uCD5C\uC18C",
      "\uC81C\uD55C",
      "\uC608\uC0B0",
      // Arabic
      "\u0639\u0644\u0649 \u0627\u0644\u0623\u0643\u062B\u0631",
      "\u0639\u0644\u0649 \u0627\u0644\u0623\u0642\u0644",
      "\u0636\u0645\u0646",
      "\u0644\u0627 \u064A\u0632\u064A\u062F \u0639\u0646",
      "\u0623\u0642\u0635\u0649",
      "\u0623\u062F\u0646\u0649",
      "\u062D\u062F",
      "\u0645\u064A\u0632\u0627\u0646\u064A\u0629"
    ],
    outputFormatKeywords: [
      // English
      "json",
      "yaml",
      "xml",
      "table",
      "csv",
      "markdown",
      "schema",
      "format as",
      "structured",
      // Chinese
      "\u8868\u683C",
      "\u683C\u5F0F\u5316\u4E3A",
      "\u7ED3\u6784\u5316",
      // Japanese
      "\u30C6\u30FC\u30D6\u30EB",
      "\u30D5\u30A9\u30FC\u30DE\u30C3\u30C8",
      "\u69CB\u9020\u5316",
      // Russian
      "\u0442\u0430\u0431\u043B\u0438\u0446\u0430",
      "\u0444\u043E\u0440\u043C\u0430\u0442\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u043A\u0430\u043A",
      "\u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0439",
      // German
      "tabelle",
      "formatieren als",
      "strukturiert",
      // Spanish
      "tabla",
      "formatear como",
      "estructurado",
      // Portuguese
      "tabela",
      "formatar como",
      "estruturado",
      // Korean
      "\uD14C\uC774\uBE14",
      "\uD615\uC2DD",
      "\uAD6C\uC870\uD654",
      // Arabic
      "\u062C\u062F\u0648\u0644",
      "\u062A\u0646\u0633\u064A\u0642",
      "\u0645\u0646\u0638\u0645"
    ],
    referenceKeywords: [
      // English
      "above",
      "below",
      "previous",
      "following",
      "the docs",
      "the api",
      "the code",
      "earlier",
      "attached",
      // Chinese
      "\u4E0A\u9762",
      "\u4E0B\u9762",
      "\u4E4B\u524D",
      "\u63A5\u4E0B\u6765",
      "\u6587\u6863",
      "\u4EE3\u7801",
      "\u9644\u4EF6",
      // Japanese
      "\u4E0A\u8A18",
      "\u4E0B\u8A18",
      "\u524D\u306E",
      "\u6B21\u306E",
      "\u30C9\u30AD\u30E5\u30E1\u30F3\u30C8",
      "\u30B3\u30FC\u30C9",
      // Russian
      "\u0432\u044B\u0448\u0435",
      "\u043D\u0438\u0436\u0435",
      "\u043F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0438\u0439",
      "\u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439",
      "\u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u0430\u0446\u0438\u044F",
      "\u043A\u043E\u0434",
      "\u0440\u0430\u043D\u0435\u0435",
      "\u0432\u043B\u043E\u0436\u0435\u043D\u0438\u0435",
      // German
      "oben",
      "unten",
      "vorherige",
      "folgende",
      "dokumentation",
      "der code",
      "fr\xFCher",
      "anhang",
      // Spanish
      "arriba",
      "abajo",
      "anterior",
      "siguiente",
      "documentaci\xF3n",
      "el c\xF3digo",
      "adjunto",
      // Portuguese
      "acima",
      "abaixo",
      "anterior",
      "seguinte",
      "documenta\xE7\xE3o",
      "o c\xF3digo",
      "anexo",
      // Korean
      "\uC704",
      "\uC544\uB798",
      "\uC774\uC804",
      "\uB2E4\uC74C",
      "\uBB38\uC11C",
      "\uCF54\uB4DC",
      "\uCCA8\uBD80",
      // Arabic
      "\u0623\u0639\u0644\u0627\u0647",
      "\u0623\u062F\u0646\u0627\u0647",
      "\u0627\u0644\u0633\u0627\u0628\u0642",
      "\u0627\u0644\u062A\u0627\u0644\u064A",
      "\u0627\u0644\u0648\u062B\u0627\u0626\u0642",
      "\u0627\u0644\u0643\u0648\u062F",
      "\u0645\u0631\u0641\u0642"
    ],
    negationKeywords: [
      // English
      "don't",
      "do not",
      "avoid",
      "never",
      "without",
      "except",
      "exclude",
      "no longer",
      // Chinese
      "\u4E0D\u8981",
      "\u907F\u514D",
      "\u4ECE\u4E0D",
      "\u6CA1\u6709",
      "\u9664\u4E86",
      "\u6392\u9664",
      // Japanese
      "\u3057\u306A\u3044\u3067",
      "\u907F\u3051\u308B",
      "\u6C7A\u3057\u3066",
      "\u306A\u3057\u3067",
      "\u9664\u304F",
      // Russian
      "\u043D\u0435 \u0434\u0435\u043B\u0430\u0439",
      "\u043D\u0435 \u043D\u0430\u0434\u043E",
      "\u043D\u0435\u043B\u044C\u0437\u044F",
      "\u0438\u0437\u0431\u0435\u0433\u0430\u0442\u044C",
      "\u043D\u0438\u043A\u043E\u0433\u0434\u0430",
      "\u0431\u0435\u0437",
      "\u043A\u0440\u043E\u043C\u0435",
      "\u0438\u0441\u043A\u043B\u044E\u0447\u0438\u0442\u044C",
      "\u0431\u043E\u043B\u044C\u0448\u0435 \u043D\u0435",
      // German
      "nicht",
      "vermeide",
      "niemals",
      "ohne",
      "au\xDFer",
      "ausschlie\xDFen",
      "nicht mehr",
      // Spanish
      "no hagas",
      "evitar",
      "nunca",
      "sin",
      "excepto",
      "excluir",
      // Portuguese
      "n\xE3o fa\xE7a",
      "evitar",
      "nunca",
      "sem",
      "exceto",
      "excluir",
      // Korean
      "\uD558\uC9C0 \uB9C8",
      "\uD53C\uD558\uB2E4",
      "\uC808\uB300",
      "\uC5C6\uC774",
      "\uC81C\uC678",
      // Arabic
      "\u0644\u0627 \u062A\u0641\u0639\u0644",
      "\u062A\u062C\u0646\u0628",
      "\u0623\u0628\u062F\u0627\u064B",
      "\u0628\u062F\u0648\u0646",
      "\u0628\u0627\u0633\u062A\u062B\u0646\u0627\u0621",
      "\u0627\u0633\u062A\u0628\u0639\u0627\u062F"
    ],
    domainSpecificKeywords: [
      // English
      "quantum",
      "fpga",
      "vlsi",
      "risc-v",
      "asic",
      "photonics",
      "genomics",
      "proteomics",
      "topological",
      "homomorphic",
      "zero-knowledge",
      "lattice-based",
      // Chinese
      "\u91CF\u5B50",
      "\u5149\u5B50\u5B66",
      "\u57FA\u56E0\u7EC4\u5B66",
      "\u86CB\u767D\u8D28\u7EC4\u5B66",
      "\u62D3\u6251",
      "\u540C\u6001",
      "\u96F6\u77E5\u8BC6",
      "\u683C\u5BC6\u7801",
      // Japanese
      "\u91CF\u5B50",
      "\u30D5\u30A9\u30C8\u30CB\u30AF\u30B9",
      "\u30B2\u30CE\u30DF\u30AF\u30B9",
      "\u30C8\u30DD\u30ED\u30B8\u30AB\u30EB",
      // Russian
      "\u043A\u0432\u0430\u043D\u0442\u043E\u0432\u044B\u0439",
      "\u0444\u043E\u0442\u043E\u043D\u0438\u043A\u0430",
      "\u0433\u0435\u043D\u043E\u043C\u0438\u043A\u0430",
      "\u043F\u0440\u043E\u0442\u0435\u043E\u043C\u0438\u043A\u0430",
      "\u0442\u043E\u043F\u043E\u043B\u043E\u0433\u0438\u0447\u0435\u0441\u043A\u0438\u0439",
      "\u0433\u043E\u043C\u043E\u043C\u043E\u0440\u0444\u043D\u044B\u0439",
      "\u0441 \u043D\u0443\u043B\u0435\u0432\u044B\u043C \u0440\u0430\u0437\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u0435\u043C",
      "\u043D\u0430 \u043E\u0441\u043D\u043E\u0432\u0435 \u0440\u0435\u0448\u0451\u0442\u043E\u043A",
      // German
      "quanten",
      "photonik",
      "genomik",
      "proteomik",
      "topologisch",
      "homomorph",
      "zero-knowledge",
      "gitterbasiert",
      // Spanish
      "cu\xE1ntico",
      "fot\xF3nica",
      "gen\xF3mica",
      "prote\xF3mica",
      "topol\xF3gico",
      "homom\xF3rfico",
      // Portuguese
      "qu\xE2ntico",
      "fot\xF4nica",
      "gen\xF4mica",
      "prote\xF4mica",
      "topol\xF3gico",
      "homom\xF3rfico",
      // Korean
      "\uC591\uC790",
      "\uD3EC\uD1A0\uB2C9\uC2A4",
      "\uC720\uC804\uCCB4\uD559",
      "\uC704\uC0C1",
      "\uB3D9\uD615",
      // Arabic
      "\u0643\u0645\u064A",
      "\u0636\u0648\u0626\u064A\u0627\u062A",
      "\u062C\u064A\u0646\u0648\u0645\u064A\u0627\u062A",
      "\u0637\u0648\u0628\u0648\u0644\u0648\u062C\u064A",
      "\u062A\u0645\u0627\u062B\u0644\u064A"
    ],
    // Agentic task keywords - file ops, execution, multi-step, iterative work
    // Pruned: removed overly common words like "then", "first", "run", "test", "build"
    agenticTaskKeywords: [
      // English - File operations (clearly agentic)
      "read file",
      "read the file",
      "look at",
      "check the",
      "open the",
      "edit",
      "modify",
      "update the",
      "change the",
      "write to",
      "create file",
      // English - Execution (specific commands only)
      "execute",
      "deploy",
      "install",
      "npm",
      "pip",
      "compile",
      // English - Multi-step patterns (specific only)
      "after that",
      "and also",
      "once done",
      "step 1",
      "step 2",
      // English - Iterative work
      "fix",
      "debug",
      "until it works",
      "keep trying",
      "iterate",
      "make sure",
      "verify",
      "confirm",
      // Chinese (keep specific ones)
      "\u8BFB\u53D6\u6587\u4EF6",
      "\u67E5\u770B",
      "\u6253\u5F00",
      "\u7F16\u8F91",
      "\u4FEE\u6539",
      "\u66F4\u65B0",
      "\u521B\u5EFA",
      "\u6267\u884C",
      "\u90E8\u7F72",
      "\u5B89\u88C5",
      "\u7B2C\u4E00\u6B65",
      "\u7B2C\u4E8C\u6B65",
      "\u4FEE\u590D",
      "\u8C03\u8BD5",
      "\u76F4\u5230",
      "\u786E\u8BA4",
      "\u9A8C\u8BC1",
      // Spanish
      "leer archivo",
      "editar",
      "modificar",
      "actualizar",
      "ejecutar",
      "desplegar",
      "instalar",
      "paso 1",
      "paso 2",
      "arreglar",
      "depurar",
      "verificar",
      // Portuguese
      "ler arquivo",
      "editar",
      "modificar",
      "atualizar",
      "executar",
      "implantar",
      "instalar",
      "passo 1",
      "passo 2",
      "corrigir",
      "depurar",
      "verificar",
      // Korean
      "\uD30C\uC77C \uC77D\uAE30",
      "\uD3B8\uC9D1",
      "\uC218\uC815",
      "\uC5C5\uB370\uC774\uD2B8",
      "\uC2E4\uD589",
      "\uBC30\uD3EC",
      "\uC124\uCE58",
      "\uB2E8\uACC4 1",
      "\uB2E8\uACC4 2",
      "\uB514\uBC84\uADF8",
      "\uD655\uC778",
      // Arabic
      "\u0642\u0631\u0627\u0621\u0629 \u0645\u0644\u0641",
      "\u062A\u062D\u0631\u064A\u0631",
      "\u062A\u0639\u062F\u064A\u0644",
      "\u062A\u062D\u062F\u064A\u062B",
      "\u062A\u0646\u0641\u064A\u0630",
      "\u0646\u0634\u0631",
      "\u062A\u062B\u0628\u064A\u062A",
      "\u0627\u0644\u062E\u0637\u0648\u0629 1",
      "\u0627\u0644\u062E\u0637\u0648\u0629 2",
      "\u0625\u0635\u0644\u0627\u062D",
      "\u062A\u0635\u062D\u064A\u062D",
      "\u062A\u062D\u0642\u0642"
    ],
    // Dimension weights (sum to 1.0)
    dimensionWeights: {
      tokenCount: 0.08,
      codePresence: 0.15,
      reasoningMarkers: 0.18,
      technicalTerms: 0.1,
      creativeMarkers: 0.05,
      simpleIndicators: 0.02,
      // Reduced from 0.12 to make room for agenticTask
      multiStepPatterns: 0.12,
      questionComplexity: 0.05,
      imperativeVerbs: 0.03,
      constraintCount: 0.04,
      outputFormat: 0.03,
      referenceComplexity: 0.02,
      negationComplexity: 0.01,
      domainSpecificity: 0.02,
      agenticTask: 0.04
      // Reduced - agentic signals influence tier selection, not dominate it
    },
    // Tier boundaries on weighted score axis
    tierBoundaries: {
      simpleMedium: 0,
      mediumComplex: 0.3,
      // Raised from 0.18 - prevent simple tasks from reaching expensive COMPLEX tier
      complexReasoning: 0.5
      // Raised from 0.4 - reserve for true reasoning tasks
    },
    // Sigmoid steepness for confidence calibration
    confidenceSteepness: 12,
    // Below this confidence → ambiguous (null tier)
    confidenceThreshold: 0.7
  },
  // Auto (balanced) tier configs - current default smart routing
  // Demo latency tuning 2026-07-02: avoid slow default paths observed on qwen-235b and llama-3.3-70b.
  // ── Tier Configs (verified working models only) ──
  tiers: {
    SIMPLE: {
      primary: "gemini-2.5-flash",
      fallback: [
        "meta-llama/llama-4-maverick",
        "deepseek/deepseek-chat-v3-0324",
        "meta-llama/llama-3.3-70b-instruct"
      ]
    },
    MEDIUM: {
      primary: "gemini-2.5-flash",
      fallback: [
        "meta-llama/llama-4-maverick",
        "deepseek/deepseek-chat-v3-0324",
        "qwen/qwen3-235b-a22b"
      ]
    },
    COMPLEX: {
      primary: "deepseek/deepseek-chat-v3-0324",
      fallback: [
        "gemini-2.5-flash",
        "meta-llama/llama-4-maverick"
      ]
    },
    REASONING: {
      primary: "gemini-2.5-flash",
      fallback: [
        "deepseek/deepseek-chat-v3-0324",
        "qwen/qwen3-235b-a22b"
      ]
    }
  },
  // Eco tier — cheapest/free models
  ecoTiers: {
    SIMPLE: {
      primary: "openai/gpt-oss-20b:free",
      fallback: [
        "free/gpt-oss-120b",
        "nvidia/nemotron-3-super-120b-a12b:free",
        "google/gemma-4-26b-a4b-it:free",
        "google/gemma-4-31b-it:free"
      ]
    },
    MEDIUM: {
      primary: "nvidia/nemotron-3-super-120b-a12b:free",
      fallback: [
        "openai/gpt-oss-20b:free",
        "google/gemma-4-31b-it:free"
      ]
    },
    COMPLEX: {
      primary: "meta-llama/llama-3.3-70b-instruct",
      fallback: [
        "qwen/qwen3-235b-a22b",
        "nvidia/nemotron-3-super-120b-a12b:free"
      ]
    },
    REASONING: {
      primary: "liquid/lfm-2.5-1.2b-thinking:free",
      fallback: [
        "deepseek/deepseek-chat-v3-0324"
      ]
    }
  },
  // Premium tier — best quality
  premiumTiers: {
    SIMPLE: {
      primary: "gemini-2.5-flash",
      fallback: ["meta-llama/llama-4-maverick", "deepseek/deepseek-chat-v3-0324"]
    },
    MEDIUM: {
      primary: "gemini-2.5-flash",
      fallback: ["deepseek/deepseek-chat-v3-0324", "meta-llama/llama-4-maverick"]
    },
    COMPLEX: {
      primary: "deepseek/deepseek-chat-v3-0324",
      fallback: ["gemini-2.5-flash", "meta-llama/llama-4-maverick"]
    },
    REASONING: {
      primary: "gemini-2.5-flash",
      fallback: ["deepseek/deepseek-chat-v3-0324", "qwen/qwen3-235b-a22b"]
    }
  },
  // Agentic tier — models with tool use support
  agenticTiers: {
    SIMPLE: {
      primary: "gemini-2.5-flash",
      fallback: ["meta-llama/llama-4-maverick", "deepseek/deepseek-chat-v3-0324"]
    },
    MEDIUM: {
      primary: "gemini-2.5-flash",
      fallback: ["deepseek/deepseek-chat-v3-0324", "meta-llama/llama-4-maverick"]
    },
    COMPLEX: {
      primary: "meta-llama/llama-4-maverick",
      fallback: ["deepseek/deepseek-chat-v3-0324", "qwen/qwen3-235b-a22b"]
    },
    REASONING: {
      primary: "deepseek/deepseek-chat-v3-0324",
      fallback: ["meta-llama/llama-4-maverick"]
    }
  },
  promotions: [],
  overrides: {
    maxTokensForceComplex: 1e5,
    structuredOutputMinTier: "MEDIUM",
    ambiguousDefaultTier: "MEDIUM"
  }
};

// src/router/index.ts
function route(prompt, systemPrompt, maxOutputTokens, options) {
  const strategy = getStrategy("rules");
  return strategy.route(prompt, systemPrompt, maxOutputTokens, options);
}

// src/models.ts
var UnknownModelError = class extends Error {
  code = "UNKNOWN_MODEL";
  constructor(modelId) {
    super(`Unknown model id: ${modelId}`);
    this.name = "UnknownModelError";
  }
};
var BLOCKRUN_MODELS = [
  // ═══════════════════════════════════════════
  //  api.openai-proxy.org
  // ═══════════════════════════════════════════
  // ── OpenAI (GPT-4 series, works with max_tokens) ──
  {
    id: "gpt-4o",
    name: "GPT-4o",
    upstream: "proxy",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    upstream: "proxy",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    upstream: "proxy",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
    contextWindow: 1048576,
    maxTokens: 32768
  },
  {
    id: "gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    upstream: "proxy",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 },
    contextWindow: 1048576,
    maxTokens: 32768
  },
  {
    id: "gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    upstream: "proxy",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
    contextWindow: 1048576,
    maxTokens: 32768
  },
  {
    id: "gpt-4-turbo",
    name: "GPT-4 Turbo",
    upstream: "proxy",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 10, output: 30, cacheRead: 5, cacheWrite: 10 },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  // ── OpenAI (GPT-5 series, need max_completion_tokens) ──
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    upstream: "proxy",
    useMaxCompletionTokens: true,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 105e4,
    maxTokens: 128e3
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    upstream: "proxy",
    useMaxCompletionTokens: true,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
    contextWindow: 105e4,
    maxTokens: 128e3
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    upstream: "proxy",
    useMaxCompletionTokens: true,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
    contextWindow: 105e4,
    maxTokens: 128e3
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    upstream: "proxy",
    useMaxCompletionTokens: true,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 },
    contextWindow: 105e4,
    maxTokens: 65536
  },
  {
    id: "gpt-5.4-nano",
    name: "GPT-5.4 Nano",
    upstream: "proxy",
    useMaxCompletionTokens: true,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0.2 },
    contextWindow: 1048576,
    maxTokens: 32768
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    upstream: "proxy",
    useMaxCompletionTokens: true,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
    contextWindow: 1048576,
    maxTokens: 32768
  },
  // ── OpenAI Reasoning (need max_completion_tokens) ──
  {
    id: "o3",
    name: "o3",
    upstream: "proxy",
    useMaxCompletionTokens: true,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
    contextWindow: 2e5,
    maxTokens: 1e5
  },
  {
    id: "o4-mini",
    name: "o4-mini",
    upstream: "proxy",
    useMaxCompletionTokens: true,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 1.1 },
    contextWindow: 2e5,
    maxTokens: 1e5
  },
  // ── Anthropic Claude ──
  {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    upstream: "proxy",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 2e5,
    maxTokens: 16384
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    upstream: "proxy",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    contextWindow: 2e5,
    maxTokens: 16384
  },
  {
    id: "claude-opus-4-20250514",
    name: "Claude Opus 4",
    upstream: "proxy",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 2e5,
    maxTokens: 32e3
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    upstream: "proxy",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 2e5,
    maxTokens: 32e3
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    upstream: "proxy",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 2e5,
    maxTokens: 32e3
  },
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    upstream: "proxy",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    contextWindow: 2e5,
    maxTokens: 32e3
  },
  // ── Google Gemini ──
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    upstream: "proxy",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.15 },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    upstream: "proxy",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  {
    id: "gemini-3-pro-image",
    name: "Gemini 3 Pro Image",
    upstream: "proxy",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 2, output: 12, cacheRead: 1, cacheWrite: 2 },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    upstream: "proxy",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0.25 },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  {
    id: "gemini-3.1-flash-lite-image",
    name: "Gemini 3.1 Flash Lite Image",
    upstream: "proxy",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.25, output: 1.5, cacheRead: 0.125, cacheWrite: 0.25 },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  {
    id: "gemini-3.1-flash-image",
    name: "Gemini 3.1 Flash Image",
    upstream: "proxy",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.5, output: 3, cacheRead: 0.25, cacheWrite: 0.5 },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    upstream: "proxy",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 1.5 },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  // ── DeepSeek (via proxy) ──
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    upstream: "proxy",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.14, output: 0.28, cacheRead: 28e-4, cacheWrite: 0.14 },
    contextWindow: 1e6,
    maxTokens: 384e3
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    upstream: "proxy",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.435, output: 0.87, cacheRead: 3625e-6, cacheWrite: 0.435 },
    contextWindow: 163840,
    maxTokens: 163840
  },
  {
    id: "deepseek-v3.2",
    name: "DeepSeek V3.2",
    upstream: "proxy",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.3, output: 0.45, cacheRead: 0.15, cacheWrite: 0.3 },
    contextWindow: 163840,
    maxTokens: 163840
  },
  // ── Moonshot Kimi ──
  {
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    upstream: "proxy",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.95, output: 4, cacheRead: 0.475, cacheWrite: 0.95 },
    contextWindow: 256e3,
    maxTokens: 32768
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    upstream: "proxy",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 20, output: 100, cacheRead: 2, cacheWrite: 3 },
    contextWindow: 1048576,
    maxTokens: 1048576
  },
  {
    id: "kimi-k2.6",
    name: "Kimi K2.6",
    upstream: "proxy",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.95, output: 4, cacheRead: 0.475, cacheWrite: 0.95 },
    contextWindow: 256e3,
    maxTokens: 32768
  },
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    upstream: "proxy",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.6, output: 3, cacheRead: 0.3, cacheWrite: 0.6 },
    contextWindow: 256e3,
    maxTokens: 32768
  },
  // ── Qwen (via proxy) ──
  {
    id: "qwen3.7-max",
    name: "Qwen 3.7 Max",
    upstream: "proxy",
    reasoning: true,
    input: ["text"],
    cost: { input: 1.8, output: 5.4, cacheRead: 0.9, cacheWrite: 1.8 },
    contextWindow: 131072,
    maxTokens: 32768
  },
  {
    id: "qwen3.7-plus",
    name: "Qwen 3.7 Plus",
    upstream: "proxy",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.3, output: 1.2, cacheRead: 0.15, cacheWrite: 0.3 },
    contextWindow: 131072,
    maxTokens: 32768
  },
  {
    id: "qwen3.6-flash",
    name: "Qwen 3.6 Flash",
    upstream: "proxy",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.18, output: 1.1, cacheRead: 0.09, cacheWrite: 0.18 },
    contextWindow: 131072,
    maxTokens: 32768
  },
  {
    id: "qwen3.6-plus",
    name: "Qwen 3.6 Plus",
    upstream: "proxy",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.3, output: 1.75, cacheRead: 0.15, cacheWrite: 0.3 },
    contextWindow: 131072,
    maxTokens: 32768
  },
  {
    id: "qwen3.5-flash",
    name: "Qwen 3.5 Flash",
    upstream: "proxy",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.04, output: 0.3, cacheRead: 0.02, cacheWrite: 0.04 },
    contextWindow: 131072,
    maxTokens: 32768
  },
  {
    id: "qwen3.5-plus",
    name: "Qwen 3.5 Plus",
    upstream: "proxy",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.12, output: 0.75, cacheRead: 0.06, cacheWrite: 0.12 },
    contextWindow: 131072,
    maxTokens: 32768
  },
  // ── GLM ──
  {
    id: "glm-5.2",
    name: "GLM 5.2",
    upstream: "proxy",
    reasoning: false,
    input: ["text"],
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  {
    id: "glm-5.1",
    name: "GLM 5.1",
    upstream: "proxy",
    reasoning: false,
    input: ["text"],
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  {
    id: "glm-5",
    name: "GLM 5",
    upstream: "proxy",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 1 },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  // ═══════════════════════════════════════════
  //  OpenRouter
  // ═══════════════════════════════════════════
  // ── DeepSeek (via OpenRouter) ──
  {
    id: "deepseek/deepseek-chat-v3-0324",
    name: "DeepSeek V3 (OR)",
    upstream: "openrouter",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.27, output: 1.12, cacheRead: 0.135, cacheWrite: 0.27 },
    contextWindow: 163840,
    maxTokens: 163840
  },
  {
    id: "deepseek/deepseek-r1",
    name: "DeepSeek R1 (OR)",
    upstream: "openrouter",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.7, output: 2.5, cacheRead: 0.14, cacheWrite: 0.7 },
    contextWindow: 163840,
    maxTokens: 163840
  },
  // ── Meta ──
  {
    id: "meta-llama/llama-4-maverick",
    name: "Llama 4 Maverick",
    upstream: "openrouter",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.2, output: 0.8, cacheRead: 0.05, cacheWrite: 0.2 },
    contextWindow: 1048576,
    maxTokens: 32768
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct",
    name: "Llama 3.3 70B",
    upstream: "openrouter",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.13, output: 0.4, cacheRead: 0.025, cacheWrite: 0.13 },
    contextWindow: 131072,
    maxTokens: 16384
  },
  // ── Qwen (via OpenRouter) ──
  {
    id: "qwen/qwen3-235b-a22b",
    name: "Qwen3 235B (OR)",
    upstream: "openrouter",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.455, output: 1.82, cacheRead: 0.1, cacheWrite: 0.455 },
    contextWindow: 131072,
    maxTokens: 32768
  },
  // ── xAI ──
  {
    id: "x-ai/grok-4.3",
    name: "Grok 4.3 (OR)",
    upstream: "openrouter",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 1.25 },
    contextWindow: 131072,
    maxTokens: 16384
  },
  // ── Free models (OpenRouter) ──
  {
    id: "openai/gpt-oss-20b:free",
    name: "GPT-OSS 20B (Free)",
    upstream: "openrouter",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 16384
  },
  {
    id: "free/gpt-oss-120b",
    name: "GPT-OSS 120B (Legacy Free)",
    upstream: "openrouter",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 16384
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b:free",
    name: "Nemotron Super 120B (Free)",
    upstream: "openrouter",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 16384
  },
  {
    id: "google/gemma-4-26b-a4b-it:free",
    name: "Gemma 4 26B (Free)",
    upstream: "openrouter",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 16384
  },
  {
    id: "google/gemma-4-31b-it:free",
    name: "Gemma 4 31B (Free)",
    upstream: "openrouter",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 16384
  },
  {
    id: "liquid/lfm-2.5-1.2b-thinking:free",
    name: "Liquid LFM Thinking (Free)",
    upstream: "openrouter",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 16384
  }
];
var MODEL_ALIASES = {
  // OpenAI
  gpt: "gpt-4o",
  gpt4: "gpt-4o",
  mini: "gpt-4o-mini",
  o1: "o3",
  o3: "o3",
  o4: "o4-mini",
  nano: "gpt-4.1-nano",
  "gpt-5": "gpt-5.5",
  "gpt-5.5": "gpt-5.5",
  sol: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
  luna: "gpt-5.6-luna",
  "openai/gpt-4o": "gpt-4o",
  "openai/gpt-4o-mini": "gpt-4o-mini",
  "openai/gpt-4.1": "gpt-4.1",
  "openai/gpt-4.1-mini": "gpt-4.1-mini",
  "openai/gpt-4.1-nano": "gpt-4.1-nano",
  "openai/o3": "o3",
  "openai/o4-mini": "o4-mini",
  // Anthropic
  claude: "claude-sonnet-4-20250514",
  sonnet: "claude-sonnet-4-20250514",
  "claude-sonnet": "claude-sonnet-4-20250514",
  "claude-opus": "claude-opus-4-8",
  opus: "claude-opus-4-8",
  fable: "claude-fable-5",
  "anthropic/claude-sonnet-4": "claude-sonnet-4-20250514",
  "anthropic/claude-sonnet-4-20250514": "claude-sonnet-4-20250514",
  "anthropic/claude-opus-4": "claude-opus-4-20250514",
  "anthropic/claude-opus-4.7": "claude-opus-4-7",
  "anthropic/claude-opus-4.8": "claude-opus-4-8",
  "anthropic/claude-opus-4-7": "claude-opus-4-7",
  "anthropic/claude-opus-4-8": "claude-opus-4-8",
  // Google
  gemini: "gemini-2.5-flash",
  flash: "gemini-2.5-flash",
  pro: "gemini-2.5-pro",
  "google/gemini-2.5-flash": "gemini-2.5-flash",
  "google/gemini-2.5-pro": "gemini-2.5-pro",
  // DeepSeek
  deepseek: "deepseek-v4-flash",
  "deepseek-chat": "deepseek-v4-flash",
  "deepseek-pro": "deepseek-v4-pro",
  "deepseek-r1": "deepseek/deepseek-r1",
  // Kimi
  kimi: "kimi-k2.7-code",
  "kimi-k2": "kimi-k2.7-code",
  "moonshot/kimi-k2.5": "kimi-k2.5",
  "moonshot/kimi-k2.6": "kimi-k2.6",
  "moonshot/kimi-k2.7-code": "kimi-k2.7-code",
  // Routing profiles
  "blockrun/auto": "auto",
  "blockrun/eco": "eco",
  "blockrun/free": "free",
  "blockrun/premium": "premium",
  // Qwen
  qwen: "qwen3.7-plus",
  "qwen-max": "qwen3.7-max",
  // GLM
  glm: "glm-5.2",
  // Grok
  grok: "x-ai/grok-4.3",
  // Meta
  llama: "meta-llama/llama-4-maverick",
  maverick: "meta-llama/llama-4-maverick",
  // Free
  free: "nvidia/nemotron-3-super-120b-a12b:free",
  nemotron: "nvidia/nemotron-3-super-120b-a12b:free"
};
function resolveModelAlias(model) {
  const lower = model.toLowerCase().trim();
  return MODEL_ALIASES[lower] ?? lower;
}
function getModelDefinition(modelId) {
  return BLOCKRUN_MODELS.find((m) => m.id === modelId);
}
function getUpstream(modelId) {
  const model = getModelDefinition(modelId);
  if (!model) throw new UnknownModelError(modelId);
  return model.upstream;
}
function usesMaxCompletionTokens(modelId) {
  return getModelDefinition(modelId)?.useMaxCompletionTokens ?? false;
}
function supportsToolCalling(modelId) {
  const configured = getModelDefinition(modelId)?.toolCalling;
  return configured ?? !(/* @__PURE__ */ new Set(["liquid/lfm-2.5-1.2b-thinking:free"])).has(modelId);
}
function supportsVision(modelId) {
  return getModelDefinition(modelId)?.input.includes("image") ?? false;
}
function isReasoningModel(modelId) {
  return getModelDefinition(modelId)?.reasoning ?? false;
}
function getModelContextWindow(modelId) {
  return getModelDefinition(modelId)?.contextWindow;
}

// src/logger.ts
import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
var LOG_DIR = join(homedir(), ".openclaw", "blockrun", "logs");
var dirReady = false;
async function ensureDir() {
  if (dirReady) return;
  await mkdir(LOG_DIR, { recursive: true });
  dirReady = true;
}
async function logUsage(entry) {
  try {
    await ensureDir();
    const date = entry.timestamp.slice(0, 10);
    const file = join(LOG_DIR, `usage-${date}.jsonl`);
    await appendFile(file, JSON.stringify(entry) + "\n");
  } catch {
  }
}

// src/stats.ts
import { readdir, unlink } from "fs/promises";

// src/fs-read.ts
import { open } from "fs/promises";
import { openSync, readSync, closeSync, fstatSync } from "fs";
async function readTextFile(filePath) {
  const fh = await open(filePath, "r");
  try {
    const size = (await fh.stat()).size;
    const buf = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await fh.read(buf, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buf.subarray(0, offset).toString("utf-8");
  } finally {
    await fh.close();
  }
}

// src/stats.ts
import { join as join3 } from "path";
import { homedir as homedir2 } from "os";

// src/version.ts
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join as join2 } from "path";
var __filename = fileURLToPath(import.meta.url);
var __dirname = dirname(__filename);
var require2 = createRequire(import.meta.url);
var pkg = require2(join2(__dirname, "..", "package.json"));
var VERSION = pkg.version;
function clientTag() {
  const raw = (process.env.CLAWROUTER_CLIENT ?? "").trim();
  if (!raw) return "";
  const safe = raw.replace(/[^A-Za-z0-9._/+-]/g, "");
  return safe ? ` ${safe}` : "";
}
var USER_AGENT = `clawrouter/${VERSION}${clientTag()}`;

// src/stats.ts
var LOG_DIR2 = join3(homedir2(), ".openclaw", "blockrun", "logs");
async function parseLogFile(filePath) {
  try {
    const content = await readTextFile(filePath);
    const lines = content.trim().split("\n").filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        entries.push({
          timestamp: entry.timestamp || (/* @__PURE__ */ new Date()).toISOString(),
          model: entry.model || "unknown",
          tier: entry.tier || "UNKNOWN",
          cost: entry.cost || 0,
          baselineCost: entry.baselineCost || entry.cost || 0,
          savings: entry.savings || 0,
          latencyMs: entry.latencyMs || 0
        });
      } catch {
      }
    }
    return entries;
  } catch {
    return [];
  }
}
async function getLogFiles() {
  try {
    const files = await readdir(LOG_DIR2);
    return files.filter((f) => f.startsWith("usage-") && f.endsWith(".jsonl")).sort().reverse();
  } catch {
    return [];
  }
}
function aggregateDay(date, entries) {
  const byTier = {};
  const byModel = {};
  let totalLatency = 0;
  for (const entry of entries) {
    if (!byTier[entry.tier]) byTier[entry.tier] = { count: 0, cost: 0 };
    byTier[entry.tier].count++;
    byTier[entry.tier].cost += entry.cost;
    if (!byModel[entry.model]) byModel[entry.model] = { count: 0, cost: 0 };
    byModel[entry.model].count++;
    byModel[entry.model].cost += entry.cost;
    totalLatency += entry.latencyMs;
  }
  const totalCost = entries.reduce((sum, e) => sum + e.cost, 0);
  const totalBaselineCost = entries.reduce((sum, e) => sum + e.baselineCost, 0);
  return {
    date,
    totalRequests: entries.length,
    totalCost,
    totalBaselineCost,
    totalSavings: totalBaselineCost - totalCost,
    avgLatencyMs: entries.length > 0 ? totalLatency / entries.length : 0,
    byTier,
    byModel
  };
}
async function getStats(days = 7) {
  const logFiles = await getLogFiles();
  const filesToRead = logFiles.slice(0, days);
  const dailyBreakdown = [];
  const allByTier = {};
  const allByModel = {};
  let totalRequests = 0;
  let totalCost = 0;
  let totalBaselineCost = 0;
  let totalLatency = 0;
  for (const file of filesToRead) {
    const date = file.replace("usage-", "").replace(".jsonl", "");
    const filePath = join3(LOG_DIR2, file);
    const entries = await parseLogFile(filePath);
    if (entries.length === 0) continue;
    const dayStats = aggregateDay(date, entries);
    dailyBreakdown.push(dayStats);
    totalRequests += dayStats.totalRequests;
    totalCost += dayStats.totalCost;
    totalBaselineCost += dayStats.totalBaselineCost;
    totalLatency += dayStats.avgLatencyMs * dayStats.totalRequests;
    for (const [tier, stats] of Object.entries(dayStats.byTier)) {
      if (!allByTier[tier]) allByTier[tier] = { count: 0, cost: 0 };
      allByTier[tier].count += stats.count;
      allByTier[tier].cost += stats.cost;
    }
    for (const [model, stats] of Object.entries(dayStats.byModel)) {
      if (!allByModel[model]) allByModel[model] = { count: 0, cost: 0 };
      allByModel[model].count += stats.count;
      allByModel[model].cost += stats.cost;
    }
  }
  const byTierWithPercentage = {};
  for (const [tier, stats] of Object.entries(allByTier)) {
    byTierWithPercentage[tier] = {
      ...stats,
      percentage: totalRequests > 0 ? stats.count / totalRequests * 100 : 0
    };
  }
  const byModelWithPercentage = {};
  for (const [model, stats] of Object.entries(allByModel)) {
    byModelWithPercentage[model] = {
      ...stats,
      percentage: totalRequests > 0 ? stats.count / totalRequests * 100 : 0
    };
  }
  const totalSavings = totalBaselineCost - totalCost;
  const savingsPercentage = totalBaselineCost > 0 ? totalSavings / totalBaselineCost * 100 : 0;
  let entriesWithBaseline = 0;
  for (const day of dailyBreakdown) {
    if (day.totalBaselineCost !== day.totalCost) {
      entriesWithBaseline += day.totalRequests;
    }
  }
  return {
    period: days === 1 ? "today" : `last ${days} days`,
    totalRequests,
    totalCost,
    totalBaselineCost,
    totalSavings,
    savingsPercentage,
    avgLatencyMs: totalRequests > 0 ? totalLatency / totalRequests : 0,
    avgCostPerRequest: totalRequests > 0 ? totalCost / totalRequests : 0,
    byTier: byTierWithPercentage,
    byModel: byModelWithPercentage,
    dailyBreakdown: dailyBreakdown.reverse(),
    // Oldest first for charts
    entriesWithBaseline
    // How many entries have valid baseline tracking
  };
}
async function clearStats() {
  try {
    const files = await readdir(LOG_DIR2);
    const logFiles = files.filter((f) => f.startsWith("usage-") && f.endsWith(".jsonl"));
    await Promise.all(logFiles.map((f) => unlink(join3(LOG_DIR2, f))));
    return { deletedFiles: logFiles.length };
  } catch {
    return { deletedFiles: 0 };
  }
}

// src/dedup.ts
import { createHash } from "crypto";
var DEFAULT_TTL_MS = 3e4;
var MAX_BODY_SIZE = 1048576;
function canonicalize(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalize);
  }
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalize(obj[key]);
  }
  return sorted;
}
var TIMESTAMP_PATTERN = /^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]\s*/;
function stripTimestamps(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(stripTimestamps);
  }
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "content" && typeof value === "string") {
      result[key] = value.replace(TIMESTAMP_PATTERN, "");
    } else {
      result[key] = stripTimestamps(value);
    }
  }
  return result;
}
var RequestDeduplicator = class {
  inflight = /* @__PURE__ */ new Map();
  completed = /* @__PURE__ */ new Map();
  ttlMs;
  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }
  /** Hash request body to create a dedup key. */
  static hash(body) {
    let content = body;
    try {
      const parsed = JSON.parse(body.toString());
      const stripped = stripTimestamps(parsed);
      const canonical = canonicalize(stripped);
      content = Buffer.from(JSON.stringify(canonical));
    } catch {
    }
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  }
  /** Check if a response is cached for this key. */
  getCached(key) {
    const entry = this.completed.get(key);
    if (!entry) return void 0;
    if (Date.now() - entry.completedAt > this.ttlMs) {
      this.completed.delete(key);
      return void 0;
    }
    return entry;
  }
  /** Check if a request with this key is currently in-flight. Returns a promise to wait on. */
  getInflight(key) {
    const entry = this.inflight.get(key);
    if (!entry) return void 0;
    return new Promise((resolve) => {
      entry.resolvers.push(resolve);
    });
  }
  /** Mark a request as in-flight. */
  markInflight(key) {
    this.inflight.set(key, {
      resolvers: []
    });
  }
  /** Complete an in-flight request — cache result and notify waiters. */
  complete(key, result) {
    if (result.body.length <= MAX_BODY_SIZE) {
      this.completed.set(key, result);
    }
    const entry = this.inflight.get(key);
    if (entry) {
      for (const resolve of entry.resolvers) {
        resolve(result);
      }
      this.inflight.delete(key);
    }
    this.prune();
  }
  /** Remove an in-flight entry on error (don't cache failures).
   *  Also rejects any waiters so they can retry independently. */
  removeInflight(key) {
    const entry = this.inflight.get(key);
    if (entry) {
      const errorBody = Buffer.from(
        JSON.stringify({
          error: { message: "Original request failed, please retry", type: "dedup_origin_failed" }
        })
      );
      for (const resolve of entry.resolvers) {
        resolve({
          status: 503,
          headers: { "content-type": "application/json" },
          body: errorBody,
          completedAt: Date.now()
        });
      }
      this.inflight.delete(key);
    }
  }
  /** Prune expired completed entries. */
  prune() {
    const now = Date.now();
    for (const [key, entry] of this.completed) {
      if (now - entry.completedAt > this.ttlMs) {
        this.completed.delete(key);
      }
    }
  }
};

// src/response-cache.ts
import { createHash as createHash2 } from "crypto";
var DEFAULT_CONFIG = {
  maxSize: 200,
  defaultTTL: 600,
  maxItemSize: 1048576,
  // 1MB
  enabled: true
};
function canonicalize2(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalize2);
  }
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalize2(obj[key]);
  }
  return sorted;
}
var TIMESTAMP_PATTERN2 = /^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]\s*/;
function normalizeForCache(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (["user", "request_id", "x-request-id"].includes(key)) {
      continue;
    }
    if (key === "messages" && Array.isArray(value)) {
      result[key] = value.map((msg) => {
        if (typeof msg === "object" && msg !== null) {
          const m = msg;
          if (typeof m.content === "string") {
            return { ...m, content: m.content.replace(TIMESTAMP_PATTERN2, "") };
          }
        }
        return msg;
      });
    } else {
      result[key] = value;
    }
  }
  return result;
}
var ResponseCache = class {
  cache = /* @__PURE__ */ new Map();
  expirationHeap = [];
  config;
  // Stats for monitoring
  stats = {
    hits: 0,
    misses: 0,
    evictions: 0
  };
  constructor(config = {}) {
    const filtered = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== void 0)
    );
    this.config = { ...DEFAULT_CONFIG, ...filtered };
  }
  /**
   * Generate cache key from request body.
   * Hashes: model + messages + temperature + max_tokens + other params
   */
  static generateKey(body) {
    try {
      const parsed = JSON.parse(typeof body === "string" ? body : body.toString());
      const normalized = normalizeForCache(parsed);
      const canonical = canonicalize2(normalized);
      const keyContent = JSON.stringify(canonical);
      return createHash2("sha256").update(keyContent).digest("hex").slice(0, 32);
    } catch {
      const content = typeof body === "string" ? body : body.toString();
      return createHash2("sha256").update(content).digest("hex").slice(0, 32);
    }
  }
  /**
   * Check if caching is enabled for this request.
   * Respects cache control headers and request params.
   */
  shouldCache(body, headers) {
    if (!this.config.enabled) return false;
    if (headers?.["cache-control"]?.includes("no-cache")) {
      return false;
    }
    try {
      const parsed = JSON.parse(typeof body === "string" ? body : body.toString());
      if (parsed.cache === false || parsed.no_cache === true) {
        return false;
      }
    } catch {
    }
    return true;
  }
  /**
   * Get cached response if available and not expired.
   */
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return void 0;
    }
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.misses++;
      return void 0;
    }
    this.stats.hits++;
    return entry;
  }
  /**
   * Cache a response with optional custom TTL.
   */
  set(key, response, ttlSeconds) {
    if (!this.config.enabled || this.config.maxSize <= 0) return;
    if (response.body.length > this.config.maxItemSize) {
      console.log(`[ResponseCache] Skipping cache - item too large: ${response.body.length} bytes`);
      return;
    }
    if (response.status >= 400) {
      return;
    }
    if (this.cache.size >= this.config.maxSize) {
      this.evict();
    }
    const now = Date.now();
    const ttl = ttlSeconds ?? this.config.defaultTTL;
    const expiresAt = now + ttl * 1e3;
    const entry = {
      ...response,
      cachedAt: now,
      expiresAt
    };
    this.cache.set(key, entry);
    this.expirationHeap.push({ expiresAt, key });
  }
  /**
   * Evict expired and oldest entries to make room.
   */
  evict() {
    const now = Date.now();
    this.expirationHeap.sort((a, b) => a.expiresAt - b.expiresAt);
    while (this.expirationHeap.length > 0) {
      const oldest = this.expirationHeap[0];
      const entry = this.cache.get(oldest.key);
      if (!entry || entry.expiresAt !== oldest.expiresAt) {
        this.expirationHeap.shift();
        continue;
      }
      if (oldest.expiresAt <= now) {
        this.cache.delete(oldest.key);
        this.expirationHeap.shift();
        this.stats.evictions++;
      } else {
        break;
      }
    }
    while (this.cache.size >= this.config.maxSize && this.expirationHeap.length > 0) {
      const oldest = this.expirationHeap.shift();
      if (this.cache.has(oldest.key)) {
        this.cache.delete(oldest.key);
        this.stats.evictions++;
      }
    }
  }
  /**
   * Get cache statistics.
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? (this.stats.hits / total * 100).toFixed(1) + "%" : "0%";
    return {
      size: this.cache.size,
      maxSize: this.config.maxSize,
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      hitRate
    };
  }
  /**
   * Clear all cached entries.
   */
  clear() {
    this.cache.clear();
    this.expirationHeap = [];
  }
  /**
   * Check if cache is enabled.
   */
  isEnabled() {
    return this.config.enabled;
  }
};

// src/compression/types.ts
var DEFAULT_COMPRESSION_CONFIG = {
  enabled: true,
  preserveRaw: true,
  layers: {
    deduplication: true,
    // Safe: removes duplicate messages
    whitespace: true,
    // Safe: normalizes whitespace
    dictionary: false,
    // DISABLED: requires model to understand codebook
    paths: false,
    // DISABLED: requires model to understand path codes
    jsonCompact: true,
    // Safe: just removes JSON whitespace
    observation: false,
    // DISABLED: may lose important context
    dynamicCodebook: false
    // DISABLED: requires model to understand codes
  },
  dictionary: {
    maxEntries: 50,
    minPhraseLength: 15,
    includeCodebookHeader: false
    // No codebook header needed
  }
};

// src/compression/layers/deduplication.ts
import crypto from "crypto";
function hashMessage(message) {
  let contentStr = "";
  if (typeof message.content === "string") {
    contentStr = message.content;
  } else if (Array.isArray(message.content)) {
    contentStr = JSON.stringify(message.content);
  }
  const parts = [message.role, contentStr, message.tool_call_id || "", message.name || ""];
  if (message.tool_calls) {
    parts.push(
      JSON.stringify(
        message.tool_calls.map((tc) => ({
          name: tc.function.name,
          args: tc.function.arguments
        }))
      )
    );
  }
  const content = parts.join("|");
  return crypto.createHash("md5").update(content).digest("hex");
}
function deduplicateMessages(messages) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  let duplicatesRemoved = 0;
  const referencedToolCallIds = /* @__PURE__ */ new Set();
  for (const message of messages) {
    if (message.role === "tool" && message.tool_call_id) {
      referencedToolCallIds.add(message.tool_call_id);
    }
  }
  for (const message of messages) {
    if (message.role === "system") {
      result.push(message);
      continue;
    }
    if (message.role === "user") {
      result.push(message);
      continue;
    }
    if (message.role === "tool") {
      result.push(message);
      continue;
    }
    if (message.role === "assistant" && message.tool_calls) {
      const hasReferencedToolCall = message.tool_calls.some(
        (tc) => referencedToolCallIds.has(tc.id)
      );
      if (hasReferencedToolCall) {
        result.push(message);
        continue;
      }
    }
    const hash = hashMessage(message);
    if (!seen.has(hash)) {
      seen.add(hash);
      result.push(message);
    } else {
      duplicatesRemoved++;
    }
  }
  return {
    messages: result,
    duplicatesRemoved,
    originalCount: messages.length
  };
}

// src/compression/layers/whitespace.ts
function normalizeWhitespace(content) {
  if (!content || typeof content !== "string") return content;
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "").replace(/([^\n]) {2,}/g, "$1 ").replace(/^[ ]{8,}/gm, (match) => "  ".repeat(Math.ceil(match.length / 4))).replace(/\t/g, "  ").trim();
}
function normalizeMessagesWhitespace(messages) {
  let charsSaved = 0;
  const result = messages.map((message) => {
    if (!message.content || typeof message.content !== "string") return message;
    const originalLength = message.content.length;
    const normalizedContent = normalizeWhitespace(message.content);
    charsSaved += originalLength - normalizedContent.length;
    return {
      ...message,
      content: normalizedContent
    };
  });
  return {
    messages: result,
    charsSaved
  };
}

// src/compression/codebook.ts
var STATIC_CODEBOOK = {
  // High-impact: OpenClaw/Agent system prompt patterns (very common)
  $OC01: "unbrowse_",
  // Common prefix in tool names
  $OC02: "<location>",
  $OC03: "</location>",
  $OC04: "<name>",
  $OC05: "</name>",
  $OC06: "<description>",
  $OC07: "</description>",
  $OC08: "(may need login)",
  $OC09: "API skill for OpenClaw",
  $OC10: "endpoints",
  // Skill/tool markers
  $SK01: "<available_skills>",
  $SK02: "</available_skills>",
  $SK03: "<skill>",
  $SK04: "</skill>",
  // Schema patterns (very common in tool definitions)
  $T01: 'type: "function"',
  $T02: '"type": "function"',
  $T03: '"type": "string"',
  $T04: '"type": "object"',
  $T05: '"type": "array"',
  $T06: '"type": "boolean"',
  $T07: '"type": "number"',
  // Common descriptions
  $D01: "description:",
  $D02: '"description":',
  // Common instructions
  $I01: "You are a personal assistant",
  $I02: "Tool names are case-sensitive",
  $I03: "Call tools exactly as listed",
  $I04: "Use when",
  $I05: "without asking",
  // Safety phrases
  $S01: "Do not manipulate or persuade",
  $S02: "Prioritize safety and human oversight",
  $S03: "unless explicitly requested",
  // JSON patterns
  $J01: '"required": ["',
  $J02: '"properties": {',
  $J03: '"additionalProperties": false',
  // Heartbeat patterns
  $H01: "HEARTBEAT_OK",
  $H02: "Read HEARTBEAT.md if it exists",
  // Role markers
  $R01: '"role": "system"',
  $R02: '"role": "user"',
  $R03: '"role": "assistant"',
  $R04: '"role": "tool"',
  // Common endings/phrases
  $E01: "would you like to",
  $E02: "Let me know if you",
  $E03: "internal APIs",
  $E04: "session cookies",
  // BlockRun model aliases (common in prompts)
  $M01: "blockrun/",
  $M02: "openai/",
  $M03: "anthropic/",
  $M04: "google/",
  $M05: "xai/"
};
function getInverseCodebook() {
  const inverse = {};
  for (const [code, phrase] of Object.entries(STATIC_CODEBOOK)) {
    inverse[phrase] = code;
  }
  return inverse;
}
function generateCodebookHeader(usedCodes, pathMap = {}) {
  if (usedCodes.size === 0 && Object.keys(pathMap).length === 0) {
    return "";
  }
  const parts = [];
  if (usedCodes.size > 0) {
    const codeEntries = Array.from(usedCodes).map((code) => `${code}=${STATIC_CODEBOOK[code]}`).join(", ");
    parts.push(`[Dict: ${codeEntries}]`);
  }
  if (Object.keys(pathMap).length > 0) {
    const pathEntries = Object.entries(pathMap).map(([code, path]) => `${code}=${path}`).join(", ");
    parts.push(`[Paths: ${pathEntries}]`);
  }
  return parts.join("\n");
}

// src/compression/layers/dictionary.ts
function encodeContent(content, inverseCodebook) {
  if (!content || typeof content !== "string") {
    return { encoded: content, substitutions: 0, codes: /* @__PURE__ */ new Set(), charsSaved: 0 };
  }
  let encoded = content;
  let substitutions = 0;
  let charsSaved = 0;
  const codes = /* @__PURE__ */ new Set();
  const phrases = Object.keys(inverseCodebook).sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    const code = inverseCodebook[phrase];
    const regex = new RegExp(escapeRegex(phrase), "g");
    const matches = encoded.match(regex);
    if (matches && matches.length > 0) {
      encoded = encoded.replace(regex, code);
      substitutions += matches.length;
      charsSaved += matches.length * (phrase.length - code.length);
      codes.add(code);
    }
  }
  return { encoded, substitutions, codes, charsSaved };
}
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function encodeMessages(messages) {
  const inverseCodebook = getInverseCodebook();
  let totalSubstitutions = 0;
  let totalCharsSaved = 0;
  const allUsedCodes = /* @__PURE__ */ new Set();
  const result = messages.map((message) => {
    if (!message.content || typeof message.content !== "string") return message;
    const { encoded, substitutions, codes, charsSaved } = encodeContent(
      message.content,
      inverseCodebook
    );
    totalSubstitutions += substitutions;
    totalCharsSaved += charsSaved;
    codes.forEach((code) => allUsedCodes.add(code));
    return {
      ...message,
      content: encoded
    };
  });
  return {
    messages: result,
    substitutionCount: totalSubstitutions,
    usedCodes: allUsedCodes,
    charsSaved: totalCharsSaved
  };
}

// src/compression/layers/paths.ts
var PATH_REGEX = /(?:\/[\w.-]+){3,}/g;
function extractPaths(messages) {
  const paths = [];
  for (const message of messages) {
    if (!message.content || typeof message.content !== "string") continue;
    const matches = message.content.match(PATH_REGEX);
    if (matches) {
      paths.push(...matches);
    }
  }
  return paths;
}
function findFrequentPrefixes(paths) {
  const prefixCounts = /* @__PURE__ */ new Map();
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    for (let i = 2; i < parts.length; i++) {
      const prefix = "/" + parts.slice(0, i).join("/") + "/";
      prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
    }
  }
  return Array.from(prefixCounts.entries()).filter(([, count]) => count >= 3).sort((a, b) => b[0].length - a[0].length).slice(0, 5).map(([prefix]) => prefix);
}
function shortenPaths(messages) {
  const allPaths = extractPaths(messages);
  if (allPaths.length < 5) {
    return {
      messages,
      pathMap: {},
      charsSaved: 0
    };
  }
  const prefixes = findFrequentPrefixes(allPaths);
  if (prefixes.length === 0) {
    return {
      messages,
      pathMap: {},
      charsSaved: 0
    };
  }
  const pathMap = {};
  prefixes.forEach((prefix, i) => {
    pathMap[`$P${i + 1}`] = prefix;
  });
  let charsSaved = 0;
  const result = messages.map((message) => {
    if (!message.content || typeof message.content !== "string") return message;
    let content = message.content;
    const originalLength = content.length;
    for (const [code, prefix] of Object.entries(pathMap)) {
      content = content.split(prefix).join(code + "/");
    }
    charsSaved += originalLength - content.length;
    return {
      ...message,
      content
    };
  });
  return {
    messages: result,
    pathMap,
    charsSaved
  };
}

// src/compression/layers/json-compact.ts
function compactJson(jsonString) {
  try {
    const parsed = JSON.parse(jsonString);
    return JSON.stringify(parsed);
  } catch {
    return jsonString;
  }
}
function looksLikeJson(str) {
  const trimmed = str.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}") || trimmed.startsWith("[") && trimmed.endsWith("]");
}
function compactToolCalls(toolCalls) {
  return toolCalls.map((tc) => ({
    ...tc,
    function: {
      ...tc.function,
      arguments: compactJson(tc.function.arguments)
    }
  }));
}
function compactMessagesJson(messages) {
  let charsSaved = 0;
  const result = messages.map((message) => {
    const newMessage = { ...message };
    if (message.tool_calls && message.tool_calls.length > 0) {
      const originalLength = JSON.stringify(message.tool_calls).length;
      newMessage.tool_calls = compactToolCalls(message.tool_calls);
      const newLength = JSON.stringify(newMessage.tool_calls).length;
      charsSaved += originalLength - newLength;
    }
    if (message.role === "tool" && message.content && typeof message.content === "string" && looksLikeJson(message.content)) {
      const originalLength = message.content.length;
      const compacted = compactJson(message.content);
      charsSaved += originalLength - compacted.length;
      newMessage.content = compacted;
    }
    return newMessage;
  });
  return {
    messages: result,
    charsSaved
  };
}

// src/compression/layers/observation.ts
var TOOL_RESULT_THRESHOLD = 500;
var COMPRESSED_RESULT_MAX = 300;
function compressToolResult(content) {
  if (!content || content.length <= TOOL_RESULT_THRESHOLD) {
    return content;
  }
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const errorLines = lines.filter(
    (l) => /error|exception|failed|denied|refused|timeout|invalid/i.test(l) && l.length < 200
  );
  const statusLines = lines.filter(
    (l) => /success|complete|created|updated|found|result|status|total|count/i.test(l) && l.length < 150
  );
  const jsonMatches = [];
  const jsonPattern = /"(id|name|status|error|message|count|total|url|path)":\s*"?([^",}\n]+)"?/gi;
  let match;
  while ((match = jsonPattern.exec(content)) !== null) {
    jsonMatches.push(`${match[1]}: ${match[2].slice(0, 50)}`);
  }
  const firstLine = lines[0]?.slice(0, 100);
  const lastLine = lines.length > 1 ? lines[lines.length - 1]?.slice(0, 100) : "";
  const parts = [];
  if (errorLines.length > 0) {
    parts.push("[ERR] " + errorLines.slice(0, 3).join(" | "));
  }
  if (statusLines.length > 0) {
    parts.push(statusLines.slice(0, 3).join(" | "));
  }
  if (jsonMatches.length > 0) {
    parts.push(jsonMatches.slice(0, 5).join(", "));
  }
  if (parts.length === 0) {
    parts.push(firstLine || "");
    if (lines.length > 2) {
      parts.push(`[...${lines.length - 2} lines...]`);
    }
    if (lastLine && lastLine !== firstLine) {
      parts.push(lastLine);
    }
  }
  let result = parts.join("\n");
  if (result.length > COMPRESSED_RESULT_MAX) {
    result = result.slice(0, COMPRESSED_RESULT_MAX - 20) + "\n[...truncated]";
  }
  return result;
}
function deduplicateLargeBlocks(messages) {
  const blockHashes = /* @__PURE__ */ new Map();
  let charsSaved = 0;
  const result = messages.map((msg, idx) => {
    if (!msg.content || typeof msg.content !== "string" || msg.content.length < 500) {
      return msg;
    }
    const blockKey = msg.content.slice(0, 200);
    if (blockHashes.has(blockKey)) {
      const firstIdx = blockHashes.get(blockKey);
      const original = msg.content;
      const compressed = `[See message #${firstIdx + 1} - same content]`;
      charsSaved += original.length - compressed.length;
      return { ...msg, content: compressed };
    }
    blockHashes.set(blockKey, idx);
    return msg;
  });
  return { messages: result, charsSaved };
}
function compressObservations(messages) {
  let charsSaved = 0;
  let observationsCompressed = 0;
  let result = messages.map((msg) => {
    if (msg.role !== "tool" || !msg.content || typeof msg.content !== "string") {
      return msg;
    }
    const original = msg.content;
    if (original.length <= TOOL_RESULT_THRESHOLD) {
      return msg;
    }
    const compressed = compressToolResult(original);
    const saved = original.length - compressed.length;
    if (saved > 50) {
      charsSaved += saved;
      observationsCompressed++;
      return { ...msg, content: compressed };
    }
    return msg;
  });
  const dedupResult = deduplicateLargeBlocks(result);
  result = dedupResult.messages;
  charsSaved += dedupResult.charsSaved;
  return {
    messages: result,
    charsSaved,
    observationsCompressed
  };
}

// src/compression/layers/dynamic-codebook.ts
var MIN_PHRASE_LENGTH = 20;
var MAX_PHRASE_LENGTH = 200;
var MIN_FREQUENCY = 3;
var MAX_ENTRIES = 100;
var CODE_PREFIX = "$D";
function findRepeatedPhrases(allContent) {
  const phrases = /* @__PURE__ */ new Map();
  const segments = allContent.split(/(?<=[.!?\n])\s+/);
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed.length >= MIN_PHRASE_LENGTH && trimmed.length <= MAX_PHRASE_LENGTH) {
      phrases.set(trimmed, (phrases.get(trimmed) || 0) + 1);
    }
  }
  const lines = allContent.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length >= MIN_PHRASE_LENGTH && trimmed.length <= MAX_PHRASE_LENGTH) {
      phrases.set(trimmed, (phrases.get(trimmed) || 0) + 1);
    }
  }
  return phrases;
}
function buildDynamicCodebook(messages) {
  let allContent = "";
  for (const msg of messages) {
    if (msg.content && typeof msg.content === "string") {
      allContent += msg.content + "\n";
    }
  }
  const phrases = findRepeatedPhrases(allContent);
  const candidates = [];
  for (const [phrase, count] of phrases.entries()) {
    if (count >= MIN_FREQUENCY) {
      const codeLength = 4;
      const savings = (phrase.length - codeLength) * count;
      if (savings > 50) {
        candidates.push({ phrase, count, savings });
      }
    }
  }
  candidates.sort((a, b) => b.savings - a.savings);
  const topCandidates = candidates.slice(0, MAX_ENTRIES);
  const codebook = {};
  topCandidates.forEach((c, i) => {
    const code = `${CODE_PREFIX}${String(i + 1).padStart(2, "0")}`;
    codebook[code] = c.phrase;
  });
  return codebook;
}
function escapeRegex2(str) {
  if (!str || typeof str !== "string") return "";
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function applyDynamicCodebook(messages) {
  const codebook = buildDynamicCodebook(messages);
  if (Object.keys(codebook).length === 0) {
    return {
      messages,
      charsSaved: 0,
      dynamicCodes: {},
      substitutions: 0
    };
  }
  const phraseToCode = {};
  for (const [code, phrase] of Object.entries(codebook)) {
    phraseToCode[phrase] = code;
  }
  const sortedPhrases = Object.keys(phraseToCode).sort((a, b) => b.length - a.length);
  let charsSaved = 0;
  let substitutions = 0;
  const result = messages.map((msg) => {
    if (!msg.content || typeof msg.content !== "string") return msg;
    let content = msg.content;
    for (const phrase of sortedPhrases) {
      const code = phraseToCode[phrase];
      const regex = new RegExp(escapeRegex2(phrase), "g");
      const matches = content.match(regex);
      if (matches) {
        content = content.replace(regex, code);
        charsSaved += (phrase.length - code.length) * matches.length;
        substitutions += matches.length;
      }
    }
    return { ...msg, content };
  });
  return {
    messages: result,
    charsSaved,
    dynamicCodes: codebook,
    substitutions
  };
}
function generateDynamicCodebookHeader(codebook) {
  if (Object.keys(codebook).length === 0) return "";
  const entries = Object.entries(codebook).slice(0, 20).map(([code, phrase]) => {
    const displayPhrase = phrase.length > 40 ? phrase.slice(0, 37) + "..." : phrase;
    return `${code}=${displayPhrase}`;
  }).join(", ");
  return `[DynDict: ${entries}]`;
}

// src/compression/index.ts
function calculateTotalChars(messages) {
  return messages.reduce((total, msg) => {
    let chars = 0;
    if (typeof msg.content === "string") {
      chars = msg.content.length;
    } else if (Array.isArray(msg.content)) {
      chars = JSON.stringify(msg.content).length;
    }
    if (msg.tool_calls) {
      chars += JSON.stringify(msg.tool_calls).length;
    }
    return total + chars;
  }, 0);
}
function cloneMessages(messages) {
  return JSON.parse(JSON.stringify(messages));
}
function prependCodebookHeader(messages, usedCodes, pathMap) {
  const header = generateCodebookHeader(usedCodes, pathMap);
  if (!header) return messages;
  const userIndex = messages.findIndex((m) => m.role === "user");
  if (userIndex === -1) {
    return [{ role: "system", content: header }, ...messages];
  }
  return messages.map((msg, i) => {
    if (i === userIndex) {
      if (typeof msg.content === "string") {
        return {
          ...msg,
          content: `${header}

${msg.content}`
        };
      }
    }
    return msg;
  });
}
async function compressContext(messages, config = {}) {
  const fullConfig = {
    ...DEFAULT_COMPRESSION_CONFIG,
    ...config,
    layers: {
      ...DEFAULT_COMPRESSION_CONFIG.layers,
      ...config.layers
    },
    dictionary: {
      ...DEFAULT_COMPRESSION_CONFIG.dictionary,
      ...config.dictionary
    }
  };
  if (!fullConfig.enabled) {
    const originalChars2 = calculateTotalChars(messages);
    return {
      messages,
      originalMessages: messages,
      originalChars: originalChars2,
      compressedChars: originalChars2,
      compressionRatio: 1,
      stats: {
        duplicatesRemoved: 0,
        whitespaceSavedChars: 0,
        dictionarySubstitutions: 0,
        pathsShortened: 0,
        jsonCompactedChars: 0,
        observationsCompressed: 0,
        observationCharsSaved: 0,
        dynamicSubstitutions: 0,
        dynamicCharsSaved: 0
      },
      codebook: {},
      pathMap: {},
      dynamicCodes: {}
    };
  }
  const originalMessages = fullConfig.preserveRaw ? cloneMessages(messages) : messages;
  const originalChars = calculateTotalChars(messages);
  const stats = {
    duplicatesRemoved: 0,
    whitespaceSavedChars: 0,
    dictionarySubstitutions: 0,
    pathsShortened: 0,
    jsonCompactedChars: 0,
    observationsCompressed: 0,
    observationCharsSaved: 0,
    dynamicSubstitutions: 0,
    dynamicCharsSaved: 0
  };
  let result = cloneMessages(messages);
  let usedCodes = /* @__PURE__ */ new Set();
  let pathMap = {};
  let dynamicCodes = {};
  if (fullConfig.layers.deduplication) {
    const dedupResult = deduplicateMessages(result);
    result = dedupResult.messages;
    stats.duplicatesRemoved = dedupResult.duplicatesRemoved;
  }
  if (fullConfig.layers.whitespace) {
    const wsResult = normalizeMessagesWhitespace(result);
    result = wsResult.messages;
    stats.whitespaceSavedChars = wsResult.charsSaved;
  }
  if (fullConfig.layers.dictionary) {
    const dictResult = encodeMessages(result);
    result = dictResult.messages;
    stats.dictionarySubstitutions = dictResult.substitutionCount;
    usedCodes = dictResult.usedCodes;
  }
  if (fullConfig.layers.paths) {
    const pathResult = shortenPaths(result);
    result = pathResult.messages;
    pathMap = pathResult.pathMap;
    stats.pathsShortened = Object.keys(pathMap).length;
  }
  if (fullConfig.layers.jsonCompact) {
    const jsonResult = compactMessagesJson(result);
    result = jsonResult.messages;
    stats.jsonCompactedChars = jsonResult.charsSaved;
  }
  if (fullConfig.layers.observation) {
    const obsResult = compressObservations(result);
    result = obsResult.messages;
    stats.observationsCompressed = obsResult.observationsCompressed;
    stats.observationCharsSaved = obsResult.charsSaved;
  }
  if (fullConfig.layers.dynamicCodebook) {
    const dynResult = applyDynamicCodebook(result);
    result = dynResult.messages;
    stats.dynamicSubstitutions = dynResult.substitutions;
    stats.dynamicCharsSaved = dynResult.charsSaved;
    dynamicCodes = dynResult.dynamicCodes;
  }
  if (fullConfig.dictionary.includeCodebookHeader && (usedCodes.size > 0 || Object.keys(pathMap).length > 0 || Object.keys(dynamicCodes).length > 0)) {
    result = prependCodebookHeader(result, usedCodes, pathMap);
    if (Object.keys(dynamicCodes).length > 0) {
      const dynHeader = generateDynamicCodebookHeader(dynamicCodes);
      if (dynHeader) {
        const systemIndex = result.findIndex((m) => m.role === "system");
        if (systemIndex >= 0 && typeof result[systemIndex].content === "string") {
          result[systemIndex] = {
            ...result[systemIndex],
            content: `${dynHeader}
${result[systemIndex].content}`
          };
        }
      }
    }
  }
  const compressedChars = calculateTotalChars(result);
  const compressionRatio = compressedChars / originalChars;
  const usedCodebook = {};
  usedCodes.forEach((code) => {
    usedCodebook[code] = STATIC_CODEBOOK[code];
  });
  return {
    messages: result,
    originalMessages,
    originalChars,
    compressedChars,
    compressionRatio,
    stats,
    codebook: usedCodebook,
    pathMap,
    dynamicCodes
  };
}
function shouldCompress(messages) {
  const chars = calculateTotalChars(messages);
  return chars > 5e3;
}

// src/session.ts
import { createHash as createHash3 } from "crypto";
var DEFAULT_SESSION_CONFIG = {
  enabled: true,
  timeoutMs: 30 * 60 * 1e3,
  // 30 minutes
  headerName: "x-session-id"
};
var SessionStore = class {
  sessions = /* @__PURE__ */ new Map();
  config;
  cleanupInterval = null;
  constructor(config = {}) {
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config };
    if (this.config.enabled) {
      this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1e3);
    }
  }
  /**
   * Get the pinned model for a session, if any.
   */
  getSession(sessionId) {
    if (!this.config.enabled || !sessionId) {
      return void 0;
    }
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return void 0;
    }
    const now = Date.now();
    if (now - entry.lastUsedAt > this.config.timeoutMs) {
      this.sessions.delete(sessionId);
      return void 0;
    }
    return entry;
  }
  /**
   * Pin a model to a session.
   *
   * Pass `userExplicit: true` when the user explicitly chose this model
   * (e.g. via /model command or by sending an explicit non-profile model).
   * Explicit pins are sticky — they survive tier-escalation comparisons so
   * that the user's choice keeps winning even if subsequent requests use a
   * routing profile that would normally re-route.
   */
  setSession(sessionId, model, tier, userExplicit) {
    if (!this.config.enabled || !sessionId) {
      return;
    }
    const existing = this.sessions.get(sessionId);
    const now = Date.now();
    if (existing) {
      existing.lastUsedAt = now;
      existing.requestCount++;
      if (existing.model !== model) {
        existing.model = model;
        existing.tier = tier;
      }
      if (userExplicit) {
        existing.userExplicit = true;
      }
    } else {
      this.sessions.set(sessionId, {
        model,
        tier,
        createdAt: now,
        lastUsedAt: now,
        requestCount: 1,
        userExplicit: userExplicit || void 0,
        recentHashes: [],
        strikes: 0,
        escalated: false,
        sessionCostMicros: 0n
      });
    }
  }
  /**
   * Touch a session to extend its timeout.
   */
  touchSession(sessionId) {
    if (!this.config.enabled || !sessionId) {
      return;
    }
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.lastUsedAt = Date.now();
      entry.requestCount++;
    }
  }
  /**
   * Clear a specific session.
   */
  clearSession(sessionId) {
    this.sessions.delete(sessionId);
  }
  /**
   * Clear all sessions.
   */
  clearAll() {
    this.sessions.clear();
  }
  /**
   * Get session stats for debugging.
   */
  getStats() {
    const now = Date.now();
    const sessions = Array.from(this.sessions.entries()).map(([id, entry]) => ({
      id: id.slice(0, 8) + "...",
      model: entry.model,
      age: Math.round((now - entry.createdAt) / 1e3)
    }));
    return { count: this.sessions.size, sessions };
  }
  /**
   * Clean up expired sessions.
   */
  cleanup() {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastUsedAt > this.config.timeoutMs) {
        this.sessions.delete(id);
      }
    }
  }
  /**
   * Record a request content hash and detect repetitive patterns.
   * Returns true if escalation should be triggered (3+ consecutive similar requests).
   */
  recordRequestHash(sessionId, hash) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    const prev = entry.recentHashes;
    if (prev.length > 0 && prev[prev.length - 1] === hash) {
      entry.strikes++;
    } else {
      entry.strikes = 0;
    }
    entry.recentHashes.push(hash);
    if (entry.recentHashes.length > 3) {
      entry.recentHashes.shift();
    }
    return entry.strikes >= 2 && !entry.escalated;
  }
  /**
   * Escalate session to next tier. Returns the new model/tier or null if already at max.
   */
  escalateSession(sessionId, tierConfigs) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    const TIER_ORDER = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];
    const currentIdx = TIER_ORDER.indexOf(entry.tier);
    if (currentIdx < 0 || currentIdx >= TIER_ORDER.length - 1) return null;
    const nextTier = TIER_ORDER[currentIdx + 1];
    const nextConfig = tierConfigs[nextTier];
    if (!nextConfig) return null;
    entry.model = nextConfig.primary;
    entry.tier = nextTier;
    entry.strikes = 0;
    entry.escalated = true;
    return { model: nextConfig.primary, tier: nextTier };
  }
  /**
   * Add cost to a session's running total for maxCostPerRun tracking.
   * Cost in micro-currency units (6 decimal places).
   * Creates a cost-tracking-only entry if none exists (e.g., explicit model requests
   * that never go through the routing path).
   */
  addSessionCost(sessionId, additionalMicros) {
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      const now = Date.now();
      entry = {
        model: "",
        tier: "DIRECT",
        createdAt: now,
        lastUsedAt: now,
        requestCount: 0,
        recentHashes: [],
        strikes: 0,
        escalated: false,
        sessionCostMicros: 0n
      };
      this.sessions.set(sessionId, entry);
    }
    entry.sessionCostMicros += additionalMicros;
  }
  /**
   * Get the total accumulated cost for a session in USD.
   */
  getSessionCostUsd(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return 0;
    return Number(entry.sessionCostMicros) / 1e6;
  }
  /**
   * Stop the cleanup interval.
   */
  close() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
};
function getSessionId(headers, headerName = DEFAULT_SESSION_CONFIG.headerName) {
  const value = headers[headerName] || headers[headerName.toLowerCase()];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  return void 0;
}
function deriveSessionId(messages) {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return void 0;
  const content = typeof firstUser.content === "string" ? firstUser.content : JSON.stringify(firstUser.content);
  return createHash3("sha256").update(content).digest("hex").slice(0, 8);
}

// src/journal.ts
var DEFAULT_CONFIG2 = {
  maxEntries: 100,
  maxAgeMs: 24 * 60 * 60 * 1e3,
  // 24 hours
  maxEventsPerResponse: 5
};
var SessionJournal = class {
  journals = /* @__PURE__ */ new Map();
  config;
  constructor(config) {
    this.config = { ...DEFAULT_CONFIG2, ...config };
  }
  /**
   * Extract key events from assistant response content.
   * Looks for patterns like "I created...", "I fixed...", "Successfully..."
   */
  extractEvents(content) {
    if (!content || typeof content !== "string") {
      return [];
    }
    const events = [];
    const seen = /* @__PURE__ */ new Set();
    const patterns = [
      // Creation patterns
      /I (?:also |then |have |)?(?:created|implemented|added|wrote|built|generated|set up|initialized) ([^.!?\n]{10,150})/gi,
      // Fix patterns
      /I (?:also |then |have |)?(?:fixed|resolved|solved|patched|corrected|addressed|debugged) ([^.!?\n]{10,150})/gi,
      // Completion patterns
      /I (?:also |then |have |)?(?:completed|finished|done with|wrapped up) ([^.!?\n]{10,150})/gi,
      // Update patterns
      /I (?:also |then |have |)?(?:updated|modified|changed|refactored|improved|enhanced|optimized) ([^.!?\n]{10,150})/gi,
      // Success patterns
      /Successfully ([^.!?\n]{10,150})/gi,
      // Tool usage patterns (when agent uses tools)
      /I (?:also |then |have |)?(?:ran|executed|called|invoked) ([^.!?\n]{10,100})/gi
    ];
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const action = match[0].trim();
        const normalized = action.toLowerCase();
        if (seen.has(normalized)) {
          continue;
        }
        if (action.length >= 15 && action.length <= 200) {
          events.push(action);
          seen.add(normalized);
        }
        if (events.length >= this.config.maxEventsPerResponse) {
          break;
        }
      }
      if (events.length >= this.config.maxEventsPerResponse) {
        break;
      }
    }
    return events;
  }
  /**
   * Record events to the session journal.
   */
  record(sessionId, events, model) {
    if (!sessionId || !events.length) {
      return;
    }
    const journal = this.journals.get(sessionId) || [];
    const now = Date.now();
    for (const action of events) {
      journal.push({
        timestamp: now,
        action,
        model
      });
    }
    const cutoff = now - this.config.maxAgeMs;
    const trimmed = journal.filter((e) => e.timestamp > cutoff).slice(-this.config.maxEntries);
    this.journals.set(sessionId, trimmed);
  }
  /**
   * Check if the user message indicates a need for historical context.
   */
  needsContext(lastUserMessage) {
    if (!lastUserMessage || typeof lastUserMessage !== "string") {
      return false;
    }
    const lower = lastUserMessage.toLowerCase();
    const triggers = [
      // Direct questions about past work
      "what did you do",
      "what have you done",
      "what did we do",
      "what have we done",
      // Temporal references
      "earlier",
      "before",
      "previously",
      "this session",
      "today",
      "so far",
      // Summary requests
      "remind me",
      "summarize",
      "summary of",
      "recap",
      // Progress inquiries
      "your work",
      "your progress",
      "accomplished",
      "achievements",
      "completed tasks"
    ];
    return triggers.some((t) => lower.includes(t));
  }
  /**
   * Format the journal for injection into system message.
   * Returns null if journal is empty.
   */
  format(sessionId) {
    const journal = this.journals.get(sessionId);
    if (!journal?.length) {
      return null;
    }
    const lines = journal.map((e) => {
      const time = new Date(e.timestamp).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
      });
      return `- ${time}: ${e.action}`;
    });
    return `[Session Memory - Key Actions]
${lines.join("\n")}`;
  }
  /**
   * Get the raw journal entries for a session (for debugging/testing).
   */
  getEntries(sessionId) {
    return this.journals.get(sessionId) || [];
  }
  /**
   * Clear journal for a specific session.
   */
  clear(sessionId) {
    this.journals.delete(sessionId);
  }
  /**
   * Clear all journals.
   */
  clearAll() {
    this.journals.clear();
  }
  /**
   * Get stats about the journal.
   */
  getStats() {
    let totalEntries = 0;
    for (const entries of this.journals.values()) {
      totalEntries += entries.length;
    }
    return {
      sessions: this.journals.size,
      totalEntries
    };
  }
};

// src/exclude-models.ts
function loadExcludeList() {
  return /* @__PURE__ */ new Set();
}

// src/config.ts
var DEFAULT_PORT = 8402;
var PROXY_PORT = (() => {
  const envPort = process["env"].BLOCKRUN_PROXY_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
  }
  return DEFAULT_PORT;
})();

// src/response-store.ts
var store = [];
async function getLast(_sessionId) {
  return store[store.length - 1];
}
async function listRecent(limit) {
  return store.slice(-limit);
}

// src/ledger.ts
import { mkdir as mkdir2, readdir as readdir2, unlink as unlink2, appendFile as appendFile2 } from "fs/promises";
import { join as join4 } from "path";
import { homedir as homedir3 } from "os";
function ledgerDir() {
  return process.env.ACU_LEDGER_DIR?.trim() || join4(homedir3(), ".claw-router", "ledger");
}
async function ensureLedgerDir() {
  await mkdir2(ledgerDir(), { recursive: true });
}
function ledgerFileFor(date) {
  return join4(ledgerDir(), `${date}.jsonl`);
}
async function getLedgerFiles() {
  try {
    const files = await readdir2(ledgerDir());
    return files.filter((file) => file.endsWith(".jsonl")).sort().reverse();
  } catch {
    return [];
  }
}
async function readLedgerFile(file) {
  try {
    const text = await readTextFile(join4(ledgerDir(), file));
    return text.trim().split("\n").filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
async function appendLedgerEntry(entry) {
  try {
    await ensureLedgerDir();
    const date = entry.timestamp.slice(0, 10);
    await appendFile2(ledgerFileFor(date), JSON.stringify(entry) + "\n");
  } catch {
  }
}
async function getLedgerEntries(days = 7) {
  const files = (await getLedgerFiles()).slice(0, Math.max(1, Math.min(days, 30)));
  const entries = [];
  for (const file of files) entries.push(...await readLedgerFile(file));
  return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
function addGroup(group, key, entry) {
  if (!group[key]) group[key] = { count: 0, cost: 0, baseline_cost: 0, savings: 0 };
  group[key].count++;
  group[key].cost += entry.actual_cost;
  group[key].baseline_cost += entry.baseline_cost;
  group[key].savings += entry.savings;
}
async function getLedgerSummary(days = 7) {
  const entries = await getLedgerEntries(days);
  const by_model = {};
  const by_tier = {};
  const by_task_type = {};
  let total_cost = 0;
  let total_baseline_cost = 0;
  let total_latency = 0;
  let fallback_count = 0;
  let validator_total = 0;
  let validator_pass = 0;
  for (const entry of entries) {
    total_cost += entry.actual_cost;
    total_baseline_cost += entry.baseline_cost;
    total_latency += entry.latency_ms;
    if (entry.fallback_used ?? entry.fallback_attempts > 0) fallback_count++;
    if (entry.validator_result !== "not_applicable") {
      validator_total++;
      if (entry.validator_result === "pass") validator_pass++;
    }
    addGroup(by_model, entry.actual_model_used || "unknown", entry);
    addGroup(by_tier, entry.tier || "UNKNOWN", entry);
    addGroup(by_task_type, entry.task_type || "unknown", entry);
  }
  const total_requests = entries.length;
  const total_savings = total_baseline_cost - total_cost;
  return {
    total_requests,
    total_cost,
    baseline_cost: total_baseline_cost,
    savings: total_savings,
    total_baseline_cost,
    total_savings,
    avg_latency_ms: total_requests > 0 ? total_latency / total_requests : 0,
    fallback_rate: total_requests > 0 ? fallback_count / total_requests : 0,
    validator_pass_rate: validator_total > 0 ? validator_pass / validator_total : 0,
    by_model,
    by_tier,
    by_task_type,
    recent: entries.slice(0, 10)
  };
}
async function clearLedger() {
  const files = await getLedgerFiles();
  let deletedFiles = 0;
  for (const file of files) {
    try {
      await unlink2(join4(ledgerDir(), file));
      deletedFiles++;
    } catch {
    }
  }
  return { deletedFiles };
}

// src/validator/index.ts
function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (part && typeof part === "object" && "text" in part) {
      const text = part.text;
      return typeof text === "string" ? text : "";
    }
    return "";
  }).join(" ");
}
function promptNeedsJsonValidation(messages, responseFormat, expectedSchema) {
  const format = responseFormat && typeof responseFormat === "object" ? responseFormat : void 0;
  if (format?.type === "json_object" || format?.type === "json_schema" || expectedSchema) return true;
  const prompt = messages.filter((message) => message.role === "user").map((message) => textFromContent(message.content)).join("\n").toLowerCase();
  if (/不要\s*(输出|返回)?\s*json|do\s+not\s+(output|return)\s+json|no\s+json/.test(prompt)) return false;
  const explicitJson = /(?:只|请)?\s*(?:返回|输出|生成|提供|响应(?:为|成)?)\s*(?:严格|合法|有效)?\s*json\b|\bjson\s*(?:格式|对象|数组|输出|响应)|(?:return|output|respond\s+with|produce|generate)\s+(?:only\s+|valid\s+)?json\b/i.test(prompt);
  const structuredFieldExtraction = /(?:提取|抽取)[\s\S]{0,120}(?:字段(?:包括|包含|为|：|:)|字段列表)[\s\S]{0,120}(?:结构化(?:输出|结果)|按结构输出)|(?:字段(?:包括|包含|为|：|:)|字段列表)[\s\S]{0,120}(?:提取|抽取)[\s\S]{0,120}(?:结构化(?:输出|结果)|按结构输出)|(?:extract|parse)[\s\S]{0,120}(?:fields?\s*(?:include|:)|field list)[\s\S]{0,120}structured\s+output/i.test(prompt);
  return explicitJson || structuredFieldExtraction;
}
function extractJsonCandidate(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) return fenced;
  const firstObject = text.indexOf("{");
  const lastObject = text.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) return text.slice(firstObject, lastObject + 1);
  const firstArray = text.indexOf("[");
  const lastArray = text.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) return text.slice(firstArray, lastArray + 1);
  return void 0;
}
function requiredFieldsFromSchema(schema) {
  if (!schema || typeof schema !== "object") return [];
  const required = schema.required;
  return Array.isArray(required) ? required.filter((field) => typeof field === "string") : [];
}
function validateAssistantOutput(args) {
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
      reason: "\u672A\u627E\u5230JSON\u5BF9\u8C61\u6216\u6570\u7EC4"
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return {
      result: "fail",
      validator: "json_validator",
      reason: err instanceof Error ? err.message : "Invalid JSON"
    };
  }
  if (requiredFields.length > 0) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { result: "fail", validator: "schema_validator", reason: "JSON root is not an object" };
    }
    const parsedObject = parsed;
    const missing = requiredFields.filter((field) => !(field in parsedObject));
    if (missing.length > 0) {
      return {
        result: "fail",
        validator: "schema_validator",
        reason: `Missing required fields: ${missing.join(", ")}`
      };
    }
    return { result: "pass", validator: "schema_validator", reason: "Valid JSON matching required schema" };
  }
  return { result: "pass", validator: "json_validator", reason: "Valid JSON" };
}

// src/acu/strategy.ts
import { createHash as createHash5, randomUUID } from "crypto";

// src/acu/config.ts
var ACU_PROMPT_VERSION = "acu-tier-requirement-v4";
var ACU_DIFFICULTY_METHOD_VERSION = "acu-difficulty-index-v1";
var ACU_ROUTING_MODEL_VERSION = "acu-routing-model-v0.5";
var ACU_DEFAULT_JUDGE_MODEL = "gpt-5.6-sol";
var ACU_DEFAULT_JUDGE_REASONING_EFFORT = "default";
var ACU_DEFAULT_JUDGE_BASE_URL = "https://lucen.cc/v1";
var ACU_DEFAULT_JUDGE_MODE = "non-thinking";
var ACU_DEFAULT_JUDGE_FIRST_BYTE_TIMEOUT_MS = 0;
var ACU_DEFAULT_JUDGE_TOTAL_TIMEOUT_MS = 27e4;
var ACU_DEFAULT_JUDGE_MAX_PROFILE_ATTEMPTS = 5;
var ACU_DEFAULT_MAX_CONTEXT_TOKENS = 1e6;
var ACU_DEFAULT_BACKUP_MAX_CONTEXT_TOKENS = 1e6;
var ACU_DEFAULT_MAX_OUTPUT_TOKENS = 300;
var ACU_DEFAULT_QUALITY_TARGET = 0.8;
var ACU_DEFAULT_SWITCH_COST_USD = 2e-4;
var ACU_DEFAULT_JUDGE_ENTROPY_PENALTY = 3;
var ACU_DEFAULT_DATABASE_PATH = "/var/lib/clawrouter-dev/acu-routing.db";
var ACU_CURVE_THRESHOLDS = {
  aboveLow: 0.275,
  aboveMid: 0.525,
  aboveMidHigh: 0.765
};
var ACU_CURVE_TEMPERATURE = 0.08;
var ACU_DEMO_DISCLAIMER = "\u9884\u8BA1\u6A21\u578B\u5F97\u5206\u57FA\u4E8E\u4EFB\u52A1\u80FD\u529B\u9700\u6C42\u3001\u516C\u5F00Benchmark\u53CA\u53D7\u7EA6\u675F\u80FD\u529B\u6A21\u578B\uFF0C\u7528\u4E8E\u5C55\u793A\u6A21\u578B\u4E0E\u5F53\u524D\u4EFB\u52A1\u7684\u76F8\u5BF9\u5339\u914D\u7A0B\u5EA6\uFF0C\u4E0D\u4EE3\u8868\u9010\u8BF7\u6C42\u5B9E\u6D4B\u6210\u529F\u7387\u3002";
function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function booleanValue(value, fallback = false) {
  if (value === void 0) return fallback;
  return value.trim().toLowerCase() === "true";
}
function readAcuRuntimeConfig(overrides = {}) {
  const enabled = booleanValue(process.env.ACU_DEMO_ROUTER_ENABLED);
  const config = {
    enabled,
    judgeModel: process.env.ACU_JUDGE_MODEL?.trim() || ACU_DEFAULT_JUDGE_MODEL,
    judgeReasoningEffort: ["low", "medium", "high", "max"].find(
      (effort) => effort === process.env.ACU_JUDGE_REASONING_EFFORT?.trim()
    ) ?? ACU_DEFAULT_JUDGE_REASONING_EFFORT,
    judgeBaseUrl: process.env.ACU_JUDGE_BASE_URL?.trim() || ACU_DEFAULT_JUDGE_BASE_URL,
    judgeMode: ACU_DEFAULT_JUDGE_MODE,
    promptVersion: process.env.ACU_JUDGE_PROMPT_VERSION?.trim() || ACU_PROMPT_VERSION,
    firstByteTimeoutMs: nonNegativeInteger(
      process.env.ACU_JUDGE_FIRST_BYTE_TIMEOUT_MS,
      ACU_DEFAULT_JUDGE_FIRST_BYTE_TIMEOUT_MS
    ),
    timeoutMs: nonNegativeInteger(
      process.env.ACU_JUDGE_TOTAL_TIMEOUT_MS,
      ACU_DEFAULT_JUDGE_TOTAL_TIMEOUT_MS
    ),
    maxContextTokens: positiveInteger(
      process.env.ACU_JUDGE_MAX_CONTEXT_TOKENS,
      ACU_DEFAULT_MAX_CONTEXT_TOKENS
    ),
    maxOutputTokens: ACU_DEFAULT_MAX_OUTPUT_TOKENS,
    apiKey: process.env.ACU_JUDGE_API_KEY?.trim(),
    judgeProvider: process.env.ACU_JUDGE_PROVIDER?.trim() || "lucen",
    judgeProtocol: "chat_completions",
    backupJudgeModel: process.env.ACU_JUDGE_BACKUP_MODEL?.trim() || void 0,
    backupJudgeBaseUrl: process.env.ACU_JUDGE_BACKUP_BASE_URL?.trim() || void 0,
    backupApiKey: process.env.ACU_JUDGE_BACKUP_API_KEY?.trim() || void 0,
    backupJudgeProvider: process.env.ACU_JUDGE_BACKUP_PROVIDER?.trim() || void 0,
    backupMaxContextTokens: positiveInteger(
      process.env.ACU_JUDGE_BACKUP_MAX_CONTEXT_TOKENS,
      ACU_DEFAULT_BACKUP_MAX_CONTEXT_TOKENS
    ),
    syncBackupEnabled: booleanValue(process.env.ACU_JUDGE_SYNC_BACKUP_ENABLED, false),
    sameModelFailoverEnabled: booleanValue(process.env.ACU_JUDGE_SAME_MODEL_FAILOVER_ENABLED, true),
    maxProfileAttempts: Math.max(1, Math.min(5, positiveInteger(process.env.ACU_JUDGE_MAX_PROFILE_ATTEMPTS, ACU_DEFAULT_JUDGE_MAX_PROFILE_ATTEMPTS))),
    primaryProfileId: process.env.ACU_JUDGE_PRIMARY_PROFILE_ID?.trim() || void 0,
    cachePath: process.env.ACU_JUDGE_CACHE_PATH?.trim(),
    allowMock: booleanValue(process.env.ACU_ALLOW_MOCK),
    shadowMode: booleanValue(process.env.ACU_SHADOW_MODE, true),
    allowForceRefresh: booleanValue(process.env.ACU_ALLOW_FORCE_JUDGE_REFRESH, false),
    databasePath: process.env.ACU_DATABASE_PATH?.trim() || ACU_DEFAULT_DATABASE_PATH,
    judgeEntropyPenalty: Number.isFinite(Number(process.env.ACU_JUDGE_ENTROPY_PENALTY)) ? Math.max(0, Number(process.env.ACU_JUDGE_ENTROPY_PENALTY)) : ACU_DEFAULT_JUDGE_ENTROPY_PENALTY,
    ...overrides
  };
  if (booleanValue(process.env.ACU_JUDGE_ROLLBACK_TO_BACKUP) && config.backupJudgeModel && config.backupJudgeBaseUrl && config.backupApiKey) {
    return {
      ...config,
      judgeModel: config.backupJudgeModel,
      judgeBaseUrl: config.backupJudgeBaseUrl,
      apiKey: config.backupApiKey,
      judgeProvider: config.backupJudgeProvider ?? "openai_compatible",
      maxContextTokens: config.backupMaxContextTokens,
      backupJudgeModel: void 0,
      backupJudgeBaseUrl: void 0,
      backupApiKey: void 0,
      backupJudgeProvider: void 0
    };
  }
  return config;
}

// src/acu/math.ts
function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}
function sigmoid(value) {
  if (value >= 0) {
    const z2 = Math.exp(-value);
    return 1 / (1 + z2);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}
function applyLogitShift(probability, shift) {
  const boundedProbability = clamp(probability);
  const oddsMultiplier = Math.exp(shift);
  return clamp(
    boundedProbability * oddsMultiplier / (1 - boundedProbability + boundedProbability * oddsMultiplier)
  );
}
function normalizeProbabilities(value) {
  const raw = [value.pLow, value.pMid, value.pMidHigh, value.pHigh];
  if (raw.some((item) => !Number.isFinite(item) || item < 0 || item > 1)) {
    throw new Error("ACU tier probabilities must be finite values in [0, 1]");
  }
  const total = raw.reduce((sum, item) => sum + item, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("ACU tier probabilities must have a positive sum");
  }
  const confidence = value.confidence ?? 0.5;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("ACU confidence must be in [0, 1]");
  }
  return {
    pLow: raw[0] / total,
    pMid: raw[1] / total,
    pMidHigh: raw[2] / total,
    pHigh: raw[3] / total,
    confidence
  };
}
function normalizedEntropy(probabilities) {
  const normalized = normalizeProbabilities(probabilities);
  const values = [normalized.pLow, normalized.pMid, normalized.pMidHigh, normalized.pHigh];
  const entropy = -values.reduce((sum, value) => sum + (value > 0 ? value * Math.log(value) : 0), 0);
  return entropy / Math.log(values.length);
}
function estimatedQuality(probabilities, model) {
  const normalized = normalizeProbabilities(probabilities);
  return normalized.pLow * model.sufficientLow + normalized.pMid * model.sufficientMid + normalized.pMidHigh * model.sufficientMidHigh + normalized.pHigh * model.sufficientHigh;
}
function continuousTierProbabilities(difficulty) {
  const d = clamp(difficulty);
  const aboveLow = sigmoid((d - ACU_CURVE_THRESHOLDS.aboveLow) / ACU_CURVE_TEMPERATURE);
  const aboveMid = sigmoid((d - ACU_CURVE_THRESHOLDS.aboveMid) / ACU_CURVE_TEMPERATURE);
  const aboveMidHigh = sigmoid(
    (d - ACU_CURVE_THRESHOLDS.aboveMidHigh) / ACU_CURVE_TEMPERATURE
  );
  return normalizeProbabilities({
    pLow: 1 - aboveLow,
    pMid: aboveLow - aboveMid,
    pMidHigh: aboveMid - aboveMidHigh,
    pHigh: aboveMidHigh,
    confidence: 1
  });
}

// src/acu/catalog/model-catalog.json
var model_catalog_default = {
  schemaVersion: "acu-model-catalog-v2",
  generatedAt: "2026-08-02",
  estimateLabel: "public-benchmark constrained model score",
  disclaimer: "\u9884\u8BA1\u6A21\u578B\u5F97\u5206\u7528\u4E8E\u76F8\u5BF9\u5339\u914D\u6F14\u793A\uFF0C\u4E0D\u4EE3\u8868\u9010\u8BF7\u6C42\u5B9E\u6D4B\u6210\u529F\u7387\u3002",
  config: {
    tierDifficulty: {
      low: 0.15,
      mid: 0.4,
      mid_high: 0.65,
      high: 0.88
    },
    sharedTemperature: null,
    commonFloor: null,
    commonCeiling: null,
    curveThresholds: {
      above_low: 0.275,
      above_mid: 0.525,
      above_mid_high: 0.765
    },
    curveTemperature: 0.08,
    distributionWeights: {
      low: 0.7103092783505155,
      mid: 0.06391752577319587,
      mid_high: 0.050515463917525774,
      high: 0.17525773195876287
    },
    distributionCounts: {
      low: 689,
      mid: 62,
      mid_high: 49,
      high: 170
    },
    judge: {
      model: "mimo-v2.5-pro",
      provider: "xiaomi_mimo",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      mode: "non-thinking",
      promptVersion: "acu-tier-requirement-v4",
      firstByteTimeoutMs: 0,
      totalTimeoutMs: 0,
      maxContextTokens: 1e6,
      contextCapabilitySource: "xiaomi_official_mimo_v2_5_pro_model_spec_20260730",
      maxOutputTokens: 300,
      backup: {
        model: "deepseek-v4-flash",
        provider: "closeai",
        maxContextTokens: 1e6,
        contextCapabilitySource: "deepseek_official_v4_model_spec_20260730; closeai_long_context_not_verified"
      }
    },
    cost: {
      judgeInputTokens: null,
      judgeInputTokensSource: "actual_usage",
      judgeOutputTokens: 300,
      switchCostUsd: 2e-4
    },
    profileConstraints: {
      temperature: [
        0.09,
        0.17
      ],
      floor: [
        0.01,
        0.06
      ],
      ceiling: [
        0.96,
        0.995
      ],
      maxAbsoluteTierAdjustment: 0.08
    },
    defaultQualityTarget: 0.8,
    valueUtility: {
      qualityWeightAtPreference60: 0.58,
      qualityWeightAtPreference95: 0.82,
      uncertaintyRiskWeightAtPreference60: 0.2,
      uncertaintyRiskWeightAtPreference95: 0.45,
      qualityExponentAtPreference60: 0.8,
      qualityExponentAtPreference95: 2,
      combination: "qualityUtility * (qualityWeight + costWeight * costUtility)",
      costTransform: "pareto-frontier log-relative",
      hardScoreThreshold: false
    }
  },
  provenance: {
    twinInput: "research/quality-curves/twinrouterbench/phase1d-foundation/outputs/acu_step_contexts.parquet",
    twinInputSha256: "287ae2e5087bbd731c1513a81a94ccf936ad356c25ca3a78f652dcb91129b6e4",
    openhands: {
      name: "OpenHands Index SWE-bench aggregate",
      url: "https://huggingface.co/datasets/OpenHands/openhands-index",
      version: "v2026.06.30-3015ac6",
      revision: "94ac78ad8ec547875a0a4ec56e15a644aa5653f6",
      results_url: "https://github.com/OpenHands/openhands-index-results/tree/3015ac612e7196f428e6e8a3948965d32d9a3331",
      benchmark_date: "2026-06-30"
    },
    priceAndAvailabilitySource: "src/models.ts from official vendor pages; see deploy/alpha/official-price-sources.json",
    priceAndAvailabilitySourceSha256: "710571050de4d42749d8ce7baa4e19abbc4d1d683644f26a9148c557169c842e",
    crossBenchmarkCaveat: "Product-demo constrained connection; not strict statistical equivalence across benchmarks.",
    phase2aCatalogSha256: "f6104c065ee8f9acb92bc96ad4c6333f8aee61bccfdccda2857cb26b94293167",
    phase2bBuilder: "scripts/build-acu-phase2b-catalog.py",
    gpt56ProxyPricing: "not exposed; official list price used",
    profileEvidence: "research/quality-curves/acu-demo/phase2b-product/curve_profile_evidence.csv"
  },
  models: [
    {
      modelId: "gpt-5.5",
      displayName: "GPT-5.5",
      upstream: "proxy",
      inputPricePerMillion: 5,
      outputPricePerMillion: 30,
      cachedInputPricePerMillion: 0.5,
      cacheWritePricePerMillion: 5,
      contextWindow: 105e4,
      maxOutputTokens: 65536,
      toolCallSupport: true,
      visionSupport: true,
      provider: "OpenAI",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: false,
      abilityAnchor: 0.782,
      solvedAbilityParameter: 0.6029079429640571,
      fittingError: -2220446049250313e-31,
      sufficientLow: 0.9576135050672705,
      sufficientMid: 0.8203037450925588,
      sufficientMidHigh: 0.44211951275274175,
      sufficientHigh: 0.15424474522369108,
      benchmarkEvidence: [
        {
          benchmarkName: "SWE-bench Verified via OpenHands Index",
          normalizedScore: 0.782,
          scoreScale: "0-1 resolved fraction",
          sampleSize: 500,
          sourceModelName: "GPT-5.5",
          evaluationMode: "OpenHands agent harness",
          sourceUrl: "https://huggingface.co/datasets/OpenHands/openhands-index",
          resultsUrl: "https://github.com/OpenHands/openhands-index-results/tree/3015ac612e7196f428e6e8a3948965d32d9a3331",
          sourceVersion: "v2026.06.30-3015ac6",
          benchmarkDate: "2026-06-30",
          directForModel: true,
          configuredRelativeDelta: 0
        }
      ],
      evidenceConfidence: "medium",
      uncertaintyWidth: 0.08,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Direct aggregate anchor from the pinned OpenHands Index SWE-bench evaluation; agent-harness dependent.",
      curveProfile: "balanced_frontier",
      curveTemperature: 0.135,
      curveFloor: 0.03,
      curveCeiling: 0.99,
      tierAdjustments: {
        low: 0,
        mid: 5e-3,
        midHigh: 0.015,
        high: 0.015
      },
      profileEvidence: [
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "low"
    },
    {
      modelId: "gpt-5.4-mini",
      displayName: "GPT-5.4 Mini",
      upstream: "proxy",
      inputPricePerMillion: 0.75,
      outputPricePerMillion: 4.5,
      cachedInputPricePerMillion: 0.075,
      cacheWritePricePerMillion: 0.75,
      contextWindow: 1048576,
      maxOutputTokens: 32768,
      toolCallSupport: true,
      visionSupport: true,
      provider: "OpenAI",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: false,
      abilityAnchor: 0.6559999999999999,
      solvedAbilityParameter: 0.3171541263252635,
      fittingError: -11102230246251565e-32,
      sufficientLow: 0.8940232055766547,
      sufficientMid: 0.3280324412529797,
      sufficientMidHigh: 0,
      sufficientHigh: 0,
      benchmarkEvidence: [
        {
          benchmarkName: "SWE-bench Verified via OpenHands Index",
          normalizedScore: 0.7559999999999999,
          scoreScale: "0-1 resolved fraction",
          sampleSize: 500,
          sourceModelName: "GPT-5.4",
          evaluationMode: "OpenHands agent harness",
          sourceUrl: "https://huggingface.co/datasets/OpenHands/openhands-index",
          resultsUrl: "https://github.com/OpenHands/openhands-index-results/tree/3015ac612e7196f428e6e8a3948965d32d9a3331",
          sourceVersion: "v2026.06.30-3015ac6",
          benchmarkDate: "2026-06-30",
          directForModel: false,
          configuredRelativeDelta: -0.1
        }
      ],
      evidenceConfidence: "low",
      uncertaintyWidth: 0.14,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Series-relative estimate: GPT-5.4 0.756 plus configured delta -0.100; not a direct benchmark result.",
      curveProfile: "efficient_fast",
      curveTemperature: 0.095,
      curveFloor: 0.025,
      curveCeiling: 0.985,
      tierAdjustments: {
        low: 0.05,
        mid: 0.02,
        midHigh: -0.06,
        high: -0.08
      },
      profileEvidence: [
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "low"
    },
    {
      modelId: "claude-opus-4-8",
      displayName: "Claude Opus 4.8",
      upstream: "proxy",
      inputPricePerMillion: 5,
      outputPricePerMillion: 25,
      cachedInputPricePerMillion: 0.5,
      cacheWritePricePerMillion: 6.25,
      contextWindow: 2e5,
      maxOutputTokens: 32e3,
      toolCallSupport: true,
      visionSupport: true,
      provider: "Anthropic",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: true,
      abilityAnchor: 0.838,
      solvedAbilityParameter: 0.7501751478287932,
      fittingError: -11102230246251565e-32,
      sufficientLow: 0.9579653043641058,
      sufficientMid: 0.8882517982256185,
      sufficientMidHigh: 0.6755392782363226,
      sufficientHigh: 0.3802874657033109,
      benchmarkEvidence: [
        {
          benchmarkName: "SWE-bench Verified via OpenHands Index",
          normalizedScore: 0.838,
          scoreScale: "0-1 resolved fraction",
          sampleSize: 500,
          sourceModelName: "claude-opus-4-8",
          evaluationMode: "OpenHands agent harness",
          sourceUrl: "https://huggingface.co/datasets/OpenHands/openhands-index",
          resultsUrl: "https://github.com/OpenHands/openhands-index-results/tree/3015ac612e7196f428e6e8a3948965d32d9a3331",
          sourceVersion: "v2026.06.30-3015ac6",
          benchmarkDate: "2026-06-30",
          directForModel: true,
          configuredRelativeDelta: 0
        }
      ],
      evidenceConfidence: "medium",
      uncertaintyWidth: 0.08,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Direct aggregate anchor from the pinned OpenHands Index SWE-bench evaluation; agent-harness dependent.",
      curveProfile: "frontier_resilient",
      curveTemperature: 0.16,
      curveFloor: 0.03,
      curveCeiling: 0.99,
      tierAdjustments: {
        low: -0.01,
        mid: -5e-3,
        midHigh: 0.02,
        high: 0.055
      },
      profileEvidence: [
        "https://openrouter.ai/rankings#benchmarks",
        "https://www.anthropic.com/claude/opus",
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "medium"
    },
    {
      modelId: "claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      upstream: "proxy",
      inputPricePerMillion: 2,
      outputPricePerMillion: 10,
      cachedInputPricePerMillion: 0.2,
      cacheWritePricePerMillion: 2.5,
      contextWindow: 2e5,
      maxOutputTokens: 16384,
      toolCallSupport: true,
      visionSupport: true,
      provider: "Anthropic",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: false,
      abilityAnchor: 0.778,
      solvedAbilityParameter: 0.5939799550182703,
      fittingError: 0,
      sufficientLow: 0.9554788935293893,
      sufficientMid: 0.810653469424331,
      sufficientMidHigh: 0.4268137104879507,
      sufficientHigh: 0.14800385552960366,
      benchmarkEvidence: [
        {
          benchmarkName: "SWE-bench Verified via OpenHands Index",
          normalizedScore: 0.838,
          scoreScale: "0-1 resolved fraction",
          sampleSize: 500,
          sourceModelName: "claude-opus-4-8",
          evaluationMode: "OpenHands agent harness",
          sourceUrl: "https://huggingface.co/datasets/OpenHands/openhands-index",
          resultsUrl: "https://github.com/OpenHands/openhands-index-results/tree/3015ac612e7196f428e6e8a3948965d32d9a3331",
          sourceVersion: "v2026.06.30-3015ac6",
          benchmarkDate: "2026-06-30",
          directForModel: false,
          configuredRelativeDelta: -0.06
        }
      ],
      evidenceConfidence: "low",
      uncertaintyWidth: 0.14,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Series-relative estimate: claude-opus-4-8 0.838 plus configured delta -0.060; not a direct benchmark result.",
      curveProfile: "balanced_frontier",
      curveTemperature: 0.135,
      curveFloor: 0.03,
      curveCeiling: 0.99,
      tierAdjustments: {
        low: 0,
        mid: 5e-3,
        midHigh: 0.015,
        high: 0.015
      },
      profileEvidence: [
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "low"
    },
    {
      modelId: "gemini-3.5-flash",
      displayName: "Gemini 3.5 Flash",
      upstream: "proxy",
      inputPricePerMillion: 1.5,
      outputPricePerMillion: 9,
      cachedInputPricePerMillion: 0.15,
      cacheWritePricePerMillion: 1.5,
      contextWindow: 1048576,
      maxOutputTokens: 65536,
      toolCallSupport: true,
      visionSupport: true,
      provider: "Google",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: false,
      abilityAnchor: 0.7859999999999999,
      solvedAbilityParameter: 0.6119493615513734,
      fittingError: 11102230246251565e-32,
      sufficientLow: 0.9596451639759386,
      sufficientMid: 0.8296716167103004,
      sufficientMidHigh: 0.457798722587925,
      sufficientHigh: 0.16089826104547839,
      benchmarkEvidence: [
        {
          benchmarkName: "SWE-bench Verified via OpenHands Index",
          normalizedScore: 0.7859999999999999,
          scoreScale: "0-1 resolved fraction",
          sampleSize: 500,
          sourceModelName: "Gemini-3.5-Flash",
          evaluationMode: "OpenHands agent harness",
          sourceUrl: "https://huggingface.co/datasets/OpenHands/openhands-index",
          resultsUrl: "https://github.com/OpenHands/openhands-index-results/tree/3015ac612e7196f428e6e8a3948965d32d9a3331",
          sourceVersion: "v2026.06.30-3015ac6",
          benchmarkDate: "2026-06-30",
          directForModel: true,
          configuredRelativeDelta: 0
        }
      ],
      evidenceConfidence: "medium",
      uncertaintyWidth: 0.08,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Direct aggregate anchor from the pinned OpenHands Index SWE-bench evaluation; agent-harness dependent.",
      curveProfile: "balanced_frontier",
      curveTemperature: 0.135,
      curveFloor: 0.03,
      curveCeiling: 0.99,
      tierAdjustments: {
        low: 0,
        mid: 5e-3,
        midHigh: 0.015,
        high: 0.015
      },
      profileEvidence: [
        "https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-5/",
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "low"
    },
    {
      modelId: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      upstream: "proxy",
      inputPricePerMillion: 0.14,
      outputPricePerMillion: 0.28,
      cachedInputPricePerMillion: 28e-4,
      cacheWritePricePerMillion: 0.14,
      contextWindow: 1e6,
      maxOutputTokens: 384e3,
      toolCallSupport: true,
      visionSupport: false,
      provider: "DeepSeek",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: true,
      abilityAnchor: 0.6719999999999999,
      solvedAbilityParameter: 0.33339868413138773,
      fittingError: 0,
      sufficientLow: 0.913373885856422,
      sufficientMid: 0.3633127845955678,
      sufficientMidHigh: 0,
      sufficientHigh: 0,
      benchmarkEvidence: [
        {
          benchmarkName: "SWE-bench Verified via OpenHands Index",
          normalizedScore: 0.732,
          scoreScale: "0-1 resolved fraction",
          sampleSize: 500,
          sourceModelName: "DeepSeek-V4-Pro",
          evaluationMode: "OpenHands agent harness",
          sourceUrl: "https://huggingface.co/datasets/OpenHands/openhands-index",
          resultsUrl: "https://github.com/OpenHands/openhands-index-results/tree/3015ac612e7196f428e6e8a3948965d32d9a3331",
          sourceVersion: "v2026.06.30-3015ac6",
          benchmarkDate: "2026-06-30",
          directForModel: false,
          configuredRelativeDelta: -0.06
        }
      ],
      evidenceConfidence: "low",
      uncertaintyWidth: 0.14,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Series-relative estimate: DeepSeek-V4-Pro 0.732 plus configured delta -0.060; not a direct benchmark result.",
      curveProfile: "efficient_fast",
      curveTemperature: 0.095,
      curveFloor: 0.025,
      curveCeiling: 0.985,
      tierAdjustments: {
        low: 0.05,
        mid: 0.02,
        midHigh: -0.06,
        high: -0.08
      },
      profileEvidence: [
        "https://openrouter.ai/rankings#benchmarks",
        "https://api-docs.deepseek.com/news/news260424/",
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "high"
    },
    {
      modelId: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      upstream: "proxy",
      inputPricePerMillion: 0.435,
      outputPricePerMillion: 0.87,
      cachedInputPricePerMillion: 3625e-6,
      cacheWritePricePerMillion: 0.435,
      contextWindow: 163840,
      maxOutputTokens: 163840,
      toolCallSupport: true,
      visionSupport: false,
      provider: "DeepSeek",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: false,
      abilityAnchor: 0.732,
      solvedAbilityParameter: 0.5014247741357529,
      fittingError: -11102230246251565e-32,
      sufficientLow: 0.9238212548309142,
      sufficientMid: 0.687282296609387,
      sufficientMidHigh: 0.2846500810610676,
      sufficientHigh: 0.09981058270426857,
      benchmarkEvidence: [
        {
          benchmarkName: "SWE-bench Verified via OpenHands Index",
          normalizedScore: 0.732,
          scoreScale: "0-1 resolved fraction",
          sampleSize: 500,
          sourceModelName: "DeepSeek-V4-Pro",
          evaluationMode: "OpenHands agent harness",
          sourceUrl: "https://huggingface.co/datasets/OpenHands/openhands-index",
          resultsUrl: "https://github.com/OpenHands/openhands-index-results/tree/3015ac612e7196f428e6e8a3948965d32d9a3331",
          sourceVersion: "v2026.06.30-3015ac6",
          benchmarkDate: "2026-06-30",
          directForModel: true,
          configuredRelativeDelta: 0
        }
      ],
      evidenceConfidence: "medium",
      uncertaintyWidth: 0.08,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Direct aggregate anchor from the pinned OpenHands Index SWE-bench evaluation; agent-harness dependent.",
      curveProfile: "balanced_frontier",
      curveTemperature: 0.135,
      curveFloor: 0.03,
      curveCeiling: 0.99,
      tierAdjustments: {
        low: 0,
        mid: 5e-3,
        midHigh: 0.015,
        high: 0.015
      },
      profileEvidence: [
        "https://openrouter.ai/rankings#benchmarks",
        "https://api-docs.deepseek.com/news/news260424/",
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "high"
    },
    {
      modelId: "glm-5.1",
      displayName: "GLM 5.1",
      upstream: "proxy",
      inputPricePerMillion: 1.4,
      outputPricePerMillion: 4.4,
      cachedInputPricePerMillion: 0.26,
      cacheWritePricePerMillion: 1.4,
      contextWindow: 128e3,
      maxOutputTokens: 16384,
      toolCallSupport: true,
      visionSupport: false,
      provider: "Zhipu AI",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: false,
      abilityAnchor: 0.75,
      solvedAbilityParameter: 0.535266097743285,
      fittingError: 0,
      sufficientLow: 0.9376953212576794,
      sufficientMid: 0.7371881050531351,
      sufficientMidHigh: 0.332479557090131,
      sufficientHigh: 0.11429860495734119,
      benchmarkEvidence: [
        {
          benchmarkName: "SWE-bench Verified via OpenHands Index",
          normalizedScore: 0.75,
          scoreScale: "0-1 resolved fraction",
          sampleSize: 500,
          sourceModelName: "GLM-5.1",
          evaluationMode: "OpenHands agent harness",
          sourceUrl: "https://huggingface.co/datasets/OpenHands/openhands-index",
          resultsUrl: "https://github.com/OpenHands/openhands-index-results/tree/3015ac612e7196f428e6e8a3948965d32d9a3331",
          sourceVersion: "v2026.06.30-3015ac6",
          benchmarkDate: "2026-06-30",
          directForModel: true,
          configuredRelativeDelta: 0
        }
      ],
      evidenceConfidence: "medium",
      uncertaintyWidth: 0.08,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Direct aggregate anchor from the pinned OpenHands Index SWE-bench evaluation; agent-harness dependent.",
      curveProfile: "balanced_frontier",
      curveTemperature: 0.135,
      curveFloor: 0.03,
      curveCeiling: 0.99,
      tierAdjustments: {
        low: 0,
        mid: 5e-3,
        midHigh: 0.015,
        high: 0.015
      },
      profileEvidence: [
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "low"
    },
    {
      modelId: "kimi-k2.6",
      displayName: "Kimi K2.6",
      upstream: "proxy",
      inputPricePerMillion: 0.95,
      outputPricePerMillion: 4,
      cachedInputPricePerMillion: 0.475,
      cacheWritePricePerMillion: 0.95,
      contextWindow: 256e3,
      maxOutputTokens: 32768,
      toolCallSupport: true,
      visionSupport: false,
      provider: "Moonshot AI",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: false,
      abilityAnchor: 0.746,
      solvedAbilityParameter: 0.5186889477479781,
      fittingError: 11102230246251565e-32,
      sufficientLow: 0.9422307833909942,
      sufficientMid: 0.7471762649029163,
      sufficientMidHigh: 0.328766069295487,
      sufficientHigh: 0.07052073190673756,
      benchmarkEvidence: [
        {
          benchmarkName: "SWE-bench Verified via OpenHands Index",
          normalizedScore: 0.746,
          scoreScale: "0-1 resolved fraction",
          sampleSize: 500,
          sourceModelName: "Kimi-K2.6",
          evaluationMode: "OpenHands agent harness",
          sourceUrl: "https://huggingface.co/datasets/OpenHands/openhands-index",
          resultsUrl: "https://github.com/OpenHands/openhands-index-results/tree/3015ac612e7196f428e6e8a3948965d32d9a3331",
          sourceVersion: "v2026.06.30-3015ac6",
          benchmarkDate: "2026-06-30",
          directForModel: true,
          configuredRelativeDelta: 0
        }
      ],
      evidenceConfidence: "medium",
      uncertaintyWidth: 0.08,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Direct aggregate anchor from the pinned OpenHands Index SWE-bench evaluation; agent-harness dependent.",
      curveProfile: "coding_specialist",
      curveTemperature: 0.125,
      curveFloor: 0.03,
      curveCeiling: 0.99,
      tierAdjustments: {
        low: 0,
        mid: 0.025,
        midHigh: 0.05,
        high: -0.01
      },
      profileEvidence: [
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "low"
    },
    {
      modelId: "qwen3.5-flash",
      displayName: "Qwen 3.5 Flash",
      upstream: "proxy",
      inputPricePerMillion: 0.04,
      outputPricePerMillion: 0.3,
      cachedInputPricePerMillion: 0.02,
      cacheWritePricePerMillion: 0.04,
      contextWindow: 131072,
      maxOutputTokens: 32768,
      toolCallSupport: true,
      visionSupport: false,
      provider: "Alibaba Cloud",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: false,
      abilityAnchor: 0.62,
      solvedAbilityParameter: 0.2853970289929326,
      fittingError: -11102230246251565e-32,
      sufficientLow: 0.8489110087209144,
      sufficientMid: 0.26613411276273974,
      sufficientMidHigh: 0,
      sufficientHigh: 0,
      benchmarkEvidence: [
        {
          benchmarkName: "SWE-bench Verified via OpenHands Index",
          normalizedScore: 0.62,
          scoreScale: "0-1 resolved fraction",
          sampleSize: 500,
          sourceModelName: "Qwen3.5-Flash",
          evaluationMode: "OpenHands agent harness",
          sourceUrl: "https://huggingface.co/datasets/OpenHands/openhands-index",
          resultsUrl: "https://github.com/OpenHands/openhands-index-results/tree/3015ac612e7196f428e6e8a3948965d32d9a3331",
          sourceVersion: "v2026.06.30-3015ac6",
          benchmarkDate: "2026-06-30",
          directForModel: true,
          configuredRelativeDelta: 0
        }
      ],
      evidenceConfidence: "medium",
      uncertaintyWidth: 0.08,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Direct aggregate anchor from the pinned OpenHands Index SWE-bench evaluation; agent-harness dependent.",
      curveProfile: "efficient_fast",
      curveTemperature: 0.095,
      curveFloor: 0.025,
      curveCeiling: 0.985,
      tierAdjustments: {
        low: 0.05,
        mid: 0.02,
        midHigh: -0.06,
        high: -0.08
      },
      profileEvidence: [
        "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/",
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "low"
    },
    {
      modelId: "qwen3.6-plus",
      displayName: "Qwen 3.6 Plus",
      upstream: "proxy",
      inputPricePerMillion: 0.3,
      outputPricePerMillion: 1.75,
      cachedInputPricePerMillion: 0.15,
      cacheWritePricePerMillion: 0.3,
      contextWindow: 131072,
      maxOutputTokens: 32768,
      toolCallSupport: true,
      visionSupport: false,
      provider: "Alibaba Cloud",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: false,
      abilityAnchor: 0.742,
      solvedAbilityParameter: 0.5198384471543831,
      fittingError: -11102230246251565e-32,
      sufficientLow: 0.9317473093401957,
      sufficientMid: 0.7150771466318007,
      sufficientMidHigh: 0.3100042914659642,
      sufficientHigh: 0.10730064995059502,
      benchmarkEvidence: [
        {
          benchmarkName: "SWE-bench Verified via OpenHands Index",
          normalizedScore: 0.742,
          scoreScale: "0-1 resolved fraction",
          sampleSize: 500,
          sourceModelName: "Qwen3.6-Plus",
          evaluationMode: "OpenHands agent harness",
          sourceUrl: "https://huggingface.co/datasets/OpenHands/openhands-index",
          resultsUrl: "https://github.com/OpenHands/openhands-index-results/tree/3015ac612e7196f428e6e8a3948965d32d9a3331",
          sourceVersion: "v2026.06.30-3015ac6",
          benchmarkDate: "2026-06-30",
          directForModel: true,
          configuredRelativeDelta: 0
        }
      ],
      evidenceConfidence: "medium",
      uncertaintyWidth: 0.08,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Direct aggregate anchor from the pinned OpenHands Index SWE-bench evaluation; agent-harness dependent.",
      curveProfile: "balanced_frontier",
      curveTemperature: 0.135,
      curveFloor: 0.03,
      curveCeiling: 0.99,
      tierAdjustments: {
        low: 0,
        mid: 5e-3,
        midHigh: 0.015,
        high: 0.015
      },
      profileEvidence: [
        "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/",
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "low"
    },
    {
      modelId: "qwen3.7-max",
      displayName: "Qwen 3.7 Max",
      upstream: "proxy",
      inputPricePerMillion: 1.8,
      outputPricePerMillion: 5.4,
      cachedInputPricePerMillion: 0.9,
      cacheWritePricePerMillion: 1.8,
      contextWindow: 131072,
      maxOutputTokens: 32768,
      toolCallSupport: true,
      visionSupport: false,
      provider: "Alibaba Cloud",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: false,
      abilityAnchor: 0.762,
      solvedAbilityParameter: 0.5522710614607833,
      fittingError: -11102230246251565e-32,
      sufficientLow: 0.9530518024563952,
      sufficientMid: 0.7958714342947167,
      sufficientMidHigh: 0.3813682768545961,
      sufficientHigh: 0.08503666832585827,
      benchmarkEvidence: [
        {
          benchmarkName: "SWE-bench Verified via OpenHands Index",
          normalizedScore: 0.742,
          scoreScale: "0-1 resolved fraction",
          sampleSize: 500,
          sourceModelName: "Qwen3.6-Plus",
          evaluationMode: "OpenHands agent harness",
          sourceUrl: "https://huggingface.co/datasets/OpenHands/openhands-index",
          resultsUrl: "https://github.com/OpenHands/openhands-index-results/tree/3015ac612e7196f428e6e8a3948965d32d9a3331",
          sourceVersion: "v2026.06.30-3015ac6",
          benchmarkDate: "2026-06-30",
          directForModel: false,
          configuredRelativeDelta: 0.02
        }
      ],
      evidenceConfidence: "low",
      uncertaintyWidth: 0.14,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Series-relative estimate: Qwen3.6-Plus 0.742 plus configured delta +0.020; not a direct benchmark result.",
      curveProfile: "coding_specialist",
      curveTemperature: 0.125,
      curveFloor: 0.03,
      curveCeiling: 0.99,
      tierAdjustments: {
        low: 0,
        mid: 0.025,
        midHigh: 0.05,
        high: -0.01
      },
      profileEvidence: [
        "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/",
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "low"
    },
    {
      modelId: "minimax-m3",
      displayName: "MiniMax M3",
      upstream: "not_configured",
      inputPricePerMillion: null,
      outputPricePerMillion: null,
      cachedInputPricePerMillion: null,
      cacheWritePricePerMillion: null,
      contextWindow: null,
      maxOutputTokens: null,
      toolCallSupport: false,
      visionSupport: false,
      provider: "MiniMax",
      availability: "benchmark_only_not_configured",
      routingEligible: false,
      defaultDisplay: false,
      abilityAnchor: 0.764,
      solvedAbilityParameter: 0.5637420461488398,
      fittingError: -2220446049250313e-31,
      sufficientLow: 0.947198709803343,
      sufficientMid: 0.7749798877375116,
      sufficientMidHigh: 0.37666505081260704,
      sufficientHigh: 0.1291455789173707,
      benchmarkEvidence: [
        {
          benchmarkName: "SWE-bench Verified via OpenHands Index",
          normalizedScore: 0.764,
          scoreScale: "0-1 resolved fraction",
          sampleSize: 500,
          sourceModelName: "MiniMax-M3",
          evaluationMode: "OpenHands agent harness",
          sourceUrl: "https://huggingface.co/datasets/OpenHands/openhands-index",
          resultsUrl: "https://github.com/OpenHands/openhands-index-results/tree/3015ac612e7196f428e6e8a3948965d32d9a3331",
          sourceVersion: "v2026.06.30-3015ac6",
          benchmarkDate: "2026-06-30",
          directForModel: true,
          configuredRelativeDelta: 0
        }
      ],
      evidenceConfidence: "medium",
      uncertaintyWidth: 0.08,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Direct aggregate anchor from the pinned OpenHands Index SWE-bench evaluation; agent-harness dependent. Benchmark-only entry: no matching callable text model exists in BLOCKRUN_MODELS, so routing eligibility is false.",
      curveProfile: "balanced_frontier",
      curveTemperature: 0.135,
      curveFloor: 0.03,
      curveCeiling: 0.99,
      tierAdjustments: {
        low: 0,
        mid: 5e-3,
        midHigh: 0.015,
        high: 0.015
      },
      profileEvidence: [
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "low"
    },
    {
      modelId: "claude-fable-5",
      displayName: "Claude Fable 5",
      upstream: "proxy",
      inputPricePerMillion: 10,
      outputPricePerMillion: 50,
      cachedInputPricePerMillion: 1,
      cacheWritePricePerMillion: 12.5,
      contextWindow: 2e5,
      maxOutputTokens: 32e3,
      toolCallSupport: true,
      visionSupport: true,
      provider: "Anthropic",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: true,
      abilityAnchor: 0.958,
      solvedAbilityParameter: 1.1208913983330326,
      fittingError: 0,
      sufficientLow: 0.9777821259839409,
      sufficientMid: 0.9745104938556622,
      sufficientMidHigh: 0.961937592674017,
      sufficientHigh: 0.870667779629334,
      benchmarkEvidence: [
        {
          benchmarkName: "SWE-bench Verified via OpenHands Index",
          normalizedScore: 0.958,
          scoreScale: "0-1 resolved fraction",
          sampleSize: 500,
          sourceModelName: "claude-fable-5",
          evaluationMode: "OpenHands agent harness",
          sourceUrl: "https://huggingface.co/datasets/OpenHands/openhands-index",
          resultsUrl: "https://github.com/OpenHands/openhands-index-results/tree/3015ac612e7196f428e6e8a3948965d32d9a3331",
          sourceVersion: "v2026.06.30-3015ac6",
          benchmarkDate: "2026-06-30",
          directForModel: true,
          configuredRelativeDelta: 0
        },
        {
          benchmarkName: "Artificial Analysis Intelligence Index v4.1",
          normalizedScore: 0.598606463217303,
          scoreScale: "0-100 composite index normalized to 0-1",
          sampleSize: 0,
          sourceModelName: "Claude Fable 5 (with fallback)",
          evaluationMode: "independent composite; Opus 4.8 fallback enabled",
          sourceUrl: "https://artificialanalysis.ai/models/claude-fable-5",
          resultsUrl: "https://artificialanalysis.ai/models/claude-fable-5",
          sourceVersion: "v4.1-retrieved-2026-07-31",
          benchmarkDate: "2026-07-31",
          directForModel: true,
          configuredRelativeDelta: 0
        }
      ],
      evidenceConfidence: "medium",
      uncertaintyWidth: 0.08,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Direct OpenHands SWE-bench anchor plus an independent broad composite. The Artificial Analysis run used Opus 4.8 fallback, so its 59.8606 score is corroborating evidence, not a standalone Fable-only anchor.",
      curveProfile: "frontier_resilient",
      curveTemperature: 0.16,
      curveFloor: 0.03,
      curveCeiling: 0.99,
      tierAdjustments: {
        low: -0.01,
        mid: -5e-3,
        midHigh: 0.02,
        high: 0.055
      },
      profileEvidence: [
        "https://artificialanalysis.ai/models/gpt-5-6-sol-medium",
        "https://openrouter.ai/rankings#benchmarks",
        "https://artificialanalysis.ai/models/glm-5-2",
        "https://artificialanalysis.ai/models/kimi-k3",
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "medium"
    },
    {
      modelId: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      upstream: "proxy",
      inputPricePerMillion: 5,
      outputPricePerMillion: 30,
      cachedInputPricePerMillion: 0.5,
      cacheWritePricePerMillion: 6.25,
      contextWindow: 105e4,
      maxOutputTokens: 128e3,
      toolCallSupport: true,
      visionSupport: true,
      provider: "OpenAI",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: true,
      abilityAnchor: 0.895281886314915,
      solvedAbilityParameter: 0.8948362414976221,
      fittingError: 0,
      sufficientLow: 0.9709547480958614,
      sufficientMid: 0.9433280527995646,
      sufficientMidHigh: 0.8391578747062672,
      sufficientHigh: 0.5872384303131705,
      benchmarkEvidence: [
        {
          benchmarkName: "Artificial Analysis Intelligence Index v4.1",
          normalizedScore: 0.535888349532218,
          scoreScale: "0-100 composite index normalized to 0-1",
          sampleSize: 0,
          sourceModelName: "GPT-5.6 Sol (medium)",
          evaluationMode: "independent composite; explicit medium reasoning effort",
          sourceUrl: "https://artificialanalysis.ai/models/gpt-5-6-sol-medium",
          resultsUrl: "https://artificialanalysis.ai/models/gpt-5-6-sol-medium",
          sourceVersion: "v4.1-retrieved-2026-07-31",
          benchmarkDate: "2026-07-31",
          directForModel: true,
          configuredRelativeDelta: -0.06271811368508501
        }
      ],
      evidenceConfidence: "medium",
      uncertaintyWidth: 0.1,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Default-effort placement is calibrated from the independent same-methodology gap between Sol medium and Fable 5. Max and xhigh results are not applied to ordinary Sol requests.",
      curveProfile: "frontier_resilient",
      curveTemperature: 0.16,
      curveFloor: 0.03,
      curveCeiling: 0.99,
      tierAdjustments: {
        low: -0.01,
        mid: -5e-3,
        midHigh: 0.02,
        high: 0.055
      },
      profileEvidence: [
        "https://openai.com/index/gpt-5-6/",
        "https://openai.com/index/previewing-gpt-5-6-sol/",
        "https://artificialanalysis.ai/models/gpt-5-6-sol-medium",
        "https://openrouter.ai/rankings#benchmarks",
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "medium"
    },
    {
      modelId: "gpt-5.6-terra",
      displayName: "GPT-5.6 Terra",
      upstream: "proxy",
      inputPricePerMillion: 2,
      outputPricePerMillion: 12,
      cachedInputPricePerMillion: 0.2,
      cacheWritePricePerMillion: 2.5,
      contextWindow: 105e4,
      maxOutputTokens: 128e3,
      toolCallSupport: true,
      visionSupport: true,
      provider: "OpenAI",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: true,
      abilityAnchor: 0.812,
      solvedAbilityParameter: 0.6727914978033782,
      fittingError: -11102230246251565e-32,
      sufficientLow: 0.9704336455672251,
      sufficientMid: 0.8826330300081707,
      sufficientMidHigh: 0.5654222536725201,
      sufficientHigh: 0.21518988184542204,
      benchmarkEvidence: [
        {
          benchmarkName: "GPT-5.6 official capability suite",
          normalizedScore: 0.812,
          scoreScale: "relative family mapping onto pinned OpenHands anchor scale",
          sampleSize: 0,
          sourceModelName: "gpt-5.6-terra",
          evaluationMode: "vendor-reported; not OpenHands-comparable",
          sourceUrl: "https://openai.com/index/gpt-5-6/",
          resultsUrl: "https://openai.com/index/gpt-5-6/",
          sourceVersion: "retrieved-2026-07-27",
          benchmarkDate: "2026-07-09",
          directForModel: false,
          configuredRelativeDelta: 0.03
        }
      ],
      evidenceConfidence: "low",
      uncertaintyWidth: 0.14,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Family-relative product mapping from GPT-5.5; proxy price metadata unavailable.",
      curveProfile: "balanced_frontier",
      curveTemperature: 0.135,
      curveFloor: 0.03,
      curveCeiling: 0.99,
      tierAdjustments: {
        low: 0,
        mid: 5e-3,
        midHigh: 0.015,
        high: 0.015
      },
      profileEvidence: [
        "https://openai.com/index/gpt-5-6/",
        "https://openrouter.ai/rankings#benchmarks",
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "medium"
    },
    {
      modelId: "gpt-5.6-luna",
      displayName: "GPT-5.6 Luna",
      upstream: "proxy",
      inputPricePerMillion: 0.2,
      outputPricePerMillion: 1.2,
      cachedInputPricePerMillion: 0.02,
      cacheWritePricePerMillion: 0.25,
      contextWindow: 105e4,
      maxOutputTokens: 128e3,
      toolCallSupport: true,
      visionSupport: true,
      provider: "OpenAI",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: false,
      abilityAnchor: 0.792,
      solvedAbilityParameter: 0.6330257052523451,
      fittingError: 0,
      sufficientLow: 1,
      sufficientMid: 0.9289424844844617,
      sufficientMidHigh: 0.402231294647791,
      sufficientHigh: 0.01138960308365651,
      benchmarkEvidence: [
        {
          benchmarkName: "GPT-5.6 official capability suite",
          normalizedScore: 0.792,
          scoreScale: "relative family mapping onto pinned OpenHands anchor scale",
          sampleSize: 0,
          sourceModelName: "gpt-5.6-luna",
          evaluationMode: "vendor-reported; not OpenHands-comparable",
          sourceUrl: "https://openai.com/index/gpt-5-6/",
          resultsUrl: "https://openai.com/index/gpt-5-6/",
          sourceVersion: "retrieved-2026-07-27",
          benchmarkDate: "2026-07-09",
          directForModel: false,
          configuredRelativeDelta: 0.01
        }
      ],
      evidenceConfidence: "low",
      uncertaintyWidth: 0.14,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Family-relative product mapping from GPT-5.5; efficient profile follows official positioning.",
      curveProfile: "efficient_fast",
      curveTemperature: 0.095,
      curveFloor: 0.025,
      curveCeiling: 0.985,
      tierAdjustments: {
        low: 0.05,
        mid: 0.02,
        midHigh: -0.06,
        high: -0.08
      },
      profileEvidence: [
        "https://openai.com/index/gpt-5-6/",
        "https://openrouter.ai/rankings#benchmarks",
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "low"
    },
    {
      modelId: "glm-5.2",
      displayName: "GLM 5.2",
      upstream: "proxy",
      inputPricePerMillion: 1.4,
      outputPricePerMillion: 4.4,
      cachedInputPricePerMillion: 0.26,
      cacheWritePricePerMillion: 1.4,
      contextWindow: 128e3,
      maxOutputTokens: 16384,
      toolCallSupport: true,
      visionSupport: false,
      provider: "Zhipu AI",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: true,
      abilityAnchor: 0.870251536782697,
      solvedAbilityParameter: 0.8130550749324599,
      fittingError: -11102230246251565e-32,
      sufficientLow: 0.9829847954258241,
      sufficientMid: 0.951990135633307,
      sufficientMidHigh: 0.7841156886518483,
      sufficientHigh: 0.4083671145742209,
      benchmarkEvidence: [
        {
          benchmarkName: "Artificial Analysis Intelligence Index v4.1",
          normalizedScore: 0.510858,
          scoreScale: "0-100 composite index normalized to 0-1",
          sampleSize: 0,
          sourceModelName: "GLM 5.2",
          evaluationMode: "independent composite; high reasoning effort",
          sourceUrl: "https://artificialanalysis.ai/models/glm-5-2",
          resultsUrl: "https://openrouter.ai/rankings#benchmarks",
          sourceVersion: "v4.1-retrieved-2026-07-31",
          benchmarkDate: "2026-07-31",
          directForModel: true,
          configuredRelativeDelta: -0.08774846321730301
        }
      ],
      evidenceConfidence: "medium",
      uncertaintyWidth: 0.1,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Placement is calibrated from the independent same-methodology gap to Fable 5 and cross-checked against OpenRouter coding and agentic dimensions.",
      curveProfile: "balanced_frontier",
      curveTemperature: 0.135,
      curveFloor: 0.03,
      curveCeiling: 0.99,
      tierAdjustments: {
        low: 0,
        mid: 5e-3,
        midHigh: 0.015,
        high: 0.015
      },
      profileEvidence: [
        "https://openrouter.ai/rankings#benchmarks",
        "https://zcode.z.ai/en/docs/agents",
        "https://artificialanalysis.ai/models/glm-5-2",
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "medium"
    },
    {
      modelId: "kimi-k2.7-code",
      displayName: "Kimi K2.7 Code",
      upstream: "proxy",
      inputPricePerMillion: 0.95,
      outputPricePerMillion: 4,
      cachedInputPricePerMillion: 0.475,
      cacheWritePricePerMillion: 0.95,
      contextWindow: 256e3,
      maxOutputTokens: 32768,
      toolCallSupport: true,
      visionSupport: false,
      provider: "Moonshot AI",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: true,
      abilityAnchor: 0.776,
      solvedAbilityParameter: 0.5839101949915135,
      fittingError: 0,
      sufficientLow: 0.9610651235526767,
      sufficientMid: 0.8357220147344683,
      sufficientMidHigh: 0.43598320746351266,
      sufficientHigh: 0.10216581054680302,
      benchmarkEvidence: [
        {
          benchmarkName: "Kimi K2.7 Code official model-card suites",
          normalizedScore: 0.776,
          scoreScale: "relative family mapping onto pinned OpenHands anchor scale",
          sampleSize: 0,
          sourceModelName: "kimi-k2.7-code",
          evaluationMode: "vendor-reported; not OpenHands-comparable",
          sourceUrl: "https://huggingface.co/moonshotai/Kimi-K2.7-Code",
          resultsUrl: "https://huggingface.co/moonshotai/Kimi-K2.7-Code",
          sourceVersion: "retrieved-2026-07-27",
          benchmarkDate: "2026-07-27",
          directForModel: false,
          configuredRelativeDelta: 0.03
        }
      ],
      evidenceConfidence: "low",
      uncertaintyWidth: 0.14,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Series-relative estimate from K2.6; vendor comparisons use different agent harnesses.",
      curveProfile: "coding_specialist",
      curveTemperature: 0.125,
      curveFloor: 0.03,
      curveCeiling: 0.99,
      tierAdjustments: {
        low: 0,
        mid: 0.025,
        midHigh: 0.05,
        high: -0.01
      },
      profileEvidence: [
        "https://huggingface.co/moonshotai/Kimi-K2.7-Code",
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "medium"
    },
    {
      modelId: "kimi-k3",
      displayName: "Kimi K3",
      upstream: "proxy",
      inputPricePerMillion: 20,
      outputPricePerMillion: 100,
      cachedInputPricePerMillion: 2,
      cacheWritePricePerMillion: 3,
      contextWindow: 1048576,
      maxOutputTokens: 1048576,
      toolCallSupport: true,
      visionSupport: true,
      provider: "Moonshot AI",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: true,
      abilityAnchor: 0.930516931154788,
      solvedAbilityParameter: 1.003212096898729,
      fittingError: 0,
      sufficientLow: 0.975383957649151,
      sufficientMid: 0.9633702646634364,
      sufficientMidHigh: 0.9148906333031231,
      sufficientHigh: 0.7411957585817248,
      benchmarkEvidence: [
        {
          benchmarkName: "Artificial Analysis Intelligence Index v4.1",
          normalizedScore: 0.571123394372091,
          scoreScale: "0-100 composite index normalized to 0-1",
          sampleSize: 0,
          sourceModelName: "Kimi K3 (max)",
          evaluationMode: "independent composite; dedicated evaluation runs",
          sourceUrl: "https://artificialanalysis.ai/models/kimi-k3",
          resultsUrl: "https://artificialanalysis.ai/models/kimi-k3",
          sourceVersion: "v4.1-retrieved-2026-07-31",
          benchmarkDate: "2026-07-31",
          directForModel: true,
          configuredRelativeDelta: -0.02748306884521199
        }
      ],
      evidenceConfidence: "medium",
      uncertaintyWidth: 0.1,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Frontier placement is calibrated from the independent same-methodology gap to Fable 5; official K3 task results corroborate strong coding, terminal, browsing, tool-use and knowledge-work performance.",
      curveProfile: "frontier_resilient",
      curveTemperature: 0.16,
      curveFloor: 0.03,
      curveCeiling: 0.99,
      tierAdjustments: {
        low: -0.01,
        mid: -5e-3,
        midHigh: 0.02,
        high: 0.055
      },
      profileEvidence: [
        "https://openrouter.ai/rankings#benchmarks",
        "https://www.kimi.com/blog/kimi-k3",
        "https://artificialanalysis.ai/models/kimi-k3",
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "medium"
    },
    {
      modelId: "gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash",
      upstream: "proxy",
      inputPricePerMillion: 0.3,
      outputPricePerMillion: 2.5,
      cachedInputPricePerMillion: 0.03,
      cacheWritePricePerMillion: 0.15,
      contextWindow: 1048576,
      maxOutputTokens: 65536,
      toolCallSupport: true,
      visionSupport: true,
      provider: "Google",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: false,
      abilityAnchor: 0.6859999999999999,
      solvedAbilityParameter: 0.3488493546512945,
      fittingError: 0,
      sufficientLow: 0.9296262890788107,
      sufficientMid: 0.3988112458887811,
      sufficientMidHigh: 0.0036977465223457795,
      sufficientHigh: 0,
      benchmarkEvidence: [
        {
          benchmarkName: "Gemini family relative product mapping",
          normalizedScore: 0.6859999999999999,
          scoreScale: "relative family mapping onto pinned OpenHands anchor scale",
          sampleSize: 0,
          sourceModelName: "gemini-2.5-flash",
          evaluationMode: "vendor-reported; not OpenHands-comparable",
          sourceUrl: "https://ai.google.dev/gemini-api/docs/models#gemini-2.5-flash",
          resultsUrl: "https://ai.google.dev/gemini-api/docs/models#gemini-2.5-flash",
          sourceVersion: "retrieved-2026-07-27",
          benchmarkDate: "2026-07-27",
          directForModel: false,
          configuredRelativeDelta: -0.1
        }
      ],
      evidenceConfidence: "low",
      uncertaintyWidth: 0.14,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Low-confidence same-family relative estimate from Gemini 3.5 Flash; retained so an actual fallback is never hidden from the chart.",
      curveProfile: "efficient_fast",
      curveTemperature: 0.095,
      curveFloor: 0.025,
      curveCeiling: 0.985,
      tierAdjustments: {
        low: 0.05,
        mid: 0.02,
        midHigh: -0.06,
        high: -0.08
      },
      profileEvidence: [
        "https://ai.google.dev/gemini-api/docs/models#gemini-2.5-flash",
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "low"
    },
    {
      modelId: "meta-llama/llama-4-maverick",
      displayName: "Llama 4 Maverick",
      upstream: "openrouter",
      inputPricePerMillion: 0.2,
      outputPricePerMillion: 0.8,
      cachedInputPricePerMillion: 0.05,
      cacheWritePricePerMillion: 0.2,
      contextWindow: 1048576,
      maxOutputTokens: 32768,
      toolCallSupport: true,
      visionSupport: true,
      provider: "Meta",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: false,
      abilityAnchor: 0.6709999999999999,
      solvedAbilityParameter: 0.33233528857103356,
      fittingError: 0,
      sufficientLow: 0.9121799566038431,
      sufficientMid: 0.36093564354761387,
      sufficientMidHigh: 0,
      sufficientHigh: 0,
      benchmarkEvidence: [
        {
          benchmarkName: "Fallback relative capability mapping",
          normalizedScore: 0.6709999999999999,
          scoreScale: "relative family mapping onto pinned OpenHands anchor scale",
          sampleSize: 0,
          sourceModelName: "meta-llama/llama-4-maverick",
          evaluationMode: "vendor-reported; not OpenHands-comparable",
          sourceUrl: "https://huggingface.co/meta-llama/Llama-4-Maverick-17B-128E-Instruct",
          resultsUrl: "https://huggingface.co/meta-llama/Llama-4-Maverick-17B-128E-Instruct",
          sourceVersion: "retrieved-2026-07-27",
          benchmarkDate: "2026-07-27",
          directForModel: false,
          configuredRelativeDelta: -0.015
        }
      ],
      evidenceConfidence: "low",
      uncertaintyWidth: 0.14,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Low-confidence relative estimate; included because this model is in the live fallback chain.",
      curveProfile: "efficient_fast",
      curveTemperature: 0.095,
      curveFloor: 0.025,
      curveCeiling: 0.985,
      tierAdjustments: {
        low: 0.05,
        mid: 0.02,
        midHigh: -0.06,
        high: -0.08
      },
      profileEvidence: [
        "https://huggingface.co/meta-llama/Llama-4-Maverick-17B-128E-Instruct",
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "low"
    },
    {
      modelId: "deepseek/deepseek-chat-v3-0324",
      displayName: "DeepSeek V3 (OR)",
      upstream: "openrouter",
      inputPricePerMillion: 0.27,
      outputPricePerMillion: 1.12,
      cachedInputPricePerMillion: 0.135,
      cacheWritePricePerMillion: 0.27,
      contextWindow: 163840,
      maxOutputTokens: 163840,
      toolCallSupport: true,
      visionSupport: false,
      provider: "DeepSeek",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: false,
      abilityAnchor: 0.6019999999999999,
      solvedAbilityParameter: 0.27136198580110293,
      fittingError: -11102230246251565e-32,
      sufficientLow: 0.8257420780589249,
      sufficientMid: 0.2419952938290411,
      sufficientMidHigh: 0,
      sufficientHigh: 0,
      benchmarkEvidence: [
        {
          benchmarkName: "DeepSeek family relative product mapping",
          normalizedScore: 0.6019999999999999,
          scoreScale: "relative family mapping onto pinned OpenHands anchor scale",
          sampleSize: 0,
          sourceModelName: "deepseek/deepseek-chat-v3-0324",
          evaluationMode: "vendor-reported; not OpenHands-comparable",
          sourceUrl: "https://api-docs.deepseek.com/news/news250325",
          resultsUrl: "https://api-docs.deepseek.com/news/news250325",
          sourceVersion: "retrieved-2026-07-27",
          benchmarkDate: "2026-07-27",
          directForModel: false,
          configuredRelativeDelta: -0.07
        }
      ],
      evidenceConfidence: "low",
      uncertaintyWidth: 0.14,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Low-confidence family-relative estimate; included because this model is in the live fallback chain.",
      curveProfile: "efficient_fast",
      curveTemperature: 0.095,
      curveFloor: 0.025,
      curveCeiling: 0.985,
      tierAdjustments: {
        low: 0.05,
        mid: 0.02,
        midHigh: -0.06,
        high: -0.08
      },
      profileEvidence: [
        "https://api-docs.deepseek.com/news/news250325",
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "low"
    },
    {
      modelId: "meta-llama/llama-3.3-70b-instruct",
      displayName: "Llama 3.3 70B",
      upstream: "openrouter",
      inputPricePerMillion: 0.13,
      outputPricePerMillion: 0.4,
      cachedInputPricePerMillion: 0.025,
      cacheWritePricePerMillion: 0.13,
      contextWindow: 131072,
      maxOutputTokens: 16384,
      toolCallSupport: true,
      visionSupport: false,
      provider: "Meta",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: false,
      abilityAnchor: 0.6209999999999999,
      solvedAbilityParameter: 0.2862077219365291,
      fittingError: -2220446049250313e-31,
      sufficientLow: 0.8501878516101128,
      sufficientMid: 0.2675898425908389,
      sufficientMidHigh: 0,
      sufficientHigh: 0,
      benchmarkEvidence: [
        {
          benchmarkName: "Llama family relative product mapping",
          normalizedScore: 0.6209999999999999,
          scoreScale: "relative family mapping onto pinned OpenHands anchor scale",
          sampleSize: 0,
          sourceModelName: "meta-llama/llama-3.3-70b-instruct",
          evaluationMode: "vendor-reported; not OpenHands-comparable",
          sourceUrl: "https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct",
          resultsUrl: "https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct",
          sourceVersion: "retrieved-2026-07-27",
          benchmarkDate: "2026-07-27",
          directForModel: false,
          configuredRelativeDelta: -0.05
        }
      ],
      evidenceConfidence: "low",
      uncertaintyWidth: 0.14,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Low-confidence family-relative estimate; included because this model is in the live fallback chain.",
      curveProfile: "efficient_fast",
      curveTemperature: 0.095,
      curveFloor: 0.025,
      curveCeiling: 0.985,
      tierAdjustments: {
        low: 0.05,
        mid: 0.02,
        midHigh: -0.06,
        high: -0.08
      },
      profileEvidence: [
        "https://huggingface.co/meta-llama/Llama-4-Maverick-17B-128E-Instruct",
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "low"
    },
    {
      modelId: "qwen/qwen3-235b-a22b",
      displayName: "Qwen3 235B (OR)",
      upstream: "openrouter",
      inputPricePerMillion: 0.455,
      outputPricePerMillion: 1.82,
      cachedInputPricePerMillion: 0.1,
      cacheWritePricePerMillion: 0.455,
      contextWindow: 131072,
      maxOutputTokens: 32768,
      toolCallSupport: true,
      visionSupport: false,
      provider: "Qwen",
      availability: "callable_preflight_or_repository",
      routingEligible: true,
      defaultDisplay: false,
      abilityAnchor: 0.65,
      solvedAbilityParameter: 0.3715726164998827,
      fittingError: 0,
      sufficientLow: 0.8505872079437978,
      sufficientMid: 0.48065345307022056,
      sufficientMidHigh: 0.1734225220822092,
      sufficientHigh: 0.03615997679024336,
      benchmarkEvidence: [
        {
          benchmarkName: "Qwen family relative product mapping",
          normalizedScore: 0.65,
          scoreScale: "relative family mapping onto pinned OpenHands anchor scale",
          sampleSize: 0,
          sourceModelName: "qwen/qwen3-235b-a22b",
          evaluationMode: "vendor-reported; not OpenHands-comparable",
          sourceUrl: "https://huggingface.co/Qwen/Qwen3-235B-A22B",
          resultsUrl: "https://huggingface.co/Qwen/Qwen3-235B-A22B",
          sourceVersion: "retrieved-2026-07-27",
          benchmarkDate: "2026-07-27",
          directForModel: false,
          configuredRelativeDelta: 0.03
        }
      ],
      evidenceConfidence: "low",
      uncertaintyWidth: 0.14,
      curveMethod: "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
      sourceNames: [
        "OpenHands Index SWE-bench aggregate",
        "ClawRouter BLOCKRUN_MODELS"
      ],
      sourceRetrievedAt: "2026-07-27",
      notes: "Low-confidence family-relative estimate; included because this model is in the live fallback chain.",
      curveProfile: "coding_specialist",
      curveTemperature: 0.125,
      curveFloor: 0.03,
      curveCeiling: 0.99,
      tierAdjustments: {
        low: 0,
        mid: 0.025,
        midHigh: 0.05,
        high: -0.01
      },
      profileEvidence: [
        "https://huggingface.co/Qwen/Qwen3-235B-A22B",
        "https://huggingface.co/datasets/OpenHands/openhands-index"
      ],
      profileConfidence: "low"
    }
  ],
  priceVersion: "acu-official-public-price-2026-08-02-v1"
};

// src/acu/catalog/twin-product-presets.json
var twin_product_presets_default = {
  schemaVersion: "acu-twin-presets-v1",
  examples: [
    {
      id: "simple-rewrite-1",
      title: "\u7B80\u5355\u6539\u5199\u4EFB\u52A1",
      category: "\u5355\u4E00\u660E\u786E\u6267\u884C",
      source: "TwinRouterBench",
      publishedTier: "low",
      request: {
        model: "auto",
        messages: [
          {
            role: "user",
            content: "[USER]\n\u628A\u8FD9\u53E5\u8BDD\u6539\u5F97\u66F4\u793C\u8C8C\uFF1A\u4ECA\u5929\u628A\u6587\u4EF6\u7ED9\u6211\u3002"
          }
        ]
      }
    },
    {
      id: "json-extraction-1",
      title: "\u7ED3\u6784\u5316\u63D0\u53D6\u4EFB\u52A1",
      category: "\u683C\u5F0F\u7EA6\u675F\u4E0E\u4E00\u81F4\u6027",
      source: "TwinRouterBench",
      publishedTier: "low",
      request: {
        model: "auto",
        messages: [
          {
            role: "user",
            content: "[USER]\n\u4ECE\u8BA2\u5355\u8BF4\u660E\u4E2D\u63D0\u53D6order_id\u3001amount\u548Ccurrency\uFF0C\u53EA\u8FD4\u56DE\u5408\u6CD5JSON\uFF0C\u7F3A\u5931\u503C\u4E3Anull\u3002"
          }
        ]
      }
    },
    {
      id: "code-fix-1",
      title: "\u5E38\u89C4\u4EE3\u7801\u4FEE\u590D",
      category: "\u5C40\u90E8\u63A8\u7406\u4E0E\u4FEE\u590D",
      source: "TwinRouterBench",
      publishedTier: "mid",
      request: {
        model: "auto",
        messages: [
          {
            role: "user",
            content: "[USER]\n\u4FEE\u590D\u8FD9\u4E2APython\u51FD\u6570\u5728\u7A7A\u5217\u8868\u65F6\u9664\u96F6\u7684\u95EE\u9898\uFF0C\u7ED9\u51FA\u4FEE\u6539\u540E\u7684\u51FD\u6570\u5E76\u89E3\u91CA\u539F\u56E0\u3002"
          }
        ]
      }
    },
    {
      id: "multi-file-fix-1",
      title: "\u591A\u6587\u4EF6\u4FEE\u590D\u4EFB\u52A1",
      category: "\u8DE8\u6587\u4EF6\u72B6\u6001\u6574\u5408",
      source: "TwinRouterBench",
      publishedTier: "mid_high",
      request: {
        model: "auto",
        messages: [
          {
            role: "user",
            content: "[SYSTEM]\nYou can inspect and edit repository files and run tests.\n\n[USER]\n\u5B9A\u4F4D\u8BA4\u8BC1\u91CD\u8BD5\u5BFC\u81F4\u7684\u91CD\u590D\u5199\u5165\uFF0C\u4FEE\u6539API\u5C42\u548C\u5B58\u50A8\u5C42\uFF0C\u8865\u56DE\u5F52\u6D4B\u8BD5\u5E76\u8BF4\u660E\u517C\u5BB9\u98CE\u9669\u3002"
          }
        ]
      }
    },
    {
      id: "multi-tool-agent-1",
      title: "\u591A\u5DE5\u5177 Agent \u4EFB\u52A1",
      category: "\u5DE5\u5177\u94FE\u8C03\u67E5\u4E0E\u9A8C\u8BC1",
      source: "TwinRouterBench",
      publishedTier: "mid_high",
      request: {
        model: "auto",
        messages: [
          {
            role: "user",
            content: "[SYSTEM]\nUse shell, repository search and browser tools when necessary.\n\n[USER]\n\u8C03\u67E5\u90E8\u7F72\u540E\u652F\u4ED8\u56DE\u8C03\u91CD\u590D\u6267\u884C\uFF1A\u68C0\u67E5\u65E5\u5FD7\u548C\u914D\u7F6E\u3001\u5B9A\u4F4D\u63D0\u4EA4\u3001\u4FEE\u590D\u5E42\u7B49\u903B\u8F91\u3001\u8FD0\u884C\u6D4B\u8BD5\u5E76\u9A8C\u8BC1\u7070\u5EA6\u73AF\u5883\u3002"
          }
        ]
      }
    },
    {
      id: "long-horizon-reasoning-1",
      title: "\u957F\u7A0B\u63A8\u7406\u4EFB\u52A1",
      category: "\u9AD8\u98CE\u9669\u591A\u6B65\u89C4\u5212",
      source: "TwinRouterBench",
      publishedTier: "high",
      request: {
        model: "auto",
        messages: [
          {
            role: "user",
            content: "[USER]\n\u4E3A\u8DE8\u5730\u533A\u8BA2\u5355\u7CFB\u7EDF\u5236\u5B9A\u4E0D\u505C\u673A\u8FC1\u79FB\u65B9\u6848\uFF0C\u8986\u76D6\u652F\u4ED8\u5E42\u7B49\u3001\u6D88\u606F\u91CD\u653E\u3001\u6570\u636E\u4E00\u81F4\u6027\u3001\u7070\u5EA6\u56DE\u6EDA\u3001\u76D1\u7BA1\u7EA6\u675F\u3001\u9A8C\u8BC1\u6307\u6807\u548C\u6545\u969C\u6F14\u7EC3\uFF0C\u5E76\u7ED9\u51FA\u4F9D\u8D56\u987A\u5E8F\u3002"
          }
        ]
      }
    }
  ]
};

// src/acu/catalog.ts
var catalog = model_catalog_default;
var ACU_CURVE_DIFFICULTIES = Object.freeze(
  Array.from({ length: 101 }, (_, difficultyScore2) => difficultyScore2)
);
function getAcuCatalog() {
  return catalog;
}
function getAcuModel(modelId) {
  return catalog.models.find((model) => model.modelId === modelId);
}
function getRoutingEligibleModels(eligibleModelIds) {
  const allowed = eligibleModelIds ? new Set(eligibleModelIds) : null;
  return catalog.models.filter((model) => model.routingEligible && (!allowed || allowed.has(model.modelId)));
}
function buildModelCurve(model) {
  const points = [];
  for (const difficultyScore2 of ACU_CURVE_DIFFICULTIES) {
    const probabilities = continuousTierProbabilities(difficultyScore2 / 100);
    const quality = estimatedQuality(probabilities, model);
    points.push({
      difficultyScore: difficultyScore2,
      ...probabilities,
      estimatedQuality: quality,
      qualityLower: Math.max(0, quality - model.uncertaintyWidth),
      qualityUpper: Math.min(1, quality + model.uncertaintyWidth)
    });
  }
  return points;
}
function interpolateModelCurve(model, difficultyScore2) {
  const bounded = Math.max(0, Math.min(100, difficultyScore2));
  const lowerIndex = Math.floor(bounded);
  const upperIndex = Math.ceil(bounded);
  const curve = buildModelCurve(model);
  if (lowerIndex === upperIndex) return curve[lowerIndex];
  const fraction = bounded - lowerIndex;
  const lower = curve[lowerIndex];
  const upper = curve[upperIndex];
  const interpolate = (left, right) => left + (right - left) * fraction;
  return {
    difficultyScore: bounded,
    pLow: interpolate(lower.pLow, upper.pLow),
    pMid: interpolate(lower.pMid, upper.pMid),
    pMidHigh: interpolate(lower.pMidHigh, upper.pMidHigh),
    pHigh: interpolate(lower.pHigh, upper.pHigh),
    estimatedQuality: interpolate(lower.estimatedQuality, upper.estimatedQuality),
    qualityLower: interpolate(lower.qualityLower, upper.qualityLower),
    qualityUpper: interpolate(lower.qualityUpper, upper.qualityUpper)
  };
}
function publicCatalogPayload() {
  return {
    schemaVersion: catalog.schemaVersion,
    generatedAt: catalog.generatedAt,
    estimateLabel: catalog.estimateLabel,
    disclaimer: catalog.disclaimer,
    config: catalog.config,
    provenance: catalog.provenance,
    models: catalog.models,
    twinPresets: twin_product_presets_default.examples,
    curves: Object.fromEntries(catalog.models.map((model) => [model.modelId, buildModelCurve(model)]))
  };
}

// src/acu/execution-presets.ts
var ACU_EXECUTION_PRESETS = [{
  presetId: "gpt-5.6-luna:max",
  candidateId: "gpt-5.6-luna@max",
  modelId: "gpt-5.6-luna",
  displayName: "GPT-5.6 Luna \xB7 Max",
  canonicalReasoningEffort: "max",
  qualityLogitShift: 0.22,
  expectedOutputTokenMultiplier: 1.6,
  featureFlagEnv: "ACU_LUNA_MAX_PRESET_ENABLED",
  enabled: true,
  calibrationStatus: "provisional",
  source: "acu-execution-preset-v1"
}, {
  presetId: "gpt-5.6-sol:high",
  candidateId: "gpt-5.6-sol@high",
  modelId: "gpt-5.6-sol",
  displayName: "GPT-5.6 Sol \xB7 High",
  canonicalReasoningEffort: "high",
  qualityLogitShift: 0.081,
  expectedOutputTokenMultiplier: 1.75,
  featureFlagEnv: "ACU_SOL_HIGH_PRESET_ENABLED",
  enabled: true,
  calibrationStatus: "provisional",
  source: "artificial-analysis-v4.1-sol-medium-to-high"
}, {
  presetId: "gpt-5.6-sol:xhigh",
  candidateId: "gpt-5.6-sol@xhigh",
  modelId: "gpt-5.6-sol",
  displayName: "GPT-5.6 Sol \xB7 XHigh",
  canonicalReasoningEffort: "xhigh",
  qualityLogitShift: 0.162,
  expectedOutputTokenMultiplier: 35 / 12,
  featureFlagEnv: "ACU_SOL_XHIGH_PRESET_ENABLED",
  enabled: true,
  calibrationStatus: "provisional",
  source: "artificial-analysis-v4.1-sol-medium-to-xhigh"
}, {
  presetId: "gpt-5.6-terra:max",
  candidateId: "gpt-5.6-terra@max",
  modelId: "gpt-5.6-terra",
  displayName: "GPT-5.6 Terra \xB7 Max",
  canonicalReasoningEffort: "max",
  qualityLogitShift: 0.361,
  expectedOutputTokenMultiplier: 9.6,
  featureFlagEnv: "ACU_TERRA_MAX_PRESET_ENABLED",
  enabled: true,
  calibrationStatus: "provisional",
  source: "artificial-analysis-v4.1-terra-medium-to-max"
}];
function enabledExecutionPresets() {
  return ACU_EXECUTION_PRESETS.filter((preset) => preset.enabled && process.env[preset.featureFlagEnv]?.toLowerCase() !== "false");
}

// src/acu/decision.ts
var ACU_COST_LOG_SCALE = 2.5;
var VALUE_UTILITY_NEAR_TIE_RATIO = 0.995;
var ACU_QUALITY_SATISFACTION_ANCHORS = Object.freeze([
  { quality: 0, satisfaction: 0 },
  { quality: 0.5, satisfaction: 0.65 },
  { quality: 0.8, satisfaction: 0.9 },
  { quality: 0.95, satisfaction: 0.985 },
  { quality: 1, satisfaction: 1 }
]);
function estimateCallCost(model, inputTokens, outputTokens) {
  if (model.inputPricePerMillion === null || model.outputPricePerMillion === null) {
    return Number.POSITIVE_INFINITY;
  }
  return (Math.max(0, inputTokens) * model.inputPricePerMillion + Math.max(0, outputTokens) * model.outputPricePerMillion) / 1e6;
}
function estimateOne(model, difficultyScore2, entropyPenalty, inputTokens, outputTokens, judgeCost, fallbackCallCost, qualityTarget, switchCost, fallbackRiskScale, effectivePrice, preset) {
  const curvePoint = interpolateModelCurve(model, difficultyScore2);
  const quality = preset ? applyLogitShift(curvePoint.estimatedQuality, preset.qualityLogitShift) : curvePoint.estimatedQuality;
  const lower = clamp(quality - model.uncertaintyWidth - entropyPenalty / 100);
  const upper = clamp(quality + model.uncertaintyWidth);
  const expectedOutputTokens = Math.round(outputTokens * (preset?.expectedOutputTokenMultiplier ?? 1));
  const callCost = estimateCallCost(effectivePrice ?? model, inputTokens, expectedOutputTokens);
  const expectedFallbackCost = fallbackRiskScale * (1 - lower) * (fallbackCallCost + switchCost);
  const selectionCost = callCost + expectedFallbackCost;
  const expectedEndToEndCost = judgeCost + selectionCost;
  return {
    candidateId: preset?.candidateId ?? model.modelId,
    modelId: model.modelId,
    executionPresetId: preset?.presetId,
    reasoningEffort: preset?.canonicalReasoningEffort,
    expectedOutputTokenMultiplier: preset?.expectedOutputTokenMultiplier,
    displayName: preset?.displayName ?? model.displayName,
    provider: model.provider,
    estimatedQuality: quality,
    conservativeQuality: lower,
    qualityLower: lower,
    qualityUpper: upper,
    estimatedCallCost: callCost,
    expectedFallbackCost,
    selectionCost,
    judgeOverheadCost: judgeCost,
    expectedEndToEndCost,
    expectedTotalCost: expectedEndToEndCost,
    predictedScore: quality * 100,
    conservativeScore: lower * 100,
    riskAdjustedCost: selectionCost,
    riskAdjustedScore: quality * 100,
    qualityUtility: 0,
    costUtility: 0,
    valueUtility: 0,
    scoreGapVsBest: 0,
    costSavingsVsBest: 0,
    paretoEfficient: false,
    selectionReason: "",
    savingsVsFlagship: 0,
    savingsPercentVsFlagship: 0,
    meetsQualityTarget: quality >= qualityTarget
  };
}
function candidateIdentity(candidate) {
  return candidate.candidateId ?? candidate.modelId;
}
function isParetoEfficient(candidate, candidates) {
  return !candidates.some((other) => candidateIdentity(other) !== candidateIdentity(candidate) && other.predictedScore >= candidate.predictedScore && other.riskAdjustedCost <= candidate.riskAdjustedCost && (other.predictedScore > candidate.predictedScore || other.riskAdjustedCost < candidate.riskAdjustedCost));
}
function selectValueRoute(candidates, targetScore, costSensitivity = 1) {
  if (candidates.length === 0) throw new Error("Value routing requires at least one candidate");
  const bestScore = candidates.reduce((best, item) => item.predictedScore > best.predictedScore ? item : best);
  const frontier = candidates.filter((candidate) => isParetoEfficient(candidate, candidates));
  const preference = clamp((targetScore - 60) / 35);
  const qualityWeight = 0.58 + 0.24 * preference;
  const costWeight = clamp((1 - qualityWeight) * Math.max(0, costSensitivity), 0, 0.9);
  const riskWeight = 0.2 + 0.25 * preference;
  const qualityExponent = 0.8 + 1.2 * preference;
  const finiteCosts = frontier.map((candidate) => Math.max(1e-9, candidate.riskAdjustedCost));
  const minCost = Math.min(...finiteCosts);
  const allCostsEqual = finiteCosts.every((cost) => Math.abs(cost - minCost) <= 1e-12);
  const utilities = /* @__PURE__ */ new Map();
  for (const candidate of frontier) {
    const conservative = candidate.conservativeScore ?? candidate.predictedScore;
    const riskAdjustedScore = candidate.predictedScore - riskWeight * Math.max(0, candidate.predictedScore - conservative);
    const qualityUtility = Math.pow(Math.max(0, riskAdjustedScore) / Math.max(1, targetScore), qualityExponent);
    const costUtility = allCostsEqual ? 1 : clamp(
      1 / (1 + ACU_COST_LOG_SCALE * Math.log(
        Math.max(1e-9, candidate.riskAdjustedCost) / minCost
      ))
    );
    const valueUtility = qualityUtility * (1 - costWeight + costWeight * costUtility);
    utilities.set(candidateIdentity(candidate), { riskAdjustedScore, qualityUtility, costUtility, valueUtility });
  }
  const bestValueUtility = Math.max(...frontier.map((candidate) => utilities.get(candidateIdentity(candidate)).valueUtility));
  const nearTiedCandidates = frontier.filter((candidate) => utilities.get(candidateIdentity(candidate)).valueUtility >= bestValueUtility * VALUE_UTILITY_NEAR_TIE_RATIO);
  const selected = nearTiedCandidates.reduce((best, candidate) => candidate.riskAdjustedCost < best.riskAdjustedCost ? candidate : best);
  const saving = bestScore.riskAdjustedCost > 0 ? (1 - selected.riskAdjustedCost / bestScore.riskAdjustedCost) * 100 : 0;
  return {
    selected,
    bestScore,
    utilities,
    reason: candidateIdentity(selected) === candidateIdentity(bestScore) ? `\u7EFC\u5408\u98CE\u9669\u8C03\u6574\u5F97\u5206\u3001\u60A8\u7684\u8D28\u91CF\u504F\u597D\u4E0E\u5BF9\u6570\u6210\u672C\u6548\u7528\u540E\uFF0C${selected.displayName}\u7684\u8D28\u91CF\u6548\u7528\u4F18\u52BF\u8DB3\u4EE5\u62B5\u6D88\u6210\u672C\u3002` : `\u7EFC\u5408\u98CE\u9669\u8C03\u6574\u5F97\u5206\u3001\u60A8\u7684\u8D28\u91CF\u504F\u597D\u4E0E\u5BF9\u6570\u6210\u672C\u6548\u7528\u540E\uFF0C${selected.displayName}\u4EF7\u503C\u6548\u7528\u6700\u9AD8\uFF1B\u76F8\u5BF9\u6700\u9AD8\u5F97\u5206\u6A21\u578B\u9884\u8BA1\u7EFC\u5408\u6210\u672C${saving >= 0 ? "\u964D\u4F4E" : "\u589E\u52A0"}${Math.abs(saving).toFixed(0)}%\u3002`
  };
}
function recommendModel(input) {
  const probabilities = normalizeProbabilities(input.probabilities);
  const entropy = normalizedEntropy(probabilities);
  const entropyPenalty = entropy * Math.max(0, input.judgeEntropyPenalty ?? 0);
  const difficulty = Math.max(0, Math.min(100, input.difficultyScore));
  const qualityTarget = clamp(input.qualityTarget ?? ACU_DEFAULT_QUALITY_TARGET);
  const inputTokens = Math.max(1, Math.round(input.inputTokens));
  const outputTokens = Math.max(1, Math.round(input.expectedOutputTokens));
  const switchCost = Math.max(0, input.switchCost ?? ACU_DEFAULT_SWITCH_COST_USD);
  const costSensitivity = Math.max(0, input.costSensitivity ?? 1);
  const fallbackRiskScale = Math.max(0, input.fallbackRiskScale ?? 1);
  let models = getRoutingEligibleModels(input.eligibleModelIds);
  if (input.eligibleModelIds === void 0) {
    if (input.requireToolCallSupport) models = models.filter((model) => model.toolCallSupport);
    if (input.requireVisionSupport) models = models.filter((model) => model.visionSupport);
  }
  if (models.length === 0) throw new Error("No ACU catalog model is eligible for this request");
  const flagship = models.reduce((best, model) => model.abilityAnchor > best.abilityAnchor ? model : best);
  const fallback = flagship;
  const fallbackCallCost = estimateCallCost(input.effectivePrices?.[fallback.modelId] ?? fallback, inputTokens, outputTokens);
  const baseEstimates = models.map((model) => estimateOne(
    model,
    difficulty,
    entropyPenalty,
    inputTokens,
    outputTokens,
    Math.max(0, input.judgeCost),
    fallbackCallCost,
    qualityTarget,
    switchCost,
    fallbackRiskScale,
    input.effectivePrices?.[model.modelId]
  ));
  const presetEstimates = input.includeExecutionPresets === false ? [] : enabledExecutionPresets().flatMap((preset) => {
    const model = models.find((candidate) => candidate.modelId === preset.modelId);
    return model ? [estimateOne(
      model,
      difficulty,
      entropyPenalty,
      inputTokens,
      outputTokens,
      Math.max(0, input.judgeCost),
      fallbackCallCost,
      qualityTarget,
      switchCost,
      fallbackRiskScale,
      input.effectivePrices?.[model.modelId],
      preset
    )] : [];
  });
  const allEstimates = [...baseEstimates, ...presetEstimates];
  const allowedCandidates = input.allowedCandidateIds?.length ? new Set(input.allowedCandidateIds) : void 0;
  const estimates = allowedCandidates ? allEstimates.filter((estimate) => allowedCandidates.has(estimate.candidateId)) : allEstimates;
  if (estimates.length === 0) throw new Error("No ACU candidate is allowed by the routing policy");
  const flagshipEstimate = estimates.reduce((best, estimate) => estimate.conservativeQuality > best.conservativeQuality ? estimate : best);
  if (!flagshipEstimate) throw new Error("ACU flagship model estimate is missing");
  for (const estimate of estimates) {
    estimate.savingsVsFlagship = flagshipEstimate.selectionCost - estimate.selectionCost;
    estimate.savingsPercentVsFlagship = flagshipEstimate.selectionCost > 0 ? estimate.savingsVsFlagship / flagshipEstimate.selectionCost : 0;
  }
  const route2 = selectValueRoute(estimates, qualityTarget * 100, costSensitivity);
  const recommended = route2.selected;
  for (const estimate of estimates) {
    const utility = route2.utilities.get(estimate.candidateId);
    estimate.paretoEfficient = isParetoEfficient(estimate, estimates);
    estimate.riskAdjustedScore = utility?.riskAdjustedScore ?? estimate.conservativeScore;
    estimate.qualityUtility = utility?.qualityUtility ?? 0;
    estimate.costUtility = utility?.costUtility ?? 0;
    estimate.valueUtility = utility?.valueUtility ?? 0;
    estimate.scoreGapVsBest = route2.bestScore.predictedScore - estimate.predictedScore;
    estimate.costSavingsVsBest = route2.bestScore.riskAdjustedCost - estimate.riskAdjustedCost;
    estimate.selectionReason = estimate.candidateId === recommended.candidateId ? route2.reason : estimate.paretoEfficient ? "\u4F4D\u4E8E\u5F53\u524D\u6210\u672C\u2014\u5F97\u5206\u6709\u6548\u524D\u6CBF\u3002" : "\u5B58\u5728\u5F97\u5206\u66F4\u9AD8\u4E14\u9884\u8BA1\u7EFC\u5408\u6210\u672C\u66F4\u4F4E\u7684\u5019\u9009\u3002";
  }
  const valuePool = estimates.filter((estimate) => estimate.candidateId !== recommended.candidateId && estimate.paretoEfficient);
  const valueAlternative = valuePool.length > 0 ? valuePool.reduce((best, estimate) => estimate.riskAdjustedCost < best.riskAdjustedCost ? estimate : best) : null;
  const flagshipAlternative = flagshipEstimate;
  return {
    recommended,
    valueAlternative,
    flagshipAlternative,
    fallbackModel: flagshipAlternative,
    estimates: estimates.sort((left, right) => left.riskAdjustedCost - right.riskAdjustedCost),
    reason: route2.reason
  };
}

// src/acu/judge.ts
import { createHash as createHash4 } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir as homedir4 } from "os";
import { dirname as dirname2, join as join5 } from "path";

// src/acu/catalog/twin-few-shots.json
var twin_few_shots_default = {
  promptVersion: "acu-tier-requirement-v4",
  examples: [
    {
      exampleId: "simple-rewrite-1",
      context: "[USER]\n\u628A\u8FD9\u53E5\u8BDD\u6539\u5F97\u66F4\u793C\u8C8C\uFF1A\u4ECA\u5929\u628A\u6587\u4EF6\u7ED9\u6211\u3002",
      minimumSufficientTier: "low",
      explanation: "\u5355\u53E5\u5C40\u90E8\u6539\u5199\uFF0C\u8303\u56F4\u548C\u9A8C\u8BC1\u8D1F\u62C5\u5F88\u4F4E\u3002",
      expected: {
        difficulty_score_raw: 8.7,
        factors: { reasoning_depth: 0.8, task_scope: 0.7, constraint_density: 1.5, tool_dependency: 0, verification_burden: 1, context_burden: 0.4 },
        p_low: 0.94,
        p_mid: 0.05,
        p_mid_high: 0.01,
        p_high: 0,
        confidence: 0.93,
        signals: ["single_rewrite", "no_tools"],
        explanation: "\u5355\u53E5\u793C\u8C8C\u6539\u5199\uFF0C\u7EA6\u675F\u660E\u786E\u4E14\u5BB9\u6613\u6838\u9A8C\u3002"
      }
    },
    {
      exampleId: "json-extraction-1",
      context: "[USER]\n\u4ECE\u8BA2\u5355\u8BF4\u660E\u4E2D\u63D0\u53D6order_id\u3001amount\u548Ccurrency\uFF0C\u53EA\u8FD4\u56DE\u5408\u6CD5JSON\uFF0C\u7F3A\u5931\u503C\u4E3Anull\u3002",
      minimumSufficientTier: "low",
      explanation: "\u63D0\u53D6\u8303\u56F4\u6709\u9650\uFF0C\u4F46\u683C\u5F0F\u4E0E\u5B57\u6BB5\u7EA6\u675F\u63D0\u9AD8\u4E86\u7EA6\u675F\u5BC6\u5EA6\u3002",
      expected: {
        difficulty_score_raw: 22.6,
        factors: { reasoning_depth: 1.3, task_scope: 1.2, constraint_density: 4.7, tool_dependency: 0, verification_burden: 1.1, context_burden: 0.9 },
        p_low: 0.78,
        p_mid: 0.2,
        p_mid_high: 0.02,
        p_high: 0,
        confidence: 0.89,
        signals: ["strict_json", "field_constraints"],
        explanation: "\u7ED3\u6784\u7B80\u5355\uFF0C\u4F46\u9700\u4E25\u683C\u6EE1\u8DB3JSON\u5B57\u6BB5\u7EA6\u675F\u3002"
      }
    },
    {
      exampleId: "code-fix-1",
      context: "[USER]\n\u4FEE\u590D\u8FD9\u4E2APython\u51FD\u6570\u5728\u7A7A\u5217\u8868\u65F6\u9664\u96F6\u7684\u95EE\u9898\uFF0C\u7ED9\u51FA\u4FEE\u6539\u540E\u7684\u51FD\u6570\u5E76\u89E3\u91CA\u539F\u56E0\u3002",
      minimumSufficientTier: "mid",
      explanation: "\u9700\u8981\u5B9A\u4F4D\u8FB9\u754C\u6761\u4EF6\u3001\u4FEE\u6539\u5B9E\u73B0\u5E76\u89E3\u91CA\uFF0C\u4F46\u8303\u56F4\u5C40\u90E8\u3002",
      expected: {
        difficulty_score_raw: 38.2,
        factors: { reasoning_depth: 3.4, task_scope: 3.2, constraint_density: 2.8, tool_dependency: 2.5, verification_burden: 3.6, context_burden: 1.4 },
        p_low: 0.24,
        p_mid: 0.66,
        p_mid_high: 0.09,
        p_high: 0.01,
        confidence: 0.84,
        signals: ["edge_case", "code_change"],
        explanation: "\u5C40\u90E8\u4EE3\u7801\u4FEE\u590D\uFF0C\u9700\u8981\u6B63\u786E\u5904\u7406\u8FB9\u754C\u5E76\u4FDD\u6301\u884C\u4E3A\u3002"
      }
    },
    {
      exampleId: "multi-file-fix-1",
      context: "[SYSTEM]\nYou can inspect and edit repository files and run tests.\n\n[USER]\n\u5B9A\u4F4D\u8BA4\u8BC1\u91CD\u8BD5\u5BFC\u81F4\u7684\u91CD\u590D\u5199\u5165\uFF0C\u4FEE\u6539API\u5C42\u548C\u5B58\u50A8\u5C42\uFF0C\u8865\u56DE\u5F52\u6D4B\u8BD5\u5E76\u8BF4\u660E\u517C\u5BB9\u98CE\u9669\u3002",
      minimumSufficientTier: "mid_high",
      explanation: "\u8DE8\u6A21\u5757\u4FEE\u6539\u3001\u6D4B\u8BD5\u4E0E\u517C\u5BB9\u98CE\u9669\u5171\u540C\u63D0\u9AD8\u8303\u56F4\u548C\u9A8C\u8BC1\u8D1F\u62C5\u3002",
      expected: {
        difficulty_score_raw: 63.7,
        factors: { reasoning_depth: 6.2, task_scope: 6.8, constraint_density: 5.4, tool_dependency: 6.1, verification_burden: 5.9, context_burden: 4.2 },
        p_low: 0.03,
        p_mid: 0.24,
        p_mid_high: 0.65,
        p_high: 0.08,
        confidence: 0.82,
        signals: ["multi_module", "regression_tests", "compatibility_risk"],
        explanation: "\u8DE8\u5C42\u4FEE\u590D\u5E76\u9A8C\u8BC1\u56DE\u5F52\uFF0C\u9700\u8981\u6574\u5408\u591A\u5904\u72B6\u6001\u3002"
      }
    },
    {
      exampleId: "multi-tool-agent-1",
      context: "[SYSTEM]\nUse shell, repository search and browser tools when necessary.\n\n[USER]\n\u8C03\u67E5\u90E8\u7F72\u540E\u652F\u4ED8\u56DE\u8C03\u91CD\u590D\u6267\u884C\uFF1A\u68C0\u67E5\u65E5\u5FD7\u548C\u914D\u7F6E\u3001\u5B9A\u4F4D\u63D0\u4EA4\u3001\u4FEE\u590D\u5E42\u7B49\u903B\u8F91\u3001\u8FD0\u884C\u6D4B\u8BD5\u5E76\u9A8C\u8BC1\u7070\u5EA6\u73AF\u5883\u3002",
      minimumSufficientTier: "mid_high",
      explanation: "\u4F9D\u8D56\u591A\u5DE5\u5177\u3001\u73AF\u5883\u72B6\u6001\u548C\u6709\u5E8F\u9A8C\u8BC1\uFF0C\u6267\u884C\u94FE\u8F83\u957F\u3002",
      expected: {
        difficulty_score_raw: 76.3,
        factors: { reasoning_depth: 7, task_scope: 7.6, constraint_density: 6.1, tool_dependency: 8.8, verification_burden: 7.2, context_burden: 6.4 },
        p_low: 0.01,
        p_mid: 0.08,
        p_mid_high: 0.7,
        p_high: 0.21,
        confidence: 0.8,
        signals: ["multi_tool", "environment_state", "ordered_validation"],
        explanation: "\u591A\u5DE5\u5177\u957F\u94FE\u6267\u884C\uFF0C\u9700\u8981\u6301\u7EED\u8DDF\u8E2A\u73AF\u5883\u4E0E\u9A8C\u8BC1\u72B6\u6001\u3002"
      }
    },
    {
      exampleId: "long-horizon-reasoning-1",
      context: "[USER]\n\u4E3A\u8DE8\u5730\u533A\u8BA2\u5355\u7CFB\u7EDF\u5236\u5B9A\u4E0D\u505C\u673A\u8FC1\u79FB\u65B9\u6848\uFF0C\u8986\u76D6\u652F\u4ED8\u5E42\u7B49\u3001\u6D88\u606F\u91CD\u653E\u3001\u6570\u636E\u4E00\u81F4\u6027\u3001\u7070\u5EA6\u56DE\u6EDA\u3001\u76D1\u7BA1\u7EA6\u675F\u3001\u9A8C\u8BC1\u6307\u6807\u548C\u6545\u969C\u6F14\u7EC3\uFF0C\u5E76\u7ED9\u51FA\u4F9D\u8D56\u987A\u5E8F\u3002",
      minimumSufficientTier: "high",
      explanation: "\u9AD8\u62BD\u8C61\u3001\u591A\u7CFB\u7EDF\u3001\u591A\u7EA6\u675F\u4E14\u96BE\u4EE5\u4E00\u6B21\u6027\u9A8C\u8BC1\uFF0C\u5C5E\u4E8E\u957F\u7A0B\u9AD8\u98CE\u9669\u63A8\u7406\u3002",
      expected: {
        difficulty_score_raw: 91.4,
        factors: { reasoning_depth: 9.1, task_scope: 9, constraint_density: 8.4, tool_dependency: 8.8, verification_burden: 9.2, context_burden: 8.6 },
        p_low: 0,
        p_mid: 0.01,
        p_mid_high: 0.12,
        p_high: 0.87,
        confidence: 0.91,
        signals: ["long_horizon", "cross_system", "high_risk"],
        explanation: "\u8DE8\u7CFB\u7EDF\u9AD8\u98CE\u9669\u8FC1\u79FB\uFF0C\u63A8\u7406\u3001\u9A8C\u8BC1\u4E0E\u72B6\u6001\u4F9D\u8D56\u90FD\u5F88\u9AD8\u3002"
      }
    }
  ]
};

// src/acu/judge.ts
var AcuJudgeClientCancelledError = class extends Error {
  constructor() {
    super("Judge request cancelled by the client");
    this.name = "AcuJudgeClientCancelledError";
  }
};
var AcuJudgeAttemptError = class extends Error {
  constructor(message, attempt) {
    super(message);
    this.attempt = attempt;
    this.name = "AcuJudgeAttemptError";
  }
  attempt;
};
var JudgeProviderProtocolError = class extends Error {
  name = "JudgeProviderProtocolError";
};
var JudgeSemanticParseError = class extends Error {
  name = "JudgeSemanticParseError";
};
function looksLikeHtml(body, contentType) {
  return /text\/html/i.test(contentType) || /^\s*(?:<!doctype\s+html|<html\b)/i.test(body);
}
function extractResponsesAssistantText(payload) {
  const output = Array.isArray(payload.output) ? payload.output : [];
  const text = output.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const content = Array.isArray(item.content) ? item.content : [];
    return content.flatMap((part) => part && typeof part === "object" && part.type === "output_text" && typeof part.text === "string" ? [part.text] : []);
  }).join("");
  return text || void 0;
}
function judgeNominalCostUsd(modelId, promptTokens, cachedPromptTokens, completionTokens) {
  const price = modelId === "mimo-v2.5-pro" ? { input: 0.435, cached: 36e-4, output: 0.87 } : (() => {
    const model = getAcuCatalog().models.find((entry) => entry.modelId === modelId);
    if (!model || model.inputPricePerMillion === null || model.outputPricePerMillion === null) return void 0;
    return {
      input: model.inputPricePerMillion,
      cached: model.cachedInputPricePerMillion ?? model.inputPricePerMillion,
      output: model.outputPricePerMillion
    };
  })();
  if (!price) return 0;
  const cached = Math.max(0, Math.min(promptTokens, cachedPromptTokens));
  const uncached = Math.max(0, promptTokens - cached);
  return (uncached * price.input + cached * price.cached + Math.max(0, completionTokens) * price.output) / 1e6;
}
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  const record = value;
  if (record.type === "image_url" || "image_url" in record) return "[IMAGE]";
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalValue(record[key])]));
}
function stableJson(value) {
  return JSON.stringify(canonicalValue(value));
}
function contentText(content) {
  if (typeof content === "string") return content;
  if (content === null || content === void 0) return "";
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return String(part ?? "");
      const value = part;
      if (value.type === "image_url" || "image_url" in value) return "[IMAGE]";
      if (typeof value.text === "string") return value.text;
      return stableJson(value);
    }).join("\n");
  }
  return stableJson(content);
}
function serializeToolCall(call) {
  const value = call && typeof call === "object" ? call : {};
  const fn = value.function && typeof value.function === "object" ? value.function : {};
  const id = String(value.id ?? "unknown");
  const name = String(fn.name ?? value.name ?? "unknown");
  let args = fn.arguments ?? value.arguments ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
    }
  }
  return `[ASSISTANT_TOOL_CALL id=${id}]
name=${name}
arguments=${typeof args === "string" ? args : stableJson(args)}`;
}
function serializeVisibleContext(messages, tools = []) {
  const sections = [];
  for (const message of messages) {
    const role = String(message.role || "unknown").toLowerCase();
    const text = contentText(message.content);
    if (role === "tool") {
      const id = String(message.tool_call_id ?? "unknown");
      const name2 = String(message.name ?? "unknown");
      const extra = Object.fromEntries(
        Object.entries(message).filter(([key]) => !["role", "name", "content", "tool_call_id"].includes(key)).sort(([left], [right]) => left.localeCompare(right))
      );
      sections.push(`[TOOL_RESULT id=${id} name=${name2}]
${text}${Object.keys(extra).length ? `
metadata=${stableJson(extra)}` : ""}`);
      continue;
    }
    const name = message.name ? ` name=${message.name}` : "";
    if (text || !Array.isArray(message.tool_calls)) sections.push(`[${role.toUpperCase()}${name}]
${text}`);
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) sections.push(serializeToolCall(call));
    }
    const structured = Object.fromEntries(
      Object.entries(message).filter(([key]) => !["role", "name", "content", "tool_calls", "tool_call_id"].includes(key)).sort(([left], [right]) => left.localeCompare(right))
    );
    if (Object.keys(structured).length) sections.push(`[${role.toUpperCase()}_METADATA]
${stableJson(structured)}`);
  }
  if (tools.length > 0) sections.push(`[AVAILABLE_TOOLS]
${stableJson(tools)}`);
  return sections.join("\n\n").trim();
}
function estimateVisibleTokens(text) {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.codePointAt(0) <= 127) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}
function estimateJudgeContextTokens(rawNative) {
  return estimateVisibleTokens(
    `[ACU_STATE_METADATA]
${stableJson(rawNative.stateMetadata)}
[RAW_NATIVE_API_REQUEST]
${rawNative.rawRequest}`
  );
}
function buildJudgeSystemPrompt() {
  const examples = twin_few_shots_default.examples.map((example) => [
    `\u793A\u4F8B ${example.exampleId}`,
    "\u4E0A\u4E0B\u6587\uFF1A",
    example.context,
    `\u6700\u4F4E\u5145\u5206\u6863\u4F4D\u89E3\u91CA\uFF1A${example.minimumSufficientTier}\uFF1B${example.explanation}`,
    `\u671F\u671B\u8F93\u51FA\uFF1A${stableJson({
      ...example.expected,
      webIntent: "not_required",
      webIntentConfidence: 0.95,
      webIntentReason: "The visible task can be completed from provided or local context.",
      webIntentEvidence: ["provided_or_local_context"]
    })}`
  ].join("\n")).join("\n\n---\n\n");
  return [
    "\u4F60\u662F ACU \u4EFB\u52A1\u80FD\u529B\u9700\u6C42\u5206\u7C7B\u5668\u3002Difficulty \u8868\u793A\uFF1A\u5728\u6574\u4E2A Task\u3001\u5B8C\u6574\u53EF\u89C1\u5386\u53F2\u548C\u5F53\u524D\u5DE5\u4F5C\u9636\u6BB5\u4E0B\uFF0C\u5B8C\u6210\u5F53\u524D\u8FD9\u4E00\u6B21\u6A21\u578B\u54CD\u5E94\u6240\u9700\u7684\u6700\u4F4E\u5145\u5206\u80FD\u529B\u3002",
    "\u4E0D\u8981\u53EA\u5224\u65AD\u6700\u65B0\u4E00\u4E2A Tool Call\uFF0C\u4E5F\u4E0D\u8981\u91CD\u590D\u8BC4\u4F30\u6700\u521D\u7528\u6237\u76EE\u6807\uFF1B\u5E94\u5224\u65AD\u5F53\u524D\u5B8C\u6574\u5DE5\u4F5C Turn \u7684\u603B\u4F53\u80FD\u529B\u9700\u6C42\u3002",
    "\u4E0D\u5F97\u56DE\u7B54\u539F\u4EFB\u52A1\uFF0C\u4E0D\u5F97\u63A8\u8350\u5177\u4F53\u6A21\u578B\uFF0C\u4E0D\u5F97\u6839\u636E\u6A21\u578B\u54C1\u724C\u5224\u65AD\uFF0C\u4E0D\u5F97\u8F93\u51FA\u4EE3\u7801\u6216\u601D\u7EF4\u8FC7\u7A0B\u3002",
    '\u53EA\u8F93\u51FA\u4E25\u683C JSON\uFF1A{"difficulty_score_raw":0,"factors":{"reasoning_depth":0,"task_scope":0,"constraint_density":0,"tool_dependency":0,"verification_burden":0,"context_burden":0},"p_low":0,"p_mid":0,"p_mid_high":0,"p_high":0,"confidence":0,"signals":[],"explanation":"","webIntent":"likely","webIntentConfidence":0,"webIntentReason":"","webIntentEvidence":[]}',
    "difficulty_score_raw\u662F0\u5230100\u7684\u539F\u59CB\u603B\u4F53\u5224\u65AD\uFF1B\u516D\u4E2Afactors\u5747\u4E3A0\u523010\u3001\u5141\u8BB8\u4E00\u4F4D\u5C0F\u6570\u3002\u540E\u7AEF\u4F1A\u786E\u5B9A\u6027\u8BA1\u7B97\u6700\u7EC8\u96BE\u5EA6\u6307\u6570\uFF0C\u4E0D\u8981\u81EA\u884C\u8F93\u51FA\u6700\u7EC8\u6307\u6570\u3002",
    "reasoning_depth\u8861\u91CF\u63A8\u7406\u94FE\u957F\u5EA6\u548C\u62BD\u8C61\u7A0B\u5EA6\uFF1Btask_scope\u8861\u91CF\u6B65\u9AA4\u3001\u6587\u4EF6\u3001\u6A21\u5757\u3001\u5B9E\u4F53\u548C\u76EE\u6807\u8303\u56F4\uFF1Bconstraint_density\u8861\u91CF\u683C\u5F0F\u3001\u4E8B\u5B9E\u3001\u98CE\u683C\u3001\u4E1A\u52A1\u548C\u8D28\u91CF\u7EA6\u675F\u53CA\u5176\u76F8\u4E92\u5F71\u54CD\u3002",
    "tool_dependency\u8861\u91CF\u5DE5\u5177\u8C03\u7528\u3001\u4EE3\u7801\u6267\u884C\u3001\u68C0\u7D22\u3001\u591A\u8F6EAgent\u884C\u4E3A\u548C\u73AF\u5883\u72B6\u6001\u4F9D\u8D56\uFF1Bverification_burden\u8D8A\u96BE\u901A\u8FC7JSON\u3001\u6D4B\u8BD5\u6216\u660E\u786E\u7B54\u6848\u9A8C\u8BC1\u5219\u8D8A\u9AD8\uFF1Bcontext_burden\u8861\u91CF\u4E0A\u4E0B\u6587\u957F\u5EA6\u3001\u5206\u6563\u7A0B\u5EA6\u548C\u5386\u53F2\u4F9D\u8D56\u3002",
    "\u4E0D\u8981\u4E3A\u4E86\u7B80\u6D01\u9ED8\u8BA4\u4F7F\u75285\u7684\u500D\u6570\u3002\u8BF7\u5206\u522B\u5224\u65AD\u5404\u80FD\u529B\u9700\u6C42\u56E0\u5B50\uFF0C\u603B\u96BE\u5EA6\u7531\u540E\u7AEF\u8BA1\u7B97\uFF1B\u53EA\u6709\u771F\u5B9E\u5224\u65AD\u6070\u597D\u843D\u5728\u6574\u6570\u62165\u7684\u500D\u6570\u65F6\u624D\u53EF\u8F93\u51FA\u8BE5\u503C\u3002",
    "\u6982\u7387\u8868\u8FBE\u5206\u7C7B\u4E0D\u786E\u5B9A\u6027\uFF1B\u9664\u6781\u5176\u660E\u786E\u5916\u4E0D\u8981\u673A\u68B0\u8F93\u51FA\u5355\u6863100%\uFF0C\u76F8\u90BB\u6863\u5B58\u5728\u5408\u7406\u53EF\u80FD\u65F6\u5E94\u7ED9\u8F6F\u6982\u7387\u3002\u539F\u59CB\u603B\u5206\u4E0E\u4E3B\u8981\u6863\u4F4D\u5E94\u5927\u4F53\u4E00\u81F4\uFF0C\u4F46\u4E0D\u8981\u6C42\u7B49\u4E8E\u6982\u7387\u671F\u671B\u3002",
    "\u56DB\u6863\u6982\u7387\u5FC5\u987B\u57280\u52301\u4E14\u603B\u548C\u4E3A1\uFF1Bsignals\u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4\uFF1Bexplanation\u5FC5\u987B\u662F\u5B57\u7B26\u4E32\uFF0C\u957F\u5EA6\u7531\u6574\u4F53 Judge max output tokens \u63A7\u5236\u3002",
    "\u5728\u540C\u4E00\u6B21\u5224\u65AD\u4E2D\u8F93\u51FA Web Intent\u3002required \u8868\u793A\u5B8C\u6210\u5F53\u524D\u771F\u5B9E\u76EE\u6807\u5FC5\u987B\u53D6\u5F97\u5B9E\u65F6\u6216\u5916\u90E8 Web \u4FE1\u606F\uFF1Blikely \u8868\u793A\u53EF\u80FD\u6709\u5E2E\u52A9\u4F46\u4E0D\u80FD\u4F5C\u4E3A\u786C\u6761\u4EF6\uFF1Bnot_required \u8868\u793A\u5F53\u524D Segment \u53EF\u5B8C\u5168\u4F9D\u8D56\u672C\u5730\u5DE5\u4F5C\u533A\u3001\u5DF2\u7ED9\u4E0A\u4E0B\u6587\u548C\u666E\u901A\u5DE5\u5177\u5B8C\u6210\u3002",
    "Web \u5224\u65AD\u5FC5\u987B\u7EFC\u5408\u5F53\u524D\u771F\u5B9E\u7528\u6237\u76EE\u6807\u3001\u6700\u8FD1\u7528\u6237\u8F93\u5165\u3001Task/Goal\u3001Plan\u3001Routing Segment \u72B6\u6001\u548C\u786E\u5B9A\u6027 Web \u7EBF\u7D22\u3002\u5BA2\u6237\u7AEF\u58F0\u660E Web Tool \u53EA\u8868\u793A\u80FD\u529B\u53EF\u7528\uFF0C\u4E0D\u80FD\u76F4\u63A5\u5224\u4E3A required\u3002",
    "\u5355\u72EC\u51FA\u73B0 current\u3001latest\u3001today\u3001\u5F53\u524D\u3001\u6700\u65B0\u3001\u4ECA\u5929\u4E0D\u5F97\u5224\u4E3A required\u3002\u4EE3\u7801\u6807\u8BC6\u7B26\u3001\u53D8\u91CF\u540D\u3001\u6587\u4EF6\u540D\u3001\u672C\u5730\u65E5\u5FD7\u3001Git \u5206\u652F\u548C\u672C\u5730\u6D4B\u8BD5\u5185\u5BB9\u4E2D\u7684\u8FD9\u4E9B\u8BCD\u5E94\u5224\u4E3A not_required\u3002",
    "\u4F8B\u5982\uFF1A\u2018\u4FEE\u6539 currentUser \u51FD\u6570\u2019\u3001\u2018\u66F4\u65B0 latestVersion \u53D8\u91CF\u2019\u3001\u2018\u67E5\u770B\u4ECA\u5929\u751F\u6210\u7684\u672C\u5730\u65E5\u5FD7\u2019\u5747\u4E3A not_required\uFF1B\u2018\u67E5\u8BE2\u4ECA\u5929 BTC \u4EF7\u683C\u2019\u3001\u2018\u641C\u7D22\u6700\u65B0 Codex \u5B98\u65B9\u6587\u6863\u2019\u4E3A required\u3002",
    "webIntentConfidence \u5FC5\u987B\u57280\u52301\uFF1BwebIntentReason\u5FC5\u987B\u662F\u5B57\u7B26\u4E32\uFF1BwebIntentEvidence\u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4\uFF0C\u53EA\u5217\u53EF\u5BA1\u8BA1\u7684\u7B80\u77ED\u8BC1\u636E\u6807\u7B7E\u3002",
    "\u4EE5\u4E0B\u793A\u4F8B\u53EA\u5305\u542B\u5F53\u65F6\u53EF\u89C1\u4E0A\u4E0B\u6587\uFF0C\u4E0D\u542B\u672A\u6765\u6D88\u606F\uFF1A",
    examples
  ].join("\n\n");
}
function extractJson(text) {
  const raw = text.trim();
  const candidates = [raw];
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  if (fenced !== void 0) candidates.push(fenced.trim());
  let objectText;
  for (const candidate of candidates) {
    try {
      const direct = JSON.parse(candidate);
      if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
    } catch {
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let start = -1;
    for (let index = 0; index < candidate.length; index += 1) {
      const character = candidate[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") {
        if (depth === 0) start = index;
        depth += 1;
      } else if (character === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          objectText = candidate.slice(start, index + 1);
          break;
        }
      }
    }
    if (objectText) break;
  }
  if (!objectText) throw new SyntaxError("Judge response does not contain a complete JSON object");
  const parsed = JSON.parse(objectText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Judge response JSON must be an object");
  return parsed;
}
var FACTOR_KEYS = [
  ["reasoning_depth", "reasoningDepth"],
  ["task_scope", "taskScope"],
  ["constraint_density", "constraintDensity"],
  ["tool_dependency", "toolDependency"],
  ["verification_burden", "verificationBurden"],
  ["context_burden", "contextBurden"]
];
function oneDecimal(value, name, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > maximum) throw new Error(`Judge ${name} must be finite and in [0, ${maximum}]`);
  if (Math.abs(numeric * 10 - Math.round(numeric * 10)) > 1e-8) throw new Error(`Judge ${name} must have at most one decimal place`);
  return Math.round(numeric * 10) / 10;
}
function computeDifficultyIndex(difficultyScoreRaw, factors) {
  const factorComposite = 10 * (0.25 * factors.reasoningDepth + 0.15 * factors.taskScope + 0.15 * factors.constraintDensity + 0.2 * factors.toolDependency + 0.15 * factors.verificationBurden + 0.1 * factors.contextBurden);
  const difficultyIndex = Math.max(0, Math.min(100, 0.8 * factorComposite + 0.2 * difficultyScoreRaw));
  return {
    factorComposite: Math.round(factorComposite * 10) / 10,
    difficultyIndex: Math.round(difficultyIndex * 10) / 10
  };
}
function parseJudgeResult(text) {
  const parsed = extractJson(text);
  const difficultyScoreRaw = oneDecimal(parsed.difficulty_score_raw, "difficulty_score_raw", 100);
  if (!parsed.factors || typeof parsed.factors !== "object" || Array.isArray(parsed.factors)) throw new Error("Judge factors must be an object");
  const rawFactors = parsed.factors;
  const factors = Object.fromEntries(FACTOR_KEYS.map(([wire, local]) => [local, oneDecimal(rawFactors[wire], `factors.${wire}`, 10)]));
  const { factorComposite, difficultyIndex } = computeDifficultyIndex(difficultyScoreRaw, factors);
  const probabilities = normalizeProbabilities({
    pLow: Number(parsed.p_low),
    pMid: Number(parsed.p_mid),
    pMidHigh: Number(parsed.p_mid_high),
    pHigh: Number(parsed.p_high),
    confidence: Number(parsed.confidence)
  });
  if (!Array.isArray(parsed.signals) || parsed.signals.some((signal) => typeof signal !== "string")) {
    throw new Error("Judge signals must be an array of strings");
  }
  const rawExplanation = parsed.explanation;
  const originalExplanationType = !("explanation" in parsed) ? "missing" : rawExplanation === null ? "null" : Array.isArray(rawExplanation) ? "array" : typeof rawExplanation === "object" ? "object" : "string";
  const explanation = typeof rawExplanation === "string" ? rawExplanation : rawExplanation === null || rawExplanation === void 0 ? "" : stableJson(rawExplanation);
  const originalExplanationLength = typeof rawExplanation === "string" ? Array.from(rawExplanation).length : void 0;
  const explanationNormalized = originalExplanationType !== "string";
  if (!["required", "likely", "not_required"].includes(String(parsed.webIntent))) {
    throw new Error("Judge webIntent must be required, likely, or not_required");
  }
  const webIntentConfidence = Number(parsed.webIntentConfidence);
  if (!Number.isFinite(webIntentConfidence) || webIntentConfidence < 0 || webIntentConfidence > 1) {
    throw new Error("Judge webIntentConfidence must be finite and in [0, 1]");
  }
  if (typeof parsed.webIntentReason !== "string") throw new Error("Judge webIntentReason must be a string");
  if (!Array.isArray(parsed.webIntentEvidence) || parsed.webIntentEvidence.some((item) => typeof item !== "string")) {
    throw new Error("Judge webIntentEvidence must be an array of strings");
  }
  return {
    ...probabilities,
    difficultyScoreRaw,
    factors,
    factorComposite,
    difficultyIndex,
    difficultyMethodVersion: ACU_DIFFICULTY_METHOD_VERSION,
    difficultyScore: difficultyIndex,
    signals: parsed.signals,
    explanation,
    explanationNormalized,
    originalExplanationLength,
    originalExplanationType,
    webIntent: parsed.webIntent,
    webIntentConfidence,
    webIntentReason: parsed.webIntentReason,
    webIntentEvidence: parsed.webIntentEvidence
  };
}
function cachePath(config) {
  if (config.cachePath && config.promptVersion === "acu-tier-requirement-v4") {
    return config.cachePath.replace(/v[23](?=\.json$)/, "v4");
  }
  return config.cachePath || join5(homedir4(), ".claw-router", "acu-judge-cache-v4.json");
}
function readCache(path) {
  if (!existsSync(path)) return { schemaVersion: "acu-judge-cache-v4", entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed.schemaVersion !== "acu-judge-cache-v4" || !parsed.entries) throw new Error("wrong schema");
    return parsed;
  } catch {
    return { schemaVersion: "acu-judge-cache-v4", entries: {} };
  }
}
function writeCache(path, cache) {
  try {
    mkdirSync(dirname2(path), { recursive: true, mode: 448 });
    const entries = Object.entries(cache.entries).slice(-2e3);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ ...cache, entries: Object.fromEntries(entries) }, null, 2)}
`, { mode: 384 });
    renameSync(temporary, path);
  } catch {
  }
}
function endpointMetadata(baseUrl, provider) {
  const host = new URL(baseUrl).host;
  return { host, provider };
}
function responseHeaders(headers) {
  return Object.fromEntries([...headers.entries()].filter(([name]) => ![
    "authorization",
    "cookie",
    "proxy-authorization",
    "set-cookie",
    "x-api-key",
    "api-key"
  ].includes(name.toLowerCase())));
}
function upstreamContextError(status, body) {
  const pattern = /context[_ -]?(?:length|window)|maximum context|too many tokens|token limit/i;
  if (status === 400 || status === 413 || status === 422) return pattern.test(body);
  if (status !== 200) return false;
  try {
    const payload = JSON.parse(body);
    const error = payload.error ?? payload.response?.error;
    return error !== void 0 && pattern.test(typeof error === "string" ? error : JSON.stringify(error));
  } catch {
    return false;
  }
}
function errorResponseMetadata(body) {
  try {
    const value = JSON.parse(body);
    const promptTokens = Number(value.usage?.prompt_tokens);
    const completionTokens = Number(value.usage?.completion_tokens);
    return {
      id: typeof value.id === "string" ? value.id : typeof value.request_id === "string" ? value.request_id : void 0,
      promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
      cachedPromptTokens: Number.isFinite(Number(value.usage?.prompt_tokens_details?.cached_tokens)) ? Number(value.usage?.prompt_tokens_details?.cached_tokens) : 0,
      completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
      usageStatus: Number.isFinite(promptTokens) && Number.isFinite(completionTokens) ? "reported" : "usage_missing"
    };
  } catch {
    return { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, usageStatus: "usage_missing" };
  }
}
var AcuJudgeClient = class {
  constructor(config, fetchImplementation = fetch) {
    this.config = config;
    this.fetchImplementation = fetchImplementation;
    if (fetchImplementation !== fetch && process.env.NODE_ENV !== "test" && !config.allowMock) {
      throw new Error("Mock ACU Judge providers are forbidden outside tests unless ACU_ALLOW_MOCK=true");
    }
  }
  config;
  fetchImplementation;
  async judge(messages, tools = [], forceRefresh = false, rawNative, clientSignal, deadlineAt) {
    if (!this.config.apiKey) throw new Error("ACU Judge API key is not configured");
    if (this.config.promptVersion !== twin_few_shots_default.promptVersion) throw new Error("ACU Judge prompt version does not match frozen few-shot data");
    const rawRequestBytes = rawNative ? Buffer.byteLength(rawNative.rawRequest, "utf8") : 0;
    const rawRequestTokenEstimate = rawNative ? estimateVisibleTokens(rawNative.rawRequest) : 0;
    const visible = rawNative ? `[ACU_STATE_METADATA]
${stableJson(rawNative.stateMetadata)}
[RAW_NATIVE_API_REQUEST]
${rawNative.rawRequest}` : serializeVisibleContext(messages, tools);
    const contextSha256 = createHash4("sha256").update(visible).digest("hex");
    const judgeContextLimit = this.config.maxContextTokens;
    const contextTokenEstimate = rawNative ? estimateJudgeContextTokens(rawNative) : estimateVisibleTokens(visible);
    const truncated = { text: visible, tokenEstimate: contextTokenEstimate, truncated: false };
    const key = createHash4("sha256").update(`${this.config.promptVersion}
${this.config.judgeModel}
${this.config.judgeReasoningEffort}
${this.config.judgeProtocol}
${contextSha256}`).digest("hex");
    const path = cachePath(this.config);
    const cache = readCache(path);
    const cached = cache.entries[key];
    if (cached && !forceRefresh) {
      return {
        result: cached.result,
        status: "cache_hit",
        resultSource: "disk_cache",
        provider: cached.provider,
        model: cached.model,
        endpointHost: cached.endpointHost,
        upstreamRequestId: cached.upstreamRequestId,
        latencyMs: 0,
        cost: 0,
        promptTokens: cached.promptTokens,
        cachedPromptTokens: cached.cachedPromptTokens ?? 0,
        completionTokens: cached.completionTokens,
        usageStatus: cached.usageStatus,
        contextSha256,
        cacheKeySha256: key,
        cacheCreatedAt: cached.createdAt,
        contextTokenEstimate: truncated.tokenEstimate,
        contextTruncated: false,
        rawRequestBytes,
        rawRequestTokenEstimate,
        judgeContextLimit,
        judgeContextSource: rawNative ? "raw_native_request_v1" : "visible_context_legacy"
      };
    }
    const metadata = endpointMetadata(this.config.judgeBaseUrl, this.config.judgeProvider);
    const controller = new AbortController();
    const firstByteTimeout = this.config.firstByteTimeoutMs > 0 ? setTimeout(() => controller.abort(new Error("Judge first-byte timeout")), this.config.firstByteTimeoutMs) : void 0;
    const remainingTimeout = deadlineAt ? Math.max(1, deadlineAt - Date.now()) : this.config.timeoutMs;
    const totalTimeout = remainingTimeout > 0 ? setTimeout(() => controller.abort(new Error("Judge total timeout")), remainingTimeout) : void 0;
    const started = Date.now();
    try {
      let payload;
      let response;
      let rawResponseBody = "";
      let responseContentType = "";
      let providerEnvelopeValid = false;
      let assistantTextExtracted = false;
      try {
        const useResponses = this.config.judgeProtocol === "responses";
        const systemPrompt = buildJudgeSystemPrompt();
        const userPrompt = `\u5F53\u524DAPI\u4E0A\u4E0B\u6587\uFF1A
${truncated.text}`;
        response = await this.fetchImplementation(`${this.config.judgeBaseUrl.replace(/\/$/, "")}/${useResponses ? "responses" : "chat/completions"}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(useResponses ? {
            model: this.config.judgeModel,
            instructions: systemPrompt,
            input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
            ...this.config.judgeReasoningEffort === "default" ? {} : {
              reasoning: { effort: this.config.judgeReasoningEffort, summary: "auto" }
            },
            max_output_tokens: Math.min(300, this.config.maxOutputTokens),
            stream: false
          } : {
            model: this.config.judgeModel,
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
            temperature: 0,
            max_tokens: Math.min(300, this.config.maxOutputTokens),
            response_format: { type: "json_object" },
            thinking: { type: "disabled" },
            stream: false
          }),
          signal: clientSignal ? AbortSignal.any([controller.signal, clientSignal]) : controller.signal
        });
        if (firstByteTimeout) clearTimeout(firstByteTimeout);
        responseContentType = response.headers.get("content-type") ?? "";
        rawResponseBody = await response.text();
        const isContextError = upstreamContextError(response.status, rawResponseBody);
        if (!response.ok || isContextError) {
          const errorMetadata = errorResponseMetadata(rawResponseBody);
          throw new AcuJudgeAttemptError(`ACU Judge HTTP ${response.status}`, {
            provider: metadata.provider,
            model: this.config.judgeModel,
            endpointHost: metadata.host,
            upstreamRequestId: response.headers.get("x-request-id") ?? errorMetadata.id ?? null,
            latencyMs: Date.now() - started,
            promptTokens: errorMetadata.promptTokens,
            cachedPromptTokens: errorMetadata.cachedPromptTokens,
            completionTokens: errorMetadata.completionTokens,
            usageStatus: errorMetadata.usageStatus,
            errorCategory: isContextError ? "context_length_exceeded" : `http_${response.status}`,
            httpStatus: response.status,
            backupEligible: !isContextError && (response.status === 429 || response.status >= 500),
            backupReason: isContextError ? "backup_context_not_verified_larger_than_primary" : response.status === 429 ? "primary_rate_limited" : response.status >= 500 ? "primary_server_error" : "http_status_not_backup_eligible",
            responseHeaders: responseHeaders(response.headers),
            rawResponseBody,
            contextSha256,
            contextTokenEstimate,
            rawRequestBytes,
            rawRequestTokenEstimate,
            judgeContextLimit,
            failureLayer: "transport_failure",
            responseContentType,
            providerEnvelopeValid: false,
            assistantTextExtracted: false
          });
        }
        if (looksLikeHtml(rawResponseBody, responseContentType)) {
          throw new JudgeProviderProtocolError("ACU Judge returned HTML instead of a provider envelope");
        }
        try {
          payload = JSON.parse(rawResponseBody);
        } catch {
          throw new JudgeProviderProtocolError("ACU Judge returned an invalid JSON provider envelope");
        }
        if (!payload || typeof payload !== "object") throw new JudgeProviderProtocolError("ACU Judge returned an invalid provider envelope");
        if (payload?.model && payload.model !== this.config.judgeModel) {
          throw new JudgeProviderProtocolError(`ACU Judge actual model mismatch: ${payload.model}`);
        }
        const content = useResponses ? extractResponsesAssistantText(payload) : payload?.choices?.[0]?.message?.content;
        providerEnvelopeValid = useResponses ? Array.isArray(payload.output) : Array.isArray(payload.choices);
        if (!providerEnvelopeValid || !content) throw new JudgeProviderProtocolError("ACU Judge returned no valid Assistant output");
        assistantTextExtracted = true;
        let result;
        try {
          result = parseJudgeResult(content);
        } catch (error) {
          throw new JudgeSemanticParseError(error instanceof Error ? error.message : "Judge JSON is invalid", { cause: error });
        }
        const reportedInputTokens = payload.usage?.prompt_tokens ?? payload.usage?.input_tokens;
        const reportedOutputTokens = payload.usage?.completion_tokens ?? payload.usage?.output_tokens;
        const usageStatus = reportedInputTokens !== void 0 && reportedOutputTokens !== void 0 ? "reported" : "usage_missing";
        const promptTokens = reportedInputTokens ?? truncated.tokenEstimate;
        const cachedPromptTokens = payload.usage?.prompt_tokens_details?.cached_tokens ?? payload.usage?.input_tokens_details?.cached_tokens ?? 0;
        const completionTokens = reportedOutputTokens ?? this.config.maxOutputTokens;
        const cost = judgeNominalCostUsd(this.config.judgeModel, promptTokens, cachedPromptTokens, completionTokens);
        const upstreamRequestId = payload.id ?? response.headers.get("x-request-id");
        const createdAt = (/* @__PURE__ */ new Date()).toISOString();
        cache.entries[key] = {
          result,
          createdAt,
          promptVersion: this.config.promptVersion,
          model: this.config.judgeModel,
          provider: metadata.provider,
          endpointHost: metadata.host,
          upstreamRequestId,
          promptTokens,
          cachedPromptTokens,
          completionTokens,
          usageStatus
        };
        writeCache(path, cache);
        return {
          result,
          status: "live",
          resultSource: "upstream_live",
          provider: metadata.provider,
          model: this.config.judgeModel,
          endpointHost: metadata.host,
          upstreamRequestId,
          latencyMs: Date.now() - started,
          cost,
          promptTokens,
          cachedPromptTokens,
          completionTokens,
          usageStatus,
          contextSha256,
          cacheKeySha256: key,
          cacheCreatedAt: createdAt,
          contextTokenEstimate: truncated.tokenEstimate,
          contextTruncated: false,
          rawRequestBytes,
          rawRequestTokenEstimate,
          judgeContextLimit,
          judgeContextSource: rawNative ? "raw_native_request_v1" : "visible_context_legacy"
        };
      } catch (error) {
        if (error instanceof AcuJudgeAttemptError) throw error;
        if (clientSignal?.aborted) throw new AcuJudgeClientCancelledError();
        const promptTokens = payload?.usage?.prompt_tokens ?? payload?.usage?.input_tokens ?? 0;
        const cachedPromptTokens = payload?.usage?.prompt_tokens_details?.cached_tokens ?? payload?.usage?.input_tokens_details?.cached_tokens ?? 0;
        const completionTokens = payload?.usage?.completion_tokens ?? payload?.usage?.output_tokens ?? 0;
        const message = error instanceof Error ? error.message : "ACU Judge transport failure";
        const networkFailure = error instanceof TypeError || error instanceof DOMException || controller.signal.aborted;
        const semanticFailure = error instanceof JudgeSemanticParseError;
        const protocolFailure = error instanceof JudgeProviderProtocolError;
        const failureLayer = semanticFailure ? "judge_semantic_parse_failure" : protocolFailure ? "provider_protocol_failure" : "transport_failure";
        const errorCategory = semanticFailure ? "judge_semantic_parse_failure" : protocolFailure ? "provider_protocol_failure" : controller.signal.aborted ? "timeout" : networkFailure ? "network_error" : "provider_transport_error";
        throw new AcuJudgeAttemptError(message, {
          provider: metadata.provider,
          model: this.config.judgeModel,
          endpointHost: metadata.host,
          upstreamRequestId: payload?.id ?? response?.headers.get("x-request-id") ?? null,
          latencyMs: Date.now() - started,
          promptTokens,
          cachedPromptTokens,
          completionTokens,
          usageStatus: (payload?.usage?.prompt_tokens ?? payload?.usage?.input_tokens) !== void 0 && (payload?.usage?.completion_tokens ?? payload?.usage?.output_tokens) !== void 0 ? "reported" : "usage_missing",
          errorCategory,
          backupEligible: networkFailure || protocolFailure || semanticFailure,
          backupReason: controller.signal.aborted ? "primary_timeout" : networkFailure ? "primary_network_error" : protocolFailure ? "primary_provider_protocol_invalid" : semanticFailure ? "primary_judge_semantic_invalid" : "not_backup_eligible",
          responseHeaders: response ? responseHeaders(response.headers) : {},
          rawResponseBody,
          parserExceptionType: semanticFailure && error.cause instanceof Error ? error.cause.name : error instanceof Error ? error.name : typeof error,
          parserExceptionMessage: message,
          contextSha256,
          contextTokenEstimate,
          rawRequestBytes,
          rawRequestTokenEstimate,
          judgeContextLimit,
          failureLayer,
          responseContentType,
          providerEnvelopeValid,
          assistantTextExtracted
        });
      }
    } finally {
      if (firstByteTimeout) clearTimeout(firstByteTimeout);
      if (totalTimeout) clearTimeout(totalTimeout);
    }
  }
};

// src/acu/strategy.ts
function acuTierForRuleTier(tier) {
  return { SIMPLE: "low", MEDIUM: "mid", COMPLEX: "mid_high", REASONING: "high" }[tier];
}
function rulesFallbackJudge(decision) {
  const selected = acuTierForRuleTier(decision.tier);
  const confidence = Math.max(0.55, Math.min(0.97, decision.confidence));
  const remainder = (1 - confidence) / 3;
  const probabilities = normalizeProbabilities({
    pLow: selected === "low" ? confidence : remainder,
    pMid: selected === "mid" ? confidence : remainder,
    pMidHigh: selected === "mid_high" ? confidence : remainder,
    pHigh: selected === "high" ? confidence : remainder,
    confidence: decision.confidence
  });
  const difficultyScoreRaw = { low: 15, mid: 42, mid_high: 67, high: 90 }[selected];
  const factorValue = Math.round(difficultyScoreRaw) / 10;
  const factors = {
    reasoningDepth: factorValue,
    taskScope: factorValue,
    constraintDensity: factorValue,
    toolDependency: factorValue,
    verificationBurden: factorValue,
    contextBurden: factorValue
  };
  return {
    ...probabilities,
    difficultyScoreRaw,
    factors,
    factorComposite: difficultyScoreRaw,
    difficultyIndex: difficultyScoreRaw,
    difficultyMethodVersion: ACU_DIFFICULTY_METHOD_VERSION,
    difficultyScore: difficultyScoreRaw,
    signals: ["rules_strategy_fallback", decision.tier.toLowerCase()],
    explanation: "Difficulty Judge\u4E0D\u53EF\u7528\uFF0C\u5DF2\u4F7F\u7528\u73B0\u6709RulesStrategy\u5B89\u5168\u56DE\u9000\u3002"
  };
}
var AcuDemoStrategy = class {
  constructor(config, judgeClient = new AcuJudgeClient(config)) {
    this.config = config;
    this.judgeClient = judgeClient;
  }
  config;
  judgeClient;
  name = "acu-demo";
  get enabled() {
    return this.config.enabled;
  }
  get shadowMode() {
    return this.config.shadowMode;
  }
  get allowForceRefresh() {
    return this.config.allowForceRefresh;
  }
  get databasePath() {
    return this.config.databasePath;
  }
  async evaluate(input, rulesDecision) {
    const visible = serializeVisibleContext(input.messages, input.tools);
    let judge;
    let judgeStatus;
    let judgeLatencyMs = 0;
    let judgeCost = 0;
    let judgePromptTokens = 0;
    let judgeCompletionTokens = 0;
    let judgeResultSource = "rules_strategy";
    let judgeProvider = "rules_strategy";
    let judgeEndpointHost = "none";
    let upstreamRequestId = null;
    let cacheKeySha256;
    let cacheCreatedAt = (/* @__PURE__ */ new Date()).toISOString();
    let usageStatus = "not_applicable";
    let judgeErrorCategory;
    let contextSha256 = createHash5("sha256").update(visible).digest("hex");
    let contextTokenEstimate = estimateVisibleTokens(visible);
    let contextTruncated = false;
    try {
      if (!this.config.enabled) throw new Error("ACU Demo Router feature flag is disabled");
      const response = await this.judgeClient.judge(input.messages, input.tools, input.forceJudgeRefresh === true);
      judge = response.result;
      judgeStatus = response.status;
      judgeResultSource = response.resultSource;
      judgeProvider = response.provider;
      judgeEndpointHost = response.endpointHost;
      upstreamRequestId = response.upstreamRequestId;
      cacheKeySha256 = response.cacheKeySha256;
      cacheCreatedAt = response.cacheCreatedAt;
      usageStatus = response.usageStatus;
      judgeLatencyMs = response.latencyMs;
      judgeCost = response.cost;
      judgePromptTokens = response.promptTokens;
      judgeCompletionTokens = response.completionTokens;
      contextSha256 = response.contextSha256;
      contextTokenEstimate = response.contextTokenEstimate;
      contextTruncated = response.contextTruncated;
    } catch (error) {
      judge = rulesFallbackJudge(rulesDecision);
      judgeStatus = "rules_fallback";
      judgeErrorCategory = error instanceof Error ? error.message.slice(0, 160) : "unknown_live_error";
      cacheKeySha256 = createHash5("sha256").update(`${this.config.promptVersion}
${this.config.judgeModel}
${this.config.judgeReasoningEffort}
${this.config.judgeProtocol}
${contextSha256}`).digest("hex");
    }
    const entropy = normalizedEntropy(judge);
    const recommendation = recommendModel({
      probabilities: judge,
      difficultyScore: judge.difficultyIndex,
      inputTokens: contextTokenEstimate,
      expectedOutputTokens: input.expectedOutputTokens ?? 800,
      judgeCost,
      qualityTarget: input.qualityTarget,
      eligibleModelIds: input.eligibleModelIds,
      requireToolCallSupport: input.requireToolCallSupport,
      requireVisionSupport: input.requireVisionSupport,
      judgeEntropyPenalty: this.config.judgeEntropyPenalty
    });
    return {
      estimateLabel: "public-benchmark constrained estimate",
      promptVersion: this.config.promptVersion,
      judgeModel: this.config.judgeModel,
      judgeReasoningEffort: this.config.judgeReasoningEffort,
      judgeMode: "non-thinking",
      judge,
      judgeStatus,
      judgeResultSource,
      judgeProvider,
      judgeEndpointHost,
      upstreamRequestId,
      cacheKeySha256,
      cacheCreatedAt,
      usageStatus,
      ...judgeErrorCategory && { judgeErrorCategory },
      judgeLatencyMs,
      judgeCost,
      judgePromptTokens,
      judgeCompletionTokens,
      contextSha256,
      contextTokenEstimate,
      contextTruncated,
      difficultyScoreRaw: judge.difficultyScoreRaw,
      difficultyFactors: judge.factors,
      factorComposite: judge.factorComposite,
      difficultyIndex: judge.difficultyIndex,
      difficultyMethodVersion: judge.difficultyMethodVersion,
      difficultyScore: judge.difficultyIndex,
      judgeEntropy: entropy,
      routingModelVersion: ACU_ROUTING_MODEL_VERSION,
      shadowMode: this.config.shadowMode,
      requestId: input.requestId || randomUUID(),
      qualityTarget: input.qualityTarget ?? 0.8,
      recommendation,
      disclaimer: ACU_DEMO_DISCLAIMER
    };
  }
};

// src/acu/storage.ts
import { createHash as createHash6 } from "crypto";
import { chmodSync, mkdirSync as mkdirSync2 } from "fs";
import { createRequire as createRequire2 } from "module";
import { dirname as dirname3 } from "path";
var require3 = createRequire2(import.meta.url);
function bool(value) {
  return value === void 0 ? null : value ? 1 : 0;
}
function quantile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = (ordered.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower);
}
function hashSession(value) {
  return value ? createHash6("sha256").update(value).digest("hex") : void 0;
}
var AcuRoutingStore = class {
  constructor(path) {
    this.path = path;
    mkdirSync2(dirname3(path), { recursive: true, mode: 448 });
    chmodSync(dirname3(path), 448);
    const sqlite = require3("node:sqlite");
    this.database = new sqlite.DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS routing_requests (
        request_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        session_hash TEXT,
        context_sha256 TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        routing_model_version TEXT NOT NULL,
        judge_status TEXT NOT NULL CHECK(judge_status IN ('live','cache_hit','rules_fallback','live_error')),
        judge_model TEXT NOT NULL,
        judge_provider TEXT NOT NULL,
        difficulty_score REAL NOT NULL CHECK(difficulty_score BETWEEN 0 AND 100),
        difficulty_score_raw REAL,
        difficulty_index REAL,
        reasoning_depth REAL,
        task_scope REAL,
        constraint_density REAL,
        tool_dependency REAL,
        verification_burden REAL,
        context_burden REAL,
        difficulty_method_version TEXT,
        p_low REAL NOT NULL, p_mid REAL NOT NULL, p_mid_high REAL NOT NULL, p_high REAL NOT NULL,
        judge_confidence REAL NOT NULL,
        judge_latency_ms INTEGER NOT NULL,
        judge_tokens INTEGER,
        judge_cost REAL NOT NULL,
        requested_model TEXT,
        recommended_model TEXT,
        actual_model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        actual_cost REAL,
        latency_ms INTEGER,
        final_status TEXT,
        had_tools INTEGER NOT NULL DEFAULT 0,
        error_category TEXT
      );
      CREATE TABLE IF NOT EXISTS model_candidate_scores (
        request_id TEXT NOT NULL REFERENCES routing_requests(request_id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        predicted_score REAL NOT NULL,
        conservative_score REAL NOT NULL,
        expected_call_cost REAL NOT NULL,
        expected_total_cost REAL NOT NULL,
        value_utility REAL NOT NULL,
        pareto_efficient INTEGER NOT NULL,
        selected INTEGER NOT NULL,
        PRIMARY KEY(request_id, model_id)
      );
      CREATE TABLE IF NOT EXISTS user_feedback (
        feedback_id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL REFERENCES routing_requests(request_id) ON DELETE CASCADE,
        accepted INTEGER,
        rating INTEGER CHECK(rating BETWEEN 1 AND 5),
        required_upgrade INTEGER,
        final_model TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS execution_outcomes (
        outcome_id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL REFERENCES routing_requests(request_id) ON DELETE CASCADE,
        validator_result TEXT,
        test_result TEXT,
        tool_error_count INTEGER,
        retry_count INTEGER,
        model_switched INTEGER,
        user_retried INTEGER,
        outcome_score REAL,
        outcome_source TEXT NOT NULL CHECK(outcome_source IN ('explicit_user_feedback','validator','test_result','retry_signal','model_upgrade_signal')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS routing_attempts (
        request_id TEXT NOT NULL REFERENCES routing_requests(request_id) ON DELETE CASCADE,
        attempt_index INTEGER NOT NULL,
        model_id TEXT NOT NULL,
        upstream TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('success','error','timeout','skipped')),
        error_category TEXT,
        latency_ms INTEGER NOT NULL,
        billed_cost REAL,
        usage_source TEXT,
        attempt_type TEXT,
        execution_profile_id TEXT,
        thinking_mode TEXT,
        request_parameter_applied INTEGER,
        upstream_model TEXT,
        reasoning_tokens INTEGER,
        created_at TEXT NOT NULL,
        PRIMARY KEY(request_id, attempt_index)
      );
      CREATE TABLE IF NOT EXISTS execution_profile_health (
        execution_profile_id TEXT PRIMARY KEY,
        sample_count INTEGER NOT NULL,
        recent_success_rate REAL,
        consecutive_failures INTEGER NOT NULL,
        consecutive_timeouts INTEGER NOT NULL,
        p50_latency_ms REAL,
        p95_latency_ms REAL,
        timeout_rate REAL,
        rate_limit_rate REAL,
        server_error_rate REAL,
        last_success_at TEXT,
        cooldown_until TEXT,
        availability TEXT NOT NULL,
        priority_penalty REAL NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_routing_created ON routing_requests(created_at);
      CREATE INDEX IF NOT EXISTS idx_routing_hash ON routing_requests(context_sha256);
      CREATE INDEX IF NOT EXISTS idx_feedback_request ON user_feedback(request_id);
      CREATE INDEX IF NOT EXISTS idx_outcomes_request ON execution_outcomes(request_id);
      CREATE INDEX IF NOT EXISTS idx_attempts_request ON routing_attempts(request_id);
    `);
    this.ensureColumn("routing_requests", "visible_output_tokens", "INTEGER");
    this.ensureColumn("routing_requests", "completion_tokens", "INTEGER");
    this.ensureColumn("routing_requests", "reasoning_tokens", "INTEGER");
    this.ensureColumn("routing_requests", "cached_input_tokens", "INTEGER");
    this.ensureColumn("routing_requests", "usage_source", "TEXT");
    this.ensureColumn("routing_requests", "usage_raw_keys", "TEXT");
    this.ensureColumn("routing_requests", "input_price_per_million", "REAL");
    this.ensureColumn("routing_requests", "output_price_per_million", "REAL");
    this.ensureColumn("routing_requests", "model_call_cost", "REAL");
    this.ensureColumn("routing_requests", "total_acu_cost", "REAL");
    this.ensureColumn("routing_attempts", "billed_cost", "REAL");
    this.ensureColumn("routing_attempts", "usage_source", "TEXT");
    this.ensureColumn("routing_requests", "execution_profile_id", "TEXT");
    this.ensureColumn("routing_requests", "thinking_mode", "TEXT");
    this.ensureColumn("routing_requests", "request_parameter_applied", "INTEGER");
    this.ensureColumn("routing_requests", "upstream_model", "TEXT");
    this.ensureColumn("routing_requests", "difficulty_score_raw", "REAL");
    this.ensureColumn("routing_requests", "difficulty_index", "REAL");
    this.ensureColumn("routing_requests", "reasoning_depth", "REAL");
    this.ensureColumn("routing_requests", "task_scope", "REAL");
    this.ensureColumn("routing_requests", "constraint_density", "REAL");
    this.ensureColumn("routing_requests", "tool_dependency", "REAL");
    this.ensureColumn("routing_requests", "verification_burden", "REAL");
    this.ensureColumn("routing_requests", "context_burden", "REAL");
    this.ensureColumn("routing_requests", "difficulty_method_version", "TEXT");
    this.ensureColumn("routing_attempts", "attempt_type", "TEXT");
    this.ensureColumn("routing_attempts", "execution_profile_id", "TEXT");
    this.ensureColumn("routing_attempts", "thinking_mode", "TEXT");
    this.ensureColumn("routing_attempts", "request_parameter_applied", "INTEGER");
    this.ensureColumn("routing_attempts", "upstream_model", "TEXT");
    this.ensureColumn("routing_attempts", "reasoning_tokens", "INTEGER");
    this.ensureColumn("execution_outcomes", "execution_profile_id", "TEXT");
    chmodSync(path, 384);
  }
  path;
  database;
  ensureColumn(table, column, definition) {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((entry) => entry.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  recordEvaluation(evaluation, metadata = {}) {
    const judgeTokens = evaluation.usageStatus === "not_applicable" ? null : evaluation.judgePromptTokens + evaluation.judgeCompletionTokens;
    this.database.prepare(`
      INSERT INTO routing_requests (
        request_id,created_at,session_hash,context_sha256,prompt_version,routing_model_version,
        judge_status,judge_model,judge_provider,difficulty_score,difficulty_score_raw,difficulty_index,
        reasoning_depth,task_scope,constraint_density,tool_dependency,verification_burden,context_burden,difficulty_method_version,
        p_low,p_mid,p_mid_high,p_high,
        judge_confidence,judge_latency_ms,judge_tokens,judge_cost,requested_model,recommended_model,
        actual_model,input_tokens,output_tokens,actual_cost,latency_ms,final_status,had_tools,error_category
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(request_id) DO UPDATE SET
        actual_model=COALESCE(excluded.actual_model,routing_requests.actual_model),
        input_tokens=COALESCE(excluded.input_tokens,routing_requests.input_tokens),
        output_tokens=COALESCE(excluded.output_tokens,routing_requests.output_tokens),
        actual_cost=COALESCE(excluded.actual_cost,routing_requests.actual_cost),
        latency_ms=COALESCE(excluded.latency_ms,routing_requests.latency_ms),
        final_status=COALESCE(excluded.final_status,routing_requests.final_status),
        error_category=COALESCE(excluded.error_category,routing_requests.error_category)
    `).run(
      evaluation.requestId,
      (/* @__PURE__ */ new Date()).toISOString(),
      metadata.sessionHash ?? null,
      evaluation.contextSha256,
      evaluation.promptVersion,
      evaluation.routingModelVersion,
      evaluation.judgeStatus,
      evaluation.judgeModel,
      evaluation.judgeProvider,
      evaluation.difficultyIndex,
      evaluation.difficultyScoreRaw,
      evaluation.difficultyIndex,
      evaluation.difficultyFactors.reasoningDepth,
      evaluation.difficultyFactors.taskScope,
      evaluation.difficultyFactors.constraintDensity,
      evaluation.difficultyFactors.toolDependency,
      evaluation.difficultyFactors.verificationBurden,
      evaluation.difficultyFactors.contextBurden,
      evaluation.difficultyMethodVersion,
      evaluation.judge.pLow,
      evaluation.judge.pMid,
      evaluation.judge.pMidHigh,
      evaluation.judge.pHigh,
      evaluation.judge.confidence,
      evaluation.judgeLatencyMs,
      judgeTokens,
      evaluation.judgeCost,
      metadata.requestedModel ?? null,
      evaluation.recommendation.recommended.modelId,
      metadata.actualModel ?? null,
      metadata.inputTokens ?? null,
      metadata.outputTokens ?? null,
      metadata.actualCost ?? null,
      metadata.latencyMs ?? null,
      metadata.finalStatus ?? null,
      bool(metadata.hadTools) ?? 0,
      metadata.errorCategory ?? evaluation.judgeErrorCategory ?? null
    );
    const statement = this.database.prepare(`
      INSERT INTO model_candidate_scores (
        request_id,model_id,predicted_score,conservative_score,expected_call_cost,expected_total_cost,
        value_utility,pareto_efficient,selected
      ) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(request_id,model_id) DO UPDATE SET
        predicted_score=excluded.predicted_score,conservative_score=excluded.conservative_score,
        expected_call_cost=excluded.expected_call_cost,expected_total_cost=excluded.expected_total_cost,
        value_utility=excluded.value_utility,pareto_efficient=excluded.pareto_efficient,selected=excluded.selected
    `);
    for (const candidate of evaluation.recommendation.estimates) {
      statement.run(
        evaluation.requestId,
        candidate.modelId,
        candidate.predictedScore,
        candidate.conservativeScore,
        candidate.estimatedCallCost,
        candidate.expectedTotalCost,
        candidate.valueUtility,
        bool(candidate.paretoEfficient) ?? 0,
        candidate.modelId === evaluation.recommendation.recommended.modelId ? 1 : 0
      );
    }
    if (metadata.sessionHash) {
      const recent = this.database.prepare(`SELECT COUNT(*) AS n FROM routing_requests
        WHERE session_hash=? AND request_id<>? AND unixepoch(created_at)>=unixepoch('now')-600`).get(metadata.sessionHash, evaluation.requestId);
      if (Number(recent?.n ?? 0) > 0) {
        this.recordOutcome({ requestId: evaluation.requestId, retryCount: 1, userRetried: true, outcomeSource: "retry_signal" });
      }
    }
  }
  finalizeRequest(requestId, metadata) {
    this.database.prepare(`UPDATE routing_requests SET
      actual_model=COALESCE(?,actual_model), input_tokens=COALESCE(?,input_tokens),
      output_tokens=COALESCE(?,output_tokens), actual_cost=COALESCE(?,actual_cost),
      latency_ms=COALESCE(?,latency_ms), final_status=COALESCE(?,final_status),
      error_category=COALESCE(?,error_category),
      visible_output_tokens=COALESCE(?,visible_output_tokens),
      completion_tokens=COALESCE(?,completion_tokens), reasoning_tokens=COALESCE(?,reasoning_tokens),
      cached_input_tokens=COALESCE(?,cached_input_tokens), usage_source=COALESCE(?,usage_source),
      usage_raw_keys=COALESCE(?,usage_raw_keys), input_price_per_million=COALESCE(?,input_price_per_million),
      output_price_per_million=COALESCE(?,output_price_per_million),
      model_call_cost=COALESCE(?,model_call_cost), total_acu_cost=COALESCE(?,total_acu_cost),
      execution_profile_id=COALESCE(?,execution_profile_id), thinking_mode=COALESCE(?,thinking_mode),
      request_parameter_applied=COALESCE(?,request_parameter_applied), upstream_model=COALESCE(?,upstream_model)
      WHERE request_id=?`).run(
      metadata.actualModel ?? null,
      metadata.inputTokens ?? null,
      metadata.outputTokens ?? null,
      metadata.actualCost ?? null,
      metadata.latencyMs ?? null,
      metadata.finalStatus ?? null,
      metadata.errorCategory ?? null,
      metadata.visibleOutputTokens ?? null,
      metadata.completionTokens ?? null,
      metadata.reasoningTokens ?? null,
      metadata.cachedInputTokens ?? null,
      metadata.usageSource ?? null,
      metadata.usageRawKeys ? JSON.stringify(metadata.usageRawKeys) : null,
      metadata.inputPricePerMillion ?? null,
      metadata.outputPricePerMillion ?? null,
      metadata.modelCallCost ?? null,
      metadata.totalAcuCost ?? null,
      metadata.executionProfileId ?? null,
      metadata.thinkingMode ?? null,
      bool(metadata.requestParameterApplied),
      metadata.upstreamModel ?? null,
      requestId
    );
  }
  recordAttempts(requestId, attempts) {
    const statement = this.database.prepare(`INSERT INTO routing_attempts
      (request_id,attempt_index,model_id,upstream,status,error_category,latency_ms,billed_cost,usage_source,
       attempt_type,execution_profile_id,thinking_mode,request_parameter_applied,upstream_model,reasoning_tokens,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(request_id,attempt_index) DO UPDATE SET
        model_id=excluded.model_id,upstream=excluded.upstream,status=excluded.status,
        error_category=excluded.error_category,latency_ms=excluded.latency_ms,
        billed_cost=excluded.billed_cost,usage_source=excluded.usage_source,
        attempt_type=excluded.attempt_type,execution_profile_id=excluded.execution_profile_id,
        thinking_mode=excluded.thinking_mode,request_parameter_applied=excluded.request_parameter_applied,
        upstream_model=excluded.upstream_model,reasoning_tokens=excluded.reasoning_tokens`);
    attempts.forEach((attempt, index) => statement.run(
      requestId,
      index + 1,
      attempt.model,
      attempt.upstream,
      attempt.status,
      attempt.error_category ?? null,
      attempt.latency_ms,
      attempt.billed_cost ?? null,
      attempt.usage_source ?? null,
      attempt.attempt_type ?? "initial",
      attempt.execution_profile_id,
      attempt.thinking_mode,
      bool(attempt.request_parameter_applied),
      attempt.upstream_model ?? null,
      attempt.reasoning_tokens ?? null,
      (/* @__PURE__ */ new Date()).toISOString()
    ));
    for (const profileId of new Set(attempts.map((attempt) => attempt.execution_profile_id))) {
      this.refreshExecutionProfileHealth(profileId);
    }
  }
  recordFeedback(input) {
    if (input.rating !== void 0 && (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5)) {
      throw new Error("rating must be an integer from 1 to 5");
    }
    this.database.prepare(`INSERT INTO user_feedback
      (request_id,accepted,rating,required_upgrade,final_model,created_at) VALUES (?,?,?,?,?,?)`).run(
      input.requestId,
      bool(input.accepted),
      input.rating ?? null,
      bool(input.requiredUpgrade),
      input.finalModel ?? null,
      (/* @__PURE__ */ new Date()).toISOString()
    );
    this.recordOutcome({
      requestId: input.requestId,
      outcomeSource: "explicit_user_feedback",
      outcomeScore: input.rating === void 0 ? void 0 : input.rating / 5,
      modelSwitched: input.requiredUpgrade
    });
  }
  recordOutcome(input) {
    const storedProfile = this.database.prepare("SELECT execution_profile_id FROM routing_requests WHERE request_id=?").get(input.requestId)?.execution_profile_id;
    const executionProfileId = input.executionProfileId ?? (typeof storedProfile === "string" ? storedProfile : void 0);
    this.database.prepare(`INSERT INTO execution_outcomes
      (request_id,validator_result,test_result,tool_error_count,retry_count,model_switched,user_retried,
       outcome_score,outcome_source,execution_profile_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.requestId,
      input.validatorResult ?? null,
      input.testResult ?? null,
      input.toolErrorCount ?? null,
      input.retryCount ?? null,
      bool(input.modelSwitched),
      bool(input.userRetried),
      input.outcomeScore ?? null,
      input.outcomeSource,
      executionProfileId ?? null,
      (/* @__PURE__ */ new Date()).toISOString()
    );
  }
  refreshExecutionProfileHealth(executionProfileId) {
    const rows = this.database.prepare(`SELECT status,error_category,latency_ms,created_at
      FROM routing_attempts WHERE execution_profile_id=?
      ORDER BY datetime(created_at) DESC,attempt_index DESC LIMIT 20`).all(executionProfileId);
    if (rows.length === 0) return;
    const statuses = rows.map((row) => String(row.status));
    const categories = rows.map((row) => String(row.error_category ?? ""));
    const latencies = rows.map((row) => Number(row.latency_ms)).filter(Number.isFinite);
    const recentFive = statuses.slice(0, 5);
    let consecutiveFailures = 0;
    let consecutiveTimeouts = 0;
    for (const row of rows) {
      if (row.status === "success") break;
      consecutiveFailures += 1;
    }
    for (const row of rows) {
      if (row.status !== "timeout") break;
      consecutiveTimeouts += 1;
    }
    const latestCreated = String(rows[0].created_at);
    const cooldownCandidate = consecutiveTimeouts >= 2 ? new Date(new Date(latestCreated).getTime() + 6e4).toISOString() : null;
    const cooldownUntil = cooldownCandidate && Date.parse(cooldownCandidate) > Date.now() ? cooldownCandidate : null;
    const successRate = statuses.filter((status) => status === "success").length / statuses.length;
    const recentFiveRate = recentFive.filter((status) => status === "success").length / recentFive.length;
    const availability = cooldownUntil ? "cooldown" : recentFive.length >= 5 && recentFiveRate < 0.6 ? "degraded" : "healthy";
    const lastSuccess = rows.find((row) => row.status === "success")?.created_at;
    const ratio = (predicate) => rows.filter((_row, index) => predicate(index)).length / rows.length;
    this.database.prepare(`INSERT INTO execution_profile_health (
      execution_profile_id,sample_count,recent_success_rate,consecutive_failures,consecutive_timeouts,
      p50_latency_ms,p95_latency_ms,timeout_rate,rate_limit_rate,server_error_rate,last_success_at,
      cooldown_until,availability,priority_penalty,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(execution_profile_id) DO UPDATE SET
      sample_count=excluded.sample_count,recent_success_rate=excluded.recent_success_rate,
      consecutive_failures=excluded.consecutive_failures,consecutive_timeouts=excluded.consecutive_timeouts,
      p50_latency_ms=excluded.p50_latency_ms,p95_latency_ms=excluded.p95_latency_ms,
      timeout_rate=excluded.timeout_rate,rate_limit_rate=excluded.rate_limit_rate,
      server_error_rate=excluded.server_error_rate,last_success_at=excluded.last_success_at,
      cooldown_until=excluded.cooldown_until,availability=excluded.availability,
      priority_penalty=excluded.priority_penalty,updated_at=excluded.updated_at`).run(
      executionProfileId,
      rows.length,
      successRate,
      consecutiveFailures,
      consecutiveTimeouts,
      quantile(latencies, 0.5),
      quantile(latencies, 0.95),
      ratio((index) => statuses[index] === "timeout"),
      ratio((index) => categories[index] === "rate_limited"),
      ratio((index) => categories[index] === "server_error"),
      typeof lastSuccess === "string" ? lastSuccess : null,
      cooldownUntil,
      availability,
      availability === "cooldown" ? 1 : availability === "degraded" ? 0.25 : 0,
      (/* @__PURE__ */ new Date()).toISOString()
    );
  }
  getExecutionProfileHealth(executionProfileId) {
    this.refreshExecutionProfileHealth(executionProfileId);
    const row = this.database.prepare("SELECT * FROM execution_profile_health WHERE execution_profile_id=?").get(executionProfileId);
    if (!row) return {
      executionProfileId,
      sampleCount: 0,
      recentSuccessRate: null,
      consecutiveFailures: 0,
      consecutiveTimeouts: 0,
      p50LatencyMs: null,
      p95LatencyMs: null,
      timeoutRate: null,
      rateLimitRate: null,
      serverErrorRate: null,
      lastSuccessAt: null,
      cooldownUntil: null,
      availability: "unknown",
      priorityPenalty: 0
    };
    return {
      executionProfileId,
      sampleCount: Number(row.sample_count),
      recentSuccessRate: row.recent_success_rate === null ? null : Number(row.recent_success_rate),
      consecutiveFailures: Number(row.consecutive_failures),
      consecutiveTimeouts: Number(row.consecutive_timeouts),
      p50LatencyMs: row.p50_latency_ms === null ? null : Number(row.p50_latency_ms),
      p95LatencyMs: row.p95_latency_ms === null ? null : Number(row.p95_latency_ms),
      timeoutRate: row.timeout_rate === null ? null : Number(row.timeout_rate),
      rateLimitRate: row.rate_limit_rate === null ? null : Number(row.rate_limit_rate),
      serverErrorRate: row.server_error_rate === null ? null : Number(row.server_error_rate),
      lastSuccessAt: typeof row.last_success_at === "string" ? row.last_success_at : null,
      cooldownUntil: typeof row.cooldown_until === "string" ? row.cooldown_until : null,
      availability: String(row.availability),
      priorityPenalty: Number(row.priority_penalty)
    };
  }
  executionProfileSummaries(requests, feedback, outcomes) {
    const profileIds = [...new Set(requests.map((row) => row.execution_profile_id).filter((value) => typeof value === "string" && value.length > 0))].sort();
    return profileIds.map((executionProfileId) => {
      const profileRequests = requests.filter((row) => row.execution_profile_id === executionProfileId);
      const ids = new Set(profileRequests.map((row) => String(row.request_id)));
      const profileFeedback = feedback.filter((row) => ids.has(String(row.request_id)));
      const profileOutcomes = outcomes.filter((row) => ids.has(String(row.request_id)));
      const ratings = profileFeedback.map((row) => Number(row.rating)).filter(Number.isFinite);
      const validator = profileOutcomes.filter((row) => row.outcome_source === "validator" && row.validator_result);
      const values = (field) => profileRequests.map((row) => Number(row[field])).filter(Number.isFinite);
      const average = (items) => items.length ? items.reduce((sum, item) => sum + item, 0) / items.length : null;
      const difficulty = { low: 0, mid: 0, mid_high: 0, high: 0 };
      profileRequests.forEach((row) => {
        const value = Number(row.difficulty_score);
        difficulty[value < 30 ? "low" : value < 55 ? "mid" : value < 80 ? "mid_high" : "high"] += 1;
      });
      const upgrades = profileFeedback.filter((row) => row.required_upgrade !== null).map((row) => Number(row.required_upgrade));
      return {
        executionProfileId,
        requestCount: profileRequests.length,
        difficultyDistribution: difficulty,
        averageUserRating: average(ratings),
        validatorPassRate: validator.length ? validator.filter((row) => row.validator_result === "pass").length / validator.length : null,
        averageCost: average(values("total_acu_cost")),
        averageReasoningTokens: average(values("reasoning_tokens")),
        latencyMs: { p50: quantile(values("latency_ms"), 0.5), p95: quantile(values("latency_ms"), 0.95) },
        upgradeRate: upgrades.length ? upgrades.filter((value) => value === 1).length / upgrades.length : null,
        independentCurveEligible: profileRequests.length >= 30,
        curveNotice: profileRequests.length < 30 ? "\u6837\u672C\u5C11\u4E8E30\u6761\uFF0C\u4E0D\u5F97\u62DF\u5408\u72EC\u7ACB\u66F2\u7EBF\u3002" : null,
        health: this.getExecutionProfileHealth(executionProfileId)
      };
    });
  }
  summary() {
    const requests = this.database.prepare("SELECT * FROM routing_requests").all();
    const feedback = this.database.prepare("SELECT * FROM user_feedback").all();
    const outcomes = this.database.prepare("SELECT * FROM execution_outcomes").all();
    const count = requests.length;
    const latencies = requests.filter((row) => row.judge_status === "live").map((row) => Number(row.judge_latency_ms)).filter(Number.isFinite);
    const group = (field) => Object.fromEntries(
      [...new Set(requests.map((row) => String(row[field] ?? "unknown")))].sort().map((key) => [key, requests.filter((row) => String(row[field] ?? "unknown") === key).length])
    );
    const difficultyDistribution = { low: 0, mid: 0, mid_high: 0, high: 0 };
    for (const row of requests) {
      const score = Number(row.difficulty_score);
      difficultyDistribution[score < 30 ? "low" : score < 55 ? "mid" : score < 80 ? "mid_high" : "high"] += 1;
    }
    const labeled = new Set([...feedback, ...outcomes].map((row) => String(row.request_id))).size;
    const ratings = feedback.map((row) => Number(row.rating)).filter(Number.isFinite);
    const accepted = feedback.filter((row) => row.accepted !== null);
    const upgrades = feedback.filter((row) => row.required_upgrade !== null);
    const requestsWithActualModel = requests.filter((row) => typeof row.actual_model === "string" && row.actual_model.length > 0);
    const bucketCounts = this.database.prepare(`SELECT c.model_id,
      CASE WHEN r.difficulty_score<30 THEN 'low' WHEN r.difficulty_score<55 THEN 'mid' WHEN r.difficulty_score<80 THEN 'mid_high' ELSE 'high' END AS difficulty_bucket,
      COUNT(DISTINCT r.request_id) AS n
      FROM model_candidate_scores c JOIN routing_requests r USING(request_id)
      WHERE EXISTS(SELECT 1 FROM user_feedback f WHERE f.request_id=r.request_id)
         OR EXISTS(SELECT 1 FROM execution_outcomes o WHERE o.request_id=r.request_id)
      GROUP BY c.model_id,difficulty_bucket ORDER BY c.model_id,difficulty_bucket`).all();
    return {
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      realRequestCount: count,
      realJudgeRequestCount: requests.filter((row) => row.judge_status === "live").length,
      cacheHitRate: count ? requests.filter((row) => row.judge_status === "cache_hit").length / count : 0,
      rulesFallbackRate: count ? requests.filter((row) => row.judge_status === "rules_fallback").length / count : 0,
      judgeLatencyMs: { mean: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null, p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95) },
      difficultyDistribution,
      recommendedModelDistribution: group("recommended_model"),
      actualModelDistribution: group("actual_model"),
      recommendationActualAgreementRate: requestsWithActualModel.length ? requestsWithActualModel.filter((row) => row.recommended_model && row.recommended_model === row.actual_model).length / requestsWithActualModel.length : null,
      userSatisfactionRate: accepted.length ? accepted.filter((row) => Number(row.accepted) === 1).length / accepted.length : null,
      averageRating: ratings.length ? ratings.reduce((sum, value) => sum + value, 0) / ratings.length : null,
      upgradeRate: upgrades.length ? upgrades.filter((row) => Number(row.required_upgrade) === 1).length / upgrades.length : null,
      labeledRequestCount: labeled,
      effectiveLabeledOutcomeCount: labeled,
      modelDifficultyLabelCounts: bucketCounts,
      executionProfileSummaries: this.executionProfileSummaries(requests, feedback, outcomes),
      sampleNotice: count < 20 ? "\u5F53\u524D\u6837\u672C\u91CF\u8F83\u5C0F\uFF0C\u4EC5\u7528\u4E8E\u4EA7\u54C1\u9A8C\u8BC1\u3002" : null
    };
  }
  close() {
    this.database.close();
  }
};
function openAcuRoutingStore(path) {
  try {
    return new AcuRoutingStore(path);
  } catch (error) {
    console.error(`[ClawRouter] ACU SQLite disabled: ${error instanceof Error ? error.message : "unknown error"}`);
    return null;
  }
}

// src/acu/execution-profile.ts
function executionProfileFor(modelId, enableThinking) {
  if (modelId === "qwen3.6-plus") {
    const disabled = enableThinking === false;
    return {
      executionProfileId: `${modelId}:${disabled ? "non-thinking" : "thinking"}`,
      thinkingMode: disabled ? "disabled" : "enabled",
      requestParameterApplied: typeof enableThinking === "boolean"
    };
  }
  return {
    executionProfileId: `${modelId}:default`,
    thinkingMode: "default",
    requestParameterApplied: false
  };
}

// src/proxy.ts
var DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
var DEFAULT_PROXY_BASE_URL = "https://api.openai-proxy.org/v1";
var HEARTBEAT_INTERVAL_MS = 2e3;
var DEFAULT_REQUEST_TIMEOUT_MS = 3e5;
var PER_MODEL_TIMEOUT_MS = 6e4;
var REASONING_MODEL_TIMEOUT_MS = 18e4;
var MAX_FALLBACK_ATTEMPTS = 5;
var RATE_LIMIT_COOLDOWN_MS = 6e4;
var OVERLOAD_COOLDOWN_MS = 15e3;
var MAX_MESSAGES = 200;
var ACU_PREFIX_PATTERN = /^\/acu-router(?:-dev)?(?=\/|\?|$)/;
var DEFAULT_BASELINE_MODEL = "claude-opus-4-7";
var ACU_DEMO_BENCHMARK_MODEL_ID = "claude-opus-4-8";
var ACU_DEMO_BENCHMARK_PRICING = {
  modelId: ACU_DEMO_BENCHMARK_MODEL_ID,
  inputPricePerMillion: 10,
  outputPricePerMillion: 50,
  label: "\u65D7\u8230\u6A21\u578B\u4EF7\u683C"
};
var ROUTING_PROFILES = /* @__PURE__ */ new Set(["auto", "eco", "premium"]);
var rateLimitedModels = /* @__PURE__ */ new Map();
var overloadedModels = /* @__PURE__ */ new Map();
function isRateLimited(modelId) {
  const hitTime = rateLimitedModels.get(modelId);
  if (!hitTime) return false;
  if (Date.now() - hitTime >= RATE_LIMIT_COOLDOWN_MS) {
    rateLimitedModels.delete(modelId);
    return false;
  }
  return true;
}
function markRateLimited(modelId) {
  rateLimitedModels.set(modelId, Date.now());
  console.log(`[ClawRouter] Model ${modelId} rate-limited, deprioritize for 60s`);
}
function markOverloaded(modelId) {
  overloadedModels.set(modelId, Date.now());
  console.log(`[ClawRouter] Model ${modelId} overloaded, deprioritize for 15s`);
}
function isOverloaded(modelId) {
  const hitTime = overloadedModels.get(modelId);
  if (!hitTime) return false;
  if (Date.now() - hitTime >= OVERLOAD_COOLDOWN_MS) {
    overloadedModels.delete(modelId);
    return false;
  }
  return true;
}
function prioritizeNonRateLimited(models) {
  const available = [];
  const degraded = [];
  for (const m of models) {
    (isRateLimited(m) || isOverloaded(m) ? degraded : available).push(m);
  }
  return [...available, ...degraded];
}
function timeoutForModel(modelId) {
  return isReasoningModel(modelId) ? REASONING_MODEL_TIMEOUT_MS : PER_MODEL_TIMEOUT_MS;
}
function timeoutForAttempt(modelId, attemptIndex, acuSelected, maxTokens) {
  const configured = Number(process.env.ACU_FIRST_ATTEMPT_TIMEOUT_MS);
  const isDevConfigured = Number.isFinite(configured) && configured > 0;
  if (isDevConfigured && acuSelected && attemptIndex === 0 && !isReasoningModel(modelId) && maxTokens <= 1200) {
    return Math.min(timeoutForModel(modelId), configured);
  }
  return timeoutForModel(modelId);
}
function canWrite(res) {
  return !res.writableEnded && !res.destroyed && res.socket !== null && !res.socket.destroyed && res.socket.writable;
}
function safeWrite(res, data) {
  if (!canWrite(res)) return false;
  return res.write(data);
}
function categorizeError(status, body) {
  if (status === 401) return "auth_failure";
  if (status === 403) return "server_error";
  if (status === 429) return "rate_limited";
  if (status === 529) return "overloaded";
  if (status === 503 && /overload|capacity/i.test(body)) return "overloaded";
  if (status >= 500) return "server_error";
  if (status === 400 || status === 413) return "config_error";
  return null;
}
function attemptProfileFields(modelId, requestBody, attemptType) {
  let enableThinking;
  try {
    enableThinking = JSON.parse(requestBody.toString()).enable_thinking;
  } catch {
  }
  const profile = executionProfileFor(modelId, enableThinking);
  return {
    attempt_type: attemptType,
    execution_profile_id: profile.executionProfileId,
    thinking_mode: profile.thinkingMode,
    request_parameter_applied: profile.requestParameterApplied,
    upstream_model: modelId
  };
}
var ACU_PLAN_TTL_MS = 5 * 6e4;
var ACU_PLAN_MAX_ENTRIES = 100;
function stripAcuPrefix(url) {
  if (!url) return "/";
  const match = url.match(ACU_PREFIX_PATTERN);
  if (!match) return url;
  const stripped = url.slice(match[0].length);
  if (!stripped) return "/";
  if (stripped.startsWith("?")) return `/${stripped}`;
  return stripped;
}
function getPathname(url) {
  return new URL(url, "http://localhost").pathname;
}
function getHeaderString(value) {
  return Array.isArray(value) ? value[0] : value;
}
function normalizeRequestHeaders(req) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers[key] = value;
    else if (Array.isArray(value)) headers[key] = value.join(",");
  }
  return headers;
}
function isProtectedDemoPath(pathname) {
  return pathname === "/" || pathname === "/index.html" || pathname === "/acu" || pathname === "/acu/" || pathname.startsWith("/acu/") || pathname.startsWith("/public/") || pathname === "/cache" || pathname === "/stats" || pathname === "/ledger" || pathname === "/ledger/summary" || pathname.includes("/chat/completions");
}
function getEnvDemoAccessToken() {
  return process.env.DEMO_ACCESS_TOKEN?.trim() || process.env.ACU_DEMO_KEY?.trim() || process.env.PROXY_API_KEY?.trim() || "";
}
function decodeBasicAuthPassword(auth) {
  const encoded = auth.match(/^Basic\s+(.+)$/i)?.[1]?.trim();
  if (!encoded) return void 0;
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return decoded.trim();
    return decoded.slice(separator + 1).trim();
  } catch {
    return void 0;
  }
}
function isDemoAuthorized(req, demoAccessToken) {
  if (!demoAccessToken) return true;
  const auth = getHeaderString(req.headers.authorization) || "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const basicPassword = decodeBasicAuthPassword(auth);
  const demoKey = getHeaderString(req.headers["x-acu-demo-key"])?.trim();
  const url = new URL(req.url || "/", "http://localhost");
  const queryKey = url.searchParams.get("demo_key")?.trim();
  return basicPassword === demoAccessToken || bearer === demoAccessToken || demoKey === demoAccessToken || queryKey === demoAccessToken;
}
function hashPrompt(messages) {
  const text = messages.map((message) => JSON.stringify(message.content ?? "")).join("\n");
  return createHash7("sha256").update(text).digest("hex").slice(0, 24);
}
async function readJsonRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed;
}
function messageContentAsText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join(" ");
}
function routingTierFromAcu(evaluation) {
  const values = [
    [evaluation.judge.pLow, "SIMPLE"],
    [evaluation.judge.pMid, "MEDIUM"],
    [evaluation.judge.pMidHigh, "COMPLEX"],
    [evaluation.judge.pHigh, "REASONING"]
  ];
  return values.reduce((best, current) => current[0] > best[0] ? current : best)[1];
}
function detectTaskType(messages) {
  const text = messages.map((message) => {
    if (typeof message.content === "string") return message.content;
    return JSON.stringify(message.content ?? "");
  }).join("\n").toLowerCase();
  if (/\bjson\b|schema|extract|字段|结构化|提取/.test(text)) return "structured_extraction";
  if (/fix|bug|error|stack trace|代码|报错|修复/.test(text)) return "code_fix";
  if (/summary|summarize|abstract|摘要|总结/.test(text)) return "summary";
  if (/reason|compare|prove|design|推理|比较|证明|设计/.test(text)) return "reasoning";
  if (/email|邮件|投资人|investor/.test(text)) return "writing";
  return "general";
}
function extractPromptText(messages) {
  const lastUserMsg = [...messages].reverse().find((message) => message.role === "user");
  const rawPrompt = lastUserMsg?.content;
  const prompt = typeof rawPrompt === "string" ? rawPrompt : Array.isArray(rawPrompt) ? rawPrompt.filter((block) => block.type === "text").map((block) => block.text ?? "").join(" ") : "";
  const systemMsg = messages.find((message) => message.role === "system");
  const systemPrompt = typeof systemMsg?.content === "string" ? systemMsg.content : void 0;
  return { prompt, systemPrompt };
}
function buildRuleTraceSignals(messages, maxTokens, config) {
  const { prompt, systemPrompt } = extractPromptText(messages);
  if (!prompt) return { score: void 0, signals: [] };
  const ruleResult = classifyByRules(
    prompt,
    systemPrompt,
    Math.ceil((prompt.length + (systemPrompt?.length ?? 0)) / 4) + maxTokens,
    config.scoring
  );
  return { score: ruleResult.score, signals: ruleResult.signals };
}
function extractAssistantText(responseBody) {
  try {
    const parsed = JSON.parse(responseBody);
    const content = parsed.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  } catch {
    return "";
  }
}
function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : void 0;
}
function extractExplicitUpstreamCost(responseBody) {
  try {
    const parsed = JSON.parse(responseBody);
    const usage = parsed.usage && typeof parsed.usage === "object" ? parsed.usage : void 0;
    return finiteNonNegative(usage?.cost) ?? finiteNonNegative(usage?.total_cost) ?? finiteNonNegative(parsed.cost) ?? finiteNonNegative(parsed.provider_cost);
  } catch {
    return void 0;
  }
}
function parseUsage(responseBody, estimatedInputTokens, maxOutputTokens, pricing) {
  const inputPrice = pricing?.inputPrice ?? 0;
  const outputPrice = pricing?.outputPrice ?? 0;
  try {
    const parsed = JSON.parse(responseBody);
    const usage = parsed.usage && typeof parsed.usage === "object" ? parsed.usage : void 0;
    const details = usage?.completion_tokens_details && typeof usage.completion_tokens_details === "object" ? usage.completion_tokens_details : void 0;
    const promptDetails = usage?.prompt_tokens_details && typeof usage.prompt_tokens_details === "object" ? usage.prompt_tokens_details : void 0;
    const inputTokens = finiteNonNegative(usage?.prompt_tokens) ?? finiteNonNegative(usage?.input_tokens) ?? estimatedInputTokens;
    const upstreamCompletion = finiteNonNegative(usage?.completion_tokens) ?? finiteNonNegative(usage?.output_tokens);
    const reasoningTokens = finiteNonNegative(details?.reasoning_tokens) ?? finiteNonNegative(usage?.reasoning_tokens) ?? 0;
    const cachedInputTokens = finiteNonNegative(promptDetails?.cached_tokens) ?? finiteNonNegative(usage?.cached_input_tokens) ?? 0;
    const assistantText = extractAssistantText(responseBody);
    const visibleOutputTokens = assistantText.length > 0 ? Math.max(1, Math.ceil(assistantText.length / 4)) : 0;
    const explicitCost = finiteNonNegative(usage?.cost) ?? finiteNonNegative(usage?.total_cost) ?? finiteNonNegative(parsed.cost) ?? finiteNonNegative(parsed.provider_cost);
    const hasUsage = Boolean(usage && (upstreamCompletion !== void 0 || finiteNonNegative(usage.prompt_tokens) !== void 0 || finiteNonNegative(usage.input_tokens) !== void 0));
    const completionTokens = upstreamCompletion ?? (visibleOutputTokens > 0 ? visibleOutputTokens : maxOutputTokens);
    const usageSource = explicitCost !== void 0 ? "upstream_cost" : hasUsage ? "upstream_usage" : visibleOutputTokens > 0 ? "response_text_estimate" : "max_token_estimate";
    const calculatedCost = (inputTokens * inputPrice + completionTokens * outputPrice) / 1e6;
    return {
      inputTokens,
      visibleOutputTokens,
      completionTokens,
      reasoningTokens,
      cachedInputTokens,
      usageSource,
      usageRawKeys: usage ? [
        ...Object.keys(usage),
        ...Object.keys(details ?? {}).map((key) => `completion_tokens_details.${key}`),
        ...Object.keys(promptDetails ?? {}).map((key) => `prompt_tokens_details.${key}`)
      ].sort() : [],
      inputPricePerMillion: inputPrice,
      outputPricePerMillion: outputPrice,
      modelCallCost: explicitCost ?? calculatedCost
    };
  } catch {
    return {
      inputTokens: estimatedInputTokens,
      visibleOutputTokens: 0,
      completionTokens: maxOutputTokens,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      usageSource: "max_token_estimate",
      usageRawKeys: [],
      inputPricePerMillion: inputPrice,
      outputPricePerMillion: outputPrice,
      modelCallCost: (estimatedInputTokens * inputPrice + maxOutputTokens * outputPrice) / 1e6
    };
  }
}
function getFallbackUsed(attempts, actualModelUsed, selectedModel) {
  return attempts.some((attempt) => attempt.attempt_type === "fallback" || attempt.attempt_type === "quality_upgrade") || Boolean(selectedModel && selectedModel !== actualModelUsed);
}
function setAcuExecutionResult(evaluation, recommendationSelected, actualModel) {
  evaluation.actualModel = actualModel;
  evaluation.recommendationApplied = recommendationSelected && actualModel === evaluation.recommendation.recommended.modelId;
}
function buildStreamingTrace(args) {
  const fallbackUsed = getFallbackUsed(args.attempts, args.actualModelUsed, args.routingDecision?.model);
  const finalAttempt = [...args.attempts].reverse().find((attempt) => attempt.model === args.actualModelUsed && attempt.status === "success");
  return {
    ...buildRuleTraceSignals(args.parsedMessages, args.maxTokens, args.config),
    request_id: args.requestId,
    profile: args.routingProfile ?? "explicit",
    tier: args.routingDecision?.tier ?? "EXPLICIT",
    confidence: args.routingDecision?.confidence ?? 1,
    method: args.routingDecision?.method ?? "explicit",
    ...args.routingDecision?.agenticScore !== void 0 && { agentic_score: args.routingDecision.agenticScore },
    selected_model: args.routingDecision?.model ?? args.modelId,
    actual_model_used: args.actualModelUsed,
    upstream: args.upstream,
    fallback_chain: args.modelsToTry,
    attempts: args.attempts,
    attempt_count: args.attempts.length,
    fallback_used: fallbackUsed,
    quality_fallback_used: false,
    execution_profile_id: finalAttempt?.execution_profile_id,
    thinking_mode: finalAttempt?.thinking_mode,
    request_parameter_applied: finalAttempt?.request_parameter_applied,
    upstream_model: finalAttempt?.upstream_model ?? args.actualModelUsed,
    streaming: true,
    estimated_input_tokens: args.estimatedInputTokens,
    estimated_output_tokens: args.estimatedOutputTokens,
    estimated_cost: args.costs.costEstimate,
    baseline_model: DEFAULT_BASELINE_MODEL,
    baseline_cost: args.costs.baselineCost,
    estimated_savings: args.costs.savings,
    route_reasoning: args.routingDecision?.reasoning ?? "Explicit model request",
    validator_result: "not_applicable",
    validator: "none"
  };
}
function injectTraceIntoJsonResponse(responseBody, trace) {
  try {
    const parsed = JSON.parse(responseBody);
    parsed.acu_trace = trace;
    return JSON.stringify(parsed);
  } catch {
    return responseBody;
  }
}
var QUALITY_FALLBACK_CONSERVATIVE_TOLERANCE_POINTS = 1;
function executionHealthForModel(store2, modelId) {
  if (!store2) return void 0;
  const profile = executionProfileFor(modelId, modelId === "qwen3.6-plus" ? false : void 0);
  return store2.getExecutionProfileHealth(profile.executionProfileId);
}
function applyPassiveHealthAvailability(modelIds, store2) {
  if (!store2) return modelIds;
  const assessed = modelIds.map((modelId) => ({ modelId, health: executionHealthForModel(store2, modelId) }));
  const healthy = assessed.filter(({ health }) => health?.availability === "healthy" || health?.availability === "unknown");
  if (healthy.length > 0) return healthy.map(({ modelId }) => modelId);
  const degraded = assessed.filter(({ health }) => health?.availability === "degraded");
  if (degraded.length > 0) return degraded.map(({ modelId }) => modelId);
  return modelIds;
}
function executionProfileForDifficulty(modelId, difficultyScore2) {
  return executionProfileFor(modelId, modelId === "qwen3.6-plus" && difficultyScore2 < 55 ? false : void 0);
}
function compatibleAcuModelIds(args) {
  return BLOCKRUN_MODELS.filter((model) => {
    const catalogModel = getAcuModel(model.id);
    if (!catalogModel?.routingEligible || args.excludeList.has(model.id)) return false;
    if (args.hasTools && !supportsToolCalling(model.id)) return false;
    if (args.hasVision && !supportsVision(model.id)) return false;
    const contextWindow = getModelContextWindow(model.id);
    if (contextWindow === void 0 || contextWindow < args.requiredContextTokens) return false;
    const health = executionHealthForModel(args.store, model.id);
    return args.includeCooldown || health?.availability !== "cooldown";
  }).map((model) => model.id);
}
function healthRank(status) {
  return { healthy: 0, unknown: 1, degraded: 2, cooldown: 3 }[status];
}
function evidenceRank(confidence) {
  return { high: 0, medium: 1, low: 2 }[confidence];
}
function decoratePlanCandidate(estimate, difficultyScore2, store2) {
  const model = getAcuModel(estimate.modelId);
  const health = executionHealthForModel(store2, estimate.modelId);
  const profile = executionProfileForDifficulty(estimate.modelId, difficultyScore2);
  return {
    ...estimate,
    routingEligible: true,
    healthStatus: health?.availability ?? "unknown",
    healthPriorityPenalty: health?.priorityPenalty ?? 0,
    p50LatencyMs: health?.p50LatencyMs ?? null,
    evidenceConfidence: model.evidenceConfidence,
    ...profile
  };
}
function qualityCeilingCandidate(candidates) {
  if (candidates.length === 0) throw new Error("No compatible ACU quality-ceiling candidate");
  return [...candidates].sort((left, right) => {
    const displayedScoreDifference = Number(right.predictedScore.toFixed(1)) - Number(left.predictedScore.toFixed(1));
    return displayedScoreDifference || right.conservativeScore - left.conservativeScore || healthRank(left.healthStatus) - healthRank(right.healthStatus) || (left.p50LatencyMs ?? Number.POSITIVE_INFINITY) - (right.p50LatencyMs ?? Number.POSITIVE_INFINITY) || evidenceRank(left.evidenceConfidence) - evidenceRank(right.evidenceConfidence) || left.modelId.localeCompare(right.modelId);
  })[0];
}
function benchmarkBaselineCandidate(candidates) {
  const benchmark = candidates.find((candidate) => candidate.candidateId === ACU_DEMO_BENCHMARK_MODEL_ID);
  if (!benchmark) {
    throw new Error(`Fixed ACU benchmark ${ACU_DEMO_BENCHMARK_MODEL_ID} is unavailable for this request`);
  }
  return benchmark;
}
function demoCandidateWithinBenchmark(modelId) {
  const model = getAcuModel(modelId);
  return Boolean(model && model.inputPricePerMillion !== null && model.outputPricePerMillion !== null && model.inputPricePerMillion !== void 0 && model.outputPricePerMillion !== void 0 && model.inputPricePerMillion <= ACU_DEMO_BENCHMARK_PRICING.inputPricePerMillion && model.outputPricePerMillion <= ACU_DEMO_BENCHMARK_PRICING.outputPricePerMillion);
}
function demoEligibleModelIds(modelIds) {
  return modelIds.filter(demoCandidateWithinBenchmark);
}
function buildPlanRecord(args) {
  const displayRecommendation = recommendModel({
    probabilities: args.evaluation.judge,
    difficultyScore: args.evaluation.difficultyScore,
    inputTokens: args.evaluation.contextTokenEstimate,
    expectedOutputTokens: args.expectedOutputTokens,
    judgeCost: args.evaluation.judgeCost,
    qualityTarget: args.evaluation.qualityTarget,
    eligibleModelIds: demoEligibleModelIds(args.allCompatibleModelIds)
  });
  const routedDisplayCandidates = displayRecommendation.estimates.map((estimate) => decoratePlanCandidate(estimate, args.evaluation.difficultyScore, args.store));
  const benchmarkCandidate = benchmarkBaselineCandidate(routedDisplayCandidates);
  const benchmarkCallCost = (args.evaluation.contextTokenEstimate * ACU_DEMO_BENCHMARK_PRICING.inputPricePerMillion + args.expectedOutputTokens * ACU_DEMO_BENCHMARK_PRICING.outputPricePerMillion) / 1e6;
  const benchmarkSelectionCost = benchmarkCallCost + benchmarkCandidate.expectedFallbackCost;
  const benchmarkBaselineModel = {
    ...benchmarkCandidate,
    estimatedCallCost: benchmarkCallCost,
    selectionCost: benchmarkSelectionCost,
    expectedEndToEndCost: args.evaluation.judgeCost + benchmarkSelectionCost,
    expectedTotalCost: args.evaluation.judgeCost + benchmarkSelectionCost,
    riskAdjustedCost: benchmarkSelectionCost
  };
  const displayCandidates = routedDisplayCandidates.map((candidate) => candidate.modelId === benchmarkBaselineModel.modelId ? benchmarkBaselineModel : candidate).filter((candidate) => demoCandidateWithinBenchmark(candidate.modelId));
  const demoEvaluation = {
    ...args.evaluation,
    recommendation: displayRecommendation
  };
  const qualityLeaderModel = qualityCeilingCandidate(displayCandidates);
  const now = Date.now();
  return {
    evaluation: demoEvaluation,
    createdAt: now,
    expiresAt: now + ACU_PLAN_TTL_MS,
    contextSha256: args.evaluation.contextSha256,
    qualityTarget: args.evaluation.qualityTarget,
    expectedOutputTokens: args.expectedOutputTokens,
    benchmarkBaselineModel,
    benchmarkPricing: ACU_DEMO_BENCHMARK_PRICING,
    qualityLeaderModel,
    qualityCeilingModel: qualityLeaderModel,
    displayCandidates
  };
}
function pruneAcuPlans(plans) {
  const now = Date.now();
  for (const [planId, plan] of plans) if (plan.expiresAt <= now) plans.delete(planId);
  while (plans.size >= ACU_PLAN_MAX_ENTRIES) plans.delete(plans.keys().next().value);
}
function selectQualityFallbackModel(args) {
  if (!args.evaluation) return void 0;
  const current = args.evaluation.recommendation.estimates.find((estimate) => estimate.modelId === args.currentModel);
  if (!current) return void 0;
  const compatible = args.evaluation.recommendation.estimates.filter((estimate) => {
    const model = getAcuModel(estimate.modelId);
    return Boolean(model?.routingEligible) && !args.modelsTried.includes(estimate.modelId) && (!args.hasTools || model?.toolCallSupport) && (!args.hasVision || model?.visionSupport) && (model?.contextWindow === null || (model?.contextWindow ?? 0) >= args.requiredContextTokens) && estimate.predictedScore >= current.predictedScore && estimate.conservativeScore >= current.conservativeScore - QUALITY_FALLBACK_CONSERVATIVE_TOLERANCE_POINTS;
  }).map((estimate) => ({ estimate, health: executionHealthForModel(args.store, estimate.modelId) }));
  if (compatible.length === 0) return void 0;
  const available = compatible.filter(({ health }) => health?.availability !== "cooldown");
  const pool = available.length > 0 ? available : compatible;
  return pool.sort((left, right) => right.estimate.predictedScore - left.estimate.predictedScore || (left.health?.priorityPenalty ?? 0) - (right.health?.priorityPenalty ?? 0) || left.estimate.estimatedCallCost - right.estimate.estimatedCallCost || (left.health?.p50LatencyMs ?? Number.POSITIVE_INFINITY) - (right.health?.p50LatencyMs ?? Number.POSITIVE_INFINITY))[0]?.estimate.modelId;
}
function buildFormatRepairBody(body, validator, maxTokens) {
  const parsed = JSON.parse(body.toString());
  const messages = Array.isArray(parsed.messages) ? [...parsed.messages] : [];
  messages.push({
    role: "user",
    content: `\u4E0A\u4E00\u6761\u54CD\u5E94\u672A\u901A\u8FC7${validator.validator === "schema_validator" ? "Schema" : "JSON"}\u683C\u5F0F\u6821\u9A8C\uFF08${validator.reason ?? "\u683C\u5F0F\u65E0\u6548"}\uFF09\u3002\u53EA\u4FEE\u590D\u683C\u5F0F\uFF0C\u4E0D\u91CD\u65B0\u6269\u5199\u5185\u5BB9\uFF1B\u53EA\u8FD4\u56DE\u76EE\u6807\u683C\u5F0F\uFF0C\u4E0D\u8981\u9644\u52A0\u8BF4\u660E\u3002`
  });
  parsed.messages = messages;
  parsed.stream = false;
  parsed.enable_thinking = false;
  parsed.max_tokens = Math.min(384, Math.max(64, maxTokens));
  delete parsed.max_completion_tokens;
  return Buffer.from(JSON.stringify(parsed));
}
function upstreamModelFromBody(responseBody, fallback) {
  try {
    const model = JSON.parse(responseBody).model;
    return typeof model === "string" && model ? model : fallback;
  } catch {
    return fallback;
  }
}
async function fetchUpstreamChatCompletion(args) {
  const upstreamProvider = getUpstream(args.model);
  const isOpenRouter = upstreamProvider === "openrouter";
  const baseUrl = isOpenRouter ? process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE_URL : args.proxyBaseUrl || process.env.PROXY_BASE_URL?.trim() || DEFAULT_PROXY_BASE_URL;
  const fetchApiKey = isOpenRouter ? args.apiKey : args.proxyApiKey || args.apiKey;
  const upstreamUrl = `${baseUrl}/chat/completions`;
  const reqParsed = JSON.parse(args.body.toString());
  reqParsed.model = args.model;
  if (usesMaxCompletionTokens(args.model) && reqParsed.max_tokens) {
    reqParsed.max_completion_tokens = reqParsed.max_tokens;
    delete reqParsed.max_tokens;
  }
  const requestBody = Buffer.from(JSON.stringify(reqParsed));
  const upstreamHeaders = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${fetchApiKey}`,
    "User-Agent": USER_AGENT
  };
  if (isOpenRouter) {
    upstreamHeaders["HTTP-Referer"] = "http://localhost:8402";
    upstreamHeaders["X-Title"] = "ClawRouter";
  }
  const response = await fetch(upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders,
    body: requestBody,
    signal: args.signal
  });
  return { response, upstreamProvider, requestBody };
}
async function readResponseText(response) {
  const chunks = [];
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } catch {
    }
  }
  return Buffer.concat(chunks).toString();
}
function walletAddressFromKey(wallet) {
  const normalized = wallet?.trim();
  if (!normalized || !/^0x[0-9a-fA-F]{64}$/.test(normalized)) return void 0;
  return `0x${normalized.slice(-40)}`;
}
function normalizeMessagesForThinking(messages) {
  return messages.map((message) => {
    if (message.role === "assistant" && !("reasoning_content" in message)) {
      return { ...message, reasoning_content: "" };
    }
    return message;
  });
}
function stripDemoOnlyRequestFields(parsed) {
  let changed = false;
  for (const key of ["baseline_model", "cache", "expected_schema", "acu_quality_target", "acu_execute_recommended", "acu_plan_id"]) {
    if (key in parsed) {
      delete parsed[key];
      changed = true;
    }
  }
  return changed;
}
function isDebugCommand(messages) {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  return typeof lastUser?.content === "string" && lastUser.content.trim().startsWith("/debug");
}
function buildDebugCompletion(args) {
  const lastUser = [...args.messages].reverse().find((message) => message.role === "user");
  const prompt = typeof lastUser?.content === "string" ? lastUser.content.replace(/^\/debug\s*/, "") : "";
  const trace = buildRuleTraceSignals([{ role: "user", content: prompt || "debug" }], args.maxTokens, args.config);
  const content = [
    "ClawRouter Debug",
    `Profile: ${args.profile}`,
    `Tier: ${args.routingDecision?.tier ?? "SIMPLE"}`,
    `Model: ${args.routingDecision?.model ?? "auto"}`,
    `Confidence: ${(args.routingDecision?.confidence ?? 1).toFixed(2)}`,
    "Scoring (weighted: rule-based)",
    `tokenCount: ${Math.ceil(prompt.length / 4)}`,
    `codePresence: ${/code|function|python|javascript|bug|debug/i.test(prompt) ? 1 : 0}`,
    `reasoningMarkers: ${/prove|step|reason|analyze|compare/i.test(prompt) ? 1 : 0}`,
    `simpleIndicators: ${prompt.length < 80 ? 1 : 0}`,
    `agenticTask: ${/plan|agent|tool|workflow/i.test(prompt) ? 1 : 0}`,
    `Signals: ${trace.signals.join(", ") || "-"}`,
    "Tier Boundaries: SIMPLE / MEDIUM / COMPLEX / REASONING"
  ].join("\n");
  return {
    id: `chatcmpl-debug-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1e3),
    model: "clawrouter/debug",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }]
  };
}
function sendDebugResponse(res, payload, stream) {
  if (!stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  const chunk = {
    id: payload.id,
    object: "chat.completion.chunk",
    created: payload.created,
    model: payload.model,
    choices: [{ index: 0, delta: { role: "assistant", content: payload.choices[0].message.content }, finish_reason: null }]
  };
  const finish = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  res.write(`data: ${JSON.stringify(chunk)}

`);
  res.write(`data: ${JSON.stringify(finish)}

`);
  res.end("data: [DONE]\n\n");
}
function buildModelPricing() {
  const pricing = /* @__PURE__ */ new Map();
  for (const m of BLOCKRUN_MODELS) {
    pricing.set(m.id, {
      inputPrice: m.cost.input,
      outputPrice: m.cost.output
    });
  }
  return pricing;
}
function buildProxyModelList() {
  const routingProfiles = ["auto", "eco", "free", "premium"].map((id) => ({
    id,
    name: `ACU Router ${id}`,
    object: "model",
    created: 17e8,
    owned_by: "router",
    upstream: "router",
    pricing: {
      prompt: 0,
      completion: 0,
      cache_read: 0,
      cache_write: 0
    },
    context_length: 0,
    max_completion_tokens: 0,
    capabilities: {
      reasoning: true,
      vision: true,
      tool_calling: true
    }
  }));
  return [...routingProfiles, ...BLOCKRUN_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    object: "model",
    created: 17e8,
    owned_by: m.upstream,
    upstream: m.upstream,
    pricing: {
      prompt: m.cost.input,
      completion: m.cost.output,
      cache_read: m.cost.cacheRead,
      cache_write: m.cost.cacheWrite
    },
    context_length: m.contextWindow,
    max_completion_tokens: m.maxTokens,
    capabilities: {
      reasoning: m.reasoning,
      vision: m.input.includes("image"),
      tool_calling: supportsToolCalling(m.id)
    }
  }))];
}
function validateRoutingConfigModels(config, models = BLOCKRUN_MODELS) {
  const knownModels = new Set(models.map((m) => m.id));
  const missing = [];
  const validateTierSet = (label, tiers) => {
    if (!tiers) return;
    for (const [tier, tierConfig] of Object.entries(tiers)) {
      for (const modelId of [tierConfig.primary, ...tierConfig.fallback]) {
        if (!knownModels.has(modelId)) missing.push(`${label}.${tier}: ${modelId}`);
      }
    }
  };
  validateTierSet("tiers", config.tiers);
  validateTierSet("ecoTiers", config.ecoTiers);
  validateTierSet("premiumTiers", config.premiumTiers);
  validateTierSet("agenticTiers", config.agenticTiers);
  if (missing.length > 0) {
    throw new Error(`Routing config references unknown model IDs:
${missing.join("\n")}`);
  }
}
function mergeRoutingConfig(partial) {
  if (!partial) return DEFAULT_ROUTING_CONFIG;
  return {
    ...DEFAULT_ROUTING_CONFIG,
    ...partial,
    scoring: { ...DEFAULT_ROUTING_CONFIG.scoring, ...partial.scoring },
    overrides: { ...DEFAULT_ROUTING_CONFIG.overrides, ...partial.overrides }
  };
}
function normalizeMessageRoles(messages) {
  return messages.map((m) => {
    if (m.role === "developer") return { ...m, role: "system" };
    return m;
  });
}
function truncateMessages(messages) {
  if (messages.length <= MAX_MESSAGES) return messages;
  const system = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");
  const truncated = nonSystem.slice(-MAX_MESSAGES + system.length);
  return [...system, ...truncated];
}
function isGoogleModel(modelId) {
  return modelId.startsWith("google/");
}
function normalizeMessagesForGoogle(messages) {
  if (messages.length === 0) return messages;
  const firstNonSystem = messages.findIndex((m) => m.role !== "system");
  if (firstNonSystem >= 0 && messages[firstNonSystem].role !== "user") {
    messages = [...messages];
    messages.splice(firstNonSystem, 0, { role: "user", content: "." });
  }
  return messages;
}
async function startProxy(options) {
  const apiKey = options.apiKey || options.wallet || "test-api-key";
  const proxyBaseUrl = options.proxyBaseUrl || options.apiBase;
  const walletAddress = walletAddressFromKey(options.wallet);
  const port = options.port ?? PROXY_PORT;
  let boundPort = port;
  const routingConfig = mergeRoutingConfig(options.routingConfig);
  validateRoutingConfigModels(routingConfig);
  const modelPricing = buildModelPricing();
  const routerOpts = { config: routingConfig, modelPricing };
  const demoAccessToken = options.demoAccessToken?.trim() ?? getEnvDemoAccessToken();
  const acuStrategy = new AcuDemoStrategy(readAcuRuntimeConfig(options.acuRuntimeConfig));
  const acuStore = acuStrategy.enabled ? openAcuRoutingStore(acuStrategy.databasePath) : null;
  const acuPlans = /* @__PURE__ */ new Map();
  const deduplicator = new RequestDeduplicator();
  const responseCache = new ResponseCache(options.cacheConfig);
  const sessionStore = new SessionStore(options.sessionConfig);
  const sessionJournal = new SessionJournal();
  const excludeList = loadExcludeList();
  if (options.excludeModels) {
    for (const model of options.excludeModels) excludeList.add(model);
  }
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, {
        apiKey,
        proxyApiKey: options.proxyApiKey,
        proxyBaseUrl,
        routerOpts,
        deduplicator,
        responseCache,
        sessionStore,
        sessionJournal,
        excludeList,
        onRouted: options.onRouted,
        walletAddress,
        demoAccessToken,
        acuStrategy,
        acuStore,
        acuPlans
      });
    } catch (err) {
      console.error(`[ClawRouter] Unhandled error: ${err instanceof Error ? err.message : err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: { message: "Internal proxy error", type: "proxy_error" } }));
    }
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          const address = server.address();
          boundPort = address?.port ?? port;
          resolve();
        });
      });
      break;
    } catch (err) {
      if (err.code === "EADDRINUSE" && attempt < 4) {
        console.log(`[ClawRouter] Port ${port} busy, retrying (${attempt + 1}/5)...`);
        await new Promise((r) => setTimeout(r, 1e3));
      } else {
        throw err;
      }
    }
  }
  console.log(`[ClawRouter] v${VERSION} listening on http://127.0.0.1:${boundPort}`);
  console.log(`[ClawRouter] Routing via dual upstreams (${BLOCKRUN_MODELS.length} models)`);
  return {
    port: boundPort,
    baseUrl: `http://127.0.0.1:${boundPort}`,
    ...walletAddress && { walletAddress },
    close: () => new Promise((resolve) => server.close(() => {
      acuStore?.close();
      resolve();
    }))
  };
}
async function handleRequest(req, res, ctx) {
  req.url = stripAcuPrefix(req.url);
  const pathname = getPathname(req.url);
  if (isProtectedDemoPath(pathname)) {
    if (!isDemoAuthorized(req, ctx.demoAccessToken)) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Basic realm="ACU Router Demo"'
      });
      res.end(JSON.stringify({ error: { message: "Unauthorized", type: "unauthorized" } }));
      return;
    }
  }
  if (pathname === "/health") {
    const url = new URL(req.url, "http://localhost");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      version: VERSION,
      models: BLOCKRUN_MODELS.length,
      ...ctx.walletAddress && { wallet: ctx.walletAddress },
      ...url.searchParams.get("full") === "true" && { balanceError: "balance check disabled in local proxy" }
    }));
    return;
  }
  if (pathname === "/cache") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ctx.responseCache.getStats(), null, 2));
    return;
  }
  if (pathname === "/stats") {
    try {
      const url = new URL(req.url, "http://localhost");
      const days = parseInt(url.searchParams.get("days") || "7", 10);
      if (req.method === "DELETE") {
        const result = await clearStats();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ cleared: true, deletedFiles: result.deletedFiles }));
      } else {
        const stats = await getStats(Math.min(days, 30));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(stats, null, 2));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }
  if (pathname === "/ledger" || pathname === "/ledger/summary") {
    try {
      const url = new URL(req.url, "http://localhost");
      const days = Math.min(parseInt(url.searchParams.get("days") || "7", 10), 30);
      if (req.method === "DELETE" && pathname === "/ledger") {
        const result = await clearLedger();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ cleared: true, deletedFiles: result.deletedFiles }));
      } else if (req.method === "GET" && pathname === "/ledger/summary") {
        const summary = await getLedgerSummary(days);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(summary, null, 2));
      } else if (req.method === "GET" && pathname === "/ledger") {
        const entries = await getLedgerEntries(days);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: entries }, null, 2));
      } else {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }
  if (pathname === "/v1/models" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: buildProxyModelList() }));
    return;
  }
  if (pathname === "/acu/api/catalog" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(publicCatalogPayload()));
    return;
  }
  if (pathname === "/acu/api/data-summary" && req.method === "GET") {
    const summary = ctx.acuStore?.summary() ?? {
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      realRequestCount: 0,
      sampleNotice: "\u5F53\u524D\u6837\u672C\u91CF\u8F83\u5C0F\uFF0C\u4EC5\u7528\u4E8E\u4EA7\u54C1\u9A8C\u8BC1\u3002",
      storageStatus: "unavailable"
    };
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(summary));
    return;
  }
  if (pathname === "/acu/api/feedback" && req.method === "POST") {
    try {
      if (!ctx.acuStore) throw new Error("ACU data store is unavailable");
      const parsed = await readJsonRequest(req);
      const requestId2 = String(parsed.request_id ?? "");
      if (!requestId2) throw new Error("request_id is required");
      ctx.acuStore.recordFeedback({
        requestId: requestId2,
        accepted: typeof parsed.accepted === "boolean" ? parsed.accepted : void 0,
        rating: parsed.rating === void 0 ? void 0 : Number(parsed.rating),
        requiredUpgrade: typeof parsed.required_upgrade === "boolean" ? parsed.required_upgrade : void 0,
        finalModel: typeof parsed.final_model === "string" ? parsed.final_model : void 0
      });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ saved: true, request_id: requestId2 }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : "feedback rejected" } }));
    }
    return;
  }
  if (pathname === "/acu/api/outcome" && req.method === "POST") {
    try {
      if (!ctx.acuStore) throw new Error("ACU data store is unavailable");
      const parsed = await readJsonRequest(req);
      const source = String(parsed.outcome_source ?? "");
      if (!(/* @__PURE__ */ new Set(["validator", "test_result", "retry_signal", "model_upgrade_signal"])).has(source)) {
        throw new Error("invalid outcome_source");
      }
      ctx.acuStore.recordOutcome({
        requestId: String(parsed.request_id ?? ""),
        outcomeSource: source,
        validatorResult: typeof parsed.validator_result === "string" ? parsed.validator_result : void 0,
        testResult: typeof parsed.test_result === "string" ? parsed.test_result : void 0,
        toolErrorCount: parsed.tool_error_count === void 0 ? void 0 : Number(parsed.tool_error_count),
        retryCount: parsed.retry_count === void 0 ? void 0 : Number(parsed.retry_count),
        modelSwitched: typeof parsed.model_switched === "boolean" ? parsed.model_switched : void 0,
        userRetried: typeof parsed.user_retried === "boolean" ? parsed.user_retried : void 0,
        outcomeScore: parsed.outcome_score === void 0 ? void 0 : Number(parsed.outcome_score)
      });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ saved: true }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : "outcome rejected" } }));
    }
    return;
  }
  if (pathname === "/acu/api/plan" && req.method === "POST") {
    try {
      const parsed = await readJsonRequest(req);
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      if (messages.length === 0) throw new Error("messages must contain at least one visible API message");
      const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
      const expectedOutputTokens = Number(parsed.expected_output_tokens ?? 800);
      const qualityTarget = Number(parsed.quality_target ?? 0.8);
      if (!Number.isFinite(expectedOutputTokens) || expectedOutputTokens <= 0) throw new Error("expected_output_tokens must be positive");
      if (!Number.isFinite(qualityTarget) || qualityTarget < 0 || qualityTarget > 1) throw new Error("quality_target must be between 0 and 1");
      const requireTools = tools.length > 0;
      const requireVision = messages.some((message) => Array.isArray(message.content) && message.content.some((part) => Boolean(part && typeof part === "object" && part.type === "image_url")));
      const visible = serializeVisibleContext(messages, tools);
      const requiredContextTokens = estimateVisibleTokens(visible) + expectedOutputTokens;
      const allCompatibleModelIds = compatibleAcuModelIds({
        store: ctx.acuStore,
        excludeList: ctx.excludeList,
        hasTools: requireTools,
        hasVision: requireVision,
        requiredContextTokens
      });
      const eligibleModelIds = applyPassiveHealthAvailability(allCompatibleModelIds, ctx.acuStore);
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const system = messages.find((message) => message.role === "system");
      const rulesDecision = route(
        messageContentAsText(lastUser?.content),
        messageContentAsText(system?.content) || void 0,
        expectedOutputTokens,
        { ...ctx.routerOpts, routingProfile: "auto", hasTools: requireTools }
      );
      const evaluation = await ctx.acuStrategy.evaluate({
        messages,
        tools,
        qualityTarget,
        expectedOutputTokens,
        eligibleModelIds,
        requireToolCallSupport: requireTools,
        requireVisionSupport: requireVision,
        requestId: randomUUID2(),
        requestedModel: "planning_only"
      }, rulesDecision);
      const plan = buildPlanRecord({
        evaluation,
        allCompatibleModelIds,
        expectedOutputTokens,
        store: ctx.acuStore
      });
      pruneAcuPlans(ctx.acuPlans);
      const planId = randomUUID2();
      ctx.acuPlans.set(planId, plan);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        ...plan.evaluation,
        planId,
        planExpiresAt: new Date(plan.expiresAt).toISOString(),
        benchmarkBaselineModel: plan.benchmarkBaselineModel,
        benchmarkPricing: plan.benchmarkPricing,
        qualityLeaderModel: plan.qualityLeaderModel,
        qualityCeilingModel: plan.qualityCeilingModel,
        displayCandidates: plan.displayCandidates,
        planningOnly: true,
        databaseWrites: 0
      }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "acu_plan_error", message: error instanceof Error ? error.message : "Invalid ACU plan request" } }));
    }
    return;
  }
  if (pathname === "/acu/api/evaluate" && req.method === "POST") {
    try {
      const parsed = await readJsonRequest(req);
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      if (messages.length === 0) throw new Error("messages must contain at least one visible API message");
      const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const system = messages.find((message) => message.role === "system");
      const expectedOutputTokens = Number(parsed.expected_output_tokens ?? 800);
      const qualityTarget = Number(parsed.quality_target ?? 0.8);
      const forceJudgeRefresh = parsed.force_judge_refresh === true;
      if (forceJudgeRefresh && !ctx.acuStrategy.allowForceRefresh) throw new Error("force_judge_refresh is disabled");
      const requireTools = tools.length > 0;
      const requireVision = messages.some((message) => Array.isArray(message.content) && message.content.some((part) => Boolean(part && typeof part === "object" && part.type === "image_url")));
      const rulesDecision = route(
        messageContentAsText(lastUser?.content),
        messageContentAsText(system?.content) || void 0,
        Number.isFinite(expectedOutputTokens) ? expectedOutputTokens : 800,
        { ...ctx.routerOpts, routingProfile: "auto", hasTools: requireTools }
      );
      const eligibleModelIds = applyPassiveHealthAvailability(BLOCKRUN_MODELS.filter((model) => !ctx.excludeList.has(model.id) && (!requireTools || supportsToolCalling(model.id)) && (!requireVision || supportsVision(model.id))).map((model) => model.id), ctx.acuStore);
      const evaluation = await ctx.acuStrategy.evaluate({
        messages,
        tools,
        qualityTarget: Number.isFinite(qualityTarget) ? qualityTarget : 0.8,
        expectedOutputTokens: Number.isFinite(expectedOutputTokens) ? expectedOutputTokens : 800,
        eligibleModelIds,
        requireToolCallSupport: requireTools,
        requireVisionSupport: requireVision,
        forceJudgeRefresh,
        requestId: randomUUID2(),
        requestedModel: typeof parsed.model === "string" ? parsed.model : "evaluation_only"
      }, rulesDecision);
      try {
        ctx.acuStore?.recordEvaluation(evaluation, {
          requestedModel: typeof parsed.model === "string" ? parsed.model : "evaluation_only",
          finalStatus: "evaluated_only",
          hadTools: requireTools
        });
      } catch (error) {
        console.error(`[ClawRouter] ACU SQLite evaluation write failed: ${error instanceof Error ? error.message : "unknown"}`);
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(evaluation));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "acu_evaluation_error", message: error instanceof Error ? error.message : "Invalid ACU request" } }));
    }
    return;
  }
  if (pathname === "/acu/curves" && req.method === "GET") {
    res.writeHead(308, { Location: "curves/" });
    res.end();
    return;
  }
  if (pathname.startsWith("/share/") && req.method === "GET") {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/share/list") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 100);
        const entries = await listRecent(limit);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(entries.map((e) => ({ id: e.id, timestamp: e.timestamp, model: e.model, requestSummary: e.requestSummary }))));
      } else if (url.pathname === "/share/last") {
        const entry = await getLast();
        if (!entry) {
          res.writeHead(404);
          res.end('{"error":"no responses yet"}');
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: entry.id, model: entry.model, text: entry.responseText.slice(0, 5e3) }));
      } else {
        res.writeHead(404);
        res.end('{"error":"not found"}');
      }
    } catch {
      res.writeHead(500);
      res.end('{"error":"share route failed"}');
    }
    return;
  }
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html" || pathname === "/acu" || pathname === "/acu/" || pathname === "/acu-debug" || pathname === "/acu-debug/" || pathname === "/acu/curves" || pathname === "/acu/curves/" || pathname.startsWith("/public/") || pathname.startsWith("/acu/public/") || pathname.startsWith("/acu-debug/public/"))) {
    const { readFileSync: readFileSync3, existsSync: existsSync3 } = await import("fs");
    const { join: join7, dirname: dirname4 } = await import("path");
    const { fileURLToPath: fileURLToPath2 } = await import("url");
    const __dirname2 = dirname4(fileURLToPath2(import.meta.url));
    const publicDir = join7(__dirname2, "..", "public");
    const filePath = pathname === "/" || pathname === "/index.html" || pathname === "/acu" || pathname === "/acu/" ? join7(publicDir, "index.html") : pathname === "/acu-debug" || pathname === "/acu-debug/" ? join7(publicDir, "acu.html") : pathname === "/acu/curves" || pathname === "/acu/curves/" ? join7(publicDir, "acu-curves.html") : join7(publicDir, pathname.replace(/^\/acu-debug\/public\//, "").replace(/^\/acu\/public\//, "").replace(/^\/public\//, ""));
    if (existsSync3(filePath)) {
      const ext = filePath.split(".").pop() || "html";
      const mime = { html: "text/html", css: "text/css", js: "application/javascript", json: "application/json", png: "image/png", svg: "image/svg+xml" };
      res.writeHead(200, { "Content-Type": mime[ext] || "text/plain" });
      res.end(readFileSync3(filePath));
      return;
    }
  }
  if (!pathname.includes("/chat/completions")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", detail: { message: `Not found: ${req.url}`, type: "not_found" } }));
    return;
  }
  const startTime = Date.now();
  const requestId = randomUUID2();
  const debugHeader = req.headers["x-acu-debug"] ?? req.headers["x-clawrouter-debug"];
  const debugMode = debugHeader !== "false";
  const bodyChunks = [];
  for await (const chunk of req) {
    bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let body = Buffer.concat(bodyChunks);
  const dedupKey = RequestDeduplicator.hash(body);
  const cached = ctx.deduplicator.getCached(dedupKey);
  if (cached) {
    res.writeHead(cached.status, cached.headers);
    res.end(cached.body);
    return;
  }
  const inflight = ctx.deduplicator.getInflight(dedupKey);
  if (inflight) {
    const result = await inflight;
    res.writeHead(result.status, result.headers);
    res.end(result.body);
    return;
  }
  ctx.deduplicator.markInflight(dedupKey);
  let isStreaming = false;
  let modelId = "";
  let maxTokens = 4096;
  let routingProfile = null;
  let routingDecision;
  let acuEvaluation;
  let acuRecommendationSelected = false;
  let hasTools = false;
  let hasVision = false;
  let bodyModified = false;
  const sessionId = getSessionId(req.headers);
  let effectiveSessionId = sessionId;
  const parsedMessages = [];
  let responseFormat;
  let expectedSchema;
  let acuQualityTarget = 0.8;
  let acuPlanId;
  let executeAcuRecommended;
  let routeComputeLatencyMs = 0;
  try {
    const parsed = JSON.parse(body.toString());
    isStreaming = parsed.stream === true;
    modelId = parsed.model || "";
    maxTokens = parsed.max_tokens || 4096;
    responseFormat = parsed.response_format;
    expectedSchema = parsed.expected_schema;
    const requestedQualityTarget = Number(parsed.acu_quality_target);
    if (Number.isFinite(requestedQualityTarget)) acuQualityTarget = requestedQualityTarget;
    acuPlanId = typeof parsed.acu_plan_id === "string" ? parsed.acu_plan_id : void 0;
    executeAcuRecommended = parsed.acu_execute_recommended === true;
    if (stripDemoOnlyRequestFields(parsed)) bodyModified = true;
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    parsedMessages.push(...messages);
    parsed.messages = normalizeMessageRoles(messages);
    parsed.messages = truncateMessages(parsed.messages);
    hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
    hasVision = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")
    );
    const normalizedModel = modelId.toLowerCase().trim();
    const resolvedModel = resolveModelAlias(normalizedModel);
    const isRoutingProfile = ROUTING_PROFILES.has(normalizedModel) || ROUTING_PROFILES.has(resolvedModel);
    if (isRoutingProfile) {
      const profileName = resolvedModel.replace("blockrun/", "");
      routingProfile = profileName;
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const prompt = messageContentAsText(lastUserMsg?.content);
      const systemMsg = messages.find((m) => m.role === "system");
      const systemPrompt = typeof systemMsg?.content === "string" ? systemMsg.content : void 0;
      effectiveSessionId = sessionId ?? deriveSessionId(messages);
      const existingSession = effectiveSessionId ? ctx.sessionStore.getSession(effectiveSessionId) : void 0;
      const rulesDecision = route(prompt, systemPrompt, maxTokens, {
        ...ctx.routerOpts,
        routingProfile: routingProfile ?? void 0,
        hasTools
      });
      routingDecision = rulesDecision;
      if (ctx.acuStrategy.enabled) {
        const acuRouteStart = Date.now();
        const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
        const planned = acuPlanId ? ctx.acuPlans.get(acuPlanId) : void 0;
        const contextSha256 = createHash7("sha256").update(serializeVisibleContext(messages, tools)).digest("hex");
        if (planned && planned.expiresAt > Date.now() && planned.contextSha256 === contextSha256 && Math.abs(planned.qualityTarget - acuQualityTarget) < 1e-9 && planned.expectedOutputTokens === maxTokens) {
          acuEvaluation = structuredClone(planned.evaluation);
          acuEvaluation.requestId = requestId;
          ctx.acuPlans.delete(acuPlanId);
        } else {
          if (acuPlanId) ctx.acuPlans.delete(acuPlanId);
          const requiredContextTokens = estimateVisibleTokens(serializeVisibleContext(messages, tools)) + maxTokens;
          const compatibleModelIds = compatibleAcuModelIds({
            store: ctx.acuStore,
            excludeList: ctx.excludeList,
            hasTools,
            hasVision,
            requiredContextTokens
          });
          const eligibleModelIds = applyPassiveHealthAvailability(compatibleModelIds, ctx.acuStore);
          acuEvaluation = await ctx.acuStrategy.evaluate({
            messages,
            tools,
            qualityTarget: acuQualityTarget,
            expectedOutputTokens: maxTokens,
            eligibleModelIds,
            requireToolCallSupport: hasTools,
            requireVisionSupport: hasVision,
            requestId,
            requestedModel: modelId,
            sessionHash: hashSession(effectiveSessionId)
          }, rulesDecision);
        }
        routeComputeLatencyMs = Math.max(0, Date.now() - acuRouteStart - acuEvaluation.judgeLatencyMs);
        try {
          ctx.acuStore?.recordEvaluation(acuEvaluation, {
            sessionHash: hashSession(effectiveSessionId),
            requestedModel: modelId,
            finalStatus: "routing_pending",
            hadTools: hasTools
          });
        } catch (error) {
          console.error(`[ClawRouter] ACU SQLite routing write failed: ${error instanceof Error ? error.message : "unknown"}`);
        }
        if (acuEvaluation.judgeStatus !== "rules_fallback" && (!ctx.acuStrategy.shadowMode || executeAcuRecommended)) {
          const selected = acuEvaluation.recommendation.recommended;
          const fallback = acuEvaluation.recommendation.fallbackModel.modelId;
          const tier = routingTierFromAcu(acuEvaluation);
          const baseTiers = routingDecision.tierConfigs ?? ctx.routerOpts.config.tiers;
          const originalPrimary = baseTiers[tier].primary;
          const existingFallbacks = baseTiers[tier].fallback;
          routingDecision = {
            ...rulesDecision,
            model: selected.modelId,
            tier,
            confidence: acuEvaluation.judge.confidence,
            method: "llm",
            reasoning: `${acuEvaluation.judge.explanation} | ${acuEvaluation.recommendation.reason}`,
            costEstimate: selected.expectedTotalCost,
            baselineCost: acuEvaluation.recommendation.flagshipAlternative.estimatedCallCost,
            savings: selected.savingsPercentVsFlagship,
            tierConfigs: {
              ...baseTiers,
              [tier]: {
                primary: selected.modelId,
                fallback: [.../* @__PURE__ */ new Set([fallback, originalPrimary, ...existingFallbacks])].filter((modelId2) => modelId2 !== selected.modelId)
              }
            }
          };
          acuRecommendationSelected = true;
        }
      }
      if (acuRecommendationSelected) {
        modelId = routingDecision.model;
        parsed.model = modelId;
        if (modelId === "qwen3.6-plus" && acuEvaluation && acuEvaluation.difficultyScore < 55 && parsed.enable_thinking === void 0) {
          parsed.enable_thinking = false;
        }
        bodyModified = true;
        if (effectiveSessionId) {
          ctx.sessionStore.setSession(effectiveSessionId, routingDecision.model, routingDecision.tier);
        }
      } else if (existingSession?.userExplicit) {
        modelId = existingSession.model;
        parsed.model = modelId;
        bodyModified = true;
      } else if (existingSession) {
        const tierRank = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };
        const existingRank = tierRank[existingSession.tier] ?? 0;
        const newRank = tierRank[routingDecision.tier] ?? 0;
        if (newRank > existingRank) {
          modelId = routingDecision.model;
          parsed.model = modelId;
          bodyModified = true;
          ctx.sessionStore.setSession(effectiveSessionId, routingDecision.model, routingDecision.tier);
        } else {
          modelId = existingSession.model;
          parsed.model = modelId;
          bodyModified = true;
          ctx.sessionStore.touchSession(effectiveSessionId);
        }
      } else {
        modelId = routingDecision.model;
        parsed.model = modelId;
        bodyModified = true;
        if (effectiveSessionId) {
          ctx.sessionStore.setSession(effectiveSessionId, routingDecision.model, routingDecision.tier);
        }
      }
      ctx.onRouted?.(routingDecision);
    } else {
      modelId = resolvedModel;
      parsed.model = modelId;
      bodyModified = true;
      const explicitSessionId = sessionId ?? deriveSessionId(messages);
      if (explicitSessionId) {
        ctx.sessionStore.setSession(explicitSessionId, resolvedModel, "MEDIUM", true);
        effectiveSessionId = explicitSessionId;
      }
    }
    if (isDebugCommand(parsed.messages)) {
      const payload = buildDebugCompletion({
        messages: parsed.messages,
        profile: routingProfile ?? resolvedModel.replace("blockrun/", ""),
        routingDecision,
        maxTokens,
        config: ctx.routerOpts.config
      });
      sendDebugResponse(res, payload, isStreaming);
      ctx.deduplicator.removeInflight(dedupKey);
      return;
    }
    if (isGoogleModel(modelId) && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForGoogle(parsed.messages);
    }
    if ((modelId.startsWith("kimi-") || isReasoningModel(modelId)) && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForThinking(parsed.messages);
    }
    if (parsed.stream === true) {
      parsed.stream = false;
      bodyModified = true;
    }
    if (bodyModified) {
      body = Buffer.from(JSON.stringify(parsed));
    }
  } catch {
  }
  if (parsedMessages.length > 0 && shouldCompress(parsedMessages)) {
    try {
      const compressed = await compressContext(parsedMessages);
      if (compressed.compressionRatio < 0.95) {
        console.log(`[ClawRouter] Compression: ${(compressed.compressionRatio * 100).toFixed(0)}% of original`);
      }
    } catch {
    }
  }
  const requestHeaders = normalizeRequestHeaders(req);
  const allowResponseCache = routingProfile === null && ctx.responseCache.shouldCache(body, requestHeaders);
  const respCached = allowResponseCache ? ctx.responseCache.get(dedupKey) : void 0;
  if (respCached) {
    const headers = { "Content-Type": "application/json", "X-Cache-Hit": "true" };
    res.writeHead(200, headers);
    res.end(respCached.body);
    const estimatedInputTokens2 = Math.ceil(body.length / 4);
    const usage = parseUsage(respCached.body.toString(), estimatedInputTokens2, maxTokens, ctx.routerOpts.modelPricing.get(respCached.model));
    const costs = calculateModelCost(respCached.model, ctx.routerOpts.modelPricing, usage.inputTokens, usage.completionTokens, routingProfile ?? void 0);
    await appendLedgerEntry({
      request_id: requestId,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      prompt_hash: hashPrompt(parsedMessages),
      task_type: detectTaskType(parsedMessages),
      profile: routingProfile ?? "explicit",
      tier: routingDecision?.tier ?? "EXPLICIT",
      method: routingDecision?.method ?? "cache_hit",
      selected_model: routingDecision?.model ?? respCached.model,
      actual_model_used: respCached.model,
      upstream: getUpstream(respCached.model),
      input_tokens: usage.inputTokens,
      output_tokens: usage.completionTokens,
      estimated_cost: 0,
      actual_cost: 0,
      baseline_model: DEFAULT_BASELINE_MODEL,
      baseline_cost: costs.baselineCost,
      savings: costs.baselineCost,
      latency_ms: Date.now() - startTime,
      fallback_attempts: 0,
      fallback_used: false,
      quality_fallback_used: false,
      validator_result: "not_applicable",
      cache_hit: true
    });
    if (acuEvaluation) {
      try {
        ctx.acuStore?.finalizeRequest(requestId, {
          actualModel: respCached.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.completionTokens,
          actualCost: 0,
          latencyMs: Date.now() - startTime,
          finalStatus: "response_cache_hit"
        });
      } catch {
      }
    }
    ctx.deduplicator.complete(dedupKey, { status: 200, headers, body: Buffer.from(respCached.body), completedAt: Date.now() });
    return;
  }
  let modelsToTry = [];
  if (routingDecision) {
    const tierConfigs = routingDecision.tierConfigs ?? ctx.routerOpts.config.tiers;
    let chain = getFallbackChainFiltered(
      routingDecision.tier,
      tierConfigs,
      Math.ceil(body.length / 4) + maxTokens,
      getModelContextWindow
    );
    chain = filterByToolCalling(chain, hasTools, supportsToolCalling);
    chain = filterByVision(chain, hasVision, supportsVision);
    chain = filterByExcludeList(chain, ctx.excludeList);
    modelsToTry = chain.slice(0, MAX_FALLBACK_ATTEMPTS);
    modelsToTry = prioritizeNonRateLimited(modelsToTry);
  } else {
    modelsToTry = [modelId];
  }
  const globalController = new AbortController();
  const timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  const timeoutId = setTimeout(() => globalController.abort(), timeoutMs);
  const onClientClose = () => {
    if (!res.writableEnded) globalController.abort();
  };
  req.on("close", onClientClose);
  let heartbeatInterval;
  let headersSentEarly = false;
  if (isStreaming) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-ClawRouter-Version": VERSION
    });
    headersSentEarly = true;
    safeWrite(res, ": heartbeat\n\n");
    heartbeatInterval = setInterval(() => {
      if (canWrite(res)) safeWrite(res, ": heartbeat\n\n");
      else clearInterval(heartbeatInterval);
    }, HEARTBEAT_INTERVAL_MS);
  }
  let upstream;
  let actualModelUsed = modelId;
  let lastError;
  let lastErrorCategory;
  let upstreamProviderUsed = "";
  const attempts = [];
  for (let i = 0; i < modelsToTry.length; i++) {
    const tryModel = modelsToTry[i];
    if (globalController.signal.aborted) break;
    console.log(`[ClawRouter] Trying model ${tryModel} (${i + 1}/${modelsToTry.length})`);
    const attemptStart = Date.now();
    const perAttemptTimeout = timeoutForAttempt(tryModel, i, acuRecommendationSelected, maxTokens);
    const modelController = new AbortController();
    const modelTimeoutId = setTimeout(() => modelController.abort(), perAttemptTimeout);
    const combinedSignal = AbortSignal.any([globalController.signal, modelController.signal]);
    try {
      const { response, upstreamProvider } = await fetchUpstreamChatCompletion({
        body,
        model: tryModel,
        apiKey: ctx.apiKey,
        proxyApiKey: ctx.proxyApiKey,
        proxyBaseUrl: ctx.proxyBaseUrl,
        signal: combinedSignal
      });
      if (response.status === 200) {
        upstream = response;
        actualModelUsed = tryModel;
        upstreamProviderUsed = upstreamProvider;
        attempts.push({
          ...attemptProfileFields(tryModel, body, i === 0 ? "initial" : "fallback"),
          model: tryModel,
          upstream: upstreamProvider,
          status: "success",
          latency_ms: Date.now() - attemptStart
        });
        break;
      }
      const errorBody = await response.text().catch(() => "");
      const category = categorizeError(response.status, errorBody);
      lastErrorCategory = category ?? "upstream_error";
      lastError = { body: errorBody, status: response.status };
      attempts.push({
        ...attemptProfileFields(tryModel, body, i === 0 ? "initial" : "fallback"),
        model: tryModel,
        upstream: upstreamProvider,
        status: "error",
        error_category: lastErrorCategory,
        latency_ms: Date.now() - attemptStart,
        ...extractExplicitUpstreamCost(errorBody) !== void 0 && {
          billed_cost: extractExplicitUpstreamCost(errorBody),
          usage_source: "upstream_cost"
        }
      });
      if (category === "rate_limited") {
        markRateLimited(tryModel);
      } else if (category === "overloaded") {
        markOverloaded(tryModel);
      } else if (category === "auth_failure" && response.status === 401) {
        console.error(`[ClawRouter] Auth failure for ${tryModel} \u2014 check API key`);
        break;
      }
      console.log(`[ClawRouter] ${category ?? "error"} from ${tryModel}: ${errorBody.slice(0, 100)}`);
    } catch (err) {
      clearTimeout(modelTimeoutId);
      if (globalController.signal.aborted) break;
      if (err instanceof UnknownModelError) {
        lastError = { body: err.message, status: 500 };
        lastErrorCategory = "unknown_model";
        attempts.push({
          ...attemptProfileFields(tryModel, body, i === 0 ? "initial" : "fallback"),
          model: tryModel,
          upstream: "unknown",
          status: "skipped",
          error_category: lastErrorCategory,
          latency_ms: Date.now() - attemptStart
        });
        console.error(`[ClawRouter] ${err.message}; skipping fallback candidate`);
        continue;
      }
      if (modelController.signal.aborted && i < modelsToTry.length - 1) {
        lastErrorCategory = "timeout";
        attempts.push({
          ...attemptProfileFields(tryModel, body, i === 0 ? "initial" : "fallback"),
          model: tryModel,
          upstream: "unknown",
          status: "timeout",
          error_category: lastErrorCategory,
          latency_ms: Date.now() - attemptStart
        });
        console.log(`[ClawRouter] ${tryModel} timed out, trying fallback`);
        continue;
      }
      lastError = { body: String(err), status: 500 };
      lastErrorCategory = "server_error";
      attempts.push({
        ...attemptProfileFields(tryModel, body, i === 0 ? "initial" : "fallback"),
        model: tryModel,
        upstream: "unknown",
        status: "error",
        error_category: lastErrorCategory,
        latency_ms: Date.now() - attemptStart
      });
    }
  }
  clearTimeout(timeoutId);
  req.removeListener("close", onClientClose);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (!upstream) {
    const errorPayload = JSON.stringify({
      error: {
        message: lastError?.body ? `Upstream error: ${lastError.body.slice(0, 200)}` : "All models failed",
        type: "upstream_error",
        status: lastError?.status
      }
    });
    if (headersSentEarly) {
      safeWrite(res, `data: ${errorPayload}

data: [DONE]

`);
      res.end();
    } else {
      res.writeHead(lastError?.status ?? 502, { "Content-Type": "application/json" });
      res.end(errorPayload);
    }
    ctx.deduplicator.removeInflight(dedupKey);
    if (acuEvaluation) {
      try {
        ctx.acuStore?.recordAttempts(requestId, attempts);
        ctx.acuStore?.finalizeRequest(requestId, { finalStatus: "upstream_error", errorCategory: lastErrorCategory });
      } catch {
      }
    }
    return;
  }
  if (debugMode && routingDecision) {
    const debugInfo = `profile=${routingProfile ?? "explicit"} tier=${routingDecision.tier} model=${actualModelUsed} confidence=${routingDecision.confidence.toFixed(2)} savings=${(routingDecision.savings * 100).toFixed(0)}%`;
    if (headersSentEarly) {
      safeWrite(res, `: x-clawrouter-debug ${debugInfo}

`);
    }
  }
  const contentType = upstream.headers.get("content-type") || "application/json";
  const isSSE = contentType.includes("text/event-stream");
  if (isStreaming && !headersSentEarly) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
  }
  let responseBody = "";
  if (isSSE) {
    const reader = upstream.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          responseBody += chunk;
          if (isStreaming && canWrite(res)) {
            safeWrite(res, chunk);
          }
        }
      } catch (err) {
        if (!globalController.signal.aborted) {
          console.error(`[ClawRouter] Stream read error: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    if (isStreaming && debugMode && canWrite(res)) {
      const estimatedInputTokens2 = Math.ceil(body.length / 4);
      const costs = calculateModelCost(actualModelUsed, ctx.routerOpts.modelPricing, estimatedInputTokens2, maxTokens, routingProfile ?? void 0);
      const trace = buildStreamingTrace({
        requestId,
        routingProfile,
        routingDecision,
        parsedMessages,
        maxTokens,
        config: ctx.routerOpts.config,
        modelId,
        actualModelUsed,
        upstream: upstreamProviderUsed || getUpstream(actualModelUsed),
        modelsToTry,
        attempts,
        estimatedInputTokens: estimatedInputTokens2,
        estimatedOutputTokens: maxTokens,
        costs
      });
      if (acuEvaluation) {
        setAcuExecutionResult(acuEvaluation, acuRecommendationSelected, actualModelUsed);
        trace.acu_demo = acuEvaluation;
      }
      safeWrite(res, `event: acu_trace
data: ${JSON.stringify(trace)}

`);
    }
    if (isStreaming && canWrite(res) && !responseBody.includes("[DONE]")) {
      safeWrite(res, "data: [DONE]\n\n");
    }
  } else {
    const chunks = [];
    const reader = upstream.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      } catch {
      }
    }
    responseBody = Buffer.concat(chunks).toString();
    if (!isStreaming) {
      const initialValidatorStart = Date.now();
      let validator = validateAssistantOutput({
        messages: parsedMessages,
        assistantText: extractAssistantText(responseBody),
        responseFormat,
        expectedSchema
      });
      let validatorLatencyMs = Date.now() - initialValidatorStart;
      let qualityFallbackUsed = false;
      let qualityReviewRequired = false;
      let formatRepairUsed = false;
      let formatRepairSucceeded = false;
      const originalResponseBody = responseBody;
      const originalModel = actualModelUsed;
      const originalProvider = upstreamProviderUsed;
      const originalAttempt = [...attempts].reverse().find((attempt) => attempt.model === originalModel && attempt.status === "success");
      const billAttempt = (attempt, payload, model) => {
        if (!attempt) return;
        const attemptUsage = parseUsage(payload, Math.ceil(body.length / 4), maxTokens, ctx.routerOpts.modelPricing.get(model));
        attempt.billed_cost = attemptUsage.modelCallCost;
        attempt.usage_source = attemptUsage.usageSource;
        attempt.reasoning_tokens = attemptUsage.reasoningTokens;
        attempt.upstream_model = upstreamModelFromBody(payload, model);
      };
      if (validator.result === "fail" && (validator.validator === "json_validator" || validator.validator === "schema_validator")) {
        formatRepairUsed = true;
        const repairBody = buildFormatRepairBody(body, validator, maxTokens);
        const repairStart = Date.now();
        const repairController = new AbortController();
        const repairTimeout = setTimeout(() => repairController.abort(), timeoutForModel(originalModel));
        try {
          const { response, upstreamProvider } = await fetchUpstreamChatCompletion({
            body: repairBody,
            model: originalModel,
            apiKey: ctx.apiKey,
            proxyApiKey: ctx.proxyApiKey,
            proxyBaseUrl: ctx.proxyBaseUrl,
            signal: AbortSignal.any([globalController.signal, repairController.signal])
          });
          if (response.status === 200) {
            const repairedBody = await readResponseText(response);
            const repairAttempt = {
              ...attemptProfileFields(originalModel, repairBody, "format_repair"),
              model: originalModel,
              upstream: upstreamProvider,
              status: "success",
              latency_ms: Date.now() - repairStart
            };
            attempts.push(repairAttempt);
            const checkStart = Date.now();
            const repairedValidator = validateAssistantOutput({
              messages: parsedMessages,
              assistantText: extractAssistantText(repairedBody),
              responseFormat,
              expectedSchema
            });
            validatorLatencyMs += Date.now() - checkStart;
            if (repairedValidator.result === "pass") {
              billAttempt(originalAttempt, originalResponseBody, originalModel);
              responseBody = repairedBody;
              validator = repairedValidator;
              upstreamProviderUsed = upstreamProvider;
              formatRepairSucceeded = true;
            } else {
              repairAttempt.status = "error";
              repairAttempt.error_category = "format_repair_validation_failed";
              billAttempt(repairAttempt, repairedBody, originalModel);
              validator = repairedValidator;
            }
          } else {
            const errorBody = await response.text().catch(() => "");
            const category = categorizeError(response.status, errorBody) ?? "format_repair_error";
            attempts.push({
              ...attemptProfileFields(originalModel, repairBody, "format_repair"),
              model: originalModel,
              upstream: upstreamProvider,
              status: "error",
              error_category: category,
              latency_ms: Date.now() - repairStart,
              ...extractExplicitUpstreamCost(errorBody) !== void 0 && {
                billed_cost: extractExplicitUpstreamCost(errorBody),
                usage_source: "upstream_cost"
              }
            });
          }
        } catch {
          const category = repairController.signal.aborted ? "timeout" : "format_repair_error";
          attempts.push({
            ...attemptProfileFields(originalModel, repairBody, "format_repair"),
            model: originalModel,
            upstream: "unknown",
            status: repairController.signal.aborted ? "timeout" : "error",
            error_category: category,
            latency_ms: Date.now() - repairStart
          });
        } finally {
          clearTimeout(repairTimeout);
        }
        if (!formatRepairSucceeded) {
          const qualityFallbackModel = selectQualityFallbackModel({
            evaluation: acuEvaluation,
            currentModel: originalModel,
            modelsTried: attempts.map((attempt) => attempt.model),
            store: ctx.acuStore,
            hasTools,
            hasVision,
            requiredContextTokens: Math.ceil(body.length / 4) + maxTokens
          });
          if (qualityFallbackModel) {
            const qualityStart = Date.now();
            const qualityController = new AbortController();
            const qualityTimeout = setTimeout(() => qualityController.abort(), timeoutForModel(qualityFallbackModel));
            try {
              const { response, upstreamProvider } = await fetchUpstreamChatCompletion({
                body: repairBody,
                model: qualityFallbackModel,
                apiKey: ctx.apiKey,
                proxyApiKey: ctx.proxyApiKey,
                proxyBaseUrl: ctx.proxyBaseUrl,
                signal: AbortSignal.any([globalController.signal, qualityController.signal])
              });
              if (response.status === 200) {
                const replacementBody = await readResponseText(response);
                const replacementAttempt = {
                  ...attemptProfileFields(qualityFallbackModel, repairBody, "quality_upgrade"),
                  model: qualityFallbackModel,
                  upstream: upstreamProvider,
                  status: "success",
                  latency_ms: Date.now() - qualityStart
                };
                attempts.push(replacementAttempt);
                const checkStart = Date.now();
                const replacementValidator = validateAssistantOutput({
                  messages: parsedMessages,
                  assistantText: extractAssistantText(replacementBody),
                  responseFormat,
                  expectedSchema
                });
                validatorLatencyMs += Date.now() - checkStart;
                if (replacementValidator.result === "pass") {
                  billAttempt(originalAttempt, originalResponseBody, originalModel);
                  responseBody = replacementBody;
                  actualModelUsed = qualityFallbackModel;
                  upstreamProviderUsed = upstreamProvider;
                  validator = replacementValidator;
                  qualityFallbackUsed = true;
                } else {
                  replacementAttempt.status = "error";
                  replacementAttempt.error_category = "quality_upgrade_validation_failed";
                  billAttempt(replacementAttempt, replacementBody, qualityFallbackModel);
                  qualityReviewRequired = true;
                }
              } else {
                const errorBody = await response.text().catch(() => "");
                const category = categorizeError(response.status, errorBody) ?? "quality_upgrade_error";
                attempts.push({
                  ...attemptProfileFields(qualityFallbackModel, repairBody, "quality_upgrade"),
                  model: qualityFallbackModel,
                  upstream: upstreamProvider,
                  status: "error",
                  error_category: category,
                  latency_ms: Date.now() - qualityStart,
                  ...extractExplicitUpstreamCost(errorBody) !== void 0 && {
                    billed_cost: extractExplicitUpstreamCost(errorBody),
                    usage_source: "upstream_cost"
                  }
                });
                qualityReviewRequired = true;
              }
            } catch {
              const category = qualityController.signal.aborted ? "timeout" : "quality_upgrade_error";
              attempts.push({
                ...attemptProfileFields(qualityFallbackModel, repairBody, "quality_upgrade"),
                model: qualityFallbackModel,
                upstream: "unknown",
                status: qualityController.signal.aborted ? "timeout" : "error",
                error_category: category,
                latency_ms: Date.now() - qualityStart
              });
              qualityReviewRequired = true;
            } finally {
              clearTimeout(qualityTimeout);
            }
          } else {
            qualityReviewRequired = true;
          }
          if (!qualityFallbackUsed) {
            responseBody = originalResponseBody;
            actualModelUsed = originalModel;
            upstreamProviderUsed = originalProvider;
          }
        }
      }
      const latencyMs2 = Date.now() - startTime;
      const estimatedInputTokens2 = Math.ceil(body.length / 4);
      const usage = parseUsage(responseBody, estimatedInputTokens2, maxTokens, ctx.routerOpts.modelPricing.get(actualModelUsed));
      const finalAttempt = [...attempts].reverse().find((attempt) => attempt.model === actualModelUsed && attempt.status === "success");
      if (finalAttempt) {
        finalAttempt.reasoning_tokens = usage.reasoningTokens;
        finalAttempt.upstream_model = upstreamModelFromBody(responseBody, actualModelUsed);
      }
      const finalExecutionProfile = finalAttempt ? {
        executionProfileId: finalAttempt.execution_profile_id,
        thinkingMode: finalAttempt.thinking_mode,
        requestParameterApplied: finalAttempt.request_parameter_applied
      } : executionProfileFor(actualModelUsed, void 0);
      let costEstimate2 = 0;
      let baselineCost2 = 0;
      let savings2 = 0;
      if (routingDecision) {
        if (actualModelUsed !== routingDecision.model) {
          const costs = calculateModelCost(actualModelUsed, ctx.routerOpts.modelPricing, usage.inputTokens, usage.completionTokens, routingProfile ?? void 0);
          costEstimate2 = costs.costEstimate;
          baselineCost2 = costs.baselineCost;
          savings2 = costs.savings;
        } else {
          const costs = calculateModelCost(actualModelUsed, ctx.routerOpts.modelPricing, usage.inputTokens, usage.completionTokens, routingProfile ?? void 0);
          costEstimate2 = costs.costEstimate;
          baselineCost2 = costs.baselineCost;
          savings2 = costs.savings;
        }
      } else {
        const costs = calculateModelCost(actualModelUsed, ctx.routerOpts.modelPricing, usage.inputTokens, usage.completionTokens);
        costEstimate2 = costs.costEstimate;
        baselineCost2 = costs.baselineCost;
        savings2 = costs.savings;
      }
      const fallbackUsed = getFallbackUsed(attempts, actualModelUsed, routingDecision?.model);
      if (acuEvaluation) setAcuExecutionResult(acuEvaluation, acuRecommendationSelected, actualModelUsed);
      const upstreamLatencyMs = attempts.reduce((sum, attempt) => sum + attempt.latency_ms, 0);
      const fallbackLatencyMs = attempts.slice(1).reduce((sum, attempt) => sum + attempt.latency_ms, 0);
      const failedAttemptCost = attempts.reduce((sum, attempt, index) => index === attempts.length - 1 && attempt.status === "success" ? sum : sum + (attempt.billed_cost ?? 0), 0);
      const totalAcuCost = usage.modelCallCost + failedAttemptCost + (acuEvaluation?.judgeCost ?? 0);
      const trace = {
        ...buildRuleTraceSignals(parsedMessages, maxTokens, ctx.routerOpts.config),
        request_id: requestId,
        profile: routingProfile ?? "explicit",
        tier: routingDecision?.tier ?? "EXPLICIT",
        confidence: routingDecision?.confidence ?? 1,
        method: routingDecision?.method ?? "explicit",
        ...routingDecision?.agenticScore !== void 0 && { agentic_score: routingDecision.agenticScore },
        selected_model: routingDecision?.model ?? modelId,
        actual_model_used: actualModelUsed,
        upstream: upstreamProviderUsed || getUpstream(actualModelUsed),
        fallback_chain: modelsToTry,
        attempts,
        attempt_count: attempts.length,
        fallback_used: fallbackUsed,
        quality_fallback_used: qualityFallbackUsed,
        quality_review_required: qualityReviewRequired,
        format_repair_used: formatRepairUsed,
        format_repair_succeeded: formatRepairSucceeded,
        execution_profile_id: finalExecutionProfile.executionProfileId,
        thinking_mode: finalExecutionProfile.thinkingMode,
        request_parameter_applied: finalExecutionProfile.requestParameterApplied,
        upstream_model: upstreamModelFromBody(responseBody, actualModelUsed),
        estimated_input_tokens: usage.inputTokens,
        estimated_output_tokens: usage.completionTokens,
        estimated_cost: costEstimate2,
        baseline_model: DEFAULT_BASELINE_MODEL,
        baseline_cost: baselineCost2,
        estimated_savings: savings2,
        usage_audit: usage,
        cost_audit: {
          judge_cost: acuEvaluation?.judgeCost ?? 0,
          model_call_cost: usage.modelCallCost,
          failed_attempt_cost: failedAttemptCost,
          total_acu_cost: totalAcuCost
        },
        latency_breakdown: {
          judge_latency_ms: acuEvaluation?.judgeLatencyMs ?? 0,
          route_compute_latency_ms: routeComputeLatencyMs,
          upstream_latency_ms: upstreamLatencyMs,
          validator_latency_ms: validatorLatencyMs,
          fallback_latency_ms: fallbackLatencyMs,
          total_router_latency_ms: latencyMs2
        },
        route_reasoning: routingDecision?.reasoning ?? "Explicit model request",
        validator_result: validator.result,
        validator: validator.validator,
        ...validator.result !== "not_applicable" && { validator_pass: validator.result === "pass" },
        validator_reason: validator.reason ?? "not_applicable",
        ...acuEvaluation && { acu_demo: acuEvaluation }
      };
      if (debugMode) responseBody = injectTraceIntoJsonResponse(responseBody, trace);
      const ledgerEntry = {
        request_id: requestId,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        prompt_hash: hashPrompt(parsedMessages),
        task_type: detectTaskType(parsedMessages),
        profile: trace.profile,
        tier: trace.tier,
        method: trace.method,
        selected_model: trace.selected_model,
        actual_model_used: actualModelUsed,
        upstream: trace.upstream,
        input_tokens: usage.inputTokens,
        output_tokens: usage.completionTokens,
        estimated_cost: costEstimate2,
        actual_cost: costEstimate2,
        baseline_model: DEFAULT_BASELINE_MODEL,
        baseline_cost: baselineCost2,
        savings: baselineCost2 - costEstimate2,
        latency_ms: latencyMs2,
        fallback_attempts: Math.max(0, attempts.length - 1),
        fallback_used: fallbackUsed,
        quality_fallback_used: qualityFallbackUsed,
        validator_result: validator.result,
        ...validator.qualityScore !== void 0 && { quality_score: validator.qualityScore },
        cache_hit: false,
        ...lastErrorCategory && { error_category: lastErrorCategory }
      };
      await appendLedgerEntry(ledgerEntry);
      if (acuEvaluation) {
        try {
          ctx.acuStore?.recordAttempts(requestId, attempts);
          ctx.acuStore?.finalizeRequest(requestId, {
            actualModel: actualModelUsed,
            inputTokens: usage.inputTokens,
            outputTokens: usage.completionTokens,
            actualCost: totalAcuCost,
            latencyMs: latencyMs2,
            finalStatus: "completed",
            errorCategory: lastErrorCategory,
            visibleOutputTokens: usage.visibleOutputTokens,
            completionTokens: usage.completionTokens,
            reasoningTokens: usage.reasoningTokens,
            cachedInputTokens: usage.cachedInputTokens,
            usageSource: usage.usageSource,
            usageRawKeys: usage.usageRawKeys,
            inputPricePerMillion: usage.inputPricePerMillion,
            outputPricePerMillion: usage.outputPricePerMillion,
            modelCallCost: usage.modelCallCost,
            totalAcuCost,
            executionProfileId: finalExecutionProfile.executionProfileId,
            thinkingMode: finalExecutionProfile.thinkingMode,
            requestParameterApplied: finalExecutionProfile.requestParameterApplied,
            upstreamModel: upstreamModelFromBody(responseBody, actualModelUsed)
          });
          if (validator.result !== "not_applicable") {
            ctx.acuStore?.recordOutcome({
              requestId,
              validatorResult: validator.result,
              outcomeSource: "validator",
              outcomeScore: validator.result === "pass" ? 1 : 0,
              executionProfileId: finalExecutionProfile.executionProfileId
            });
          }
          if (attempts.length > 1) {
            ctx.acuStore?.recordOutcome({ requestId, retryCount: attempts.length - 1, outcomeSource: "retry_signal", executionProfileId: finalExecutionProfile.executionProfileId });
          }
          if (actualModelUsed !== routingDecision?.model) {
            ctx.acuStore?.recordOutcome({ requestId, modelSwitched: true, outcomeSource: "model_upgrade_signal", executionProfileId: finalExecutionProfile.executionProfileId });
          }
        } catch {
        }
      }
    }
    if (isStreaming && canWrite(res)) {
      let parsed;
      try {
        parsed = JSON.parse(responseBody);
      } catch {
        const errorPayload = JSON.stringify({
          error: {
            message: "Upstream response could not be parsed",
            type: "proxy_error"
          }
        });
        safeWrite(res, `data: ${errorPayload}

data: [DONE]

`);
        res.end();
        ctx.deduplicator.removeInflight(dedupKey);
        return;
      }
      const chunk = {
        id: parsed.id || `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: parsed.created || Math.floor(Date.now() / 1e3),
        model: parsed.model || actualModelUsed,
        choices: Array.isArray(parsed.choices) ? parsed.choices.map((c, idx) => ({
          index: idx,
          delta: { role: "assistant", content: c.message?.content || "" },
          finish_reason: null
        })) : []
      };
      safeWrite(res, `data: ${JSON.stringify(chunk)}

`);
      const finishChunk = { ...chunk, choices: chunk.choices.map((c) => ({ ...c, delta: {}, finish_reason: "stop" })) };
      safeWrite(res, `data: ${JSON.stringify(finishChunk)}

`);
      if (debugMode) {
        const estimatedInputTokens2 = Math.ceil(body.length / 4);
        const costs = calculateModelCost(actualModelUsed, ctx.routerOpts.modelPricing, estimatedInputTokens2, maxTokens, routingProfile ?? void 0);
        const trace = buildStreamingTrace({
          requestId,
          routingProfile,
          routingDecision,
          parsedMessages,
          maxTokens,
          config: ctx.routerOpts.config,
          modelId,
          actualModelUsed,
          upstream: upstreamProviderUsed || getUpstream(actualModelUsed),
          modelsToTry,
          attempts,
          estimatedInputTokens: estimatedInputTokens2,
          estimatedOutputTokens: maxTokens,
          costs
        });
        if (acuEvaluation) {
          setAcuExecutionResult(acuEvaluation, acuRecommendationSelected, actualModelUsed);
          trace.acu_demo = acuEvaluation;
        }
        safeWrite(res, `event: acu_trace
data: ${JSON.stringify(trace)}

`);
      }
      safeWrite(res, "data: [DONE]\n\n");
    } else if (!isStreaming) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(responseBody);
    }
  }
  if (isStreaming && canWrite(res)) {
    res.end();
  }
  const latencyMs = Date.now() - startTime;
  const estimatedInputTokens = Math.ceil(body.length / 4);
  let costEstimate = 0;
  let baselineCost = 0;
  let savings = 0;
  if (routingDecision) {
    if (actualModelUsed !== routingDecision.model) {
      const costs = calculateModelCost(actualModelUsed, ctx.routerOpts.modelPricing, estimatedInputTokens, maxTokens, routingProfile ?? void 0);
      costEstimate = costs.costEstimate;
      baselineCost = costs.baselineCost;
      savings = costs.savings;
    } else {
      costEstimate = routingDecision.costEstimate;
      baselineCost = routingDecision.baselineCost;
      savings = routingDecision.savings;
    }
  }
  logUsage({
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    model: actualModelUsed,
    tier: routingDecision?.tier ?? "EXPLICIT",
    cost: costEstimate,
    baselineCost,
    savings,
    latencyMs
  }).catch(() => {
  });
  if (acuEvaluation && isStreaming) {
    try {
      const streamingUsage = parseUsage(responseBody, estimatedInputTokens, maxTokens, ctx.routerOpts.modelPricing.get(actualModelUsed));
      const streamingTotalAcuCost = streamingUsage.modelCallCost + acuEvaluation.judgeCost;
      const finalAttempt = [...attempts].reverse().find((attempt) => attempt.model === actualModelUsed && attempt.status === "success");
      if (finalAttempt) {
        finalAttempt.reasoning_tokens = streamingUsage.reasoningTokens;
        finalAttempt.upstream_model = upstreamModelFromBody(responseBody, actualModelUsed);
      }
      const finalProfile = finalAttempt ?? attemptProfileFields(actualModelUsed, body, "initial");
      ctx.acuStore?.recordAttempts(requestId, attempts);
      ctx.acuStore?.finalizeRequest(requestId, {
        actualModel: actualModelUsed,
        inputTokens: streamingUsage.inputTokens,
        outputTokens: streamingUsage.completionTokens,
        actualCost: streamingTotalAcuCost,
        latencyMs,
        finalStatus: "completed_streaming",
        errorCategory: lastErrorCategory,
        visibleOutputTokens: streamingUsage.visibleOutputTokens,
        completionTokens: streamingUsage.completionTokens,
        reasoningTokens: streamingUsage.reasoningTokens,
        cachedInputTokens: streamingUsage.cachedInputTokens,
        usageSource: streamingUsage.usageSource,
        usageRawKeys: streamingUsage.usageRawKeys,
        inputPricePerMillion: streamingUsage.inputPricePerMillion,
        outputPricePerMillion: streamingUsage.outputPricePerMillion,
        modelCallCost: streamingUsage.modelCallCost,
        totalAcuCost: streamingTotalAcuCost,
        executionProfileId: finalProfile.execution_profile_id,
        thinkingMode: finalProfile.thinking_mode,
        requestParameterApplied: finalProfile.request_parameter_applied,
        upstreamModel: upstreamModelFromBody(responseBody, actualModelUsed)
      });
    } catch {
    }
  }
  if (allowResponseCache && responseBody && responseBody.length < 1048576) {
    ctx.responseCache.set(dedupKey, { body: Buffer.from(responseBody), status: 200, headers: { "Content-Type": contentType }, model: actualModelUsed });
  }
  ctx.deduplicator.complete(dedupKey, {
    status: 200,
    headers: { "Content-Type": contentType },
    body: Buffer.from(responseBody),
    completedAt: Date.now()
  });
  console.log(`[ClawRouter] ${actualModelUsed} \u2192 ${latencyMs}ms ($${costEstimate.toFixed(4)})`);
}
function getProxyPort() {
  return PROXY_PORT;
}

// src/auth.ts
import { readFileSync as readFileSync2, existsSync as existsSync2, writeFileSync as writeFileSync2, mkdirSync as mkdirSync3 } from "fs";
import { join as join6 } from "path";
import { homedir as homedir5 } from "os";
import { randomBytes } from "crypto";
var CONFIG_DIR = join6(homedir5(), ".claw-router");
function resolveApiKey() {
  const envKey = process.env.OPENROUTER_API_KEY;
  if (envKey?.trim()) return envKey.trim();
  const keyFile = join6(CONFIG_DIR, "api-key");
  if (existsSync2(keyFile)) {
    const key = readFileSync2(keyFile, "utf-8").trim();
    if (key) return key;
  }
  throw new Error("OPENROUTER_API_KEY not set. Set env var or save to ~/.claw-router/api-key");
}
function resolveProxyApiKey() {
  return process.env.PROXY_API_KEY?.trim() || void 0;
}
function resolveProxyBaseUrl() {
  return process.env.PROXY_BASE_URL?.trim() || void 0;
}
function saveApiKey(key) {
  mkdirSync3(CONFIG_DIR, { recursive: true });
  writeFileSync2(join6(CONFIG_DIR, "api-key"), key.trim() + "\n", { mode: 384 });
  console.log(`[ClawRouter] API key saved to ${join6(CONFIG_DIR, "api-key")}`);
}

// src/cli.ts
function printHelp() {
  console.log(`
ClawRouter v${VERSION} \u2014 Smart LLM Router (OpenRouter Edition)

Usage:
  clawrouter [options]
  clawrouter setup                     Save OpenRouter API key
  clawrouter models                    List available models
  clawrouter stats [--days <n>]        Usage stats (default: 7 days)
  clawrouter stats clear               Clear all usage logs

Options:
  --version, -v     Show version number
  --help, -h        Show this help message
  --port <number>   Port to listen on (default: ${getProxyPort()})

Environment:
  OPENROUTER_API_KEY    OpenRouter API key (or save via: clawrouter setup)

For more info: https://github.com/jerry0012009/ClawRouter
`);
}
async function queryProxy(path, port, method = "GET") {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    printHelp();
    return;
  }
  const command = args[0];
  const portArg = args.indexOf("--port");
  const port = portArg >= 0 ? parseInt(args[portArg + 1], 10) : getProxyPort();
  switch (command) {
    case "setup": {
      const readline = await import("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const key = await new Promise((resolve) => {
        rl.question("Enter your OpenRouter API key: ", (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      });
      if (!key) {
        console.error("No key entered.");
        process.exit(1);
      }
      saveApiKey(key);
      console.log("\u2713 API key saved. Run `clawrouter` to start the proxy.");
      return;
    }
    case "models": {
      console.log(`
Available Models (${BLOCKRUN_MODELS.length}):
`);
      const categories = {};
      for (const m of BLOCKRUN_MODELS) {
        const provider = m.id.split("/")[0];
        if (!categories[provider]) categories[provider] = [];
        categories[provider].push(m);
      }
      for (const [provider, models] of Object.entries(categories)) {
        console.log(`  ${provider.toUpperCase()}`);
        for (const m of models) {
          const flags = [];
          if (m.reasoning) flags.push("reasoning");
          if (m.input.includes("image")) flags.push("vision");
          const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
          console.log(`    ${m.id.padEnd(40)} $${m.cost.input}/$${m.cost.output} per 1M tokens${flagStr}`);
        }
        console.log();
      }
      console.log("Aliases:");
      const aliasGroups = /* @__PURE__ */ new Map();
      for (const [alias, model] of Object.entries(MODEL_ALIASES)) {
        if (!aliasGroups.has(model)) aliasGroups.set(model, []);
        aliasGroups.get(model).push(alias);
      }
      for (const [model, aliases] of aliasGroups) {
        console.log(`  ${model.padEnd(40)} \u2192 ${aliases.join(", ")}`);
      }
      return;
    }
    case "stats": {
      try {
        if (args[1] === "clear") {
          const result = await queryProxy("/stats", port, "DELETE");
          console.log("Stats cleared.");
          return;
        }
        const days = args.includes("--days") ? parseInt(args[args.indexOf("--days") + 1], 10) : 7;
        const stats = await queryProxy(`/stats?days=${days}`, port);
        console.log(`
Usage Stats (${days} days):
`);
        console.log(JSON.stringify(stats, null, 2));
      } catch (err) {
        console.error(`Failed to get stats: ${err instanceof Error ? err.message : err}`);
        console.error("Is the proxy running? Start it with: clawrouter");
      }
      return;
    }
    case "status": {
      try {
        const health = await queryProxy("/health", port);
        console.log(`
Proxy Status:
`);
        console.log(JSON.stringify(health, null, 2));
      } catch {
        console.error("Proxy not running. Start it with: clawrouter");
      }
      return;
    }
    default: {
      if (command.startsWith("--")) {
        printHelp();
        return;
      }
      console.error(`Unknown command: ${command}`);
      console.error("Run `clawrouter --help` for usage.");
      process.exit(1);
    }
  }
}
async function startDirect() {
  const args = process.argv.slice(2);
  const hasCommand = args.length > 0 && !args[0].startsWith("--");
  if (hasCommand) {
    await main();
    return;
  }
  const portArg = args.indexOf("--port");
  const port = portArg >= 0 ? parseInt(args[portArg + 1], 10) : getProxyPort();
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  let apiKey;
  try {
    apiKey = resolveApiKey();
  } catch (err) {
    console.error(`
  ${err instanceof Error ? err.message : err}
`);
    console.error("  Set OPENROUTER_API_KEY or run: clawrouter setup\n");
    process.exit(1);
  }
  const proxy = await startProxy({ apiKey, proxyApiKey: resolveProxyApiKey(), proxyBaseUrl: resolveProxyBaseUrl(), port });
  const shutdown = async () => {
    console.log("\n[ClawRouter] Shutting down...");
    await proxy.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
startDirect().catch((err) => {
  console.error(`[ClawRouter] Fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
//# sourceMappingURL=cli.js.map