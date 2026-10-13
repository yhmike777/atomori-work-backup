'use strict';

// 同源轻量调用层；不自动重试写入，业务层保留 requestId 后由用户重试。
const AtomoriApi = {
  async request(path, { method = 'GET', body, timeoutMs = 8000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch('/api/v1' + path, {
        method, cache: 'no-store', signal: controller.signal,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      if (response.status === 204) return null;
      let value;
      try { value = await response.json(); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        throw Object.assign(new Error(`服务返回无效 JSON（HTTP ${response.status}）`), { status: response.status });
      }
      if (!response.ok) throw Object.assign(new Error(value.error?.message || `请求失败（HTTP ${response.status}）`), {
        status: response.status, code: value.error?.code
      });
      return value;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('请求超时，结果尚未确认；请重试或刷新记录核对');
      if (error instanceof TypeError) throw new Error('后端不可用，请检查本机服务后重试');
      throw error;
    } finally { clearTimeout(timer); }
  },
  message(error) { return error?.message || '请求失败，请重试'; }
};
const AtomoriRuntime = { config: null };
