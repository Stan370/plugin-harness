'use strict';
// fetch() here is the host-brokered shim: every request is checked against
// this plugin's granted `network` hosts. Direct sockets are blocked.

const WMO = {
  0: '晴', 1: '大部晴朗', 2: '局部多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨',
  71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 81: '较强阵雨', 82: '强阵雨',
  95: '雷暴', 96: '雷暴伴冰雹', 99: '强雷暴伴冰雹',
};
const AQ_HOST = 'air-quality-api.open-meteo.com';

let host;

async function getJson(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`天气服务返回 HTTP ${res.status}`);
  return res.json();
}

module.exports = {
  activate(h) {
    host = h;
  },

  tools: {
    async current({ city }, ctx) {
      const lang = host.config.language || 'zh';
      ctx.progress(`正在查找城市「${city}」…`);
      const geo = await getJson(
        `https://geocoding-api.open-meteo.com/v1/search?count=10&language=${lang}&name=${encodeURIComponent(city.trim())}`,
      );
      // Same name can match small towns first (e.g. 东京 → a town in Jiangsu): prefer the most populous.
      const place = (geo.results || []).sort((a, b) => (b.population || 0) - (a.population || 0))[0];
      if (!place) throw new Error(`找不到城市「${city}」，换个写法试试（如英文名）`);

      ctx.progress(`正在获取 ${place.name} 的天气…`);
      const unit = host.config.units === 'fahrenheit' ? 'fahrenheit' : 'celsius';
      const w = await getJson(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
          `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&temperature_unit=${unit}&timezone=auto`,
      );
      const c = w.current;
      const u = w.current_units;
      const data = {
        city: place.name,
        region: [place.admin1, place.country].filter(Boolean).join('，'),
        time: c.time.replace('T', ' '),
        condition: WMO[c.weather_code] || `天气代码 ${c.weather_code}`,
        temperature: `${c.temperature_2m}${u.temperature_2m}`,
        feelsLike: `${c.apparent_temperature}${u.apparent_temperature}`,
        humidity: `${c.relative_humidity_2m}%`,
        wind: `${c.wind_speed_10m} ${u.wind_speed_10m}`,
      };

      // Optional capability: only if the user granted the air-quality host.
      if ((host.permissions.network || []).includes(AQ_HOST)) {
        try {
          const aq = await getJson(`https://${AQ_HOST}/v1/air-quality?latitude=${place.latitude}&longitude=${place.longitude}&current=pm2_5,us_aqi`);
          data.aqi = `${aq.current.us_aqi}（PM2.5 ${aq.current.pm2_5} μg/m³）`;
        } catch (e) {
          host.log.warn(`空气质量获取失败：${e.message}`);
        }
      }

      const lines = [
        `${data.city}（${data.region}）${data.time}`,
        `${data.condition}，${data.temperature}（体感 ${data.feelsLike}）`,
        `湿度 ${data.humidity}，风速 ${data.wind}`,
      ];
      if (data.aqi) lines.push(`空气质量 AQI ${data.aqi}`);
      if (!place.population) lines.push(`提示：匹配到的「${place.name}」可能是小地名；如果不是想要的城市，请改用英文名或其他写法（如 Tokyo / 東京）。`);
      return {
        content: lines.join('\n'),
        data,
        display: { type: 'card', labels: { city: '城市', region: '地区', time: '当地时间', condition: '天气', temperature: '气温', feelsLike: '体感', humidity: '湿度', wind: '风速', aqi: '空气质量' } },
      };
    },
  },
};
