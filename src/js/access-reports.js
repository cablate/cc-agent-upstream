import {ct} from './agent-i18n.js';
import {timeLocale} from './i18n.js';

// How a scope report reads on the review pages: its icon, style and label.
export function reportMeta(r) {
  if (r.status === 'open') return {icon: r.kind === 'permission' ? 'hand_raised_fill' : 'lock_shield_fill', cls: 'report-open', label: ct('未處理')};
  if (r.resolution === 'granted') return {icon: 'checkmark_seal_fill', cls: 'report-granted', label: ct('已開通')};
  return {icon: 'xmark_seal_fill', cls: 'report-dismissed', label: ct('已略過')};
}

export const reportKind = (r) => (r.kind === 'permission' ? ct('要求權限') : ct('被沙盒擋下'));

export function reportTime(at) {
  if (!at) return '';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(timeLocale(), {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
}

export const excerpt = (text, n = 120) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};

export const listOrNone = (items) => (items || []).join('\n');
