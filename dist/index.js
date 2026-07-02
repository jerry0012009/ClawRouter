import { createRequire as __cjs_createRequire } from 'node:module'; const require = __cjs_createRequire(import.meta.url);
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/proxy.ts
import { createServer } from "http";
import { createHash as createHash4, randomUUID } from "crypto";

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
  // Benchmark-tuned 2026-03-16: balancing quality (retention) + latency
  // ── Tier Configs (verified working models only) ──
  tiers: {
    SIMPLE: {
      primary: "meta-llama/llama-3.3-70b-instruct",
      fallback: [
        "openai/gpt-oss-20b:free",
        "nvidia/nemotron-3-super-120b-a12b:free",
        "google/gemma-4-26b-a4b-it:free"
      ]
    },
    MEDIUM: {
      primary: "qwen/qwen3-235b-a22b",
      fallback: [
        "deepseek/deepseek-chat-v3-0324",
        "meta-llama/llama-3.3-70b-instruct",
        "nvidia/nemotron-3-super-120b-a12b:free"
      ]
    },
    COMPLEX: {
      primary: "deepseek/deepseek-chat-v3-0324",
      fallback: [
        "meta-llama/llama-4-maverick",
        "qwen/qwen3-235b-a22b",
        "nvidia/nemotron-3-super-120b-a12b:free"
      ]
    },
    REASONING: {
      primary: "liquid/lfm-2.5-1.2b-thinking:free",
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
      primary: "meta-llama/llama-4-maverick",
      fallback: ["deepseek/deepseek-chat-v3-0324", "qwen/qwen3-235b-a22b"]
    },
    MEDIUM: {
      primary: "deepseek/deepseek-chat-v3-0324",
      fallback: ["meta-llama/llama-4-maverick", "qwen/qwen3-235b-a22b"]
    },
    COMPLEX: {
      primary: "deepseek/deepseek-chat-v3-0324",
      fallback: ["meta-llama/llama-4-maverick", "qwen/qwen3-235b-a22b"]
    },
    REASONING: {
      primary: "liquid/lfm-2.5-1.2b-thinking:free",
      fallback: ["deepseek/deepseek-chat-v3-0324"]
    }
  },
  // Agentic tier — models with tool use support
  agenticTiers: {
    SIMPLE: {
      primary: "meta-llama/llama-3.3-70b-instruct",
      fallback: ["qwen/qwen3-235b-a22b"]
    },
    MEDIUM: {
      primary: "deepseek/deepseek-chat-v3-0324",
      fallback: ["meta-llama/llama-4-maverick", "qwen/qwen3-235b-a22b"]
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
    id: "gpt-5.5",
    name: "GPT-5.5",
    upstream: "proxy",
    useMaxCompletionTokens: true,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 30, cacheRead: 2.5, cacheWrite: 5 },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  {
    id: "gpt-5.4-nano",
    name: "GPT-5.4 Nano",
    upstream: "proxy",
    useMaxCompletionTokens: true,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.2, output: 1.25, cacheRead: 0.1, cacheWrite: 0.2 },
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
    cost: { input: 0.75, output: 4.5, cacheRead: 0.375, cacheWrite: 0.75 },
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
    cost: { input: 10, output: 40, cacheRead: 2.5, cacheWrite: 10 },
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
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
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
    cost: { input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0.15 },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    upstream: "proxy",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.25, output: 10, cacheRead: 0.3125, cacheWrite: 1.25 },
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
    cost: { input: 0.25, output: 1.5, cacheRead: 0.125, cacheWrite: 0.25 },
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
    cost: { input: 1.5, output: 9, cacheRead: 0.75, cacheWrite: 1.5 },
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
    cost: { input: 0.15, output: 0.3, cacheRead: 0.07, cacheWrite: 0.15 },
    contextWindow: 163840,
    maxTokens: 163840
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    upstream: "proxy",
    reasoning: true,
    input: ["text"],
    cost: { input: 1.8, output: 3.6, cacheRead: 0.9, cacheWrite: 1.8 },
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
    cost: { input: 1.2, output: 4.2, cacheRead: 0.6, cacheWrite: 1.2 },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  {
    id: "glm-5.1",
    name: "GLM 5.1",
    upstream: "proxy",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.9, output: 3.5, cacheRead: 0.45, cacheWrite: 0.9 },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  {
    id: "glm-5",
    name: "GLM 5",
    upstream: "proxy",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.6, output: 2.7, cacheRead: 0.3, cacheWrite: 0.6 },
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
    cost: { input: 0.5, output: 1.54, cacheRead: 0.07, cacheWrite: 0.5 },
    contextWindow: 163840,
    maxTokens: 163840
  },
  {
    id: "deepseek/deepseek-r1",
    name: "DeepSeek R1 (OR)",
    upstream: "openrouter",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
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
    cost: { input: 0.2, output: 0.6, cacheRead: 0.05, cacheWrite: 0.2 },
    contextWindow: 1048576,
    maxTokens: 32768
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct",
    name: "Llama 3.3 70B",
    upstream: "openrouter",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.1, output: 0.1, cacheRead: 0.025, cacheWrite: 0.1 },
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
    cost: { input: 0.2, output: 0.6, cacheRead: 0.1, cacheWrite: 0.2 },
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
    cost: { input: 3, output: 15, cacheRead: 1.5, cacheWrite: 3 },
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
var OPENCLAW_MODELS = BLOCKRUN_MODELS;
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
function buildProviderModels(baseUrl) {
  return { baseUrl, api: "openai-completions", models: BLOCKRUN_MODELS.map((m) => ({ ...m, headers: {} })) };
}
function supportsToolCalling(modelId) {
  return !(/* @__PURE__ */ new Set(["liquid/lfm-2.5-1.2b-thinking:free"])).has(modelId);
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
function hashRequestContent(lastUserContent, toolCallNames) {
  const normalized = lastUserContent.replace(/\s+/g, " ").trim().slice(0, 500);
  const toolSuffix = toolCallNames?.length ? `|tools:${toolCallNames.sort().join(",")}` : "";
  return createHash3("sha256").update(normalized + toolSuffix).digest("hex").slice(0, 12);
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
var LEDGER_DIR = join4(homedir3(), ".claw-router", "ledger");
async function ensureLedgerDir() {
  await mkdir2(LEDGER_DIR, { recursive: true });
}
function ledgerFileFor(date) {
  return join4(LEDGER_DIR, `${date}.jsonl`);
}
async function getLedgerFiles() {
  try {
    const files = await readdir2(LEDGER_DIR);
    return files.filter((file) => file.endsWith(".jsonl")).sort().reverse();
  } catch {
    return [];
  }
}
async function readLedgerFile(file) {
  try {
    const text = await readTextFile(join4(LEDGER_DIR, file));
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
    if (entry.fallback_attempts > 0) fallback_count++;
    if (entry.validator_result !== "not_applicable") {
      validator_total++;
      if (entry.validator_result === "pass") validator_pass++;
    }
    addGroup(by_model, entry.actual_model_used || "unknown", entry);
    addGroup(by_tier, entry.tier || "UNKNOWN", entry);
    addGroup(by_task_type, entry.task_type || "unknown", entry);
  }
  const total_requests = entries.length;
  return {
    total_requests,
    total_cost,
    total_baseline_cost,
    total_savings: total_baseline_cost - total_cost,
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
      await unlink2(join4(LEDGER_DIR, file));
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
  if (responseFormat || expectedSchema) return true;
  const prompt = messages.map((message) => textFromContent(message.content)).join("\n").toLowerCase();
  return /\bjson\b|schema|structured|fields?|字段|结构化|表格|提取/.test(prompt);
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
    return { result: "fail", validator: "json_validator", reason: "No JSON object or array found" };
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
    return { result: "pass", validator: "schema_validator" };
  }
  return { result: "pass", validator: "json_validator" };
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
var ACU_PREFIX = "/acu-router";
var DEFAULT_BASELINE_MODEL = "claude-opus-4-7";
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
function stripAcuPrefix(url) {
  if (!url?.startsWith(ACU_PREFIX)) return url || "/";
  const stripped = url.slice(ACU_PREFIX.length);
  if (!stripped) return "/";
  if (stripped.startsWith("?")) return `/${stripped}`;
  return stripped;
}
function getPathname(url) {
  return new URL(url, "http://localhost").pathname;
}
function hashPrompt(messages) {
  const text = messages.map((message) => JSON.stringify(message.content ?? "")).join("\n");
  return createHash4("sha256").update(text).digest("hex").slice(0, 24);
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
function extractAssistantText(responseBody) {
  try {
    const parsed = JSON.parse(responseBody);
    const content = parsed.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  } catch {
    return "";
  }
}
function parseUsage(responseBody, estimatedInputTokens, estimatedOutputTokens) {
  try {
    const parsed = JSON.parse(responseBody);
    return {
      inputTokens: parsed.usage?.prompt_tokens ?? parsed.usage?.input_tokens ?? estimatedInputTokens,
      outputTokens: parsed.usage?.completion_tokens ?? parsed.usage?.output_tokens ?? estimatedOutputTokens
    };
  } catch {
    return { inputTokens: estimatedInputTokens, outputTokens: estimatedOutputTokens };
  }
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
function selectQualityFallbackModel(routingDecision, routingConfig, actualModelUsed, modelsTried) {
  if (!routingDecision) return void 0;
  const premiumTiers = routingConfig.premiumTiers ?? routingConfig.tiers;
  const premiumChain = getFallbackChain(routingDecision.tier, premiumTiers);
  return premiumChain.find((model) => model !== actualModelUsed && !modelsTried.includes(model));
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
  return BLOCKRUN_MODELS.map((m) => ({
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
  }));
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
  const apiKey = options.apiKey;
  const port = options.port ?? PROXY_PORT;
  let boundPort = port;
  const routingConfig = mergeRoutingConfig(options.routingConfig);
  validateRoutingConfigModels(routingConfig);
  const modelPricing = buildModelPricing();
  const routerOpts = { config: routingConfig, modelPricing };
  const deduplicator = new RequestDeduplicator();
  const responseCache = new ResponseCache(options.cacheConfig);
  const sessionStore = new SessionStore(options.sessionConfig);
  const sessionJournal = new SessionJournal();
  const excludeList = loadExcludeList();
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, {
        apiKey,
        proxyApiKey: options.proxyApiKey,
        proxyBaseUrl: options.proxyBaseUrl,
        routerOpts,
        deduplicator,
        responseCache,
        sessionStore,
        sessionJournal,
        excludeList,
        onRouted: options.onRouted
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
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
async function handleRequest(req, res, ctx) {
  req.url = stripAcuPrefix(req.url);
  const pathname = getPathname(req.url);
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: VERSION, models: BLOCKRUN_MODELS.length }));
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
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html" || pathname.startsWith("/public/"))) {
    const { readFileSync: readFileSync2, existsSync: existsSync3 } = await import("fs");
    const { join: join7, dirname: dirname3 } = await import("path");
    const { fileURLToPath: fileURLToPath3 } = await import("url");
    const __dirname2 = dirname3(fileURLToPath3(import.meta.url));
    const publicDir = join7(__dirname2, "..", "public");
    const filePath = pathname === "/" || pathname === "/index.html" ? join7(publicDir, "index.html") : join7(publicDir, pathname.replace("/public/", ""));
    if (existsSync3(filePath)) {
      const ext = filePath.split(".").pop() || "html";
      const mime = { html: "text/html", css: "text/css", js: "application/javascript", json: "application/json", png: "image/png", svg: "image/svg+xml" };
      res.writeHead(200, { "Content-Type": mime[ext] || "text/plain" });
      res.end(readFileSync2(filePath));
      return;
    }
  }
  if (!pathname.includes("/chat/completions")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Not found: ${req.url}`, type: "not_found" } }));
    return;
  }
  const startTime = Date.now();
  const requestId = randomUUID();
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
  let hasTools = false;
  let hasVision = false;
  let bodyModified = false;
  const sessionId = getSessionId(req.headers);
  let effectiveSessionId = sessionId;
  const parsedMessages = [];
  let responseFormat;
  let expectedSchema;
  try {
    const parsed = JSON.parse(body.toString());
    isStreaming = parsed.stream === true;
    modelId = parsed.model || "";
    maxTokens = parsed.max_tokens || 4096;
    responseFormat = parsed.response_format;
    expectedSchema = parsed.expected_schema;
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
      const rawPrompt = lastUserMsg?.content;
      const prompt = typeof rawPrompt === "string" ? rawPrompt : Array.isArray(rawPrompt) ? rawPrompt.filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ") : "";
      const systemMsg = messages.find((m) => m.role === "system");
      const systemPrompt = typeof systemMsg?.content === "string" ? systemMsg.content : void 0;
      effectiveSessionId = sessionId ?? deriveSessionId(messages);
      const existingSession = effectiveSessionId ? ctx.sessionStore.getSession(effectiveSessionId) : void 0;
      routingDecision = route(prompt, systemPrompt, maxTokens, {
        ...ctx.routerOpts,
        routingProfile: routingProfile ?? void 0,
        hasTools
      });
      if (existingSession?.userExplicit) {
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
    if (isGoogleModel(modelId) && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForGoogle(parsed.messages);
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
  const respCached = ctx.responseCache.get(dedupKey);
  if (respCached) {
    const headers = { "Content-Type": "application/json", "X-Cache-Hit": "true" };
    res.writeHead(200, headers);
    res.end(respCached.body);
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
    console.log(`[ClawRouter] Trying ${i + 1}/${modelsToTry.length}: ${tryModel}`);
    const attemptStart = Date.now();
    const perAttemptTimeout = timeoutForModel(tryModel);
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
        model: tryModel,
        upstream: upstreamProvider,
        status: "error",
        error_category: lastErrorCategory,
        latency_ms: Date.now() - attemptStart
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
      let validator = validateAssistantOutput({
        messages: parsedMessages,
        assistantText: extractAssistantText(responseBody),
        responseFormat,
        expectedSchema
      });
      let qualityFallbackUsed = false;
      if (validator.result === "fail" && routingDecision) {
        const qualityFallbackModel = selectQualityFallbackModel(
          routingDecision,
          ctx.routerOpts.config,
          actualModelUsed,
          attempts.map((attempt) => attempt.model)
        );
        if (qualityFallbackModel) {
          const qualityStart = Date.now();
          const qualityController = new AbortController();
          const qualityTimeout = setTimeout(() => qualityController.abort(), timeoutForModel(qualityFallbackModel));
          try {
            const { response, upstreamProvider } = await fetchUpstreamChatCompletion({
              body,
              model: qualityFallbackModel,
              apiKey: ctx.apiKey,
              proxyApiKey: ctx.proxyApiKey,
              proxyBaseUrl: ctx.proxyBaseUrl,
              signal: AbortSignal.any([globalController.signal, qualityController.signal])
            });
            if (response.status === 200) {
              responseBody = await readResponseText(response);
              actualModelUsed = qualityFallbackModel;
              upstreamProviderUsed = upstreamProvider;
              qualityFallbackUsed = true;
              attempts.push({
                model: qualityFallbackModel,
                upstream: upstreamProvider,
                status: "success",
                latency_ms: Date.now() - qualityStart
              });
              validator = validateAssistantOutput({
                messages: parsedMessages,
                assistantText: extractAssistantText(responseBody),
                responseFormat,
                expectedSchema
              });
            } else {
              const errorBody = await response.text().catch(() => "");
              const category = categorizeError(response.status, errorBody) ?? "validation_fallback_error";
              lastErrorCategory = category;
              attempts.push({
                model: qualityFallbackModel,
                upstream: upstreamProvider,
                status: "error",
                error_category: category,
                latency_ms: Date.now() - qualityStart
              });
            }
          } catch (err) {
            const category = qualityController.signal.aborted ? "timeout" : "validation_fallback_error";
            lastErrorCategory = category;
            attempts.push({
              model: qualityFallbackModel,
              upstream: "unknown",
              status: qualityController.signal.aborted ? "timeout" : "error",
              error_category: category,
              latency_ms: Date.now() - qualityStart
            });
          } finally {
            clearTimeout(qualityTimeout);
          }
        }
      }
      const latencyMs2 = Date.now() - startTime;
      const estimatedInputTokens2 = Math.ceil(body.length / 4);
      const usage = parseUsage(responseBody, estimatedInputTokens2, maxTokens);
      let costEstimate2 = 0;
      let baselineCost2 = 0;
      let savings2 = 0;
      if (routingDecision) {
        if (actualModelUsed !== routingDecision.model) {
          const costs = calculateModelCost(actualModelUsed, ctx.routerOpts.modelPricing, usage.inputTokens, usage.outputTokens, routingProfile ?? void 0);
          costEstimate2 = costs.costEstimate;
          baselineCost2 = costs.baselineCost;
          savings2 = costs.savings;
        } else {
          const costs = calculateModelCost(actualModelUsed, ctx.routerOpts.modelPricing, usage.inputTokens, usage.outputTokens, routingProfile ?? void 0);
          costEstimate2 = costs.costEstimate;
          baselineCost2 = costs.baselineCost;
          savings2 = costs.savings;
        }
      } else {
        const costs = calculateModelCost(actualModelUsed, ctx.routerOpts.modelPricing, usage.inputTokens, usage.outputTokens);
        costEstimate2 = costs.costEstimate;
        baselineCost2 = costs.baselineCost;
        savings2 = costs.savings;
      }
      const trace = {
        request_id: requestId,
        profile: routingProfile ?? "explicit",
        tier: routingDecision?.tier ?? "EXPLICIT",
        confidence: routingDecision?.confidence ?? 1,
        method: routingDecision?.method ?? "explicit",
        signals: [],
        ...routingDecision?.agenticScore !== void 0 && { agentic_score: routingDecision.agenticScore },
        selected_model: routingDecision?.model ?? modelId,
        actual_model_used: actualModelUsed,
        upstream: upstreamProviderUsed || getUpstream(actualModelUsed),
        fallback_chain: modelsToTry,
        attempts,
        estimated_input_tokens: usage.inputTokens,
        estimated_output_tokens: usage.outputTokens,
        estimated_cost: costEstimate2,
        baseline_model: DEFAULT_BASELINE_MODEL,
        baseline_cost: baselineCost2,
        estimated_savings: savings2,
        route_reasoning: routingDecision?.reasoning ?? "Explicit model request",
        validator_result: validator.result,
        validator_pass: validator.result === "pass",
        ...validator.reason && { validator_reason: validator.reason },
        ...qualityFallbackUsed && { validator_reason: validator.reason ?? "quality_fallback" }
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
        output_tokens: usage.outputTokens,
        estimated_cost: costEstimate2,
        actual_cost: costEstimate2,
        baseline_model: DEFAULT_BASELINE_MODEL,
        baseline_cost: baselineCost2,
        savings: baselineCost2 - costEstimate2,
        latency_ms: latencyMs2,
        fallback_attempts: Math.max(0, attempts.length - 1),
        validator_result: validator.result,
        ...validator.qualityScore !== void 0 && { quality_score: validator.qualityScore },
        cache_hit: false,
        ...lastErrorCategory && { error_category: lastErrorCategory }
      };
      await appendLedgerEntry(ledgerEntry);
    }
    if (isStreaming && canWrite(res)) {
      const parsed = JSON.parse(responseBody);
      const chunk = {
        id: parsed.id || `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: parsed.created || Math.floor(Date.now() / 1e3),
        model: parsed.model || actualModelUsed,
        choices: parsed.choices?.map((c, idx) => ({
          index: idx,
          delta: { role: "assistant", content: c.message?.content || "" },
          finish_reason: null
        })) || []
      };
      safeWrite(res, `data: ${JSON.stringify(chunk)}

`);
      const finishChunk = { ...chunk, choices: chunk.choices.map((c) => ({ ...c, delta: {}, finish_reason: "stop" })) };
      safeWrite(res, `data: ${JSON.stringify(finishChunk)}

`);
      if (debugMode) {
        const estimatedInputTokens2 = Math.ceil(body.length / 4);
        const costs = calculateModelCost(actualModelUsed, ctx.routerOpts.modelPricing, estimatedInputTokens2, maxTokens, routingProfile ?? void 0);
        const trace = {
          request_id: requestId,
          profile: routingProfile ?? "explicit",
          tier: routingDecision?.tier ?? "EXPLICIT",
          confidence: routingDecision?.confidence ?? 1,
          method: routingDecision?.method ?? "explicit",
          signals: [],
          selected_model: routingDecision?.model ?? modelId,
          actual_model_used: actualModelUsed,
          upstream: upstreamProviderUsed || getUpstream(actualModelUsed),
          fallback_chain: modelsToTry,
          attempts,
          estimated_input_tokens: estimatedInputTokens2,
          estimated_output_tokens: maxTokens,
          estimated_cost: costs.costEstimate,
          baseline_model: DEFAULT_BASELINE_MODEL,
          baseline_cost: costs.baselineCost,
          estimated_savings: costs.savings,
          route_reasoning: routingDecision?.reasoning ?? "Explicit model request",
          validator_result: "not_applicable"
        };
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
  if (responseBody && responseBody.length < 1048576) {
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

// src/provider.ts
var activeProxy = null;
function setActiveProxy(proxy) {
  activeProxy = proxy;
}
var blockrunProvider = {
  id: "blockrun",
  label: "ClawRouter",
  docsPath: "https://github.com/jerry0012009/ClawRouter",
  aliases: ["cr", "clawrouter"],
  envVars: ["OPENROUTER_API_KEY"],
  get models() {
    const port = activeProxy?.port ?? getProxyPort();
    return buildProviderModels(`http://127.0.0.1:${port}/v1`);
  },
  // No auth required — the proxy handles API key internally
  auth: []
};

// src/auth.ts
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join as join5 } from "path";
import { homedir as homedir4 } from "os";
var CONFIG_DIR = join5(homedir4(), ".claw-router");
function resolveApiKey() {
  const envKey = process.env.OPENROUTER_API_KEY;
  if (envKey?.trim()) return envKey.trim();
  const keyFile = join5(CONFIG_DIR, "api-key");
  if (existsSync(keyFile)) {
    const key = readFileSync(keyFile, "utf-8").trim();
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
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(join5(CONFIG_DIR, "api-key"), key.trim() + "\n", { mode: 384 });
  console.log(`[ClawRouter] API key saved to ${join5(CONFIG_DIR, "api-key")}`);
}

// src/index.ts
import { existsSync as existsSync2, readdirSync, mkdirSync as mkdirSync2, copyFileSync } from "fs";
import { homedir as homedir5 } from "os";
import { join as join6, dirname as dirname2 } from "path";
import { fileURLToPath as fileURLToPath2 } from "url";
function getPackageRoot() {
  return join6(dirname2(fileURLToPath2(import.meta.url)), "..");
}
function installSkillsToWorkspace(logger) {
  try {
    const packageRoot = getPackageRoot();
    const bundledSkillsDir = join6(packageRoot, "skills");
    if (!existsSync2(bundledSkillsDir)) return;
    const profile = (process["env"].OPENCLAW_PROFILE ?? "").trim().toLowerCase();
    const workspaceDirName = profile && profile !== "default" ? `workspace-${profile}` : "workspace";
    const workspaceSkillsDir = join6(homedir5(), ".openclaw", workspaceDirName, "skills");
    mkdirSync2(workspaceSkillsDir, { recursive: true });
    const entries = readdirSync(bundledSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const srcSkillFile = join6(bundledSkillsDir, entry.name, "SKILL.md");
      const dstSkillDir = join6(workspaceSkillsDir, entry.name);
      const dstSkillFile = join6(dstSkillDir, "SKILL.md");
      if (!existsSync2(srcSkillFile)) continue;
      if (existsSync2(dstSkillFile)) {
        const src = __require("fs").readFileSync(srcSkillFile, "utf-8");
        const dst = __require("fs").readFileSync(dstSkillFile, "utf-8");
        if (src === dst) continue;
      }
      mkdirSync2(dstSkillDir, { recursive: true });
      copyFileSync(srcSkillFile, dstSkillFile);
      logger.info(`Installed skill: ${entry.name}`);
    }
  } catch (err) {
    logger.warn(`Skill install failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
var plugin = {
  reload: { noopPrefixes: ["models.providers.blockrun"] },
  async register(api) {
    api.registerProvider(blockrunProvider);
  },
  async activate(api) {
    let apiKey;
    try {
      apiKey = resolveApiKey();
    } catch {
      api.logger.warn("OpenRouter API key not set. Set OPENROUTER_API_KEY or save to ~/.claw-router/api-key");
      return;
    }
    const proxy = await startProxy({
      apiKey,
      proxyApiKey: resolveProxyApiKey(),
      proxyBaseUrl: resolveProxyBaseUrl(),
      onRouted: (decision) => {
        api.logger.info(`Routed \u2192 ${decision.model} (${decision.tier}, ${(decision.savings * 100).toFixed(0)}% savings)`);
      }
    });
    setActiveProxy(proxy);
    installSkillsToWorkspace(api.logger);
    api.logger.info(`ClawRouter v${VERSION} active \u2014 proxy on ${proxy.baseUrl}`);
  },
  async deactivate(api) {
    setActiveProxy(null);
    api.logger.info("ClawRouter deactivated");
  }
};
var index_default = plugin;
export {
  BLOCKRUN_MODELS,
  DEFAULT_ROUTING_CONFIG,
  MODEL_ALIASES,
  OPENCLAW_MODELS,
  RequestDeduplicator,
  ResponseCache,
  SessionStore,
  VERSION,
  blockrunProvider,
  buildProviderModels,
  calculateModelCost,
  index_default as default,
  getFallbackChain,
  getModelContextWindow,
  getProxyPort,
  getSessionId,
  hashRequestContent,
  isReasoningModel,
  logUsage,
  resolveApiKey,
  resolveModelAlias,
  route,
  saveApiKey,
  startProxy,
  supportsToolCalling,
  supportsVision
};
//# sourceMappingURL=index.js.map