// @azen/agents — the fleet runner chassis + data-pack builders + versioned
// prompts (docs/phase3/CONTRACTS.md §P3-RUNNER). Every current and future agent
// runs through runAgent: structured-output call, retry-once-on-null, budget
// guard (critical bypass), agent_runs logging + attribution, provider-error
// mapping. Delivery (packages/agents/src/delivery) is a separate workstream.

export {
  runAgent,
  type RunAgentOptions,
  type AgentRunResult,
  type AgentErrorCode,
  type OsAgentKind,
} from "./runner";

export {
  checkBudget,
  type BudgetState,
  type BudgetStatus,
} from "./budget";

export { getAnthropic } from "./anthropic";

// Phase 8 (P8-HEALTH) — additive re-export of the existing Phase-3 WhatsApp
// sender so apps/web's Health escalation reuses the one delivery layer instead
// of reimplementing the Twilio POST (graceful no-key degradation lives there).
export { sendWhatsApp, type SendWhatsAppInput } from "./delivery/index";

export {
  PROMPT_VERSION,
  TONE_RULES,
  withSharedTone,
} from "./prompts/shared";

export {
  buildAgencyDailyPack,
  buildAgencyMonthlyPack,
  type DailyPack,
  type DailyPackAgency,
  type DailyPackAnomaly,
  type DailyPackInsight,
  type DailyPackKpi,
  type DailyPackProject,
  type MonthlyPack,
  type MonthlyKpi,
  type MonthlyRoi,
  type MonthlyProject,
  type MonthlyProjectCost,
  type MonthlyProjectValue,
  type MonthlyInsight,
  type MonthlyWeeklyBrief,
  type MonthlyClient,
  type MonthlyConversationDigest,
  type MonthlyAgentActivity,
  type MonthlyMoneyPoint,
  type MrrBridge,
  type MrrBridgeMove,
} from "./datapack/index";

// Phase 5 (P5-WEEKLY) — the Agency Weekly data pack builder + its shape.
export {
  buildAgencyWeeklyPack,
  type WeeklyPack,
  type WeeklyPackScoreboardKpi,
  type WeeklyPackDailyBrief,
  type WeeklyPackProject,
  type WeeklyPackInsightRef,
  type WeeklyPackCluster,
  type WeeklyPackPriorEdition,
} from "./datapack/agency-weekly";

// Wave 2 (P3-BRIEF) public API — the Daily Brief agent. apps/web's briefs API
// routes import these from the package root (the exports map exposes only "."),
// so they live on the barrel. Additive: no existing export is touched.
export {
  runDailyBrief,
  runDailyBriefDefault,
  resendBrief,
  dailyBriefOutputSchema,
  type DailyBriefOutput,
  type RunDailyBriefOptions,
  type RunDailyBriefResult,
  type ResendBriefOptions,
  type ResendBriefResult,
} from "./agents/daily-brief";

// Phase 5 (P5-CONVO) public API — the conversation clustering agent. jobs/ and
// CLI callers import these from the package root (the exports map exposes only
// "."). Additive: no existing export is touched.
export {
  runConvoClustering,
  runConvoClusteringForOrg,
  runConvoClusteringForOrgDefault,
  buildConvoClusterPack,
  convoClusterOutputSchema,
  convoFingerprint,
  type ConvoClusterOutput,
  type ConvoClusterPack,
  type ConvoConversation,
  type ConvoTrend,
  type RunConvoClusteringOptions,
  type RunConvoClusteringResult,
  type RunConvoClusteringForOrgResult,
} from "./agents/convo-cluster";

// Phase 5 (P5-WEEKLY) — the Weekly Synthesizer agent. jobs/ and CLI callers
// import these from the package root. Additive: no existing export is touched.
export {
  runWeeklySynth,
  runWeeklySynthDefault,
  weeklyOutputSchema,
  type WeeklyOutput,
  type RunWeeklySynthOptions,
  type RunWeeklySynthResult,
} from "./agents/weekly";

// Phase 5 (P5-MONTHLY) — the Monthly Strategist agent (three documents). jobs/
// and CLI callers import these from the package root. Additive: no existing
// export is touched.
export {
  runMonthlyStrategist,
  runMonthlyStrategistDefault,
  monthlyOutputSchema,
  type MonthlyOutput,
  type MonthlyOwnerReport,
  type MonthlyClientReport,
  type MonthlyUpsellDossier,
  type RunMonthlyStrategistOptions,
  type RunMonthlyStrategistResult,
  type MonthlyBriefRef,
} from "./agents/monthly";

// Phase 6 (P6-SCOUT) — the Opportunity Scout agent + its pure-SQL unused-taxonomy
// detector. jobs/ and CLI callers import these from the package root. Additive:
// no existing export is touched.
export {
  runOpportunityScout,
  runOpportunityScoutForOrg,
  runOpportunityScoutForOrgDefault,
  buildScoutPack,
  detectUnusedTaxonomyAreas,
  scoutFingerprint,
  normalizeSlug,
  scoutOutputSchema,
  type ScoutOutput,
  type ScoutOpportunity,
  type ScoutPack,
  type ScoutCandidate,
  type UnusedTaxonomyArea,
  type RunOpportunityScoutOptions,
  type RunOpportunityScoutResult,
  type RunOpportunityScoutForOrgResult,
} from "./agents/scout";

// Phase 6 (P6-GROWTH) — the Upsell Engine agent. jobs/ + CLI + apps/web (the
// growth proposal route) import these from the package root (the exports map
// exposes only "."). Additive: no existing export is touched.
export {
  runUpsellEngine,
  runUpsellEngineDefault,
  buildUpsellPack,
  upsellOutputSchema,
  type UpsellOutput,
  type UpsellPack,
  type UpsellSourceInsight,
  type UpsellEvidenceEvent,
  type RunUpsellEngineOptions,
  type RunUpsellEngineResult,
} from "./agents/upsell";

// Phase 6 (P6-LEARN) — the Industry Learning agent (aggregate anonymized pattern
// pack → knowledge_articles with Voyage embeddings) + the shared Voyage embedding
// helper (apps/web's knowledge retrieval imports embedOne/embedTexts from the
// package root). jobs/ + CLI callers import the runners from here. Additive: no
// existing export is touched.
export {
  runIndustryLearning,
  runIndustryLearningForOrg,
  runIndustryLearningForOrgDefault,
  buildLearnPack,
  learnFingerprint,
  normalizeTitle,
  learnOutputSchema,
  type LearnOutput,
  type LearnArticle,
  type KnowledgeKind,
  type LearnPack,
  type LearnBookingCurvePoint,
  type LearnFaqTopic,
  type LearnConversion,
  type LearnRepeatedPattern,
  type LearnWebResearch,
  type LearnWebCitation,
  type RunIndustryLearningOptions,
  type RunIndustryLearningResult,
  type RunIndustryLearningForOrgResult,
} from "./agents/learn";

// Phase 9 (P9-KB) — the KB-gap miner: content gaps → drafted KB articles +
// bot-improvement briefs written as automation_opportunity insights that flow
// into the Growth pipeline. jobs/ + CLI callers import these from the package
// root. Additive: no existing export is touched.
export {
  runKbGapMiner,
  runKbGapMinerForOrg,
  runKbGapMinerForOrgDefault,
  buildKbGapPack,
  kbGapFingerprint,
  normalizeGapSlug,
  kbGapOutputSchema,
  type KbGapOutput,
  type KbGapDraft,
  type KbGapPack,
  type KbGap,
  type RunKbGapMinerOptions,
  type RunKbGapMinerResult,
  type RunKbGapMinerForOrgResult,
} from "./agents/kb-gaps";

export {
  embedTexts,
  embedOne,
  voyageConfigured,
  type VoyageInputType,
} from "./voyage";
