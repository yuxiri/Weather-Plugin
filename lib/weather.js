import fs from 'node:fs/promises';
import path from 'node:path';
import { findAdministrativeAlertScope } from './admin-divisions.js';
import { classifyPrecipitation } from './precipitation.js';

const ALIASES = new Map([
  ['北京', ['Beijing', 'CN']], ['北京市', ['Beijing', 'CN']],
  ['东京', ['Tokyo', 'JP']], ['东京都', ['Tokyo', 'JP']],
  ['洛杉矶', ['Los Angeles', 'US']], ['洛杉磯', ['Los Angeles', 'US']],
  ['纽约', ['New York City', 'US']], ['纽约市', ['New York City', 'US']], ['紐約', ['New York City', 'US']], ['紐約市', ['New York City', 'US']],
  ['伦敦', ['London', 'GB']], ['倫敦', ['London', 'GB']],
  ['巴黎', ['Paris', 'FR']], ['首尔', ['Seoul', 'KR']], ['首爾', ['Seoul', 'KR']],
  ['新加坡', ['Singapore', 'SG']], ['悉尼', ['Sydney', 'AU']], ['墨尔本', ['Melbourne', 'AU']], ['墨爾本', ['Melbourne', 'AU']],
  ['罗马', ['Rome', 'IT']], ['羅馬', ['Rome', 'IT']], ['曼谷', ['Bangkok', 'TH']],
  ['温哥华', ['Vancouver', 'CA']], ['溫哥華', ['Vancouver', 'CA']],
  ['旧金山', ['San Francisco', 'US']], ['舊金山', ['San Francisco', 'US']],
  ['多伦多', ['Toronto', 'CA']], ['多倫多', ['Toronto', 'CA']], ['迪拜', ['Dubai', 'AE']],
  ['香港', ['Hong Kong', 'HK']], ['台北', ['Taipei', 'TW']], ['台北市', ['Taipei', 'TW']],
  ['大阪', ['Osaka', 'JP']], ['京都', ['Kyoto', 'JP']], ['莫斯科', ['Moscow', 'RU']],
  ['柏林', ['Berlin', 'DE']], ['马德里', ['Madrid', 'ES']], ['馬德里', ['Madrid', 'ES']],
  ['阿姆斯特丹', ['Amsterdam', 'NL']], ['开罗', ['Cairo', 'EG']], ['開羅', ['Cairo', 'EG']],
  ['孟买', ['Mumbai', 'IN']], ['孟買', ['Mumbai', 'IN']], ['雅加达', ['Jakarta', 'ID']], ['雅加達', ['Jakarta', 'ID']],
  ['吉隆坡', ['Kuala Lumpur', 'MY']], ['河内', ['Hanoi', 'VN']], ['河內', ['Hanoi', 'VN']],
]);

const GEOCODING_CACHE_TTL = 90 * 24 * 60 * 60 * 1000;
const GEOCODING_CACHE_LIMIT = 1000;
const geocodingCacheFile = path.resolve(process.env.WEATHER_GEOCODING_CACHE_FILE || 'data/weather-panel/geocoding-cache.json');
const geocodingCache = new Map();
let geocodingCacheLoad;
let geocodingCacheWrite = Promise.resolve();
let geocodingCacheWriteTimer;
const geocodingRequests = new Map();
let photonQueue = Promise.resolve();
let lastPhotonRequest = 0;

async function loadGeocodingCache() {
  if (!geocodingCacheLoad) {
    geocodingCacheLoad = (async () => {
      try {
        const data = JSON.parse(await fs.readFile(geocodingCacheFile, 'utf8'));
        for (const [key, item] of Object.entries(data)) {
          if (item?.expiresAt > Date.now() && item.location?.latitude != null && item.location?.longitude != null) {
            geocodingCache.set(key, item);
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    })();
  }
  await geocodingCacheLoad;
}

async function cachedLocation(key) {
  await loadGeocodingCache();
  const item = geocodingCache.get(key);
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    geocodingCache.delete(key);
    return null;
  }
  geocodingCache.delete(key);
  geocodingCache.set(key, item);
  return item.location;
}

async function cacheLocation(key, location) {
  await loadGeocodingCache();
  geocodingCache.delete(key);
  geocodingCache.set(key, { expiresAt: Date.now() + GEOCODING_CACHE_TTL, location });
  while (geocodingCache.size > GEOCODING_CACHE_LIMIT) geocodingCache.delete(geocodingCache.keys().next().value);
  clearTimeout(geocodingCacheWriteTimer);
  geocodingCacheWriteTimer = setTimeout(() => {
    geocodingCacheWriteTimer = null;
    const snapshot = JSON.stringify(Object.fromEntries(geocodingCache), null, 2);
    const job = geocodingCacheWrite.then(async () => {
      await fs.mkdir(path.dirname(geocodingCacheFile), { recursive: true });
      const temp = `${geocodingCacheFile}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temp, snapshot, 'utf8');
      await fs.rename(temp, geocodingCacheFile);
    });
    geocodingCacheWrite = job.catch(() => {});
  }, 100);
  geocodingCacheWriteTimer.unref?.();
}

export async function clearGeocodingCache() {
  await loadGeocodingCache();
  clearTimeout(geocodingCacheWriteTimer);
  geocodingCacheWriteTimer = null;
  const count = geocodingCache.size;
  geocodingCache.clear();
  await geocodingCacheWrite.catch(() => {});
  const temporary = `${geocodingCacheFile}.${process.pid}.${Date.now()}.clear.tmp`;
  await fs.mkdir(path.dirname(geocodingCacheFile), { recursive: true });
  try {
    await fs.writeFile(temporary, '{}', 'utf8');
    await fs.rename(temporary, geocodingCacheFile);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return count;
}

const normalizedPlace = value => String(value || '').toLocaleLowerCase().replace(/[\s,，、·._-]/g, '');

// This is the same autosuggest route and public app id used by the MSN Weather
// page's current location-search client. The response schema is not a public API.
const MSN_PLACE_SEARCH_URL = 'https://assets.msn.cn/service/weather/api/v6/Places/AutoSuggest';
const MSN_WEATHER_APP_ID = 'D41D8CD98F00B204E9800998ECF8427E1FBE79C2';

const CN_PROVINCES = [
  { name: '内蒙古自治区', prefixes: ['内蒙古自治区', '内蒙古', '内蒙', '蒙'] },
  { name: '广西壮族自治区', prefixes: ['广西壮族自治区', '广西', '桂'] },
  { name: '宁夏回族自治区', prefixes: ['宁夏回族自治区', '宁夏', '宁'] },
  { name: '新疆维吾尔自治区', prefixes: ['新疆维吾尔自治区', '新疆', '新'] },
  { name: '西藏自治区', prefixes: ['西藏自治区', '西藏', '藏'] },
  { name: '澳门特别行政区', prefixes: ['澳门特别行政区', '澳门', '澳'] },
  { name: '黑龙江省', prefixes: ['黑龙江省', '黑龙江', '黑'] },
  { name: '吉林省', prefixes: ['吉林省', '吉林', '吉'] },
  { name: '辽宁省', prefixes: ['辽宁省', '辽宁', '辽'] },
  { name: '河北省', prefixes: ['河北省', '河北', '冀'] },
  { name: '山西省', prefixes: ['山西省', '山西', '晋'] },
  { name: '江苏省', prefixes: ['江苏省', '江苏', '苏'] },
  { name: '浙江省', prefixes: ['浙江省', '浙江', '浙'] },
  { name: '安徽省', prefixes: ['安徽省', '安徽', '皖'] },
  { name: '福建省', prefixes: ['福建省', '福建', '闽'] },
  { name: '江西省', prefixes: ['江西省', '江西', '赣'] },
  { name: '山东省', prefixes: ['山东省', '山东', '鲁'] },
  { name: '河南省', prefixes: ['河南省', '河南', '豫'] },
  { name: '湖北省', prefixes: ['湖北省', '湖北', '鄂'] },
  { name: '湖南省', prefixes: ['湖南省', '湖南', '湘'] },
  { name: '广东省', prefixes: ['广东省', '广东', '粤'] },
  { name: '海南省', prefixes: ['海南省', '海南', '琼'] },
  { name: '四川省', prefixes: ['四川省', '四川', '川', '蜀'] },
  { name: '贵州省', prefixes: ['贵州省', '贵州', '黔', '贵'] },
  { name: '云南省', prefixes: ['云南省', '云南', '滇', '云'] },
  { name: '陕西省', prefixes: ['陕西省', '陕西', '陕', '秦'] },
  { name: '甘肃省', prefixes: ['甘肃省', '甘肃', '甘', '陇'] },
  { name: '青海省', prefixes: ['青海省', '青海', '青'] },
  { name: '台湾省', prefixes: ['台湾省', '台湾', '台'] },
];

const CN_CITY_PREFIXES = [
  { name: '北京市', prefixes: ['北京市', '北京', '京', '帝都', '首都'] },
  { name: '天津市', prefixes: ['天津市', '天津', '津'] },
  { name: '上海市', prefixes: ['上海市', '上海', '沪', '申城', '魔都'] },
  { name: '重庆市', prefixes: ['重庆市', '重庆', '渝', '山城'] },
  { name: '成都市', prefixes: ['成都市', '成都', '蓉城'] },
  { name: '广州市', prefixes: ['广州市', '广州', '羊城', '穗城'] },
  { name: '深圳市', prefixes: ['深圳市', '深圳', '鹏城'] },
  { name: '南京市', prefixes: ['南京市', '南京', '金陵'] },
  { name: '武汉市', prefixes: ['武汉市', '武汉', '江城'] },
  { name: '昆明市', prefixes: ['昆明市', '昆明', '春城'] },
  { name: '哈尔滨市', prefixes: ['哈尔滨市', '哈尔滨', '冰城'] },
  { name: '济南市', prefixes: ['济南市', '济南', '泉城'] },
  { name: '福州市', prefixes: ['福州市', '福州', '榕城'] },
  { name: '厦门市', prefixes: ['厦门市', '厦门', '鹭岛'] },
  { name: '长沙市', prefixes: ['长沙市', '长沙', '星城'] },
];

const PROVINCE_PREFIXES = CN_PROVINCES.flatMap(item => item.prefixes
  .map(prefix => ({ prefix, name: item.name })))
  .sort((a, b) => b.prefix.length - a.prefix.length);
const CITY_PREFIXES = CN_CITY_PREFIXES.flatMap(item => item.prefixes
  .map(prefix => ({ prefix, name: item.name })))
  .sort((a, b) => b.prefix.length - a.prefix.length);
const CN_PLACE_ALIASES = new Map([
  ['恩施州', '恩施土家族苗族自治州'], ['阿坝州', '阿坝藏族羌族自治州'],
  ['甘孜州', '甘孜藏族自治州'], ['凉山州', '凉山彝族自治州'],
  ['延边州', '延边朝鲜族自治州'], ['湘西州', '湘西土家族苗族自治州'],
  ['黔东南州', '黔东南苗族侗族自治州'], ['黔南州', '黔南布依族苗族自治州'],
  ['黔西南州', '黔西南布依族苗族自治州'], ['西双版纳州', '西双版纳傣族自治州'],
  ['德宏州', '德宏傣族景颇族自治州'], ['大理州', '大理白族自治州'],
  ['迪庆州', '迪庆藏族自治州'], ['文山州', '文山壮族苗族自治州'],
  ['红河州', '红河哈尼族彝族自治州'], ['楚雄州', '楚雄彝族自治州'],
  ['怒江州', '怒江傈僳族自治州'], ['海西州', '海西蒙古族藏族自治州'],
  ['海北州', '海北藏族自治州'], ['海南州', '海南藏族自治州'],
  ['黄南州', '黄南藏族自治州'], ['果洛州', '果洛藏族自治州'],
  ['玉树州', '玉树藏族自治州'],
]);
const PREFECTURE_SUFFIXES = ['自治州', '自治盟', '地区', '市', '盟', '州'];
const COUNTY_SUFFIXES = ['自治县', '自治旗', '区', '县', '旗'];
const LOCATION_SUFFIX = /(?:特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|自治盟|自治县|自治旗|地区|省|市|区|县|旗|盟|州|镇|乡|街道)$/;

function compactPlace(value) {
  return String(value || '').normalize('NFKC').replace(/[\s,，、·._-]/g, '').toLocaleLowerCase();
}

function stripLocationSuffix(value) {
  return compactPlace(value).replace(LOCATION_SUFFIX, '');
}

function sameMsnAdministrativeLabel(left, right) {
  const leftValue = compactPlace(left);
  const rightValue = compactPlace(right);
  if (leftValue === rightValue) return true;
  const leftStem = stripLocationSuffix(leftValue);
  const rightStem = stripLocationSuffix(rightValue);
  if (leftStem !== rightStem) return false;
  const leftSuffix = leftValue.slice(leftStem.length);
  const rightSuffix = rightValue.slice(rightStem.length);
  return !leftSuffix || !rightSuffix || leftSuffix === rightSuffix;
}

function splitAfterSuffix(value, suffixes) {
  for (let index = 1; index < value.length; index++) {
    const suffix = suffixes.find(item => value.slice(0, index).endsWith(item));
    const child = value.slice(index);
    // Do not split a city such as 儋州市 at 州 + 市. The remainder is itself
    // only an administrative suffix, so this is one complete place name.
    if (suffix && child && stripLocationSuffix(child)) return { parent: value.slice(0, index), child };
  }
  return null;
}

function parseDomesticPlace(input) {
  const raw = compactPlace(input);
  const province = PROVINCE_PREFIXES.find(item => {
    const prefix = compactPlace(item.prefix);
    return raw === prefix || (prefix.length > 1 && raw.startsWith(prefix));
  });
  if (province) {
    const rest = raw.slice(compactPlace(province.prefix).length);
    if (!rest) return { target: province.name, parents: [], level: 'province' };
    const prefecture = splitAfterSuffix(rest, PREFECTURE_SUFFIXES);
    if (!prefecture) return { target: rest, parents: [province.name], level: 'city' };
    const county = splitAfterSuffix(prefecture.child, COUNTY_SUFFIXES);
    return {
      target: county?.child || prefecture.child,
      parents: [province.name, prefecture.parent, ...(county ? [county.parent] : [])],
      level: county ? 'town' : 'county',
    };
  }

  const city = CITY_PREFIXES.find(item => {
    const prefix = compactPlace(item.prefix);
    return raw === prefix || (prefix.length > 1 && raw.startsWith(prefix));
  });
  if (city) {
    const rest = raw.slice(compactPlace(city.prefix).length);
    if (!rest) return { target: city.name, parents: [], level: 'city' };
    const county = splitAfterSuffix(rest, COUNTY_SUFFIXES);
    return {
      target: county?.child || rest,
      parents: [city.name, ...(county ? [county.parent] : [])],
      level: county ? 'town' : 'county',
    };
  }

  const prefecture = splitAfterSuffix(raw, PREFECTURE_SUFFIXES);
  if (prefecture) {
    const county = splitAfterSuffix(prefecture.child, COUNTY_SUFFIXES);
    return {
      target: county?.child || prefecture.child,
      parents: [prefecture.parent, ...(county ? [county.parent] : [])],
      level: county ? 'town' : 'county',
    };
  }
  return { target: raw, parents: [], level: 'unknown' };
}

function expandCnPlaceAlias(input) {
  const raw = compactPlace(input);
  const exact = CN_PLACE_ALIASES.get(raw);
  if (exact) return exact;
  const prefix = [...CN_PLACE_ALIASES.entries()]
    .filter(([alias]) => alias.length > 1 && raw.startsWith(compactPlace(alias)))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return prefix ? `${prefix[1]}${raw.slice(compactPlace(prefix[0]).length)}` : input;
}

function msnPlaceQueries(input, parsed) {
  const queries = [String(input || '').trim()];
  const suffixes = parsed.level === 'city'
    ? ['市', '自治州', '地区', '自治盟', '州', '盟']
    : parsed.level === 'county' || parsed.level === 'town'
      ? ['区', '县', '自治县', '旗', '自治旗', '市', '镇', '乡', '街道']
      : [];
  const targets = LOCATION_SUFFIX.test(parsed.target)
    ? [parsed.target, parsed.target.replace(LOCATION_SUFFIX, '')].filter((value, index, all) => value && all.indexOf(value) === index)
    : [parsed.target, ...suffixes.map(suffix => `${parsed.target}${suffix}`)];
  const ethnicSuffixes = ['黎族苗族', '哈萨克族', '蒙古族', '藏族', '彝族', '回族', '土家族', '布依族', '朝鲜族',
    '柯尔克孜族', '锡伯族', '撒拉族', '东乡族', '保安族', '羌族', '苗族', '黎族', '壮族', '瑶族', '傣族', '白族'];
  for (const ethnic of ethnicSuffixes) {
    const shortened = parsed.target.replace(new RegExp(`${ethnic}(?:自治县|自治州|自治旗)$`), '');
    if (shortened && shortened !== parsed.target && !targets.includes(shortened)) targets.push(shortened);
  }
  for (const target of targets) {
    if (parsed.parents.length) {
      queries.push(`${parsed.parents.join('')}${target}`);
      if (parsed.parents.length > 1) queries.push(`${parsed.parents.slice(1).join('')}${target}`);
      queries.push(target);
    } else queries.push(target);
  }
  return [...new Set(queries.map(value => String(value || '').trim()).filter(Boolean))].slice(0, 8);
}

function normalizeMsnPlace(item) {
  if (!item || (item._type && item._type !== 'Place')) return null;
  const latitude = Number(item.geo?.latitude), longitude = Number(item.geo?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const address = item.address || {};
  const countryCode = String(address.countryIso || '').toUpperCase();
  if (countryCode && countryCode !== 'CN') return null;
  const suppliedName = String(item.name || '').trim();
  // MSN also returns numeric place codes for grid points inside a county.
  if (/^\d+$/.test(suppliedName)) return null;
  const placeName = suppliedName || [address.addressLocality, address.addressSubregion, address.addressRegion]
    .find(value => typeof value === 'string' && value.trim()) || '';
  if (!placeName) return null;
  const adminLabels = [address.addressRegion, address.addressSubregion, address.addressLocality]
    .filter(value => typeof value === 'string' && value.trim());
  const hierarchy = [];
  for (const label of [...adminLabels, placeName]) {
    if (!hierarchy.some(existing => sameMsnAdministrativeLabel(existing, label))) hierarchy.push(label.trim());
  }
  const name = hierarchy.join('');
  return {
    name,
    country: address.addressCountry || '中华人民共和国',
    countryCode: countryCode || 'CN',
    latitude,
    longitude,
    timezone: 'Asia/Shanghai',
    geocoder: 'msn',
    providerIds: {
      placeId: item.id || null,
      entityId: item.entityId || null,
      geoId: item.geoId || null,
    },
    administrativeArea: {
      countryCode: countryCode || 'CN',
      region: address.addressRegion || null,
      subregion: address.addressSubregion || null,
      locality: address.addressLocality || null,
      code: null,
    },
    _placeName: placeName,
    _parents: adminLabels,
  };
}

function msnCandidateMatches(candidate, parsed) {
  const target = stripLocationSuffix(parsed.target);
  if (!target || stripLocationSuffix(candidate._placeName) !== target) return false;
  return parsed.parents.every(parent => candidate._parents.some(value => stripLocationSuffix(value) === stripLocationSuffix(parent)));
}

function msnCandidateMatchesTarget(candidate, parsed) {
  const target = stripLocationSuffix(parsed.target);
  return Boolean(target && stripLocationSuffix(candidate._placeName) === target);
}

function uniqueMsnCandidates(candidates) {
  return [...new Map(candidates.map(candidate => [
    `${compactPlace(candidate.name)}:${Number(candidate.latitude).toFixed(6)},${Number(candidate.longitude).toFixed(6)}`,
    candidate,
  ])).values()];
}

async function verifiedAdministrativeMatch(input, parsed) {
  if (!parsed.parents.length || parsed.parents.length > 2) return null;
  try {
    const scope = await findAdministrativeAlertScope(input, { countryCode: 'CN' });
    if (!scope || stripLocationSuffix(scope.division?.name) !== stripLocationSuffix(parsed.target)
      || stripLocationSuffix(scope.province?.name) !== stripLocationSuffix(parsed.parents[0])) return null;
    if (parsed.parents[1] && stripLocationSuffix(scope.city?.name) !== stripLocationSuffix(parsed.parents[1])) return null;
    return scope;
  } catch {
    return null;
  }
}

function publicMsnLocation(candidate) {
  const { _placeName, _parents, ...location } = candidate;
  return location;
}

function describeMsnCandidates(candidates) {
  return candidates.map(candidate => candidate.name).slice(0, 6).join('、');
}

async function searchMsnPlaces(query, fetcher) {
  const params = new URLSearchParams({
    appid: MSN_WEATHER_APP_ID,
    count: '10',
    q: query,
    localcircularview: '40,116,100',
    setmkt: 'zh-cn',
    setlang: 'zh-cn',
    types: 'Place',
    abbrtext: '1',
    structuredaddress: 'true',
    strucaddrread: '1',
  });
  const data = await getJson(`${MSN_PLACE_SEARCH_URL}?${params}`, fetcher, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  });
  if (!Array.isArray(data.value)) throw new Error('MSN/Bing 地点搜索响应格式异常');
  return data.value.map(normalizeMsnPlace).filter(Boolean);
}

async function resolveMsnDomesticPlace(input, fetcher, parsed = parseDomesticPlace(input)) {
  parsed = parseDomesticPlace(expandCnPlaceAlias(input));
  let successfulSearches = 0;
  let lastError = null;
  for (const query of msnPlaceQueries(input, parsed)) {
    let candidates;
    try {
      candidates = await searchMsnPlaces(query, fetcher);
      successfulSearches++;
    } catch (error) {
      lastError = error;
      break;
    }
    let matches = candidates.filter(candidate => msnCandidateMatches(candidate, parsed));
    let verifiedAdministrativeScope = null;
    if (!matches.length && parsed.parents.length) {
      const inputKey = compactPlace(input);
      const qualified = parsed.parents.every(parent => inputKey.includes(stripLocationSuffix(parent)))
        && inputKey.includes(stripLocationSuffix(parsed.target));
      const exactCandidates = candidates.filter(candidate => msnCandidateMatchesTarget(candidate, parsed));
      // Some MSN place rows contain exact coordinates but omit parent fields.
      // Accept one only when both the qualified query and local admin tree identify
      // exactly the same division; never infer an unverified parent from text alone.
      if (qualified && exactCandidates.length && exactCandidates.every(candidate => candidate._parents.length === 0)) {
        const exactUnique = uniqueMsnCandidates(exactCandidates);
        if (exactUnique.length === 1) verifiedAdministrativeScope = await verifiedAdministrativeMatch(input, parsed);
        if (exactUnique.length === 1 && verifiedAdministrativeScope) {
          matches = exactUnique;
        } else if (exactUnique.length > 1) {
          const error = new Error(`“${input}”匹配到多个地点，请补充更具体的上级地区：${describeMsnCandidates(exactUnique)}。`);
          error.code = 'location-ambiguous';
          error.stage = 'location';
          throw error;
        }
      }
    }
    const unique = uniqueMsnCandidates(matches);
    if (unique.length > 1) {
      const error = new Error(`“${input}”匹配到多个地点，请补充上级地区：${describeMsnCandidates(unique)}。`);
      error.code = 'location-ambiguous';
      error.stage = 'location';
      throw error;
    }
    if (unique.length === 1) {
      const location = publicMsnLocation(unique[0]);
      location.locationMatchMethod = verifiedAdministrativeScope
        ? 'admin-verified-qualified-query-single-exact-candidate' : 'provider-hierarchy';
      if (verifiedAdministrativeScope) {
        location.name = [verifiedAdministrativeScope.province?.name,
          verifiedAdministrativeScope.city?.name, verifiedAdministrativeScope.division?.name].filter(Boolean).join('');
        location.administrativeArea = {
          ...(location.administrativeArea || {}),
          region: location.administrativeArea?.region || verifiedAdministrativeScope.province?.name || null,
          subregion: location.administrativeArea?.subregion || verifiedAdministrativeScope.city?.name || null,
        };
      }
      return location;
    }
  }
  if (!successfulSearches && lastError) {
    const error = new Error(`MSN/Bing 地点搜索暂不可用：${lastError.message}`, { cause: lastError });
    Object.assign(error, lastError);
    error.stage ||= 'location';
    throw error;
  }
  if (lastError) {
    const error = new Error(`MSN/Bing 地点搜索未完成：${lastError.message}`, { cause: lastError });
    Object.assign(error, lastError);
    error.stage ||= 'location';
    throw error;
  }
  const error = new Error(`MSN/Bing 地点搜索未找到“${input}”，请检查地名或补充上级地区。`);
  error.code = 'location-not-found';
  error.stage = 'location';
  throw error;
}

function photonLocationName(properties, requestedName) {
  const name = String(properties.name || requestedName).trim();
  const parent = properties.city || properties.state || '';
  return parent && normalizedPlace(parent) !== normalizedPlace(name) ? `${name}·${parent}` : name;
}

function selectPhotonFeature(features, namePart, countryCode, scope = 'any') {
  const wanted = normalizedPlace(namePart);
  const candidates = (features || []).map(feature => {
    const properties = feature?.properties || {};
    const coordinates = feature?.geometry?.coordinates || [];
    const name = normalizedPlace(properties.name);
    const exact = name && name === wanted;
    const city = properties.type !== 'district'
      && (['city', 'town', 'village', 'municipality'].includes(properties.type)
        || (properties.osm_key === 'place' && ['city', 'town', 'village', 'municipality'].includes(properties.osm_value)));
    const resultCountryCode = String(properties.countrycode || '').toUpperCase();
    // Photon does not expose a reliable China prefecture-level classification.
    // Keep it for overseas fallback only; domestic results must pass GeoNames feature codes below.
    const countryMatches = resultCountryCode !== 'CN'
      && (!countryCode || resultCountryCode === countryCode)
      && scope !== 'domestic'
      && (scope !== 'foreign' || resultCountryCode !== '');
    return {
      feature, properties, coordinates, exact, city, countryMatches,
      score: (exact ? 100 : 0) + (city ? 20 : 0) + (countryMatches ? 10 : -100),
    };
  }).filter(item => item.exact && item.city && item.countryMatches && item.coordinates.length >= 2
    && Number.isFinite(Number(item.coordinates[0])) && Number.isFinite(Number(item.coordinates[1])))
    .sort((a, b) => b.score - a.score);

  const top = candidates[0];
  if (!top) return null;
  const duplicate = candidates.find(item => item !== top && item.exact && item.city && top.exact && top.city
    && item.score === top.score
    && normalizedPlace(item.properties.city || item.properties.state) !== normalizedPlace(top.properties.city || top.properties.state));
  if (duplicate) throw new Error(`“${namePart}”有多个同名城市，请使用国家代码区分，例如“${namePart},JP”。`);
  return top;
}

async function photonSearch(query, fetcher) {
  const params = new URLSearchParams({ q: query.replace(/[,，]/g, ' '), limit: '10' });
  const url = `https://photon.komoot.io/api/?${params}`;
  const job = photonQueue.then(async () => {
    const delay = 1000 - (Date.now() - lastPhotonRequest);
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    lastPhotonRequest = Date.now();
    return getJson(url, fetcher, {
      headers: { 'User-Agent': 'Weather-Plugin/1.1 (https://github.com/yuxiri/Weather-Plugin)' },
    });
  });
  photonQueue = job.catch(() => {});
  return job;
}

async function timezoneAt(latitude, longitude, countryCode, fetcher) {
  const fixedZones = { CN: 'Asia/Shanghai', HK: 'Asia/Hong_Kong', MO: 'Asia/Macau', TW: 'Asia/Taipei' };
  if (fixedZones[countryCode]) return fixedZones[countryCode];
  const params = new URLSearchParams({
    latitude: String(latitude), longitude: String(longitude), current: 'temperature_2m',
    timezone: 'auto', forecast_days: '1',
  });
  const data = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`, fetcher);
  if (!data.timezone) throw new Error('无法确定该城市的当地时区');
  return data.timezone;
}

const SENSITIVE_QUERY_PARAMETER = /^(?:key|api[-_]?key|token|access[-_]?token|secret|client[-_]?secret|password|signature|authorization)$/i;

function redactDiagnosticText(value, secrets = []) {
  let text = String(value ?? '');
  const variants = new Set();
  for (const secret of secrets) {
    if (!secret) continue;
    const raw = String(secret);
    variants.add(raw);
    try { variants.add(decodeURIComponent(raw)); } catch {}
    try { variants.add(encodeURIComponent(raw)); } catch {}
    try { variants.add(encodeURI(raw)); } catch {}
  }
  for (const secret of [...variants].sort((a, b) => b.length - a.length)) {
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  // Also redact credential-like query parameters if a provider echoes a URL
  // that was not the original request URL.
  return text.replace(/([?&](?:key|api[-_]?key|token|access[-_]?token|secret|client[-_]?secret|password|signature|authorization)=)[^&#\s"'<>]+/gi, '$1[REDACTED]');
}

function requestDiagnostics(rawUrl) {
  const secrets = [];
  try {
    const parsed = new URL(String(rawUrl));
    const parameters = [...parsed.searchParams];
    for (const [name, value] of parameters) {
      if (!SENSITIVE_QUERY_PARAMETER.test(name)) continue;
      if (value) secrets.push(value);
    }
    for (const [name] of parameters) {
      if (!SENSITIVE_QUERY_PARAMETER.test(name)) continue;
      parsed.searchParams.set(name, '[REDACTED]');
    }
    parsed.username = '';
    parsed.password = '';
    const endpoint = `${parsed.host}${parsed.pathname}`;
    return {
      endpoint: redactDiagnosticText(endpoint, secrets),
      url: redactDiagnosticText(parsed.toString(), secrets),
      secrets,
    };
  } catch {
    const raw = String(rawUrl);
    for (const match of raw.matchAll(/[?&](?:key|api[-_]?key|token|access[-_]?token|secret|client[-_]?secret|password|signature|authorization)=([^&#\s]+)/gi)) {
      try { secrets.push(decodeURIComponent(match[1].replaceAll('+', ' '))); } catch { secrets.push(match[1]); }
    }
    const safeUrl = redactDiagnosticText(raw, secrets);
    return { endpoint: 'weather API', url: safeUrl, secrets };
  }
}

function safeErrorSummary(value, secrets) {
  return redactDiagnosticText(value, secrets).slice(0, 240);
}

function addRequestDiagnostics(error, diagnostics) {
  error.endpoint = diagnostics.endpoint;
  error.url = diagnostics.url;
  return error;
}

export async function getJson(url, fetcher = fetch, options = {}) {
  const diagnostics = requestDiagnostics(url);
  let response;
  let requestSignal;
  try {
    const timeoutSignal = AbortSignal.timeout(12000);
    requestSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    response = await fetcher(url, { ...options, signal: requestSignal });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError' && error?.cause?.name === 'TimeoutError';
    const message = timedOut ? '天气接口请求超时，请稍后重试' : '连接天气接口失败，请检查网络后重试';
    const requestError = addRequestDiagnostics(new Error(message), diagnostics);
    requestError.code = timedOut ? 'timeout' : 'network-request-failed';
    requestError.stage = 'network';
    requestError.errorSummary = message;
    requestError.timedOut = timedOut;
    throw requestError;
  }
  if (!response.ok) {
    const message = `天气接口返回 HTTP ${response.status}`;
    const requestError = addRequestDiagnostics(new Error(message), diagnostics);
    requestError.code = response.status === 429 ? 'http-429' : 'network-request-failed';
    requestError.stage = 'network';
    requestError.httpStatus = response.status;
    requestError.retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
    requestError.errorSummary = message;
    throw requestError;
  }
  let data;
  try { data = await response.json(); }
  catch (error) {
    const timedOut = error?.name === 'TimeoutError' || requestSignal?.reason?.name === 'TimeoutError';
    const summary = timedOut ? '' : safeErrorSummary(error?.message || '无效响应内容', diagnostics.secrets);
    const message = timedOut
      ? '天气接口读取响应内容超时，请稍后重试'
      : `天气接口响应格式无法解析：${summary || '无效响应内容'}`;
    const parseError = addRequestDiagnostics(new Error(message), diagnostics);
    parseError.code = timedOut ? 'timeout' : 'page-parse-failed';
    parseError.stage = timedOut ? 'network' : 'parse';
    parseError.httpStatus = response.status;
    parseError.errorSummary = timedOut ? message : summary;
    parseError.timedOut = timedOut;
    throw parseError;
  }
  if (data.error) {
    const summary = safeErrorSummary(data.error.message || data.reason || '天气接口返回错误', diagnostics.secrets);
    const requestError = addRequestDiagnostics(new Error(summary || '天气接口返回错误'), diagnostics);
    requestError.code = data.error.code === 'location-not-found' ? 'location-not-found' : 'provider-error';
    requestError.stage = 'provider';
    requestError.httpStatus = response.status;
    requestError.errorSummary = summary || '天气接口返回错误';
    throw requestError;
  }
  return data;
}

export async function resolveCity(input, fetcher = fetch, options = {}) {
  const raw = String(input || '').trim().replace(/，/g, ',');
  if (!raw || raw.length > 80) throw new Error('请输入有效的城市名');
  const scope = options.scope || 'any';
  if (!['any', 'domestic', 'foreign'].includes(scope)) throw new Error('未知的城市查询范围');
  const commaParts = raw.split(',').map(s => s.trim()).filter(Boolean);
  let namePart = commaParts[0] || '';
  let countryPart = '';
  if (commaParts.length === 2 && /^[A-Za-z]{2}$/.test(commaParts[1])) {
    countryPart = commaParts[1];
  } else if (commaParts.length > 1 && commaParts.every(part => /[\u3400-\u9fff]/.test(part))) {
    // Accept the province/city/district comma form used by MSN's location pages.
    namePart = commaParts.join('');
  } else if (commaParts.length > 1) {
    throw new Error('国家代码需用两位字母并放在末尾，例如“东京,JP”；行政区划可写作“重庆市,铜梁区”。');
  }
  const alias = ALIASES.get(namePart);
  const name = alias?.[0] || namePart;
  const hintedCountryCode = /^[A-Za-z]{2}$/.test(countryPart || '') ? countryPart.toUpperCase() : alias?.[1];
  if (scope === 'domestic' && hintedCountryCode && hintedCountryCode !== 'CN') {
    throw new Error(`“${namePart}”属于海外地区，请使用 #国外天气 ${namePart} 查询。`);
  }
  if (scope === 'foreign' && hintedCountryCode === 'CN') {
    throw new Error(`“${namePart}”属于中国境内，请使用 #国内天气 ${namePart} 查询。`);
  }
  const countryCode = scope === 'domestic' ? 'CN' : hintedCountryCode;
  const useMsnPlaceSearch = scope === 'domestic' || countryCode === 'CN'
    || (scope === 'any' && !hintedCountryCode && /[\u3400-\u9fff]/.test(namePart));
  const cacheKey = `${useMsnPlaceSearch ? 'msn-place-v4' : 'prefecture-v2'}:${normalizedPlace(raw)}`;
  const cached = options.force ? null : await cachedLocation(cacheKey);
  // A previous fuzzy lookup may have cached a same-name place in another country.
  const cachedCountryCode = String(cached?.countryCode || '').toUpperCase();
  const cachedInScope = scope === 'any' || (scope === 'domestic'
    ? cachedCountryCode === 'CN'
    : cachedCountryCode !== '' && cachedCountryCode !== 'CN');
  if (cached && cachedInScope && (!countryCode || cachedCountryCode === countryCode)) {
    options.onCacheHit?.('persistent');
    return cached;
  }
  const requestKey = options.force ? `${cacheKey}:forced` : cacheKey;
  if (geocodingRequests.has(requestKey)) {
    options.onCacheHit?.('in-flight');
    return geocodingRequests.get(requestKey);
  }

  const request = (async () => {
  if (useMsnPlaceSearch) {
    const location = await resolveMsnDomesticPlace(namePart, fetcher);
    await cacheLocation(cacheKey, location);
    return location;
  }

  const params = new URLSearchParams({ name, count: '10', language: 'zh', format: 'json' });
  if (countryCode) params.set('countryCode', countryCode);
  let openMeteoError = null;
  try {
    const data = await getJson(`https://geocoding-api.open-meteo.com/v1/search?${params}`, fetcher);
    const results = (data.results || []).filter(item => {
      const itemCountryCode = String(item.country_code || '').toUpperCase();
      const feature = String(item.feature_code || '').toUpperCase();
      // For China, whitelist GeoNames codes for municipalities, provincial capitals,
      // and prefecture-level cities. PPLA3/PPLA4 are lower-level settlements.
      const cityLevel = itemCountryCode === 'CN'
        ? ['PPLC', 'PPLA', 'PPLA1', 'PPLA2'].includes(feature)
        : !/^ADM[1-4]$/.test(feature) && !/^PPLA[34]$/.test(feature) && feature !== 'PPLX';
      return cityLevel && (scope === 'any' || (scope === 'domestic'
        ? itemCountryCode === 'CN'
        : itemCountryCode !== '' && itemCountryCode !== 'CN'));
    });
    if (results.length) {
      const maxPopulation = Math.max(...results.map(item => Number(item.population) || 0));
      const strongExact = item => normalizedPlace(item.name) === normalizedPlace(name)
        && ((Number(item.population) || 0) >= maxPopulation * 0.05 || /^PPLA/.test(item.feature_code || ''));
      const best = [...results].sort((a, b) => {
        return Number(strongExact(b)) - Number(strongExact(a))
          || (b.population || 0) - (a.population || 0);
      })[0];
      const location = {
        name: alias || /^[\x00-\x7F]+$/.test(namePart) ? namePart : best.name,
        country: best.country || '', countryCode: best.country_code || '',
        latitude: best.latitude, longitude: best.longitude, timezone: best.timezone, geocoder: 'open-meteo',
        administrativeArea: {
          countryCode: best.country_code || '',
          region: best.admin1 || null,
          subregion: best.admin2 || null,
          locality: best.admin3 || best.admin4 || null,
          code: null,
        },
        providerIds: {
          geonamesId: best.id || null,
          admin1Id: best.admin1_id || null,
          admin2Id: best.admin2_id || null,
          admin3Id: best.admin3_id || null,
          admin4Id: best.admin4_id || null,
        },
      };
      await cacheLocation(cacheKey, location);
      return location;
    }
  } catch (error) { openMeteoError = error; }

  // Domestic lookups cannot fall back to Photon because it does not report a
  // dependable prefecture-vs-county level for Chinese locations.
  if (scope === 'domestic' || countryCode === 'CN') {
    if (openMeteoError) throw new Error(`中国境内地点查询暂不可用：${openMeteoError.message}`);
    throw new Error(`未找到“${raw}”对应的中国境内地点，请检查城市或区县名称。`);
  }

  try {
    const data = await photonSearch(raw, fetcher);
    const match = selectPhotonFeature(data.features, namePart, countryCode, scope);
    if (!match) {
      const domesticName = scope === 'domestic' || countryCode === 'CN'
        || (!hintedCountryCode && /[\u3400-\u9fff]/.test(namePart));
      const scopeLabel = domesticName ? '中国境内地点' : scope === 'foreign' ? '海外城市' : '城市';
      throw new Error(`未找到“${raw}”对应的${scopeLabel}，请检查城市名称。`);
    }
    const [longitude, latitude] = match.coordinates.map(Number);
    const resultCountryCode = String(match.properties.countrycode || countryCode || '').toUpperCase();
    const location = {
      name: photonLocationName(match.properties, namePart),
      country: match.properties.country || '', countryCode: resultCountryCode,
      latitude, longitude, timezone: await timezoneAt(latitude, longitude, resultCountryCode, fetcher),
      geocoder: 'photon',
      providerIds: {
        osmId: match.properties.osm_id || null,
        osmType: match.properties.osm_type || null,
        osmKey: match.properties.osm_key || null,
        osmValue: match.properties.osm_value || null,
      },
      administrativeArea: {
        countryCode: resultCountryCode,
        region: match.properties.state || null,
        subregion: match.properties.county || match.properties.city || null,
        locality: match.properties.district || null,
        code: null,
      },
    };
    await cacheLocation(cacheKey, location);
    return location;
  } catch (error) {
    if (/多个同名城市/.test(error.message)) throw error;
    if (/未找到/.test(error.message)) throw error;
    const detail = openMeteoError ? `Open-Meteo：${openMeteoError.message}；` : '';
    throw new Error(`${detail}城市地理编码暂不可用，请稍后重试。`);
  }
  })();
  geocodingRequests.set(requestKey, request);
  try { return await request; }
  finally { geocodingRequests.delete(requestKey); }
}

const condition = code => {
  if (code == null || code === '' || !Number.isFinite(Number(code))) return ['天气状况未知', 'cloudy'];
  const value = Number(code);
  if (value === 0) return ['晴', 'sun'];
  if (value === 1 || value === 2) return ['晴间多云', 'partly'];
  if (value === 3) return ['阴', 'cloudy'];
  if ([45, 48].includes(value)) return ['有雾', 'foggy'];
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67].includes(value)) return ['有雨', 'rainy'];
  if ([71, 73, 75, 77, 85, 86].includes(value)) return ['有雪', 'snowy'];
  if ([80, 81, 82].includes(value)) return ['阵雨', 'rainy'];
  if (value === 97) return ['天气状况未知', 'thunderstorm'];
  if ([95, 96, 99].includes(value)) return ['雷雨', 'thunderstorm'];
  return ['天气状况未知', 'cloudy'];
};
const conditionDescription = code => {
  const value = Number(code);
  return ({
    0: '晴', 1: '晴间多云', 2: '晴间多云', 3: '阴', 45: '有雾', 48: '冻雾',
    51: '毛毛雨', 53: '中等毛毛雨', 55: '浓毛毛雨', 56: '冻毛毛雨', 57: '浓冻毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '强冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
    80: '小阵雨', 81: '中阵雨', 82: '强阵雨', 85: '小阵雪', 86: '强阵雪',
    95: '雷雨', 96: '雷暴伴小冰雹', 97: '强雷暴', 99: '雷暴伴大冰雹',
  })[value] || '天气状况未知';
};
function normalizedWeatherCondition(conditionText, source, code, fallbackIcon, amounts = {}) {
  const classification = classifyPrecipitation(conditionText, { source, code, ...amounts });
  return { ...classification, icon: classification.icon || fallbackIcon };
}
const numericValue = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const r = value => {
  const number = numericValue(value);
  return number == null ? null : Math.round(number);
};
const probability = value => {
  const number = numericValue(value);
  return number == null || number < 0 || number > 100 ? null : Math.round(number);
};
const amount = value => {
  const number = numericValue(value);
  return number == null || number < 0 ? null : Math.round(number * 10) / 10;
};
const hm = s => String(s || '').slice(11, 16);
const minutes = s => Number(String(s).slice(11, 13)) * 60 + Number(String(s).slice(14, 16));
const weekday = date => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${date}T12:00:00Z`).getUTCDay()];
const aqiLabel = n => n == null ? '未提供' : n <= 50 ? '优' : n <= 100 ? '良' : n <= 150 ? '敏感人群注意' : n <= 200 ? '不健康' : n <= 300 ? '非常不健康' : '危险';
const uvLabel = n => n == null ? '未提供' : n < 3 ? '低' : n < 6 ? '中等' : n < 8 ? '高' : n < 11 ? '很高' : '极高';
const visibilityLabel = n => n >= 10 ? '良好' : n >= 5 ? '一般' : n >= 1 ? '较差' : '很差';
const windLevel = n => n < 6 ? 1 : n < 12 ? 2 : n < 20 ? 3 : n < 29 ? 4 : n < 39 ? 5 : 6;
const isSnowCode = code => [71, 73, 75, 77, 85, 86].includes(Number(code));
const isRainCode = code => [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(Number(code));

function generatedLifeIndices({ high, low, uv, rain, snow, rainAmount, snowAmount, precipitationAmount, precipitation, condition: weatherText }) {
  const indices = [];
  const hasRain = (rain ?? 0) >= 50 || (rainAmount ?? 0) > 0 || /雨|雷/.test(weatherText || '');
  const hasSnow = (snow ?? 0) >= 30 || (snowAmount ?? 0) > 0 || /雪/.test(weatherText || '');
  if (hasRain && hasSnow) indices.push({ name: '出行', detail: '预报显示有雨雪，留意道路湿滑并按需携带雨具。' });
  else if (hasRain) indices.push({ name: '出行', detail: '预报显示有降雨，建议携带雨具。' });
  else if (hasSnow) indices.push({ name: '出行', detail: '预报显示有降雪，留意道路湿滑和交通变化。' });
  else if ((precipitationAmount ?? 0) > 0) indices.push({ name: '出行', detail: '预报显示有降水，但类型信息暂缺，请留意天气变化。' });
  else if (precipitation == null) indices.push({ name: '出行', detail: '降水概率数据暂缺，请留意天气变化。' });
  else if (precipitation === 0) indices.push({ name: '出行', detail: '当前预报降水概率为 0%，适合正常出行。' });
  else if (precipitation >= 50) indices.push({ name: '出行', detail: '预报降水概率较高，出行前请留意天气变化。' });
  else indices.push({ name: '出行', detail: '预报降水概率较低，仍建议留意天气变化。' });
  if (low != null && low <= 5) indices.push({ name: '穿衣', detail: '气温偏低，建议穿保暖外套。' });
  else if (high != null && high >= 30) indices.push({ name: '穿衣', detail: '天气偏热，建议穿轻薄透气衣物。' });
  else indices.push({ name: '穿衣', detail: '建议按早晚温差采用分层穿搭。' });
  indices.push({ name: '紫外线', detail: uv == null ? '紫外线数据暂缺。' : uv >= 6 ? '紫外线较强，外出注意防晒。' : uv >= 3 ? '紫外线中等，可适当防晒。' : '紫外线较弱。' });
  indices.push({ name: '户外活动', detail: /雷|暴雨|大雪|暴雪/.test(weatherText || '') ? '天气不稳定，建议减少长时间户外活动。' : '可安排日常户外活动，留意天气变化。' });
  return indices;
}

function makeOpenMeteoHour(h, index) {
  const code = h.weather_code[index];
  const [label, icon] = condition(code);
  const description = conditionDescription(code);
  const precipitationChance = probability(h.precipitation_probability?.[index]);
  const rainAmount = amount(h.rain?.[index]);
  const snowAmount = amount(h.snowfall?.[index]);
  const normalized = normalizedWeatherCondition(label, 'open-meteo', code, icon, { rainAmount, snowAmount });
  const mixed = rainAmount > 0 && snowAmount > 0;
  const snow = isSnowCode(code) || (snowAmount != null && snowAmount > 0);
  const rain = isRainCode(code) || (rainAmount != null && rainAmount > 0);
  return {
    time: hm(h.time[index]), dateTime: h.time[index], temp: r(h.temperature_2m[index]), condition: label, displayCondition: description,
    icon: mixed ? 'sleet' : normalized.icon,
    precipitationKind: mixed ? 'mixed' : normalized.precipitationKind,
    precipitationIntensity: mixed ? 'unknown' : normalized.precipitationIntensity,
    precipitationType: mixed ? 'sleet' : snow ? 'snow' : rain ? 'rain' : null,
    // Open-Meteo exposes a general precipitation probability, not separate rain/snow chances.
    rainProbability: null,
    snowProbability: null,
    precipitationProbability: precipitationChance,
    precipitationAmount: amount(h.precipitation?.[index]), rainAmount, snowAmount,
    rain: precipitationChance,
  };
}

export function formatWeather(location, forecast, air = {}) {
  const c = forecast.current, d = forecast.daily, h = forecast.hourly;
  if (!c?.time || !d?.time?.length || !h?.time?.length) throw new Error('天气数据不完整');
  const today = d.time.indexOf(c.time.slice(0, 10));
  if (today < 0) throw new Error('天气日期不匹配');
  const [label, fallbackIcon] = condition(c.weather_code);
  const displayCondition = conditionDescription(c.weather_code);
  const currentPrecipitation = normalizedWeatherCondition(label, 'open-meteo', c.weather_code, fallbackIcon);
  const nowMinutes = minutes(c.time), sunriseMinutes = minutes(d.sunrise[today]), sunsetMinutes = minutes(d.sunset[today]);
  const night = nowMinutes < sunriseMinutes || nowMinutes > sunsetMinutes;
  const icon = night && currentPrecipitation.icon === 'sun' ? 'moon'
    : night && currentPrecipitation.icon === 'partly' ? 'night' : currentPrecipitation.icon;
  const first = h.time.findIndex(s => s.slice(0, 10) === c.time.slice(0, 10) && minutes(s) >= nowMinutes - 15);
  if (first < 0) throw new Error('逐小时天气数据不完整');
  const aqi = air.current?.us_aqi ?? null;
  const visibility = c.visibility == null ? null : r(c.visibility / 1000);
  const uv = d.uv_index_max[today] == null ? null : r(d.uv_index_max[today]);
  const duration = sunsetMinutes - sunriseMinutes;
  const hourly24 = h.time.slice(first, first + 24).map((_, i) => makeOpenMeteoHour(h, first + i));
  const days = d.time.slice(today, today + 7).map((date, i) => {
    const code = d.weather_code[today + i];
    const [dayCondition, fallbackIcon] = condition(code);
    const dayDescription = conditionDescription(code);
    const precipitation = probability(d.precipitation_probability_max?.[today + i]);
    const snowAmount = amount(d.snowfall_sum?.[today + i]);
    const rainAmount = amount(d.rain_sum?.[today + i]);
    const dayPrecipitation = normalizedWeatherCondition(dayCondition, 'open-meteo', code, fallbackIcon);
    return {
      date, name: i === 0 ? '今天' : `${weekday(date)} ${Number(date.slice(8))}`,
      icon: dayPrecipitation.icon, condition: dayCondition, displayCondition: dayDescription,
      precipitationKind: dayPrecipitation.precipitationKind,
      precipitationIntensity: dayPrecipitation.precipitationIntensity,
      high: r(d.temperature_2m_max[today + i]), low: r(d.temperature_2m_min[today + i]),
      rainProbability: null, snowProbability: null, precipitationProbability: precipitation,
      precipitationAmount: amount(d.precipitation_sum?.[today + i]), rainAmount, snowAmount,
      uv: r(d.uv_index_max?.[today + i]),
    };
  });
  const todayData = days[0];
  return {
    city: `${location.name} ${hm(c.time)}`,
    updated: `当地时间 ${c.time.replace('T', ' ')} 更新`,
    temperature: r(c.temperature_2m), condition: label, displayCondition, icon,
    precipitationKind: currentPrecipitation.precipitationKind,
    precipitationIntensity: currentPrecipitation.precipitationIntensity,
    high: todayData.high, low: todayData.low,
    days,
    hourly24,
    hourly: hourly24.filter((_, i) => i % 3 === 0).slice(0, 8),
    visibility: visibility ?? '—', visibilityNote: visibility == null ? '未提供' : visibilityLabel(visibility),
    pressure: r(c.pressure_msl) ?? '—', pressureNote: '当前气压',
    aqi: aqi == null ? '—' : r(aqi), aqiNote: aqiLabel(aqi),
    uv: uv ?? '—', uvNote: uvLabel(uv),
    wind: r(c.wind_speed_10m) ?? '—', gust: r(c.wind_gusts_10m) ?? '—',
    windDirection: r(c.wind_direction_10m), windNote: c.wind_speed_10m == null ? '风力未知' : `风力: ${windLevel(c.wind_speed_10m)}级`,
    humidity: r(c.relative_humidity_2m) ?? '—', dewPoint: r(c.dew_point_2m) ?? '—',
    humidityNote: c.relative_humidity_2m == null ? '未提供' : c.relative_humidity_2m >= 70 ? '潮湿' : c.relative_humidity_2m >= 40 ? '适中' : '干燥',
    daylight: `${Math.floor(duration / 60)}小时 ${duration % 60}分钟`,
    sunrise: hm(d.sunrise[today]), sunset: hm(d.sunset[today]),
    lifeIndices: generatedLifeIndices({ high: todayData.high, low: todayData.low, uv, rain: todayData.rainProbability, snow: todayData.snowProbability, rainAmount: todayData.rainAmount, snowAmount: todayData.snowAmount, precipitationAmount: todayData.precipitationAmount, precipitation: todayData.precipitationProbability, condition: todayData.condition }),
    sourceNote: `数据来源：Open-Meteo · ${location.name}当地时间 ${c.time.replace('T', ' ')} 的天气快照。`,
    timezone: forecast.timezone || location.timezone || 'UTC',
    providerData: { source: 'open-meteo', current: c, hourly: h, daily: d, airCurrent: air.current || null },
  };
}

const WEATHER_API_RAIN = new Set([1063, 1069, 1072, 1087, 1150, 1153, 1168, 1171, 1180, 1183, 1186, 1189, 1192, 1195, 1198, 1201, 1204, 1207, 1240, 1243, 1246, 1249, 1252, 1261, 1264, 1273, 1276, 1279, 1282]);
const WEATHER_API_SNOW = new Set([1066, 1069, 1114, 1117, 1210, 1213, 1216, 1219, 1222, 1225, 1255, 1258]);
const WEATHER_API_SLEET = new Set([1069, 1204, 1207, 1261, 1264]);
const WEATHER_API_SLEET_ICON = new Set([1069, 1204, 1207, 1249, 1252, 1261, 1264]);
const WEATHER_API_FOG = new Set([1030, 1135, 1147]);
const WEATHER_API_THUNDER = new Set([1087, 1273, 1276, 1279, 1282]);
const WEATHER_API_HAIL = new Set([1237]);

function weatherApiIcon(code, isDay = true) {
  const value = Number(code);
  if (value === 1000) return isDay ? 'sun' : 'moon';
  if (value === 1003) return isDay ? 'partly' : 'night';
  if (WEATHER_API_FOG.has(value)) return 'foggy';
  if (WEATHER_API_THUNDER.has(value)) return 'thunderstorm';
  if (WEATHER_API_HAIL.has(value)) return 'hail';
  if (WEATHER_API_SLEET_ICON.has(value)) return 'sleet';
  if (WEATHER_API_RAIN.has(value)) return 'rainy';
  if (WEATHER_API_SNOW.has(value)) return 'snowy';
  return 'cloudy';
}

function weatherApiTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return String(value || '—');
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'PM') hour += 12;
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

function weatherApiTimeMinutes(value) {
  const normalized = weatherApiTime(value);
  const [hour, minute] = normalized.split(':').map(Number);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
}

const localTimestamp = value => Date.parse(`${String(value || '').replace(' ', 'T')}Z`);

function weatherApiAqiLabel(value) {
  return ({ 1: '优', 2: '良', 3: '对敏感人群不健康', 4: '不健康', 5: '非常不健康', 6: '危险' })[Number(value)] || '未提供';
}

export function formatWeatherApi(location, forecast) {
  const current = forecast.current;
  const days = forecast.forecast?.forecastday || [];
  const localtime = forecast.location?.localtime || current?.last_updated;
  if (!current || !days.length || !localtime) throw new Error('WeatherAPI 返回的天气数据不完整');
  const date = localtime.slice(0, 10);
  const today = days.find(day => day.date === date) || days[0];
  const dayForecast = today.day || {};
  const dayNumber = Number(today.date.slice(8));
  const name = today.date === date ? '今天' : `${weekday(today.date)} ${dayNumber}`;
  const currentCode = current.condition?.code;
  const currentCondition = current.condition?.text || '天气状况未知';
  const currentPrecipitation = normalizedWeatherCondition(currentCondition, 'weatherapi', currentCode, weatherApiIcon(currentCode, current.is_day !== 0));
  const currentIcon = currentPrecipitation.icon;
  const hourRows = days.flatMap(day => day.hour || []);
  const currentTime = current.last_updated || localtime;
  const currentStamp = localTimestamp(currentTime);
  const start = hourRows.findIndex(hour => localTimestamp(hour.time) >= currentStamp - 15 * 60000);
  if (start < 0) throw new Error('WeatherAPI 没有返回可用的逐小时天气');

  const sunrise = weatherApiTime(today.astro?.sunrise);
  const sunset = weatherApiTime(today.astro?.sunset);
  const sunriseMinute = weatherApiTimeMinutes(today.astro?.sunrise);
  const sunsetMinute = weatherApiTimeMinutes(today.astro?.sunset);
  const daylightMinutes = sunriseMinute == null || sunsetMinute == null
    ? null : (sunsetMinute - sunriseMinute + 1440) % 1440;
  const aqiRaw = current.air_quality?.['us-epa-index'];
  const aqi = r(aqiRaw);
  const high = r(dayForecast.maxtemp_c), low = r(dayForecast.mintemp_c);
  const visibility = r(current.vis_km);
  const humidity = r(current.humidity);
  const wind = r(current.wind_kph);
  const hourly24 = hourRows.slice(start, start + 24).map(hour => {
    const conditionText = hour.condition?.text || '天气状况未知';
    const rainProbability = probability(hour.chance_of_rain);
    const snowProbability = probability(hour.chance_of_snow);
    const precipitationAmount = amount(hour.precip_mm), snowAmount = amount(hour.snow_cm);
    const precipitation = normalizedWeatherCondition(conditionText, 'weatherapi', hour.condition?.code, weatherApiIcon(hour.condition?.code), { snowAmount });
    const mixed = WEATHER_API_SLEET.has(Number(hour.condition?.code))
      || /雨夹雪|雨雪|雨.*雪|雪.*雨|\bsleet\b/i.test(conditionText);
    const snow = /雪/.test(conditionText) || WEATHER_API_SNOW.has(Number(hour.condition?.code)) || (snowAmount != null && snowAmount > 0);
    const rain = /雨|雷/.test(conditionText) || WEATHER_API_RAIN.has(Number(hour.condition?.code));
    return {
      time: hour.time.slice(11, 16), dateTime: hour.time, temp: r(hour.temp_c), condition: conditionText,
      icon: mixed ? 'sleet' : precipitation.icon,
      precipitationKind: mixed ? 'mixed' : precipitation.precipitationKind,
      precipitationIntensity: mixed ? 'unknown' : precipitation.precipitationIntensity,
      precipitationType: mixed ? 'sleet' : snow ? 'snow' : rain ? 'rain' : null,
      rainProbability: mixed ? null : rainProbability,
      snowProbability: mixed ? null : snowProbability,
      // WeatherAPI only supplies separate rain/snow chances here; their maximum is
      // not a generic precipitation probability and must not be presented as one.
      precipitationProbability: null,
      precipitationAmount, rainAmount: null, snowAmount,
      rain: null,
    };
  });
  const normalizedDays = days.map((item, index) => {
    const day = item.day || {};
    const conditionText = day.condition?.text || '天气状况未知';
    const snowAmount = amount(day.totalsnow_cm);
    const precipitation = normalizedWeatherCondition(conditionText, 'weatherapi', day.condition?.code, weatherApiIcon(day.condition?.code), { snowAmount });
    const rainProbability = probability(day.daily_chance_of_rain);
    const snowProbability = probability(day.daily_chance_of_snow);
    return {
      date: item.date,
      name: index === 0 ? (item.date === date ? '今天' : name) : `${weekday(item.date)} ${Number(item.date.slice(8))}`,
      icon: precipitation.icon, condition: conditionText,
      precipitationKind: precipitation.precipitationKind,
      precipitationIntensity: precipitation.precipitationIntensity,
      high: r(day.maxtemp_c), low: r(day.mintemp_c), rainProbability, snowProbability,
      precipitationProbability: null,
      precipitationAmount: amount(day.totalprecip_mm), rainAmount: null,
      snowAmount, uv: r(day.uv),
    };
  });
  const todayData = normalizedDays.find(item => item.name === '今天') || normalizedDays[0];

  return {
    city: `${location.name} ${localtime.slice(11, 16)}`,
    updated: `当地时间 ${localtime} 更新`,
    temperature: r(current.temp_c),
    currentPrecipitationAmount: amount(current.precip_mm),
    condition: currentCondition,
    icon: currentIcon,
    precipitationKind: currentPrecipitation.precipitationKind,
    precipitationIntensity: currentPrecipitation.precipitationIntensity,
    high: todayData?.high ?? high, low: todayData?.low ?? low,
    days: normalizedDays,
    hourly24,
    hourly: hourly24.filter((_, index) => index % 3 === 0).slice(0, 8),
    visibility: visibility ?? '—', visibilityNote: visibility == null ? '未提供' : visibilityLabel(visibility),
    pressure: r(current.pressure_mb) ?? '—', pressureNote: '当前气压',
    aqi: aqi ?? '—', aqiNote: weatherApiAqiLabel(aqi),
    uv: r(dayForecast.uv) ?? '—', uvNote: uvLabel(r(dayForecast.uv)),
    wind: wind ?? '—', gust: r(current.gust_kph) ?? '—',
    windDirection: r(current.wind_degree), windNote: wind == null ? '风力未知' : `风力: ${windLevel(wind)}级`,
    humidity: humidity ?? '—', dewPoint: r(current.dewpoint_c) ?? '—',
    humidityNote: humidity == null ? '未提供' : humidity >= 70 ? '潮湿' : humidity >= 40 ? '适中' : '干燥',
    daylight: daylightMinutes == null ? '—' : `${Math.floor(daylightMinutes / 60)}小时 ${daylightMinutes % 60}分钟`,
    sunrise, sunset,
    lifeIndices: generatedLifeIndices({ high, low, uv: r(dayForecast.uv), rain: todayData?.rainProbability, snow: todayData?.snowProbability, rainAmount: todayData?.rainAmount, snowAmount: todayData?.snowAmount, precipitationAmount: todayData?.precipitationAmount, precipitation: todayData?.precipitationProbability, condition: todayData?.condition }),
    sourceNote: `数据来源：WeatherAPI.com · ${location.name}当地时间 ${localtime} 的天气快照。`,
    timezone: forecast.location?.tz_id || location.timezone || 'UTC',
    providerData: { source: 'weatherapi', location: forecast.location || null, current, forecast: forecast.forecast },
  };
}

async function getText(url, fetcher = fetch, timeoutMs = 12000) {
  let response;
  const requestSignal = AbortSignal.timeout(timeoutMs);
  try {
    response = await fetcher(url, {
      signal: requestSignal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError' && error.cause?.name === 'TimeoutError';
    const requestError = new Error(timedOut ? 'Bing/MSN 天气请求超时，请稍后重试' : '无法连接 Bing/MSN 天气，请检查网络后重试', { cause: error });
    requestError.code = timedOut ? 'timeout' : 'network-request-failed';
    requestError.stage = 'network';
    requestError.url = String(url);
    requestError.timedOut = timedOut;
    throw requestError;
  }
  if (!response.ok) {
    const requestError = new Error(`Bing/MSN 天气页面返回 HTTP ${response.status}`);
    requestError.code = response.status === 429 ? 'http-429' : 'network-request-failed';
    requestError.stage = 'network';
    requestError.httpStatus = response.status;
    requestError.retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
    requestError.url = String(url);
    throw requestError;
  }
  try { return await response.text(); }
  catch (error) {
    const timedOut = error?.name === 'TimeoutError' || requestSignal.aborted && requestSignal.reason?.name === 'TimeoutError';
    const requestError = new Error(timedOut
      ? '读取 MSN 天气网页内容超时，请稍后重试'
      : `读取 MSN 天气网页内容失败：${error.message || error}`, { cause: error });
    requestError.code = timedOut ? 'timeout' : 'network-request-failed';
    requestError.stage = 'network';
    requestError.httpStatus = response.status;
    requestError.url = String(url);
    requestError.timedOut = timedOut;
    throw requestError;
  }
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

function bingSearchResultUrl(html) {
  for (const match of html.matchAll(/href=(['"])(.*?)\1/gi)) {
    const href = match[2]
      .replaceAll('\\/', '/')
      .replaceAll('&amp;', '&')
      .replaceAll('&#x3D;', '=')
      .replaceAll('&#39;', "'");
    try {
      const url = new URL(href);
      if (/^www\.msn\.(?:cn|com)$/i.test(url.hostname)
        && /^\/zh-cn\/weather\/forecast\/in-/i.test(url.pathname)) return url;
    } catch {}
  }
  return null;
}

async function msnForecastUrl(location, fetcher, { skipSearch = false, timeoutMs = 12000 } = {}) {
  const term = `${location.name}${location.country ? ` ${location.country}` : ''} 天气`;
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(term)}&setlang=zh-CN&cc=CN&mkt=zh-CN`;
  let pageUrl;
  if (!skipSearch) {
    try {
      const bingHtml = await getText(searchUrl, fetcher, timeoutMs);
      pageUrl = bingSearchResultUrl(bingHtml);
    } catch {
      // Some networks block Bing search HTML; the coordinate-specific MSN page remains usable.
    }
  }
  if (!pageUrl) pageUrl = new URL(`https://www.msn.cn/zh-cn/weather/forecast/in-${location.latitude},${location.longitude}`);

  // MSN may otherwise use the server's detected location instead of the city requested by the user.
  const loc = Buffer.from(JSON.stringify({ x: String(location.longitude), y: String(location.latitude) })).toString('base64');
  pageUrl.hostname = 'www.msn.cn';
  pageUrl.searchParams.set('loc', loc);
  pageUrl.searchParams.set('weadegreetype', 'C');
  return pageUrl;
}

const msnNumber = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const match = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
};

function msnIcon(symbol, description = '') {
  const text = String(description);
  if (/雨夹雪|雨雪|雨.*雪|雪.*雨/.test(text)) return 'sleet';
  if (/冰雹|冰粒/.test(text)) return 'hail';
  if (/雾|霾/.test(text)) return 'foggy';
  if (/雪/.test(text)) return 'snowy';
  if (/雷|thunder/i.test(text)) return 'thunderstorm';
  if (/雨|阵雨|暴雨|drizzle|rain|shower/i.test(text)) return 'rainy';
  const code = String(symbol || '').replace(/^[dn]/i, '');
  if (/^(?:4[1-9]|5\d|6\d|8\d|9\d)/.test(code)) return 'rainy';
  if (/^0+/.test(code)) return String(symbol || '').startsWith('n') ? 'moon' : 'sun';
  if (/^[12]/.test(code)) return String(symbol || '').startsWith('n') ? 'night' : 'partly';
  if (/^[34]/.test(code)) return 'cloudy';
  if (/(晴)/.test(text)) return String(symbol || '').startsWith('n') ? 'moon' : 'sun';
  if (/(多云|阴|云)/.test(text)) return 'cloudy';
  return 'cloudy';
}

function msnDayDate(day) {
  const value = day.almanac?.valid || day.almanac?.sunrise || day.validTime?.dataValue || day.day?.dataValue;
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

function msnAqiLabel(value, severity) {
  if (severity) return String(severity).replace(/^空气/, '');
  const aqi = msnNumber(value);
  return aqi == null ? '未提供' : aqi <= 50 ? '优' : aqi <= 100 ? '良' : aqi <= 150 ? '轻度污染' : aqi <= 200 ? '中度污染' : aqi <= 300 ? '重度污染' : '严重污染';
}

export function formatBingWeather(location, weather) {
  const raw = weather?.currentCondition?.currentRaw;
  const current = weather?.currentCondition;
  const forecasts = weather?.forecast;
  const created = raw?.created;
  if (!raw || !current || !Array.isArray(forecasts) || !forecasts.length || !created) {
    throw new Error('MSN 天气页面没有返回完整的天气数据');
  }

  const date = created.slice(0, 10);
  const localTimestamp = created.replace('T', ' ').replace(/[+-]\d{2}:?\d{2}$/, '');
  const today = Math.max(0, forecasts.findIndex(day => msnDayDate(day) === date));
  const todayForecast = forecasts[today];
  const sunrise = todayForecast?.almanac?.sunrise || '';
  const sunset = todayForecast?.almanac?.sunset || '';
  const daylightMinutes = sunrise && sunset
    ? (minutes(sunset) - minutes(sunrise) + 1440) % 1440
    : null;
  const localTime = created.match(/T(\d{2}:\d{2})/)?.[1] || '—';
  const currentTime = Date.parse(created);
  const allHours = forecasts.flatMap(day => day.hourly || [])
    .filter(hour => hour.timeStr && Number.isFinite(msnNumber(hour.temperature)))
    .sort((a, b) => Date.parse(a.timeStr) - Date.parse(b.timeStr));
  const hours = [...new Map(allHours.map(hour => [hour.timeStr, hour])).values()];
  const firstHour = hours.findIndex(hour => !Number.isFinite(currentTime) || Date.parse(hour.timeStr) >= currentTime - 15 * 60000);
  if (firstHour < 0) throw new Error('MSN 天气页面没有返回未来逐小时预报');
  const hourly = Array.from({ length: 8 }, (_, index) => hours[firstHour + index * 3])
    .filter(Boolean)
    .map(hour => ({
      time: hour.timeStr.slice(11, 16),
      temp: r(msnNumber(hour.temperature)),
      rain: probability(msnNumber(hour.precipitation)),
    }));
  if (!hourly.length) throw new Error('MSN 天气页面没有返回可用的逐小时预报');
  const hourly24 = hours.slice(firstHour, firstHour + 24).map(hour => {
    const conditionText = hour.cap || '天气状况未知';
    const precipitation = probability(msnNumber(hour.precipitation));
    const rainAmount = amount(msnNumber(hour.rainAmount));
    const snowAmount = amount(msnNumber(hour.snowAmount));
    const precipitationData = normalizedWeatherCondition(conditionText, 'msn', null, msnIcon(hour.symbol, conditionText), { rainAmount, snowAmount });
    const mixed = /雨夹雪|雨雪|雨.*雪|雪.*雨/.test(conditionText) || (rainAmount > 0 && snowAmount > 0);
    const snow = /雪/.test(conditionText) || (snowAmount != null && snowAmount > 0);
    const rain = /雨|雷/.test(conditionText) || (rainAmount != null && rainAmount > 0);
    return {
      time: hour.timeStr.slice(11, 16), dateTime: hour.timeStr, temp: r(msnNumber(hour.temperature)),
      condition: conditionText, icon: mixed ? 'sleet' : precipitationData.icon,
      precipitationKind: mixed ? 'mixed' : precipitationData.precipitationKind,
      precipitationIntensity: mixed ? 'unknown' : precipitationData.precipitationIntensity,
      precipitationType: mixed ? 'sleet' : snow ? 'snow' : rain ? 'rain' : null,
      // The MSN page field is general precipitation probability; it does not identify rain vs snow.
      rainProbability: null,
      snowProbability: null,
      precipitationProbability: precipitation,
      rainAmount, snowAmount, rain: precipitation,
    };
  });

  const humidity = r(msnNumber(raw.rh ?? current.humidity));
  const visibility = r(msnNumber(raw.vis ?? current.visiblity));
  const aqi = r(msnNumber(raw.aqi ?? current.aqi));
  const wind = r(msnNumber(raw.windSpd ?? current.windSpeedNumber));
  const gust = r(msnNumber(raw.windGust ?? current.windGustNumber));
  const uv = r(msnNumber(raw.uv ?? current.uv));
  const pressure = r(msnNumber(raw.baro ?? current.baro));
  const conditionText = raw.cap || current.shortCap || '天气状况未知';
  const days = forecasts.slice(today, today + 7).map((day, index) => {
    const description = day.dayCap || day.cap || '天气状况未知';
    const precipitation = probability(msnNumber(day.precipitation));
    const snowAmount = amount(msnNumber(day.snowAmount));
    const rainAmount = amount(msnNumber(day.rainAmount));
    const precipitationData = normalizedWeatherCondition(description, 'msn', null, msnIcon(day.daySymbol || day.symbol, description));
    const dayDate = msnDayDate(day);
    return {
      date: dayDate || null,
      name: index === 0 ? '今天' : dayDate ? `${weekday(dayDate)} ${Number(dayDate.slice(8))}` : `第${index + 1}天`,
      icon: precipitationData.icon, condition: description,
      precipitationKind: precipitationData.precipitationKind,
      precipitationIntensity: precipitationData.precipitationIntensity,
      high: r(msnNumber(day.highTemp)), low: r(msnNumber(day.lowTemp)),
      rainProbability: null, snowProbability: null, precipitationProbability: precipitation,
      rainAmount, snowAmount, uv: r(msnNumber(day.uv)),
    };
  });
  const todayData = days[0];
  const currentPrecipitation = normalizedWeatherCondition(conditionText, 'msn', null, msnIcon(raw.symbol || current.symbol, conditionText));
  const lifeTypeNames = new Map(['1:1:穿衣指数', '1:3:风寒指数', '1:4:高温指数', '2:10:雨伞指数', '3:26:户外活动'].map(value => {
    const [type, subtype, ...name] = value.split(':');
    return [`${type}:${subtype}`, name.join(':')];
  }));
  const msnLife = (weather.lifeActivityData?.days?.[today]?.lifeDailyIndices || [])
    .map(item => ({
      name: lifeTypeNames.get(`${item.type}:${item.subType}`) || '生活提示',
      detail: item.shortSummary || item.taskbarSummary || item.summary || '',
    }))
    .filter(item => item.detail)
    .slice(0, 5);
  const lifeIndices = msnLife.length ? msnLife : generatedLifeIndices({
    high: todayData?.high, low: todayData?.low, uv, rain: todayData?.rainProbability,
    snow: todayData?.snowProbability, rainAmount: todayData?.rainAmount, snowAmount: todayData?.snowAmount,
    precipitationAmount: todayData?.precipitationAmount, precipitation: todayData?.precipitationProbability, condition: todayData?.condition,
  });

  return {
    city: `${location.name} ${localTime}`,
    updated: `当地时间 ${localTimestamp} 更新`,
    temperature: r(msnNumber(raw.temp ?? current.currentTemperature)),
    condition: conditionText,
    icon: currentPrecipitation.icon,
    precipitationKind: currentPrecipitation.precipitationKind,
    precipitationIntensity: currentPrecipitation.precipitationIntensity,
    high: todayData?.high ?? r(msnNumber(todayForecast.highTemp)),
    low: todayData?.low ?? r(msnNumber(todayForecast.lowTemp)),
    days, hourly24, hourly,
    visibility: visibility ?? '—',
    visibilityNote: visibility == null ? '未提供' : visibilityLabel(visibility),
    pressure: pressure ?? '—', pressureNote: '当前气压',
    aqi: aqi ?? '—', aqiNote: msnAqiLabel(raw.aqi ?? current.aqi, current.aqiSeverity),
    uv: uv ?? '—', uvNote: uvLabel(uv),
    wind: wind ?? '—', gust: gust ?? '—',
    windDirection: r(msnNumber(raw.windDir ?? current.windDir)),
    windNote: current.windDesc || raw.pvdrWindSpd || (wind == null ? '风力未知' : `风速 ${wind} 公里/小时`),
    humidity: humidity ?? '—', dewPoint: r(msnNumber(raw.dewPt ?? current.dewPoint)) ?? '—',
    humidityNote: humidity == null ? '未提供' : humidity >= 70 ? '潮湿' : humidity >= 40 ? '适中' : '干燥',
    daylight: daylightMinutes == null ? '—' : `${Math.floor(daylightMinutes / 60)}小时 ${daylightMinutes % 60}分钟`,
    sunrise: sunrise.slice(11, 16) || '—', sunset: sunset.slice(11, 16) || '—',
    lifeIndices,
    sourceNote: `数据来源：Bing 天气（MSN 天气预报）· ${location.name}当地时间 ${localTimestamp} 的天气快照。`,
    timezone: location.timezone || 'UTC',
    providerData: { source: 'msn', currentCondition: current, currentRaw: raw, forecast: forecasts },
  };
}

async function getBingWeather(location, fetcher) {
  const url = await msnForecastUrl(location, fetcher);
  const html = await getText(url, fetcher);
  const match = html.match(/<script id="redux-data" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('MSN 天气页面未提供可读取的预报数据');
  let payload;
  try { payload = JSON.parse(match[1]); }
  catch { throw new Error('无法解析 MSN 天气页面的数据'); }
  return formatBingWeather(location, payload?.WeatherData?.['_@STATE@_']);
}

function addGeocoderCredit(location, weather) {
  if (location.geocoder === 'photon') {
    weather.sourceNote += ' · 地点解析：Photon / © OpenStreetMap contributors';
  }
  return weather;
}

export async function getWeather(location, fetcher = fetch, settings = {}) {
  const source = settings.source || 'bing';
  if (source === 'bing') return addGeocoderCredit(location, await getBingWeather(location, fetcher));
  if (source === 'weatherapi') {
    const apiKey = String(settings.weatherApiKey || '').trim();
    if (!apiKey) throw new Error('尚未配置 WeatherAPI 密钥；请先配置后发送 #切换天气源 WeatherAPI。');
    const params = new URLSearchParams({
      key: apiKey,
      q: `${location.latitude},${location.longitude}`,
      days: '3', aqi: 'yes', alerts: 'no', lang: 'zh',
    });
    const forecast = await getJson(`https://api.weatherapi.com/v1/forecast.json?${params}`, fetcher);
    return addGeocoderCredit(location, formatWeatherApi(location, forecast));
  }
  if (source !== 'open-meteo') throw new Error(`未知天气数据源：${source}`);

  const params = new URLSearchParams({
    latitude: String(location.latitude), longitude: String(location.longitude), timezone: location.timezone,
    current: 'temperature_2m,relative_humidity_2m,dew_point_2m,weather_code,pressure_msl,wind_speed_10m,wind_gusts_10m,wind_direction_10m,visibility',
    hourly: 'temperature_2m,precipitation_probability,precipitation,rain,snowfall,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,rain_sum,snowfall_sum,sunrise,sunset,uv_index_max', forecast_days: '7',
  });
  const airParams = new URLSearchParams({ latitude: String(location.latitude), longitude: String(location.longitude), timezone: location.timezone, current: 'us_aqi' });
  const [forecast, air] = await Promise.all([
    getJson(`https://api.open-meteo.com/v1/forecast?${params}`, fetcher),
    getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?${airParams}`, fetcher).catch(() => ({})),
  ]);
  return addGeocoderCredit(location, formatWeather(location, forecast, air));
}

export async function getMsnWeatherAlertData(location, fetcher = fetch) {
  const url = await msnForecastUrl(location, fetcher, { skipSearch: true, timeoutMs: 5000 });
  const requestStarted = performance.now();
  const html = await getText(url, fetcher, 5000);
  const requestMs = performance.now() - requestStarted;
  const parseStarted = performance.now();
  const match = html.match(/<script id="redux-data" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match) {
    const error = new Error('MSN 天气页面没有提供预警数据');
    error.code = 'page-parse-failed';
    error.stage = 'parse';
    error.url = String(url);
    error.httpStatus = 200;
    error.pageFetched = true;
    error.alertDataExtracted = false;
    throw error;
  }
  let payload;
  try { payload = JSON.parse(match[1]); }
  catch {
    const error = new Error('无法解析 MSN 天气页面的预警数据');
    error.code = 'page-parse-failed';
    error.stage = 'parse';
    error.url = String(url);
    error.httpStatus = 200;
    error.pageFetched = true;
    error.alertDataExtracted = false;
    throw error;
  }
  const state = payload?.WeatherData?.['_@STATE@_'];
  const hasAlertsList = Array.isArray(state?.alertsInfoList)
    || Array.isArray(state?.alertsInfo)
    || (state?.alertsInfo && typeof state.alertsInfo === 'object');
  if (!state || !hasAlertsList) {
    const error = new Error('MSN 天气页面没有提供可读取的预警列表');
    error.code = 'source-unsupported';
    error.stage = 'provider';
    error.url = String(url);
    error.httpStatus = 200;
    error.pageFetched = true;
    error.alertDataExtracted = false;
    throw error;
  }
  const raw = Array.isArray(state.alertsInfoList) && state.alertsInfoList.length
    ? state.alertsInfoList
    : Array.isArray(state.alertsInfo) ? state.alertsInfo
      : state.alertsInfo && typeof state.alertsInfo === 'object' ? [state.alertsInfo] : [];
  return {
    alerts: raw,
    sourceUrl: state.currentCondition?.deepLink || String(url),
    requestUrl: String(url),
    pageFetched: true,
    alertDataExtracted: true,
    fetchedAt: new Date().toISOString(),
    timings: { requestMs, providerParseMs: performance.now() - parseStarted },
  };
}

export async function getWeatherApiAlertData(location, fetcher, apiKey) {
  const params = new URLSearchParams({ key: apiKey, q: `${location.latitude},${location.longitude}` });
  const requestStarted = performance.now();
  const data = await getJson(`https://api.weatherapi.com/v1/alerts.json?${params}`, fetcher);
  const requestMs = performance.now() - requestStarted;
  const parseStarted = performance.now();
  if (!data?.alerts || !Object.hasOwn(data.alerts, 'alert')) {
    const error = new Error('WeatherAPI 响应中没有预警列表');
    error.code = 'unsupported';
    throw error;
  }
  const alerts = data.alerts.alert;
  return {
    alerts: Array.isArray(alerts) ? alerts : alerts ? [alerts] : [],
    sourceUrl: null,
    fetchedAt: new Date().toISOString(),
    timings: { requestMs, providerParseMs: performance.now() - parseStarted },
  };
}

export function localDateTime(timezone, date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
