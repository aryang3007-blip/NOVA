/**
 * AURA :: Real-time Data Module
 * -----------------------------
 * Gives AURA awareness of the actual world: weather, news, markets,
 * currency, encyclopedic facts.
 *
 * Every source here was verified to send `Access-Control-Allow-Origin: *`,
 * so they work directly from the browser with NO API key and NO backend.
 * The one exception is RSS news, which has no CORS headers — that routes
 * through serve.py's /api/fetch proxy when available.
 *
 * OFFLINE MODE: if `liveData` is disabled in config, every function returns
 * a clear "disabled" result. Nothing silently phones home.
 */

import { config } from '../core/config.js';


const TIMEOUT = 9000;

async function jget(url, { timeout = TIMEOUT, viaProxy = false } = {}) {
  const target = viaProxy ? `/api/fetch?url=${encodeURIComponent(url)}` : url;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(target, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

const WMO = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'violent showers',
  85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail',
};

export class LiveData {
  constructor() {
    this.cache = new Map();
    this.location = null;
  }

  get enabled() { return config.get('liveData') !== false; }

  _disabled(what) {
    return { ok: false, disabled: true,
      message: `Live data is OFF, so I can't fetch ${what}. Turn on **Settings → Interface → Live internet data** to enable it.` };
  }

  /** Simple TTL cache so we don't hammer public APIs. */
  async _cached(key, ttlMs, fn) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.t < ttlMs) return hit.v;
    const v = await fn();
    this.cache.set(key, { v, t: Date.now() });
    return v;
  }

  /* ── location ─────────────────────────────────────────────────────── */

  /** Browser geolocation, falling back to a configured default city. */
  async getLocation({ ask = false } = {}) {
    if (this.location) return this.location;
    if (ask && navigator.geolocation) {
      try {
        const pos = await new Promise((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000, maximumAge: 600000 }));
        this.location = { lat: pos.coords.latitude, lon: pos.coords.longitude, source: 'gps' };
        return this.location;
      } catch { /* denied or unavailable — fall through */ }
    }
    const city = config.get('defaultCity');
    if (city) {
      const geo = await this.geocode(city);
      if (geo.ok) { this.location = { ...geo, source: 'config' }; return this.location; }
    }
    return null;
  }

  /** @param {string} place @returns {Promise<any>} */
  async geocode(place) {
    if (!this.enabled) return this._disabled('location data');
    try {
      const d = await jget(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`);
      const r = d.results?.[0];
      if (!r) return { ok: false, message: `I couldn't find a place called "${place}".` };
      return { ok: true, lat: r.latitude, lon: r.longitude, name: r.name, country: r.country, admin: r.admin1 };
    } catch (e) { return { ok: false, message: `Geocoding failed: ${e.message}` }; }
  }

  /* ── weather ──────────────────────────────────────────────────────── */

  async weather(place) {
    if (!this.enabled) return this._disabled('the weather');
    try {
      let loc;
      if (place) {
        loc = await this.geocode(place);
        if (!loc.ok) return loc;
      } else {
        loc = await this.getLocation({ ask: true });
        if (!loc) {
          return { ok: false, message: 'I need a location. Say "weather in Delhi", or set a default city in Settings.' };
        }
      }

      const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}`
        + `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m`
        + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max`
        + `&timezone=auto&forecast_days=3`;
      const d = await this._cached(`w:${loc.lat},${loc.lon}`, 10 * 60_000, () => jget(url));

      const c = d.current;
      const cond = WMO[c.weather_code] || 'unknown conditions';
      const name = loc.name || 'your location';
      const days = (d.daily?.time || []).slice(0, 3).map((t, i) => ({
        date: t,
        label: i === 0 ? 'Today' : new Date(t).toLocaleDateString(undefined, { weekday: 'short' }),
        max: d.daily.temperature_2m_max[i],
        min: d.daily.temperature_2m_min[i],
        cond: WMO[d.daily.weather_code[i]] || '—',
        rain: d.daily.precipitation_probability_max?.[i],
      }));

      return {
        ok: true, place: name, country: loc.country,
        tempC: c.temperature_2m, feelsC: c.apparent_temperature,
        humidity: c.relative_humidity_2m, wind: c.wind_speed_10m, cond, days,
        summary: `${Math.round(c.temperature_2m)}°C and ${cond} in ${name}`
          + `${loc.country ? `, ${loc.country}` : ''}. Feels like ${Math.round(c.apparent_temperature)}°C, `
          + `humidity ${c.relative_humidity_2m}%, wind ${Math.round(c.wind_speed_10m)} km/h.`,
        markdown: `**${name}${loc.country ? ', ' + loc.country : ''}** — ${Math.round(c.temperature_2m)}°C, ${cond}\n\n`
          + `Feels like ${Math.round(c.apparent_temperature)}°C · Humidity ${c.relative_humidity_2m}% · Wind ${Math.round(c.wind_speed_10m)} km/h\n\n`
          + days.map(x => `• **${x.label}** ${Math.round(x.min)}–${Math.round(x.max)}°C, ${x.cond}${x.rain != null ? ` (${x.rain}% rain)` : ''}`).join('\n'),
      };
    } catch (e) { return { ok: false, message: `Weather lookup failed: ${e.message}` }; }
  }

  /* ── news ─────────────────────────────────────────────────────────── */

  /** Top stories. Hacker News is CORS-open; general news uses the RSS proxy. */
  async news(topic = 'top', limit = 6) {
    if (!this.enabled) return this._disabled('the news');
    try {
      if (/tech|hacker|hn|startup|programming/i.test(topic)) {
        const ids = await this._cached('hn:ids', 5 * 60_000, () =>
          jget('https://hacker-news.firebaseio.com/v0/topstories.json'));
        const items = await Promise.all(ids.slice(0, limit).map(id =>
          jget(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).catch(() => null)));
        const stories = items.filter(Boolean).map(i => ({
          title: i.title, url: i.url || `https://news.ycombinator.com/item?id=${i.id}`,
          score: i.score, by: i.by,
          when: new Date(i.time * 1000).toLocaleString(),
        }));
        return {
          ok: true, source: 'Hacker News', stories,
          summary: stories.slice(0, 3).map((s, i) => `${i + 1}. ${s.title}`).join(' '),
          markdown: `**Top tech stories — Hacker News**\n\n` +
            stories.map((s, i) => `${i + 1}. [${s.title}](${s.url}) — ${s.score} pts`).join('\n'),
        };
      }

      // General news via RSS (needs the proxy — no CORS on news sites)
      const feeds = {
        world: 'https://feeds.bbci.co.uk/news/world/rss.xml',
        india: 'https://feeds.bbci.co.uk/news/world/asia/india/rss.xml',
        business: 'https://feeds.bbci.co.uk/news/business/rss.xml',
        science: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
        top: 'https://feeds.bbci.co.uk/news/rss.xml',
      };
      const key = Object.keys(feeds).find(k => topic.toLowerCase().includes(k)) || 'top';
      const res = await fetch(`/api/fetch?url=${encodeURIComponent(feeds[key])}&as=text`);
      if (!res.ok) {
        return { ok: false, message: 'News needs AURA\'s local server for the RSS proxy (news sites block direct browser access). Try "tech news" — Hacker News works without it.' };
      }
      const xml = await res.text();
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      const stories = [...doc.querySelectorAll('item')].slice(0, limit).map(it => ({
        title: it.querySelector('title')?.textContent || '',
        url: it.querySelector('link')?.textContent || '',
        desc: (it.querySelector('description')?.textContent || '').replace(/<[^>]+>/g, '').slice(0, 160),
        when: it.querySelector('pubDate')?.textContent || '',
      })).filter(s => s.title);

      return {
        ok: true, source: `BBC ${key}`, stories,
        summary: stories.slice(0, 3).map((s, i) => `${i + 1}. ${s.title}.`).join(' '),
        markdown: `**${key.toUpperCase()} NEWS — BBC**\n\n` +
          stories.map((s, i) => `${i + 1}. [${s.title}](${s.url})\n   ${s.desc}`).join('\n\n'),
      };
    } catch (e) { return { ok: false, message: `News fetch failed: ${e.message}` }; }
  }

  /* ── markets ──────────────────────────────────────────────────────── */

  async crypto(coins = ['bitcoin', 'ethereum']) {
    if (!this.enabled) return this._disabled('crypto prices');
    try {
      const ids = coins.join(',');
      const d = await this._cached(`c:${ids}`, 60_000, () =>
        jget(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`));
      const rows = Object.entries(d).map(([k, v]) => ({
        coin: k, usd: v.usd, change: v.usd_24h_change,
      }));
      if (!rows.length) return { ok: false, message: `No price data for "${ids}".` };
      return {
        ok: true, rows,
        summary: rows.map(r => `${r.coin} is $${r.usd.toLocaleString()}, ${r.change >= 0 ? 'up' : 'down'} ${Math.abs(r.change).toFixed(1)} percent`).join('. '),
        markdown: rows.map(r =>
          `**${r.coin.toUpperCase()}** $${r.usd.toLocaleString()} ${r.change >= 0 ? '🟢 +' : '🔴 '}${r.change.toFixed(2)}% (24h)`).join('\n'),
      };
    } catch (e) { return { ok: false, message: `Crypto lookup failed: ${e.message}` }; }
  }

  async currency(from = 'USD', to = 'INR', amount = 1) {
    if (!this.enabled) return this._disabled('exchange rates');
    try {
      const F = from.toUpperCase(), T = to.toUpperCase();
      const d = await this._cached(`fx:${F}${T}`, 30 * 60_000, () =>
        jget(`https://api.frankfurter.dev/v1/latest?base=${F}&symbols=${T}`));
      const rate = d.rates?.[T];
      if (!rate) return { ok: false, message: `No rate for ${F}→${T}.` };
      const val = rate * amount;
      return {
        ok: true, rate, value: val, from: F, to: T, date: d.date,
        summary: `${amount} ${F} is ${val.toFixed(2)} ${T}`,
        markdown: `**${amount} ${F} = ${val.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${T}**\n\nRate: 1 ${F} = ${rate} ${T} · ${d.date}`,
      };
    } catch (e) { return { ok: false, message: `Currency lookup failed: ${e.message}` }; }
  }

  /* ── knowledge ────────────────────────────────────────────────────── */

  async wiki(query) {
    if (!this.enabled) return this._disabled('Wikipedia');
    try {
      const s = await jget(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*&srlimit=1`);
      const hit = s.query?.search?.[0];
      if (!hit) return { ok: false, message: `Wikipedia has nothing for "${query}".` };
      const d = await jget(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`);
      return {
        ok: true, title: d.title, extract: d.extract,
        url: d.content_urls?.desktop?.page,
        summary: d.extract,
        markdown: `**${d.title}**\n\n${d.extract}\n\n[Read more ↗](${d.content_urls?.desktop?.page || ''})`,
      };
    } catch (e) { return { ok: false, message: `Wikipedia lookup failed: ${e.message}` }; }
  }

  /** Context line injected into the AI prompt so the model knows the time/place. */
  contextNote() {
    if (!this.enabled) return 'Live internet data is DISABLED — you have no access to weather, news or prices. Say so if asked.';
    const bits = ['Live data is ON: you can fetch weather, news, crypto, currency and Wikipedia when the user asks.'];
    if (this.location) bits.push(`User location ≈ ${this.location.name || `${this.location.lat.toFixed(2)},${this.location.lon.toFixed(2)}`}.`);
    return bits.join(' ');
  }
}

/* ── intent parsing ───────────────────────────────────────────────── */

export function parseLiveIntent(text) {
  const t = String(text || '').trim();
  const low = t.toLowerCase();
  if (!low) return null;

  // weather
  const w = /\b(weather|temperature|forecast|how (hot|cold)|is it (raining|sunny|hot|cold))\b/i.exec(low);
  if (w) {
    const place = /(?:in|at|for)\s+([a-z\u00c0-\u024f\s.'-]{2,40})$/i.exec(t.replace(/[?!.]+$/, ''));
    return { type: 'weather', place: place ? place[1].trim() : null };
  }

  // news
  if (/\b(news|headlines|what'?s happening|current events|latest stories|what is happening)\b/i.test(low)) {
    const topic = /\b(tech|technology|hacker|world|india|business|science|sport)\b/i.exec(low);
    return { type: 'news', topic: topic ? topic[1] : 'top' };
  }

  // crypto
  const cm = /\b(bitcoin|btc|ethereum|eth|dogecoin|doge|solana|sol|cardano|ada|crypto)\b/i.exec(low);
  if (cm && /\b(price|worth|cost|value|how much|rate|trading)\b/i.test(low)) {
    const map = { btc: 'bitcoin', eth: 'ethereum', doge: 'dogecoin', sol: 'solana', ada: 'cardano' };
    const raw = cm[1].toLowerCase();
    const coin = map[raw] || raw;
    return { type: 'crypto', coins: coin === 'crypto' ? ['bitcoin', 'ethereum'] : [coin] };
  }

  // currency
  const fx = /(?:convert\s+)?([\d.,]+)?\s*\b([a-z]{3})\b\s*(?:to|in|into)\s*\b([a-z]{3})\b/i.exec(t);
  if (fx && /\b(usd|eur|gbp|inr|jpy|aud|cad|chf|cny|sgd|aed|nzd|sek|krw|brl|zar)\b/i.test(t)) {
    return { type: 'currency', amount: fx[1] ? parseFloat(fx[1].replace(/,/g, '')) : 1, from: fx[2], to: fx[3] };
  }

  // wikipedia — must NOT swallow maths, unit conversions or self-questions.
  // "what is 47*89" was being answered with the AK-47 article. Caught by test.
  const wk = /\b(?:who is|who was|what is|what are|tell me about|look up|wikipedia)\s+(.{2,60})$/i.exec(t.replace(/[?!.]+$/, ''));
  if (wk) {
    const q = wk[1].trim();
    const isMath = /[\d]\s*[-+*/^%x]\s*[\d]/.test(q) || /^[\d\s.,+\-*/^%()]+$/.test(q)
      || /\b(sqrt|sin|cos|tan|log|ln|factorial)\s*\(/i.test(q);
    const isSelf = /\b(your name|my name|the time|the date|you doing|this|that|aura)\b/i.test(q);
    const isConvert = /\b(?:in|to)\s+(?:km|miles?|kg|lbs?|celsius|fahrenheit|[a-z]{3})\b/i.test(q);
    if (!isMath && !isSelf && !isConvert) return { type: 'wiki', query: q };
  }

  return null;
}

export const liveData = new LiveData();
export default liveData;
