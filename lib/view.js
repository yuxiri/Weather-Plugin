const escapeHtml = value => String(value ?? '—').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);
const iconName = name => ['sun', 'moon', 'partly', 'night', 'rainy', 'cloudy'].includes(name) ? name : 'cloudy';
const degree = value => value == null || value === '—' ? '—' : `${Math.round(Number(value))}°`;

export function weatherView(data) {
  const daysHtml = data.days.map((day, i) => `<div class="day ${i === 0 ? 'today' : ''}">
    <div class="day-name">${escapeHtml(day.name)}</div>
    <svg class="wxicon" aria-hidden="true"><use href="#${iconName(day.icon)}"/></svg>
    <div class="day-temp">${degree(day.high)} <span>${degree(day.low)}</span></div>
  </div>`).join('');

  const hoursHtml = data.hourly.map(hour => `<div class="hour">
    <span class="hour-temp">${degree(hour.temp)}</span>
    <span class="rain">💧${escapeHtml(hour.rain)}%</span>
    <span class="time">${escapeHtml(hour.time)}</span>
  </div>`).join('');

  const values = data.hourly.map(hour => Number(hour.temp));
  const min = Math.min(...values) - 1, max = Math.max(...values) + 1;
  const points = values.map((value, i) => `${i * 800 / Math.max(1, values.length - 1)},${63 - (value - min) / (max - min) * 26}`);
  const chartHtml = `<defs><linearGradient id="hourFill" x2="0" y2="1"><stop stop-color="#fff5dc"/><stop offset="1" stop-color="#e7faee"/></linearGradient></defs><path d="M${points.join(' L')} L800 90 L0 90Z" fill="url(#hourFill)"/>`;

  return {
    ...data,
    icon: iconName(data.icon),
    temperature: data.temperature ?? '—',
    highText: degree(data.high), lowText: degree(data.low),
    humidityText: data.humidity === '—' ? '—' : `${data.humidity}%`,
    dewPointText: degree(data.dewPoint),
    daysHtml, hoursHtml, chartHtml,
  };
}
