# Weather source field compatibility

This checklist follows the response fields currently read by `lib/weather.js`. Provider payloads remain available on a normalized result as `providerData` for diagnostics; the HTML renderer receives only normalized display fields.

| Field | Bing / MSN weather page | Open-Meteo | WeatherAPI |
| --- | --- | --- | --- |
| Current conditions | `currentCondition.currentRaw` and `currentCondition` inside the page Redux state | `current` | `current` |
| Daily forecast | `forecast[]`, including `highTemp`, `lowTemp`, `dayCap`, `precipitation` | `daily.*` arrays | `forecast.forecastday[].day` |
| Hourly forecast | `forecast[].hourly[]`; `timeStr`, `temperature`, `cap`, `precipitation` | `hourly.*` arrays; local wall-clock `time` | `forecastday[].hour[]`; local wall-clock `time` |
| Rain / snow probability | One general `precipitation` field; no separate probability fields are read | One general `precipitation_probability`; no separate probability fields are requested | Separate `chance_of_rain` and `chance_of_snow` |
| Precipitation amounts | `rainAmount` / `snowAmount` when present; their availability varies by page payload | General `precipitation` / `precipitation_sum`, plus `rain` / `snowfall` and daily `rain_sum` / `snowfall_sum` | General `precip_mm` / `totalprecip_mm`, plus `snow_cm` / `totalsnow_cm` |
| Weather type | Provider description (`cap`, `dayCap`) and symbol | WMO `weather_code` | `condition.text` and `condition.code` |
| Time zone / timestamp | `currentRaw.created` includes the provider timestamp; forecast hours may include an offset | `timezone`; timestamps are local strings without an offset | `location.tz_id`, `location.localtime`; forecast times are local strings without an offset |
| Units used by the adapter | Celsius requested from the MSN page; page fields are interpreted in its displayed units | Celsius, km/h, hPa, mm and km visibility as returned by the current request | Celsius, km/h, hPa (`pressure_mb`), mm/cm and km visibility |

## Normalization rules

- Temperatures are Celsius. Wind speed is km/h, pressure is hPa, visibility is km, and precipitation amounts are retained to one decimal place.
- Probabilities are percentages in the range 0–100. Invalid, absent, or out-of-range values become `null`; a provider's real numeric `0` stays `0`.
- `precipitationProbability` is the general probability. It is not copied into `rainProbability` or `snowProbability` unless the provider returned those distinct fields.
- `precipitationAmount` is the general amount. It is not copied into `rainAmount`; this avoids treating snow or mixed precipitation as rain when only a total amount is present.
- Weather type is taken from the provider's type/code fields. Temperature alone never establishes that snow is forecast. Unknown Open-Meteo WMO codes become “天气状况未知”.
- A missing numeric field stays missing. It is not converted to zero for display or reminder decisions.
- The provider response used by the adapter is retained in `providerData` on the returned weather object. This raw object is not sent to the image template.
- The selected source is reflected in the weather data source note. Weather forecast results have no persistent shared cache; scheduled sends coalesce requests only within one scheduler run and include the selected source in that run's key. Warning and place caches have their own source-aware keys and storage.

## Source-specific limits

- Bing/MSN weather data is extracted from an undocumented HTML page payload. Its fields and units can change without notice, and the page currently exposes only a general precipitation probability through the fields used here.
- Open-Meteo provides general precipitation probability, not separate rain/snow probability in this request. Rain and snow amount fields and WMO codes remain separate evidence for type.
- WeatherAPI has separate rain and snow chances in the forecast response. Its weather and alert coverage still depends on the configured service plan and returned location.
