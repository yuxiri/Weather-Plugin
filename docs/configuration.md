# 高级配置

本文面向机器人主人，介绍天气数据源、API Key、预警缓存和地点维护配置。所有配置均为可选；未配置时使用下文列出的默认值。

## 权限说明

- `#天气源`、`#切换天气源`、`#设置天气API`、`#天气设置帮助` 仅机器人主人可用。
- `#设置天气API` 需要私聊机器人；群聊中的设置请求不会保存密钥。
- `#刷新天气地点缓存 地区` 和 `#清理天气地点缓存` 仅机器人主人可用。
- 群内绑定城市、主题、订阅、早晚报及提醒开关需要群主、管理员或机器人主人权限。

## 天气数据源

查看当前来源：

```text
#天气源
```

切换全局天气来源：

```text
#切换天气源 bing
#切换天气源 open-meteo
#切换天气源 weatherapi
```

可选值为 `bing`、`open-meteo`、`weatherapi`。切换后天气查询和每日推送使用所选来源。数据字段及来源限制见[天气源兼容清单](weather-source-compatibility.md)。

切换至 `weatherapi` 前必须先配置 API Key；未配置时切换会被拒绝。

气象预警有独立的来源选择逻辑：通常优先读取 MSN 天气页面；配置 WeatherAPI Key 后，MSN 没有可用预警时可尝试备用来源。将天气来源切换为 `weatherapi` 时，预警查询使用 WeatherAPI。

## WeatherAPI Key

先在 [WeatherAPI.com](https://www.weatherapi.com/signup.aspx) 申请 API Key。机器人主人私聊发送：

```text
#设置天气API <API Key>
```

`#添加天气API` 是兼容别名。也可以设置环境变量 `WEATHERAPI_KEY`，或在 `data/weather-panel/settings.json` 中填写：

```json
{
  "source": "weatherapi",
  "weatherApiKey": "YOUR_API_KEY"
}
```

`settings.json` 中已保存的密钥优先于环境变量。设置文件包含明文密钥，应限制文件访问权限，并避免提交到版本库、粘贴到公开日志或在群聊中发送。命令必须私聊机器人；回执不会回显密钥。

## 预警缓存与扫描

区域预警查询采用受控并发、同地区任务合并和缓存。环境变量中的整数会按代码设置的范围限制；超出范围时会被截断到允许范围。毫秒值使用毫秒，地点缓存期限使用天或小时。

| 环境变量 | 默认值 | 有效范围 / 说明 |
| --- | ---: | --- |
| `WEATHER_ALERT_CACHE_TTL_MS` | `300000` | 单地点预警缓存；30,000–3,600,000 毫秒 |
| `WEATHER_ALERT_AGGREGATE_CACHE_TTL_MS` | `300000` | 省、市级汇总缓存；30,000–3,600,000 毫秒 |
| `WEATHER_ALERT_REFRESH_LEAD_MS` | `90000` | 缓存到期前启动刷新；0–240,000 毫秒 |
| `WEATHER_ALERT_ACTIVE_REGION_TTL_MS` | `2700000` | 查询后保留区域后台刷新计划；60,000–43,200,000 毫秒 |
| `WEATHER_ALERT_ACTIVE_REGION_LIMIT` | `10` | 保存的活跃区域上限；1–100 |
| `WEATHER_ALERT_GLOBAL_CONCURRENCY` | `3` | 全局请求并发；1–5 |
| `WEATHER_ALERT_CONCURRENCY` | `3` | 区域扫描并发；1–5 |
| `WEATHER_ALERT_REQUEST_INTERVAL_MS` | `250` | 同主机请求间隔；0–5,000 毫秒 |
| `WEATHER_ALERT_COUNTY_TIMEOUT_MS` | `25000` | 单地区请求超时；1,000–60,000 毫秒 |
| `WEATHER_ALERT_TOTAL_TIMEOUT_MS` | `90000` | 一次区域汇总总时限；1,000–180,000 毫秒 |
| `WEATHER_ALERT_REQUEST_RETRIES` | `2` | 可恢复请求的重试次数；0–3 |
| `WEATHER_ALERT_AGGREGATE_STALE_TTL_MS` | `86400000` | 汇总缓存可保留为历史快照的最长时间；300,000–604,800,000 毫秒 |
| `WEATHER_ALERT_BACKGROUND_REFRESH` | 开启 | 设置为 `0` 时关闭主动后台刷新及后台失败重试 |

后台只刷新近期查询过的地区，不会在启动时扫描全国。刷新失败时保留上次成功快照并标记时间和历史状态；部分地区失败不会被统计为无预警。

### 缓存文件路径

以下环境变量只用于更改对应 JSON 文件的存储路径，默认均位于 `data/weather-panel/`：

| 环境变量 | 默认文件 |
| --- | --- |
| `WEATHER_ALERT_CACHE_FILE` | `alert-cache.json` |
| `WEATHER_ALERT_AGGREGATE_CACHE_FILE` | `alert-region-cache.json` |
| `WEATHER_ALERT_ACTIVE_REGIONS_FILE` | `alert-active-regions.json` |
| `WEATHER_ALERT_PLACE_CACHE_FILE` | `alert-place-cache.json` |

### 地点映射缓存

| 环境变量 | 默认值 | 有效范围 |
| --- | ---: | --- |
| `WEATHER_ALERT_PLACE_CACHE_TTL_DAYS` | `180` 天 | 1–730 天；成功地点映射 |
| `WEATHER_ALERT_PLACE_NEGATIVE_TTL_HOURS` | `24` 小时 | 1–720 小时；明确未找到的地点 |

成功映射与未命中地点分开存储。负缓存不表示无预警，也不会计入地区查询成功数。强制重新解析或清理地点记录请使用：

```text
#刷新天气地点缓存 辽宁省锦州市古塔区
#清理天气地点缓存
```

清理地点映射不会清除地区预警缓存。

## 行政区划数据更新

行政区划数据首次加载时使用本地数据，并在后台尝试更新；默认每 180 天检查一次。更新失败后使用本地数据，之后至少间隔 24 小时再重试。设置 `WEATHER_ADMIN_DIVISION_AUTO_UPDATE=0` 可关闭自动更新。

下载后的数据和更新时间元数据分别保存在 `admin-divisions.json` 与 `admin-divisions-meta.json`。插件内置基线文件位于 `resources/admin-divisions.json`。

行政区划数据来源标注为中国国家地名信息库数据，由 FHZDCJ 镜像；随仓库提供的数据许可说明见 `resources/admin-divisions.LICENSE`。

## 地名解析缓存

通用地点解析缓存默认保存至 `data/weather-panel/geocoding-cache.json`，有效期为 90 天，容量上限为 1,000 条。可通过 `WEATHER_GEOCODING_CACHE_FILE` 更改文件路径；代码没有提供该缓存期限的环境变量。

## 相关文件

- [开发与数据说明](development.md)
- [天气源字段兼容清单](weather-source-compatibility.md)
- [返回项目首页](../README.md)
