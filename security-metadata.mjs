// Persist operational facts, never prompts, headers, credentials or upstream text.
const categories = new Set(['rate_limit', 'encrypted_context', 'payload_too_large', 'credential_rejected', 'account_quota', 'upstream_unavailable', 'transport_error', 'tls_handshake', 'connect_timeout', 'dns_failure', 'proxy_unreachable', 'upstream_error']);
export function classifyError(value) {
  const text = typeof value === 'string' ? value : '';
  if (categories.has(text)) return text;
  if (/rate[ _-]?limit|too many requests|限速/i.test(text)) return 'rate_limit';
  if (/encrypted[ _-]?content|decrypt|different resource|same resource that created/i.test(text)) return 'encrypted_context';
  if (/413|payload.*large|body.*large/i.test(text)) return 'payload_too_large';
  if (/401|unauthorized|invalid.*(?:key|token)|(?:key|token).*invalid|credential|expired.*token/i.test(text)) return 'credential_rejected';
  if (/quota|balance|credits?.*(?:insufficient|exhausted)|额度|余额/i.test(text)) return 'account_quota';
  if (/server_error|overload|unavailable|上游/i.test(text)) return 'upstream_unavailable';
  // A dead tunnel, a refused name, a stalled handshake and a dropped TLS session
  // all look alike in a 502; the category is what tells them apart later.
  if (/proxy/i.test(text) || /CONNECT/.test(text)) return 'proxy_unreachable';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|dns/i.test(text)) return 'dns_failure';
  if (/ERR_SSL|SSL routines|TLS|handshake|certificate|wrong version/i.test(text)) return 'tls_handshake';
  if (/ETIMEDOUT|ECONNREFUSED|connect.*timeout|timed? ?out/i.test(text)) return 'connect_timeout';
  if (/ECONN|EPIPE|connection reset|socket|aborted/i.test(text)) return 'transport_error';
  return 'upstream_error';
}

const numberKeys = ['status', 'ms', 'items', 'bytes', 'reuse', 'shrunk', 'rotated', 'rebuilt', 'waited'];
const usageKeys = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens'];
const eventTypes = new Set(['oversize', 'untyped', 'unparsable', 'response.completed', 'response.output_text.delta', 'response.output_text.done', 'response.output_item.done', 'response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.custom_tool_call_input.delta', 'response.custom_tool_call_input.done']);
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value) && !/^sk-/i.test(value);
// `local` is the one route that never leaves this process: it names a body the
// router refused by itself, so the row still has a route to group under.
const routeName = value => ['original', 'opencode', 'agentrouter', 'gemini', 'antigravity', 'local'].includes(value) ? value : 'unknown';
const safeTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;

export function safeRequestEvent(event, knownModels = new Set()) {
  const result = { route: routeName(event.route) };
  const at = safeTime(event.at);
  if (at) result.at = at;
  if (identifier(event.accountId)) result.accountId = event.accountId;
  result.model = typeof event.model === 'string' && knownModels.has(event.model) && /^[a-zA-Z0-9._:/-]{1,96}$/.test(event.model) && !/^sk-/i.test(event.model) ? event.model : 'unknown';
  if (event.upstreamModel !== undefined) result.upstreamModel = typeof event.upstreamModel === 'string' && knownModels.has(event.upstreamModel) && /^[a-zA-Z0-9._:/-]{1,96}$/.test(event.upstreamModel) && !/^sk-/i.test(event.upstreamModel) ? event.upstreamModel : 'unknown';
  for (const key of numberKeys) if (numeric(event[key])) result[key] = event[key];
  for (const key of ['store', 'chain', 'sanitized', 'aborted']) if (typeof event[key] === 'boolean') result[key] = event[key];
  // Eight hex characters of a session fingerprint: enough to group one thread's
  // requests, too short to reconstruct the client supplied conversation id.
  if (typeof event.sess === 'string' && /^[a-f0-9]{8}$/.test(event.sess)) result.sess = event.sess;
  if (['new', 'home', 'away'].includes(event.aff)) result.aff = event.aff;
  for (const key of ['error', 'failed']) if (event[key]) result[key] = classifyError(event[key]);
  if (typeof event.opened === 'string') {
    const match = /^(.*):(\d{1,10})$/.exec(event.opened);
    result.opened = match ? `${eventTypes.has(match[1]) ? match[1] : 'other'}:${match[2]}` : 'other';
  }
  if (event.usage && typeof event.usage === 'object') {
    const usage = {};
    for (const key of usageKeys) if (numeric(event.usage[key])) usage[key] = event.usage[key];
    if (Object.keys(usage).length) result.usage = usage;
  }
  // How much of a refused body was tool output and how much was screenshots: a
  // count, not the text, so the next refusal says which one to cut.
  if (event.oversized && typeof event.oversized === 'object') {
    const oversized = {};
    for (const key of ['limitMB', 'outputMB', 'imageMB']) if (numeric(event.oversized[key])) oversized[key] = event.oversized[key];
    if (Object.keys(oversized).length) result.oversized = oversized;
  }
  // The same breakdown as a sentence, built only out of numbers by the router. The
  // pattern is what keeps it a sentence: a size, a unit and a category.
  // The same breakdown as a sentence, built only out of numbers by the router. The
  // pattern is what keeps it a sentence: a size and a category, and at most a count
  // of the items that arrived.
  if (typeof event.composition === 'string' && /^(\d+(\.\d)? MiB of (instructions|developer messages|message text|screenshots|tool output|schemas and arguments)(, \d+ items? before the cut)?)(, \d+(\.\d)? MiB of (instructions|developer messages|message text|screenshots|tool output|schemas and arguments))*$|^nothing readable before the cut$/.test(event.composition)) {
    result.composition = event.composition;
  }
  return result;
}

export function safeDiagnostic(value) {
  const result = { route: routeName(value.route), error: classifyError(value.error) };
  const at = safeTime(value.at);
  if (at) result.at = at;
  if (identifier(value.accountId)) result.accountId = value.accountId;
  for (const key of ['status', 'level', 'bodyBytes']) if (numeric(value[key])) result[key] = value[key];
  return result;
}
