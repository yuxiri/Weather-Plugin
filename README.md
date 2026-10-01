# TRSS-Yunzai 天气图片插件

本插件由 GPTcodex 生成，适用于 TRSS-Yunzai。天气查询、帮助、订阅反馈和每日推送均以图片发送。

## 安装

在 TRSS-Yunzai 根目录执行：

```bash
git clone https://github.com/yuxiri/Yunzai-Weather-Plugin.git ./plugins/trss-weather-plugin
```

确认 TRSS-Yunzai 的图片渲染器可用，并能访问 Open-Meteo 天气接口。然后重启 TRSS-Yunzai 即可，无需为插件单独安装 npm 依赖。

## 指令

| 指令 | 功能 |
|---|---|
| `#天气帮助` | 发送图片版帮助 |
| `#天气 北京` | 查询指定城市天气 |
| `#查询天气 东京` | 查询指定城市天气 |
| `#天气 东京,JP` | 用国家代码区分同名城市 |
| `#订阅天气 北京 07:30` | 每天按北京当地时间 07:30 推送天气图片 |
| `#订阅天气 北京` | 默认每天当地时间 07:00 推送 |
| `#天气订阅` | 查看当前会话的订阅 |
| `#天气` | 查询当前会话已订阅的城市 |
| `#取消天气订阅` | 取消当前会话的每日推送 |

每个群或私聊最多保留一个订阅。群订阅需要群主、管理员或机器人主人设置；推送使用订阅时对应的机器人账号。

## 数据说明

- 天气和城市地理编码使用 [Open-Meteo](https://open-meteo.com/en/docs)，空气质量使用 [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api)。
- 空气质量数据暂不可用时，天气图片仍可生成，并显示“未提供”。
- 城市可写作 `城市,国家代码`，例如 `东京,JP`、`巴黎,FR`。北京、东京、洛杉矶的常见中文名已内置识别。
- 订阅保存在 Yunzai 根目录的 `data/weather-panel/subscriptions.json`。

## 文件结构

- `index.js`：Yunzai 指令和每日推送任务。
- `lib/weather.js`：城市解析、天气请求和数据整理。
- `lib/subscriptions.js`：订阅数据读写。
- `resources/weather.html`：天气图片模板。
- `resources/info.html`：帮助与操作结果图片模板。
