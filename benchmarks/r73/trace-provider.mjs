export function traceProvider(adapter, report, persist) {
  return new Proxy(adapter, { get(target, property) {
    if (property === 'streamChat') return async function* (request, signal) {
      const frame = { providerId: target.providerId, transport: 'stream', at: new Date().toISOString(), request: structuredClone(request), events: [] };
      report.inferenceFrames.push(frame);
      await persist();
      try { for await (const event of target.streamChat(request, signal)) { frame.events.push(structuredClone(event)); yield event; } }
      catch (error) { frame.error = { message: error.message, code: error.code, status: error.status, rateLimitScope: error.rateLimitScope, retryAfterMs: error.retryAfterMs }; throw error; }
      finally { frame.finishedAt = new Date().toISOString(); await persist(); }
    };
    if (property === 'chat') return async function (request) {
      const frame = { providerId: target.providerId, transport: 'chat', at: new Date().toISOString(), request: structuredClone(request) };
      report.inferenceFrames.push(frame);
      await persist();
      try { frame.response = await target.chat(request); return frame.response; }
      catch (error) { frame.error = { message: error.message, code: error.code, status: error.status, rateLimitScope: error.rateLimitScope, retryAfterMs: error.retryAfterMs }; throw error; }
      finally { frame.finishedAt = new Date().toISOString(); await persist(); }
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
