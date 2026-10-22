// Fills the create sheet from JSON a Claude Code session wrote about itself. Pasted text may
// carry a ```json fence or a sentence around it, so the outermost {...} is read.
const LIMITS = { title: 80, description: 4000, memory: 20000 };
const SESSION = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function parseAgentJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('找不到 JSON 內容');
  let data;
  try { data = JSON.parse(raw.slice(start, end + 1)); } catch { throw new Error('JSON 格式不正確'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('JSON 必須是一個物件');
  const out = {};
  for (const [key, value] of [['title', data.title ?? data.name], ['description', data.description], ['memory', data.memory]]) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw new Error(`${key} 必須是文字`);
    if (value.length > LIMITS[key]) throw new Error(`${key} 最多 ${LIMITS[key]} 字`);
    out[key] = key === 'title' ? value.trim() : value;
  }
  const session = data.resumeSessionId ?? data.sessionId;
  if (session !== undefined && session !== null && session !== '') {
    if (typeof session !== 'string' || !SESSION.test(session.trim())) throw new Error('resumeSessionId 不是有效的 session ID');
    out.resumeSessionId = session.trim().toLowerCase();
  }
  if (data.allow !== undefined && data.allow !== null) {
    if (!Array.isArray(data.allow) || data.allow.some((f) => typeof f !== 'string')) throw new Error('allow 必須是資料夾清單');
    out.allow = [...new Set(data.allow.map((f) => f.trim()).filter(Boolean))];
  }
  if (!Object.keys(out).length) throw new Error('JSON 裡沒有可以帶入的欄位');
  return out;
}
