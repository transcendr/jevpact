const REQUEST_LIMIT = 4000;
const REPORT_LIMIT = 3500;
const PACKET_LIMIT = 22 * 1024;
const REFERENTIAL = /\b(?:do it|try again|where(?:'s| is) my|this was|that was)\b/i;
const AWAITED = /\b(?:running|pending|awaiting|await|will return|is checking|is verifying|underway)\b/i;

function bounded(text, limit) {
  return { text: text.slice(0, limit), truncated: text.length > limit };
}

/** Keep user-authored work, excluding ambient wrappers and controller directions. */
export function sourceRequest(visible, provenance) {
  let text = visible.trim();
  let origin = provenance?.kind === 'native-delegation' ? 'delegation' : 'ordinary';
  if (text.startsWith('<heartbeat>')) {
    origin = 'heartbeat';
    text = /<instructions>([\s\S]*?)<\/instructions>/.exec(text)?.[1] ?? '';
  } else if (text.startsWith('<codex_internal_context')) {
    origin = 'goal';
    text = /<objective>([\s\S]*?)<\/objective>/.exec(text)?.[1] ?? '';
  } else if (text.startsWith('<send_user_message_question_reply>')) {
    origin = 'answer';
    try {
      const body = text.slice(text.indexOf('\n') + 1, text.lastIndexOf('</send_user_message_question_reply>')).trim();
      const answers = JSON.parse(body);
      text = Array.isArray(answers) ? answers.map(item => item?.answer).filter(value => typeof value === 'string').join('\n') : '';
    } catch { text = ''; }
  } else if (text.includes('## My request:')) {
    text = text.split('## My request:').at(-1).replace(/<image[\s\S]*/, '').trim();
  }
  text = text.trim();
  if (!text) return null;
  // Heartbeat assignments can contain their full standing instructions.
  // The packet-level byte limit still rejects evidence that cannot fit.
  return { origin, ...bounded(text, origin === 'heartbeat' ? PACKET_LIMIT : REQUEST_LIMIT) };
}

export function finalReport(visible) {
  const text = visible.replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/, '').trim();
  return text ? bounded(text, REPORT_LIMIT) : null;
}

/** A source-linked packet built solely from bounded, visible rollout records. */
export function buildTimingPacket(snapshot) {
  const turnId = snapshot.turnId;
  const currentMessage = snapshot.messages?.findLast(message => message.role === 'assistant' && message.turnId === turnId);
  const recordedFinal = snapshot.recentFinalReports?.findLast(report => report.turnId === turnId);
  const report = recordedFinal ?? (currentMessage && { turnId, sequence: currentMessage.sequence,
    prompted: currentMessage.prompted, ...finalReport(currentMessage.text) });
  if (!report?.text) return { packet: null, metadata: { available: false, reason: 'no-current-assistant-report' } };

  const currentUser = snapshot.recentUserRequests?.findLast(request => request.turnId === turnId) ?? null;
  const referential = !!currentUser && REFERENTIAL.test(currentUser.text);
  const prior = (snapshot.recentFinalReports ?? []).filter(item => item.turnId !== turnId).slice(-5);
  const packet = {
    source: snapshot.timingSource ?? 'codex-visible-source-linked-timing',
    currentTurnId: turnId,
    sourceRequests: (snapshot.recentUserRequests ?? []).filter(item => item.turnId !== turnId).slice(-1),
    currentUser,
    currentReport: report,
    ...(referential && prior.length
      ? { referentPreviousFinal: { turnId: prior.at(-1).turnId, ...bounded(prior.at(-1).text, 1500) } } : {}),
  };
  const omissions = { sourceRequests: 0 };
  let bytes = Buffer.byteLength(JSON.stringify(packet));
  while (bytes > PACKET_LIMIT && packet.sourceRequests.length) {
    packet.sourceRequests.shift(); omissions.sourceRequests++;
    bytes = Buffer.byteLength(JSON.stringify(packet));
  }
  // The current report and current request must remain complete; omitting
  // either is unsafe. An omitted latest prior request is also disclosed.
  const coverageComplete = bytes <= PACKET_LIMIT && !report.truncated && !currentUser?.truncated
    && omissions.sourceRequests === 0;
  packet.coverage = { complete: coverageComplete, ...omissions,
    truncatedSourceRequests: packet.sourceRequests.filter(item => item.truncated).length,
    truncatedPriorFinals: prior.filter(item => item.truncated).length };
  return { packet: coverageComplete ? packet : null,
    metadata: { available: coverageComplete, reason: coverageComplete ? null : 'timing-evidence-incomplete',
      prompted: !!report.prompted, waitingEvidence: AWAITED.test(report.text), turnId } };
}
