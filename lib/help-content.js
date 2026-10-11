export const userHelpCards = [
  {
    tone: 'blue', icon: 'search', title: '天气查询', subtitle: '查看当前天气与逐小时预报；#天气 快速查询默认城市',
    rows: [
      { command: '#天气 北京', note: '当前天气' },
      { command: '#24小时天气 北京', note: '逐小时预报' },
      { command: '#天气', note: '快捷查询' },
    ],
  },
  {
    tone: 'green', icon: 'leaf', title: '天气详情', subtitle: '生活建议与多城市天气对比',
    rows: [
      { command: '#生活指数 北京', note: '出行与穿衣建议' },
      { command: '#天气对比 重庆/北京', note: '对比城市天气' },
    ],
  },
  {
    tone: 'orange', icon: 'bell', title: '气象预警', subtitle: '查询预警并管理新预警提醒',
    rows: [
      { command: '#天气预警 北京', note: '查询生效预警' },
      { command: '#开启预警提醒 / #关闭预警提醒', note: '' },
    ],
  },
  {
    tone: 'purple', icon: 'pin', title: '城市管理', subtitle: '设置天气查询使用的默认城市',
    rows: [
      { command: '#绑定城市 重庆', note: '设置默认城市' },
      { command: '#解绑城市', note: '解除默认城市' },
    ],
  },
  {
    tone: 'rose', icon: 'send', title: '天气订阅', subtitle: '按指定时间推送每日天气',
    rows: [
      { command: '#订阅天气 北京 07:30', note: '每日推送' },
      { command: '#取消天气订阅', note: '取消推送' },
    ],
  },
  {
    tone: 'green', icon: 'palette', title: '外观设置', subtitle: '更换天气卡片显示主题',
    rows: [{ command: '#天气主题 ocean', note: 'ocean / sunset / night' }],
  },
  {
    tone: 'cyan', icon: 'bell', title: '降水提醒', subtitle: '按天气预报提醒降雨或降雪',
    rows: [
      { command: '#天气提醒', note: '查看提醒状态' },
      { command: '#开启降雨提醒 / #关闭降雨提醒', note: '' },
      { command: '#开启降雪提醒 / #关闭降雪提醒', note: '' },
    ],
  },
  {
    tone: 'orange', icon: 'calendar', title: '天气早晚报', subtitle: '设置每日天气简报的推送时间',
    rows: [
      { command: '#开启天气早报 07:00', note: '' },
      { command: '#开启天气晚报 20:00', note: '' },
      { command: '#关闭天气早报', note: '' },
      { command: '#关闭天气晚报', note: '' },
    ],
  },
];

export const advancedHelpCards = [
  {
    tone: 'blue', icon: 'settings', title: '天气数据源', subtitle: '支持 bing、open-meteo、weatherapi',
    rows: [
      { command: '#天气源', note: '查看当前来源' },
      { command: '#切换天气源 bing', note: '切换全局来源' },
    ],
  },
  {
    tone: 'orange', icon: 'settings', title: 'API 配置', subtitle: '配置 WeatherAPI 服务密钥',
    rows: [{ command: '#设置天气API <API Key>', note: '请勿公开密钥' }],
  },
  {
    tone: 'purple', icon: 'pin', title: '地点缓存管理', subtitle: '维护天气地点识别记录',
    rows: [
      { command: '#刷新天气地点缓存 地区', note: '重新解析地点' },
      { command: '#清理天气地点缓存', note: '清理地点记录' },
    ],
  },
];

export const helpGuideEntries = [
  { command: '#天气设置帮助', note: '查看高级设置（机器人主人专用）' },
];

export function helpImageView(type = 'usage') {
  if (type === 'settings') {
    return {
      saveId: 'settings-help-advanced-v2',
      title: '天气插件 · 高级设置',
      subtitle: '机器人主人专用管理功能',
      footer: '高级管理指令仅机器人主人可用 · API Key 属于敏感信息',
      cards: advancedHelpCards,
      helpGuide: [],
    };
  }
  return {
    saveId: 'help-user-unified-v2',
    title: '天气插件 · 使用帮助',
    subtitle: '天气查询、订阅与提醒管理',
    footer: '指令前的 # 可以省略 · 部分功能需要先绑定城市 · 早晚报旧指令仍兼容',
    cards: userHelpCards,
    helpGuide: helpGuideEntries,
  };
}
