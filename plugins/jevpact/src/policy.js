import { validateAnswers } from './jev.js';

/** Provisional trial settings, not calibrated accuracy or a model capacity promise. */
export const DEFAULT_POLICY = Object.freeze({
  minInputTokens: 200000,
  minGrowthTokens: 40000,
  minRequests: 3,
  nativeLimitTokens: 450000,
  reserveTokens: 20000,
  reserveRatio: 0.1,
  growthReserveMultiplier: 2,
  minProbability: 0.7,
  minConfidence: 0.35,
  minRelationProbability: 0.6,
  minSupportingProbability: 0.5,
});

const result = (action, reason, kind) => ({ action, reason, kind });
const nonnegative = n => Number.isSafeInteger(n) && n >= 0;

/** Ordering can prove a visibility gap, never that an assistant interpreted a result. */
export function hasUninterpretedActivity(chronology) {
  if (!chronology || !nonnegative(chronology.latestAssistantSequence)) return true;
  const omitted = chronology.latestOmittedActivitySequence;
  return omitted !== null && (!nonnegative(omitted) || omitted > chronology.latestAssistantSequence);
}

export function decide({ usage, baseline, requestsSinceCompact, signals, chronology, timing, config = {} } = {}) {
  const cfg = { ...DEFAULT_POLICY, ...config };
  for (const key of ['minInputTokens', 'minGrowthTokens', 'minRequests', 'reserveTokens', 'nativeLimitTokens']) {
    if (!nonnegative(cfg[key])) throw new TypeError(`Invalid policy setting ${key}`);
  }
  for (const key of ['reserveRatio', 'minProbability', 'minConfidence',
    'minRelationProbability', 'minSupportingProbability']) {
    if (!Number.isFinite(cfg[key]) || cfg[key] < 0 || cfg[key] > 1) throw new TypeError(`Invalid policy setting ${key}`);
  }
  if (!Number.isFinite(cfg.growthReserveMultiplier) || cfg.growthReserveMultiplier < 0) throw new TypeError('Invalid policy setting growthReserveMultiplier');
  if (!usage || !nonnegative(usage.inputTokens) || !Number.isSafeInteger(usage.contextWindow) || usage.contextWindow <= 0 || (usage.recentGrowthTokens !== undefined && !nonnegative(usage.recentGrowthTokens))) {
    return result('wait', 'Current runtime context usage/window is unavailable or invalid', 'ineligible');
  }
  if (!baseline || !nonnegative(baseline.inputTokens) || !nonnegative(requestsSinceCompact)) return result('wait', 'Compaction baseline or request count is unavailable', 'ineligible');
  if (usage.inputTokens < cfg.minInputTokens) return result('wait', 'Below the discretionary compaction floor', 'ineligible');
  if (requestsSinceCompact < cfg.minRequests) return result('wait', 'Too few requests since the last compaction', 'ineligible');
  if (usage.inputTokens - baseline.inputTokens < cfg.minGrowthTokens) return result('wait', 'Too little new context since the last compaction', 'ineligible');
  const limit = cfg.nativeLimitTokens > 0 ? Math.min(usage.contextWindow, cfg.nativeLimitTokens) : usage.contextWindow;
  const reserve = Math.max(cfg.reserveTokens, Math.ceil(limit * cfg.reserveRatio), (usage.recentGrowthTokens ?? 0) * cfg.growthReserveMultiplier);
  if (limit - usage.inputTokens <= reserve) return result('checkpoint', 'Remaining headroom has reached the wrap-up reserve', 'pressure');
  // Without a packet there is nothing to send Jev, so this precedes every signal-seeking wait.
  if (timing?.available === false) return { ...result('wait', 'Source-linked timing evidence is incomplete', 'semantic'), requiresSignals: false };
  if (chronology !== undefined && hasUninterpretedActivity(chronology)) {
    return result('wait', 'No visible assistant message follows the latest omitted activity, or chronology is unavailable', 'semantic');
  }
  if (timing?.prompted) return { ...result('wait', 'Controller-prompted wrap-up is not an independent checkpoint', 'semantic'), requiresSignals: false };
  if (signals && Object.hasOwn(signals, 'relation')) {
    let answers;
    try { answers = validateAnswers(signals, { purpose: 'timing2' }); }
    catch { return result('wait', 'Source-linked semantic evidence is absent or invalid', 'semantic'); }
    const supports = (id, choice, probability) => answers[id].choice === choice
      && answers[id].probability >= probability && answers[id].confidence >= cfg.minConfidence;
    const noOpenResult = supports('open_result', 'no', cfg.minSupportingProbability);
    if (supports('relation', 'checkpoint', cfg.minRelationProbability) && noOpenResult
      && supports('settled', 'yes', cfg.minSupportingProbability)) {
      return result('checkpoint', 'A source-linked substantive step has a usable handoff', 'semantic');
    }
    if (timing?.waitingEvidence && answers.relation.choice !== 'side_answer'
      && answers.relation.choice !== 'unknown' && answers.open_result.choice === 'no'
      && supports('next', 'await', cfg.minProbability)) {
      return result('checkpoint', 'The parent is waiting for a required external result', 'semantic');
    }
    return result('wait', 'Source-linked timing does not establish a safe checkpoint', 'semantic');
  }
  let answers;
  try { answers = validateAnswers(signals); } catch { return result('wait', 'Semantic evidence is absent or invalid; headroom remains', 'semantic'); }
  const trusted = id => answers[id].probability >= cfg.minProbability && answers[id].confidence >= cfg.minConfidence;
  const is = (id, choice) => trusted(id) && answers[id].choice === choice;
  if (is('continuity', 'yes')) return result('wait', 'An unsettled connected step is continuing', 'semantic');
  if (is('open_result', 'yes')) return result('wait', 'A new result or requirement still needs interpretation', 'semantic');
  if (is('boundary', 'yes') && is('continuity', 'no') && is('open_result', 'no') && is('settled', 'yes')) {
    return result('checkpoint', 'A reported local transition has a settled outcome and no indicated open dependency', 'semantic');
  }
  if (is('boundary', 'no')) return result('wait', 'No local phase transition is reported', 'semantic');
  return result('wait', 'The transition is uncertain, qualified, or not yet settled', 'semantic');
}
