export function parseReportCommand(message, label) {
  const command = String(message ?? '').trim().replace(/^#/, '').trim();
  if (command === `关闭天气${label}`) return { action: 'disable' };
  const match = command.match(new RegExp(`^(?:开启天气${label}|设置天气${label}|天气${label})(?:\\s+(.+))?$`));
  if (!match) return null;
  const arg = (match[1] || '').trim();
  return arg ? { action: 'configure', arg } : { action: 'status' };
}

export function reportTimePatch(preferences, timeKey, dateKey, time) {
  const patch = { [timeKey]: time };
  if (preferences[timeKey] !== time) patch[dateKey] = null;
  return patch;
}
