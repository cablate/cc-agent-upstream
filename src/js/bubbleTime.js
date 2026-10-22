// A bubble's time: today the time alone, then
// "昨天" and the time, and from the day before that the date as well; another
// year's date carries its year.
const clock = (d) => d.toLocaleTimeString('zh-TW', {hour: '2-digit', minute: '2-digit'});
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function bubbleTime(iso, {now = new Date(), yesterday = '昨天'} = {}) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  if (days <= 0) return clock(d);
  if (days === 1) return `${yesterday} ${clock(d)}`;
  const date = `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear() === now.getFullYear() ? date : `${d.getFullYear()}/${date}`} ${clock(d)}`;
}
