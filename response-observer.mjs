import { StringDecoder } from 'node:string_decoder';

const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

// Usage events are cumulative snapshots, not additional billable deltas.
// Preserve reported fields when a later event contains only a partial snapshot.
export function mergeResponseUsage(previous, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return previous;
  const incoming = {
    inputTokens: finite(raw.input_tokens) ?? finite(raw.prompt_tokens),
    outputTokens: finite(raw.output_tokens) ?? finite(raw.completion_tokens),
    totalTokens: finite(raw.total_tokens),
    cachedTokens: finite(raw.input_tokens_details?.cached_tokens) ?? finite(raw.prompt_tokens_details?.cached_tokens),
    reasoningTokens: finite(raw.output_tokens_details?.reasoning_tokens) ?? finite(raw.completion_tokens_details?.reasoning_tokens),
  };
  if (!Object.values(incoming).some(value => value !== null)) return previous;
  const usage = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== null) usage[key] = value;
    else if (!(key in usage)) usage[key] = null;
  }
  return usage;
}

// Observe response identifiers without changing any upstream bytes.
export function createResponseObserver(contentType, remember, maxBytes = 1024 * 1024, onUsage, onFailure, onComplete) {
  const streaming = /text\/event-stream/i.test(contentType ?? '');
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let eventData = [];
  let eventBytes = 0;
  let overflow = false;
  let reportedUsage;
  let explicitTotal = false;
  function inspect(text) {
    try {
      const value = JSON.parse(text);
      const id = value?.response?.id ?? value?.id;
      if (typeof id === 'string' && /^resp_[A-Za-z0-9_-]{1,200}$/.test(id)) remember(id);
      // A stream that ends with response.failed still arrives as HTTP 200, so the
      // only place the reason shows up is inside the event itself.
      if (onFailure) {
        const failed = value?.type === 'response.failed' || value?.response?.status === 'failed' || value?.type === 'error';
        if (failed) {
          const error = value?.response?.error ?? value?.error ?? value;
          onFailure({
            type: typeof value?.type === 'string' ? value.type : 'response.failed',
            code: typeof error?.code === 'string' ? error.code.slice(0, 64) : '',
            message: String(error?.message ?? '').replace(/\s+/g, ' ').slice(0, 300),
          });
        }
      }
      // A client may hang up the moment it reads the terminal event, before the
      // last chunk terminator arrives, so tell the router the turn really ended.
      if (onComplete && (value?.type === 'response.completed' || value?.response?.status === 'completed')) onComplete();
      const raw = value?.response?.usage ?? value?.usage;
      if (raw && typeof raw === 'object' && onUsage) {
        explicitTotal ||= finite(raw.total_tokens) !== null;
        reportedUsage = mergeResponseUsage(reportedUsage, raw);
        if (reportedUsage) {
          if (!explicitTotal && reportedUsage.inputTokens !== null && reportedUsage.outputTokens !== null) {
            reportedUsage.totalTokens = reportedUsage.inputTokens + reportedUsage.outputTokens;
          }
          onUsage({ ...reportedUsage });
        }
      }
    } catch { /* Partial or non-JSON events carry no usable affinity. */ }
  }
  function line(text) {
    if (!text) {
      if (!overflow && eventData.length) inspect(eventData.join('\n'));
      eventData = []; eventBytes = 0; overflow = false;
      return;
    }
    if (overflow || !text.startsWith('data:')) return;
    const value = text.slice(5).replace(/^ /, '');
    // Count the data field and its separator too: an empty value still retains
    // an array element, so counting only value bytes leaves its growth unbounded.
    eventBytes += Buffer.byteLength(text) + 1;
    if (eventBytes > maxBytes) { overflow = true; eventData = []; }
    else if (!overflow) eventData.push(value);
  }
  function accept(text) {
    if (!streaming) {
      if (!overflow && Buffer.byteLength(pending) + Buffer.byteLength(text) <= maxBytes) pending += text;
      else { pending = ''; overflow = true; }
      return;
    }
    pending += text;
    for (;;) {
      const at = pending.indexOf('\n');
      if (at < 0) break;
      const value = pending.slice(0, at).replace(/\r$/, '');
      pending = pending.slice(at + 1);
      line(value);
    }
    if (Buffer.byteLength(pending) > maxBytes) { pending = ''; overflow = true; eventData = []; }
  }
  return {
    write(chunk) { accept(decoder.write(chunk)); },
    end() {
      accept(decoder.end());
      if (streaming) { if (pending) line(pending.replace(/\r$/, '')); line(''); }
      else if (!overflow) inspect(pending);
    },
  };
}
