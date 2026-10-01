## Yunzai 天气插件

本插件由 GPT生成

## 安装

在 Yunzai 根目录执行：

```bash
git clone https://github.com/yuxiri/Yunzai-Weather-Plugin.git ./plugins/weather-plugin
```

确认图片渲染器可用，并能访问所选天气数据源。然后重启即可，无需为插件单独安装 npm 依赖。

## 指令

| 指令 | 功能 |
|---|---|
| `#天气帮助` | 发送图片版帮助 |
| `#天气 北京` | 查询指定城市天气 |
| `#查询天气 东京` | 查询指定城市天气 |
| `#天气 东京,JP` | 用国家代码区分同名城市 |
| `#天气源` | 查看当前天气数据源 |
| `#切换天气源 Open-Meteo` | 切换到 Open-Meteo |
| `#切换天气源 WeatherAPI` | 切换到 WeatherAPI.com |
| `#切换天气源 Bing` | 从 Bing 搜索定位并读取 MSN 天气预报 |
| `#订阅天气 北京 07:30` | 每天按北京当地时间 07:30 推送天气图片 |
| `#订阅天气 北京` | 默认每天当地时间 07:00 推送 |
| `#天气订阅` | 查看当前会话的订阅 |
| `#天气` | 查询当前会话已订阅的城市 |
| `#取消天气订阅` | 取消当前会话的每日推送 |

每个群或私聊最多保留一个订阅。群订阅需要群主、管理员或机器人主人设置；推送使用订阅时对应的机器人账号。

数据源为全局设置，只能由机器人主人切换。切换后天气查询和每日推送都会使用所选来源；天气卡片底部会标注来源。

### 使用 Bing 天气

发送 `#切换天气源 Bing` 后，插件会先用城市名查询 Bing 搜索结果，再读取对应的 MSN 天气预报页面，并使用页面提供的当前天气、逐小时天气和多日预报生成图片。该来源无需 API Key；Yunzai 所在服务器需要能够访问 Bing 和 MSN 天气页面。

### 配置 WeatherAPI

Open-Meteo 默认可用，无需 API Key。使用 WeatherAPI.com 前，先在 [WeatherAPI.com](https://www.weatherapi.com/signup.aspx) 申请 API Key，再通过环境变量 `WEATHERAPI_KEY` 配置，或在 Yunzai 根目录的 `data/weather-panel/settings.json` 中填写：

```json
{
  "source": "weatherapi",
  "weatherApiKey": "YOUR_API_KEY"
}
```

之后发送 `#切换天气源 WeatherAPI`。不要在聊天指令中发送 API Key。Bing 天气（MSN）为默认来源，Open-Meteo 与 WeatherAPI 也可手动切换；城市名称和坐标仍由 Open-Meteo 地理编码接口解析。

## 数据说明

- 天气预报源可选 [Bing 天气（MSN）](https://www.msn.cn/zh-cn/weather/forecast/in-%E5%8C%97%E4%BA%AC%E5%B8%82)、[Open-Meteo](https://open-meteo.com/en/docs) 或 [WeatherAPI.com](https://www.weatherapi.com/docs/)。Bing 天气（MSN）为默认来源。
- 城市地理编码使用 [Open-Meteo Geocoding API](https://open-meteo.com/en/docs/geocoding-api)。
- 空气质量数据由当前所选天气源提供；接口暂不可用时，天气图片仍可生成，并显示“未提供”。
- 城市可写作 `城市,国家代码`，例如 `东京,JP`、`巴黎,FR`。北京、东京、洛杉矶的常见中文名已内置识别。
- 订阅保存在 Yunzai 根目录的 `data/weather-panel/subscriptions.json`。
- 数据源设置保存在 `data/weather-panel/settings.json`；WeatherAPI 密钥也可通过 `WEATHERAPI_KEY` 环境变量提供。

## 文件结构

- `index.js`：Yunzai 指令和每日推送任务。
- `lib/weather.js`：城市解析、天气请求和数据整理。
- `lib/subscriptions.js`：订阅数据读写。
- `lib/settings.js`：全局数据源设置。
- `resources/weather.html`：天气图片模板。
- `resources/info.html`：结果图片模板。

