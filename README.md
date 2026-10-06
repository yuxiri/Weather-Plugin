## Weather Plugin

本插件由 GPT 生成

## 安装

在机器人框架根目录执行以下命令之一：

从 Gitee 安装：

```bash
git clone https://gitee.com/cloud-star-dot/Yunzai-Weather-Plugin.git ./plugins/weather-plugin
```

从 GitHub 安装：

```bash
git clone https://github.com/yuxiri/Weather-Plugin.git ./plugins/weather-plugin
```

确认图片渲染器可用，并能访问所选天气数据源。然后重启即可，无需为插件单独安装 npm 依赖。

## 指令

| 指令 | 功能 |
|---|---|
| `#天气帮助` | 发送图片版帮助 |
| `#天气 北京` | 查询指定城市或区县天气 |
| `#天气 昌平区,北京` / `#天气 渝中区,重庆` | 查询区县；同名区县请补充所属城市 |
| `#查询天气 东京` | 查询指定城市或区县天气 |
| `#天气 东京,JP` | 用国家代码区分同名城市 |
| `#绑定城市 重庆` / `#解绑城市` | 设置或解除当前会话的默认城市 |
| `#天气提醒` | 查看降雨、降雪提醒状态 |
| `#开启降雨提醒` / `#开启降雪提醒` | 开启未来24小时天气提醒；用 `#关闭降雨提醒` / `#关闭降雪提醒` 停用 |
| `#天气预警 北京` | 查询该城市当前生效的政府气象预警 |
| `#开启预警提醒` / `#关闭预警提醒` | 开启或关闭新预警提醒；每条预警只推送一次 |
| `#生活指数` | 查看出行、穿衣、防晒等建议 |
| `#24小时预报` | 查看未来逐小时预报 |
| `#设置天气早报 07:00` / `#设置天气晚报 20:00` | 设置每日简报时间；用 `#关闭天气早报` / `#关闭天气晚报` 停用 |
| `#天气对比 重庆/北京/上海` | 对比 2 至 4 个城市的天气 |
| `#天气主题 ocean` | 选择 `ocean`、`sunset` 或 `night` 卡片主题 |
| `#天气设置帮助` | 查看数据源、简报和 API 的设置说明 |
| `#天气源` | 查看当前天气数据源 |
| `#切换天气源 <open-meteo/bing/weatherapi>` | 选择一种数据源，例如 `#切换天气源 bing`（仅机器人主人） |
| 私聊 `#设置天气API <API Key>` | 设置 WeatherAPI 密钥（仅机器人主人） |
| `#订阅天气 北京 07:30` | 每天按北京当地时间 07:30 推送天气图片 |
| `#订阅天气 北京` | 默认每天当地时间 07:00 推送 |
| `#天气订阅` | 查看当前会话的订阅 |
| `#天气` | 查询当前会话已订阅的城市 |
| `#取消天气订阅` | 取消当前会话的每日推送 |

每个群或私聊最多保留一个订阅。群订阅需要群主、管理员或机器人主人设置；推送使用订阅时对应的机器人账号。

数据源为全局设置，只能由机器人主人切换。切换后天气查询和每日推送都会使用所选来源；天气卡片底部会标注来源。

### 使用 Bing 天气

发送 `#切换天气源 Bing` 后，插件会先用城市名查询 Bing 搜索结果，再读取对应的 MSN 天气预报页面，并使用页面提供的当前天气、逐小时天气和多日预报生成图片。该来源无需 API Key；机器人框架所在服务器需要能够访问 Bing 和 MSN 天气页面。

### 配置 WeatherAPI

Bing 天气（MSN）为默认数据源，无需 API Key。使用 WeatherAPI.com 前，先在 [WeatherAPI.com](https://www.weatherapi.com/signup.aspx) 申请 API Key。机器人主人可私聊机器人发送 `#设置天气API <API Key>` 保存密钥；插件会将密钥写入机器人框架根目录的 `data/weather-panel/settings.json`，回执不会显示密钥，群聊中的设置命令不会保存密钥。也可通过环境变量 `WEATHERAPI_KEY` 配置，或手动在 `data/weather-panel/settings.json` 中填写：

```json
{
  "source": "weatherapi",
  "weatherApiKey": "YOUR_API_KEY"
}
```

密钥保存后发送 `#切换天气源 WeatherAPI` 即可使用该来源。Open-Meteo 也可手动切换；城市名称和坐标由 Open-Meteo 与 Photon 地理编码接口解析。

Bing/MSN 页面提供预警数据时，可直接使用 `#天气预警 北京` 查询和 `#开启预警提醒` 接收新预警，无需额外 API Key。若 Bing/MSN 暂无可读预警数据，可配置上方的 WeatherAPI API Key 作为备用预警源；天气预报来源无需切换。预警类型包括雷暴、暴雨、大雾、大风、台风等，具体取决于预警数据覆盖地区。

## 数据说明

- 天气预报源可选 [Bing 天气（MSN）](https://www.msn.cn/zh-cn/weather/forecast/in-%E5%8C%97%E4%BA%AC%E5%B8%82)、[Open-Meteo](https://open-meteo.com/en/docs) 或 [WeatherAPI.com](https://www.weatherapi.com/docs/)。Bing 天气（MSN）为默认来源。
- 地理编码优先使用 [Open-Meteo Geocoding API](https://open-meteo.com/en/docs/geocoding-api)；没有匹配到时使用 [Photon](https://photon.komoot.io/) 查询城市、区县和上级地区。Photon 结果缓存 90 天，缓存文件位于 `data/weather-panel/geocoding-cache.json`；请求间隔至少 1 秒。天气卡片会注明 [OpenStreetMap 署名](https://www.openstreetmap.org/copyright)。Photon 公共服务可能限流或暂时不可用。
- 区县可直接查询，例如 `#天气 昌平区`、`#天气 昆山市`；若有同名区县，可补充上级城市，例如 `#天气 长安区,西安`。
- 空气质量数据由当前所选天气源提供；接口暂不可用时，天气图片仍可生成，并显示“未提供”。
- 降雨、降雪提醒根据所选来源的未来24小时概率和天气状况判断；来源不提供概率时会显示“未提供”。
- 气象预警优先读取 Bing/MSN 的预警数据，无法读取时可用 WeatherAPI 官方机构预警数据作为备用；覆盖范围、类型和更新情况以来源数据为准。
- 生活指数优先使用来源提供的数据；缺少时按天气、温度、紫外线和降水信息生成通用建议。
- 城市可写作 `城市,国家代码`，例如 `东京,JP`、`巴黎,FR`。北京、东京、洛杉矶的常见中文名已内置识别。
- 订阅保存在机器人框架根目录的 `data/weather-panel/subscriptions.json`。
- 默认城市、提醒、早晚报和主题保存在机器人框架根目录的 `data/weather-panel/preferences.json`；群内设置需群管理员权限。
- 数据源设置保存在 `data/weather-panel/settings.json`；WeatherAPI 密钥也可通过 `WEATHERAPI_KEY` 环境变量提供。

## 文件结构

- `index.js`：插件指令和每日推送任务。
- `lib/weather.js`：城市解析、天气请求和数据整理。
- `lib/subscriptions.js`：订阅数据读写。
- `lib/settings.js`：全局数据源设置。
- `lib/preferences.js`：默认城市、降水提醒、气象预警、早晚报和主题设置。
- `resources/weather.html`：天气图片模板。
- `resources/info.html`：结果图片模板。

## 开源许可

本项目使用 MIT License，详见 [LICENSE](LICENSE)。
