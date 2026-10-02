const escapeHtml = value => String(value ?? '—').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);
const iconName = name => ['sun', 'moon', 'partly', 'night', 'rainy', 'cloudy'].includes(name) ? name : 'cloudy';
const degree = value => value == null || value === '—' ? '—' : `${Math.round(Number(value))}°`;

export function weatherView(data, theme = 'ocean') {
  const themeName = ['ocean', 'sunset', 'night'].includes(theme) ? theme : 'ocean';
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
  const nearHours = (data.hourly24 || []).slice(0, 2);
  const nearTypes = nearHours.map(hour => {
    const condition = String(hour.condition || '');
    const snow = /雪/.test(condition) || Number(hour.snowAmount) > 0 || Number(hour.snowProbability) >= 50;
    const rain = /雨|雷/.test(condition) || Number(hour.rainAmount) > 0 || Number(hour.rainProbability) >= 50;
    const known = hour.rainProbability != null || hour.snowProbability != null || hour.rainAmount != null || hour.snowAmount != null || (condition && condition !== '天气状况未知');
    return { rain, snow, known };
  });
  let nearPrecipitationText = '未提供';
  if (nearTypes.length >= 2 && nearTypes.every(hour => hour.known)) {
    const [first, second] = nearTypes;
    const raining = first.rain || first.snow;
    const nextRaining = second.rain || second.snow;
    const state = raining && nextRaining ? '持续降水'
      : !raining && nextRaining ? '将开始'
        : raining && !nextRaining ? '即将停止' : '暂无降水';
    if (state === '暂无降水') nearPrecipitationText = state;
    else {
      const rain = first.rain || second.rain;
      const snow = first.snow || second.snow;
      const kind = rain && snow ? '雨雪' : snow ? '雪' : '雨';
      nearPrecipitationText = `${state} · ${kind}`;
    }
  }

  return {
    ...data,
    icon: iconName(data.icon),
    temperature: data.temperature ?? '—',
    highText: degree(data.high), lowText: degree(data.low),
    humidityText: data.humidity === '—' ? '—' : `${data.humidity}%`,
    dewPointText: degree(data.dewPoint),
    themeClass: `theme-${themeName}`,
    daysHtml, hoursHtml, chartHtml, nearPrecipitationText,
  };
}
