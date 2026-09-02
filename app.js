/* ==========================================================================
   SMART MIRROR — app.js
   外部サービス依存を最小限にするため、天気は無料・APIキー不要の Open-Meteo、
   ニュースは rss2json 経由の RSS を利用しています。
   カスタマイズしたい項目は CONFIG にまとめてあります。
   ========================================================================== */

const CONFIG = {
  // 表示する地点。既存実装（水戸市）を踏襲したデフォルト値。
  location: { name: "水戸", lat: 36.3418, lon: 140.4468 },
  // trueにすると起動時にブラウザの現在地取得を試み、失敗時は上記にフォールバック
  useGeolocation: false,

  weather: {
    refreshIntervalMs: 10 * 60 * 1000, // 10分ごとに再取得
    suddenChange: {
      lookAheadHours: 6,     // 何時間先までを「急変予測」の対象にするか
      precipProbJump: 40,    // 降水確率がこのポイント以上急上昇したら警告
      windSpeedThreshold: 15, // m/s。これを超える突風予測で警告
      tempDropThreshold: 6,   // ℃。数時間内にこの温度差以上の急降下で警告
      renotifyCooldownMs: 2 * 60 * 60 * 1000, // 同一内容の警告は2時間は再通知しない
    },
  },

  news: {
    // rss2json (https://rss2json.com) 経由で読み込むRSSフィード。無料枠は1日数千件程度。
    rssUrl: "https://www3.nhk.or.jp/rss/news/cat0.xml",
    maxItems: 8,
    rotateIntervalMs: 12000,
    refetchIntervalMs: 15 * 60 * 1000,
  },

  // 常時稼働のキオスク表示向けの設定
  display: {
    nightStart: 22, // 22時〜翌6時は自動的に少し減光する（就寝時に眩しくなりすぎないように）
    nightEnd: 6,
    dailyReloadHour: 4, // 毎日この時刻に自動リロードし、長時間稼働によるメモリ肥大等を防ぐ
  },

  // 既存実装から引き継いだ Supabase 接続情報（ToDoリスト表示用）
  // 「こんだーてMenu」（買い物リストアプリ）と同一プロジェクト・同一テーブルを参照する
  supabase: {
    url: "https://nnfvwpzwvscfpyrrsygt.supabase.co",
    anonKey:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5uZnZ3cHp3dnNjZnB5cnJzeWd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAxNjgzMjIsImV4cCI6MjA4NTc0NDMyMn0.wqeKyvXjVKK8oo5CD09L8FvEH3H7rs2Xit-H4FG1HSc",
    table: "todos2",       // タスク（こんだーてMenuの「todo2」画面と同じテーブル）
    shoppingTable: "todos", // 買い物リスト（こんだーてMenuの「todo」画面と同じテーブル）
  },
};

/* カテゴリ値 → 表示ラベル（こんだーてMenu側の定義に合わせてある） */
const SHOPPING_TYPES = [
  { value: "vegetable", label: "野菜室" },
  { value: "freezer", label: "冷凍庫" },
  { value: "fridge", label: "冷蔵庫" },
  { value: "diary", label: "日用品" },
  { value: "stock", label: "ストック" },
  { value: "other", label: "その他" },
];

/* ==========================================================================
   状態
   ========================================================================== */
const state = {
  location: CONFIG.location,
  sunrise: null,
  sunset: null,
  currentRisk: false,
};

/* ==========================================================================
   天気アイコン（線と塗りを組み合わせたシンプルな自作アイコンセット）
   ========================================================================== */
const CLOUD_FRAG =
  '<g fill="currentColor"><rect x="5" y="13.4" width="12.6" height="5" rx="2.5"/>' +
  '<circle cx="9" cy="12.4" r="3.3"/><circle cx="13" cy="11.5" r="4.1"/>' +
  '<circle cx="16.6" cy="13.2" r="2.6"/></g>';

const MINI_SUN_FRAG =
  '<circle cx="7.6" cy="7.2" r="2.7" fill="currentColor"/>' +
  '<g stroke="currentColor" stroke-width="1.2" stroke-linecap="round">' +
  '<line x1="7.6" y1="2.2" x2="7.6" y2="3.5"/><line x1="7.6" y1="10.9" x2="7.6" y2="12.2"/>' +
  '<line x1="2.6" y1="7.2" x2="3.9" y2="7.2"/><line x1="11.3" y1="7.2" x2="12.6" y2="7.2"/>' +
  '<line x1="4" y1="3.6" x2="4.9" y2="4.5"/><line x1="10.3" y1="9.9" x2="11.2" y2="10.8"/>' +
  '<line x1="4" y1="10.8" x2="4.9" y2="9.9"/><line x1="10.3" y1="4.5" x2="11.2" y2="3.6"/></g>';

const MINI_MOON_FRAG =
  '<path d="M11.4 2.6a4.6 4.6 0 1 0 3.4 7.9 3.7 3.7 0 0 1-3.4-7.9Z" fill="currentColor"/>';

const RAIN_DROPS_FRAG =
  '<g stroke="currentColor" stroke-width="1.7" stroke-linecap="round">' +
  '<line x1="8" y1="18.6" x2="6.7" y2="22.4"/><line x1="12" y1="18.6" x2="10.7" y2="22.4"/>' +
  '<line x1="16" y1="18.6" x2="14.7" y2="22.4"/></g>';

const DRIZZLE_DROPS_FRAG =
  '<g stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
  '<line x1="8" y1="19" x2="7.3" y2="20.9"/><line x1="12" y1="19" x2="11.3" y2="20.9"/>' +
  '<line x1="16" y1="19" x2="15.3" y2="20.9"/></g>';

const SNOW_FRAG =
  '<g stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
  '<line x1="8" y1="18.6" x2="8" y2="22.4"/><line x1="6.4" y1="19.3" x2="9.6" y2="21.7"/>' +
  '<line x1="9.6" y1="19.3" x2="6.4" y2="21.7"/><line x1="15" y1="18.8" x2="15" y2="22.2"/>' +
  '<line x1="13.5" y1="19.5" x2="16.5" y2="21.5"/><line x1="16.5" y1="19.5" x2="13.5" y2="21.5"/></g>';

const BOLT_FRAG =
  '<polygon points="13.4,13 8.4,20 11.6,20 10.2,24 16.2,17 12.9,17" fill="currentColor"/>';

const FOG_FRAG =
  '<g stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
  '<line x1="3" y1="8.5" x2="16.5" y2="8.5"/><line x1="2" y1="12.5" x2="21" y2="12.5"/>' +
  '<line x1="4" y1="16.5" x2="19" y2="16.5"/><line x1="6.5" y1="20.2" x2="15.5" y2="20.2"/></g>';

const SUN_FULL_FRAG =
  '<circle cx="12" cy="12" r="5" fill="currentColor"/>' +
  '<g stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
  '<line x1="12" y1="1.6" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22.4"/>' +
  '<line x1="1.6" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22.4" y2="12"/>' +
  '<line x1="4.3" y1="4.3" x2="6" y2="6"/><line x1="18" y1="18" x2="19.7" y2="19.7"/>' +
  '<line x1="4.3" y1="19.7" x2="6" y2="18"/><line x1="18" y1="6" x2="19.7" y2="4.3"/></g>';

const MOON_FULL_FRAG =
  '<path d="M20.4 14.6A8.5 8.5 0 1 1 11 3.4a6.8 6.8 0 0 0 9.4 11.2Z" fill="currentColor"/>';

const ICON_FRAGMENTS = {
  "clear-day": SUN_FULL_FRAG,
  "clear-night": MOON_FULL_FRAG,
  "partly-day": MINI_SUN_FRAG + CLOUD_FRAG,
  "partly-night": MINI_MOON_FRAG + CLOUD_FRAG,
  cloudy: CLOUD_FRAG,
  fog: FOG_FRAG,
  drizzle: CLOUD_FRAG + DRIZZLE_DROPS_FRAG,
  rain: CLOUD_FRAG + RAIN_DROPS_FRAG,
  snow: CLOUD_FRAG + SNOW_FRAG,
  thunder: CLOUD_FRAG + BOLT_FRAG,
};

function iconMarkup(key) {
  const frag = ICON_FRAGMENTS[key] || CLOUD_FRAG;
  return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">${frag}</svg>`;
}

function resolveDayNightIcon(base, isDay) {
  if (base === "clear") return isDay ? "clear-day" : "clear-night";
  if (base === "partly") return isDay ? "partly-day" : "partly-night";
  return base;
}

/* WMO weather code → アイコン種別・日本語ラベル */
const WEATHER_CODE = {
  0: { icon: "clear", label: "快晴" },
  1: { icon: "partly", label: "ほぼ晴れ" },
  2: { icon: "partly", label: "晴れ時々曇り" },
  3: { icon: "cloudy", label: "曇り" },
  45: { icon: "fog", label: "霧" },
  48: { icon: "fog", label: "霧氷" },
  51: { icon: "drizzle", label: "霧雨" },
  53: { icon: "drizzle", label: "霧雨" },
  55: { icon: "drizzle", label: "強い霧雨" },
  56: { icon: "drizzle", label: "着氷性の霧雨" },
  57: { icon: "drizzle", label: "強い着氷性の霧雨" },
  61: { icon: "rain", label: "小雨" },
  63: { icon: "rain", label: "雨" },
  65: { icon: "rain", label: "大雨" },
  66: { icon: "rain", label: "着氷性の雨" },
  67: { icon: "rain", label: "強い着氷性の雨" },
  71: { icon: "snow", label: "小雪" },
  73: { icon: "snow", label: "雪" },
  75: { icon: "snow", label: "大雪" },
  77: { icon: "snow", label: "霧雪" },
  80: { icon: "rain", label: "にわか雨" },
  81: { icon: "rain", label: "にわか雨" },
  82: { icon: "rain", label: "激しいにわか雨" },
  85: { icon: "snow", label: "にわか雪" },
  86: { icon: "snow", label: "強いにわか雪" },
  95: { icon: "thunder", label: "雷雨" },
  96: { icon: "thunder", label: "雷雨（雹あり）" },
  99: { icon: "thunder", label: "激しい雷雨（雹あり）" },
};
const STORM_CODES = [95, 96, 99];
const HEAVY_CODES = [65, 67, 75, 82, 86];

/* ==========================================================================
   ユーティリティ
   ========================================================================== */
function pad2(n) { return String(n).padStart(2, "0"); }
function formatHM(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function stripHtml(str) {
  const div = document.createElement("div");
  div.innerHTML = str || "";
  return (div.textContent || div.innerText || "").trim();
}
function flipValue(el) {
  el.classList.remove("value-flip");
  void el.offsetWidth;
  el.classList.add("value-flip");
}
function findCurrentHourIndex(times) {
  const now = new Date();
  let idx = 0;
  for (let i = 0; i < times.length; i++) {
    if (new Date(times[i]) <= now) idx = i; else break;
  }
  return idx;
}
function formatOnset(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? `本日${d.getHours()}時ごろ` : `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}時ごろ`;
}

/* ==========================================================================
   時計・日付・挨拶・一日の進捗バー
   ========================================================================== */
const DAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];
const RING_CIRCUMFERENCE = 339.3;

function greetingFor(hour) {
  if (hour >= 5 && hour < 10) return "おはようございます";
  if (hour >= 10 && hour < 17) return "こんにちは";
  if (hour >= 17 && hour < 22) return "こんばんは";
  return "お疲れ様です";
}
function formatDateLine(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${DAY_NAMES[d.getDay()]}）`;
}

function updateDayProgress() {
  if (!state.sunrise || !state.sunset) return;
  const sunrise = new Date(state.sunrise);
  const sunset = new Date(state.sunset);
  const now = new Date();
  let frac = (now - sunrise) / (sunset - sunrise);
  frac = Math.max(0, Math.min(1, frac));
  document.getElementById("day-progress-fill").style.width = `${frac * 100}%`;
  document.getElementById("day-progress-now").style.left = `${frac * 100}%`;
  document.getElementById("sunrise-label").textContent = formatHM(sunrise);
  document.getElementById("sunset-label").textContent = formatHM(sunset);
}

function isNightHour(hour) {
  const { nightStart, nightEnd } = CONFIG.display;
  if (nightStart > nightEnd) return hour >= nightStart || hour < nightEnd;
  return hour >= nightStart && hour < nightEnd;
}

function tickClock() {
  const now = new Date();
  document.getElementById("time-main").textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  document.getElementById("time-seconds").textContent = pad2(now.getSeconds());
  const frac = (now.getMinutes() * 60 + now.getSeconds()) / 3600;
  document.getElementById("clock-ring-fill").style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - frac));
  document.getElementById("greeting").textContent = greetingFor(now.getHours());
  document.getElementById("date-line").textContent = formatDateLine(now);
  updateDayProgress();
  document.body.classList.toggle("is-night", isNightHour(now.getHours()));

  // キオスク運用向け：誰も操作できない前提のため、日次で自動リロードして
  // 長時間稼働によるメモリリークや描画崩れをリセットする
  if (now.getHours() === CONFIG.display.dailyReloadHour && now.getMinutes() === 0 && now.getSeconds() === 0) {
    location.reload();
  }
}

/* ==========================================================================
   補助指標：月齢／洗濯指数／おでかけの目安／大気質
   ========================================================================== */
function getMoonPhase(date) {
  const synodicMonth = 29.53058867;
  const knownNewMoonUTC = Date.UTC(2000, 0, 6, 18, 14);
  let diffDays = (date.getTime() - knownNewMoonUTC) / 86400000;
  let phase = (diffDays % synodicMonth) / synodicMonth;
  if (phase < 0) phase += 1;
  return phase;
}
function moonPhaseLabel(phase) {
  if (phase < 0.03 || phase > 0.97) return "新月";
  if (phase < 0.22) return "三日月";
  if (phase < 0.28) return "上弦の月";
  if (phase < 0.47) return "十三夜月";
  if (phase < 0.53) return "満月";
  if (phase < 0.72) return "十六夜月";
  if (phase < 0.78) return "下弦の月";
  return "有明月";
}

function laundryIndex(precipProbMax, humidity) {
  if (precipProbMax >= 50) return { label: "室内干し推奨", level: "bad" };
  if (precipProbMax >= 20 || humidity >= 75) return { label: "乾きにくめ", level: "mid" };
  return { label: "よく乾く", level: "good" };
}

function outfitAdvice(temp, precipProb, windSpeed) {
  let base;
  if (temp >= 28) base = "半袖で快適";
  else if (temp >= 22) base = "半袖 + 薄手の羽織り";
  else if (temp >= 16) base = "長袖が安心";
  else if (temp >= 8) base = "しっかりした上着を";
  else base = "防寒対策必須";
  const extras = [];
  if (precipProb >= 50) extras.push("傘を忘れずに");
  if (windSpeed >= 10) extras.push("風が強め");
  return extras.length ? `${base}・${extras.join("・")}` : base;
}

function aqiCategory(aqi) {
  if (aqi == null) return { label: "取得不可", level: "mid" };
  if (aqi <= 50) return { label: "良好", level: "good" };
  if (aqi <= 100) return { label: "普通", level: "good" };
  if (aqi <= 150) return { label: "敏感な方は注意", level: "mid" };
  if (aqi <= 200) return { label: "健康に影響のおそれ", level: "bad" };
  return { label: "非常に悪い", level: "bad" };
}

/* ==========================================================================
   天気の急変・悪化予測
   直近の時間別データ（数時間先まで）を見て、しきい値を超える変化があれば検出する。
   完全な予報精度を保証するものではなく、あくまで簡易的な目安。
   ========================================================================== */
function buildHourlyObjects(hourly) {
  return hourly.time.map((t, i) => ({
    time: t,
    temperature_2m: hourly.temperature_2m[i],
    precipitation_probability: hourly.precipitation_probability[i],
    weather_code: hourly.weather_code[i],
    wind_speed_10m: hourly.wind_speed_10m[i],
  }));
}

function detectSuddenChange(hourlyObjects, nowIdx) {
  const cfg = CONFIG.weather.suddenChange;
  const win = hourlyObjects.slice(nowIdx, nowIdx + cfg.lookAheadHours + 1);
  if (win.length < 2) return null;

  const startProb = win[0].precipitation_probability ?? 0;
  const maxProb = Math.max(...win.map((h) => h.precipitation_probability ?? 0));
  const maxWind = Math.max(...win.map((h) => h.wind_speed_10m ?? 0));
  const startTemp = win[0].temperature_2m;
  const minTemp = Math.min(...win.map((h) => h.temperature_2m));
  const hasStorm = win.some((h) => STORM_CODES.includes(h.weather_code));
  const hasHeavy = win.some((h) => HEAVY_CODES.includes(h.weather_code));

  const reasons = [];
  if (maxProb - startProb >= cfg.precipProbJump) reasons.push(`降水確率が${Math.round(maxProb)}%まで急上昇`);
  if (maxWind >= cfg.windSpeedThreshold) reasons.push(`最大${maxWind.toFixed(1)}m/sの強風`);
  if (startTemp - minTemp >= cfg.tempDropThreshold) reasons.push(`気温が${(startTemp - minTemp).toFixed(1)}℃急降下`);
  if (hasStorm) reasons.push("雷を伴う可能性");
  else if (hasHeavy) reasons.push("激しい雨または雪の可能性");

  if (reasons.length === 0) return null;

  const onset = win.find(
    (h) =>
      STORM_CODES.includes(h.weather_code) ||
      HEAVY_CODES.includes(h.weather_code) ||
      (h.precipitation_probability ?? 0) - startProb >= cfg.precipProbJump
  );
  return { reasons, onsetTime: onset ? onset.time : win[win.length - 1].time };
}

let lastAlertSignature = null;
let lastAlertTime = 0;
function maybeTriggerAlert(alertInfo) {
  const dot = document.getElementById("status-dot");
  if (!alertInfo) {
    if (state.currentRisk) hideWeatherAlert();
    state.currentRisk = false;
    dot.className = "status-dot";
    return;
  }
  state.currentRisk = true;
  const signature = alertInfo.reasons.join("|");
  const now = Date.now();
  const cooldown = CONFIG.weather.suddenChange.renotifyCooldownMs;
  if (signature !== lastAlertSignature || now - lastAlertTime > cooldown) {
    showWeatherAlert(alertInfo);
    lastAlertSignature = signature;
    lastAlertTime = now;
  } else {
    dot.className = "status-dot warn";
  }
}

/* ==========================================================================
   天気データ取得（Open-Meteo：APIキー不要）
   ========================================================================== */
async function fetchWeather() {
  const { lat, lon } = state.location;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,surface_pressure,is_day` +
    `&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max` +
    `&timezone=auto&forecast_days=7`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("weather fetch failed: " + res.status);
  return res.json();
}

async function fetchAirQuality() {
  const { lat, lon } = state.location;
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("air quality fetch failed: " + res.status);
  return res.json();
}

/* ==========================================================================
   天気の描画
   ========================================================================== */
function renderCurrentWeather(data, nowIdx) {
  const cur = data.current;
  const info = WEATHER_CODE[cur.weather_code] || { icon: "cloudy", label: "不明" };
  const iconKey = resolveDayNightIcon(info.icon, cur.is_day === 1);
  document.getElementById("weather-icon-lg").innerHTML = iconMarkup(iconKey);

  const tempEl = document.getElementById("weather-temp");
  tempEl.innerHTML = `${Math.round(cur.temperature_2m)}<small>°</small>`;
  flipValue(tempEl);
  document.getElementById("weather-desc").textContent = info.label;
  document.getElementById("weather-feelslike").textContent = `体感 ${Math.round(cur.apparent_temperature)}°`;

  const popNow = data.hourly.precipitation_probability?.[nowIdx] ?? 0;
  const uvToday = data.daily.uv_index_max?.[0];

  const subItems = [
    { label: "体感", value: `${Math.round(cur.apparent_temperature)}°` },
    { label: "湿度", value: `${cur.relative_humidity_2m}%` },
    { label: "風速", value: `${cur.wind_speed_10m.toFixed(1)}m/s` },
    { label: "気圧", value: `${Math.round(cur.surface_pressure)}hPa` },
    { label: "降水確率", value: `${popNow}%` },
  ];
  if (uvToday !== undefined && uvToday !== null) {
    subItems.push({ label: "UV指数", value: uvToday.toFixed(1) });
  }
  const grid = document.getElementById("weather-sub-grid");
  grid.innerHTML = subItems
    .map((it) => `<div class="sub-stat"><span class="sub-stat-label">${it.label}</span><span class="sub-stat-value">${it.value}</span></div>`)
    .join("");
}

function renderHourly(data, nowIdx) {
  const container = document.getElementById("hourly-strip");
  const cards = [];
  for (let i = 0; i < 10; i++) {
    const idx = nowIdx + i;
    if (idx >= data.hourly.time.length) break;
    const d = new Date(data.hourly.time[idx]);
    const info = WEATHER_CODE[data.hourly.weather_code[idx]] || { icon: "cloudy", label: "" };
    const isDay = d.getHours() >= 6 && d.getHours() < 18;
    const iconKey = resolveDayNightIcon(info.icon, isDay);
    const label = i === 0 ? "現在" : `${d.getHours()}時`;
    cards.push(`<div class="hour-card" style="animation-delay:${i * 0.04}s">
      <span class="hour-time">${label}</span>
      <span class="hour-icon">${iconMarkup(iconKey)}</span>
      <span class="hour-temp">${Math.round(data.hourly.temperature_2m[idx])}°</span>
      <span class="hour-pop">${data.hourly.precipitation_probability[idx]}%</span>
    </div>`);
  }
  container.innerHTML = cards.join("");
}

function renderDaily(data) {
  const days = data.daily.time.map((t, i) => ({
    date: t,
    code: data.daily.weather_code[i],
    max: data.daily.temperature_2m_max[i],
    min: data.daily.temperature_2m_min[i],
    pop: data.daily.precipitation_probability_max[i],
  }));
  const weekMin = Math.min(...days.map((d) => d.min));
  const weekMax = Math.max(...days.map((d) => d.max));
  const span = Math.max(1, weekMax - weekMin);

  const rows = days.map((d, i) => {
    const dt = new Date(d.date + "T00:00:00");
    const label = i === 0 ? "今日" : `${DAY_NAMES[dt.getDay()]}曜`;
    const info = WEATHER_CODE[d.code] || { icon: "cloudy", label: "" };
    const iconKey = resolveDayNightIcon(info.icon, true);
    const leftPct = ((d.min - weekMin) / span) * 100;
    const widthPct = Math.max(((d.max - d.min) / span) * 100, 5);
    return `<div class="day-row" style="animation-delay:${i * 0.05}s">
      <span class="day-name">${label}</span>
      <span class="day-icon">${iconMarkup(iconKey)}</span>
      <span class="day-min">${Math.round(d.min)}°</span>
      <span class="day-range"><span class="day-range-fill" style="left:${leftPct}%;width:${widthPct}%"></span></span>
      <span class="day-max">${Math.round(d.max)}°</span>
      <span class="day-pop">${d.pop}%</span>
    </div>`;
  });
  document.getElementById("daily-strip").innerHTML = rows.join("");
}

function renderMoon() {
  const phase = getMoonPhase(new Date());
  document.getElementById("extra-moon-value").textContent = moonPhaseLabel(phase);
}
function renderLaundry(popMaxToday, humidity) {
  const idx = laundryIndex(popMaxToday, humidity);
  const el = document.getElementById("extra-laundry-value");
  el.textContent = idx.label;
  el.className = "extra-value state-" + idx.level;
}
function renderOutfit(temp, popNow, wind) {
  document.getElementById("extra-outfit-value").textContent = outfitAdvice(temp, popNow, wind);
}
function renderAQI(aqData) {
  const aqi = aqData?.current?.us_aqi;
  const cat = aqiCategory(aqi);
  const el = document.getElementById("extra-aqi-value");
  el.textContent = aqi != null ? `${aqi}｜${cat.label}` : cat.label;
  el.className = "extra-value state-" + cat.level;
}
function renderPeak(hourly, nowIdx) {
  const end = Math.min(nowIdx + 24, hourly.time.length);
  let maxI = nowIdx, minI = nowIdx;
  for (let i = nowIdx; i < end; i++) {
    if (hourly.temperature_2m[i] > hourly.temperature_2m[maxI]) maxI = i;
    if (hourly.temperature_2m[i] < hourly.temperature_2m[minI]) minI = i;
  }
  const hourLabel = (iso) => `${new Date(iso).getHours()}時`;
  document.getElementById("extra-peak-value").textContent =
    `${hourLabel(hourly.time[maxI])} ${Math.round(hourly.temperature_2m[maxI])}° ／ ${hourLabel(hourly.time[minI])} ${Math.round(hourly.temperature_2m[minI])}°`;
}

function setStatus(text, level) {
  document.getElementById("status-text").textContent = `${text} ・ 最終更新 ${formatHM(new Date())}`;
  if (!state.currentRisk) {
    const dot = document.getElementById("status-dot");
    dot.className = "status-dot" + (level === "warn" ? " warn" : level === "danger" ? " danger" : "");
  }
}

async function refreshWeather() {
  let ok = true;
  try {
    const data = await fetchWeather();
    const nowIdx = findCurrentHourIndex(data.hourly.time);
    renderCurrentWeather(data, nowIdx);
    renderHourly(data, nowIdx);
    renderDaily(data);
    renderPeak(data.hourly, nowIdx);

    state.sunrise = data.daily.sunrise[0];
    state.sunset = data.daily.sunset[0];
    updateDayProgress();

    renderOutfit(data.current.temperature_2m, data.hourly.precipitation_probability[nowIdx], data.current.wind_speed_10m);
    renderLaundry(data.daily.precipitation_probability_max[0], data.current.relative_humidity_2m);

    const alertInfo = detectSuddenChange(buildHourlyObjects(data.hourly), nowIdx);
    maybeTriggerAlert(alertInfo);

    setStatus("天気情報を更新しました", "ok");
  } catch (err) {
    console.error(err);
    setStatus("天気情報の取得に失敗しました", "warn");
    ok = false;
  }

  try {
    renderAQI(await fetchAirQuality());
  } catch (err) {
    console.warn("air quality fetch failed", err);
    document.getElementById("extra-aqi-value").textContent = "取得不可";
  }

  renderMoon();
  return ok;
}

let weatherTimer = null;
async function scheduleWeatherRefresh() {
  if (weatherTimer) clearTimeout(weatherTimer);
  const ok = await refreshWeather();
  // 誰も手動で再読み込みできない前提のため、失敗時は短い間隔で自動的に再試行する
  const delay = ok ? CONFIG.weather.refreshIntervalMs : 60 * 1000;
  weatherTimer = setTimeout(scheduleWeatherRefresh, delay);
}

/* ==========================================================================
   ニュース（rss2json 経由でRSSを取得し、一定間隔でローテーション表示）
   ========================================================================== */
const FALLBACK_NEWS = [
  { title: "ニュースを取得できませんでした", summary: "しばらくすると自動的に再試行します。ネットワーク状況をご確認ください。", source: "SYSTEM" },
];

async function fetchNews() {
  try {
    const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(CONFIG.news.rssUrl)}`;
    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error("rss2json http error " + res.status);
    const data = await res.json();
    if (data.status !== "ok" || !Array.isArray(data.items) || data.items.length === 0) {
      throw new Error("rss2json returned no items");
    }
    const sourceName = (data.feed && data.feed.title) || "NEWS";
    return data.items.slice(0, CONFIG.news.maxItems).map((item) => ({
      title: stripHtml(item.title),
      summary: stripHtml(item.description).slice(0, 220),
      source: sourceName,
    }));
  } catch (err) {
    console.warn("news fetch failed, showing fallback", err);
    return FALLBACK_NEWS;
  }
}

const newsState = { items: [], index: 0, timer: null };

function buildNewsDots() {
  document.getElementById("news-dots").innerHTML = newsState.items.map(() => "<span></span>").join("");
}

function resetNewsProgress() {
  const fill = document.getElementById("news-progress-fill");
  fill.style.transition = "none";
  fill.style.width = "0%";
  void fill.offsetWidth;
  fill.style.transition = `width ${CONFIG.news.rotateIntervalMs}ms linear`;
  fill.style.width = "100%";
}

function showNewsItem(index, animateOut) {
  if (newsState.items.length === 0) return;
  const viewport = document.getElementById("news-viewport");
  const item = newsState.items[index];
  document.getElementById("news-source").textContent = item.source || "";

  const old = viewport.querySelector(".news-article");
  const el = document.createElement("article");
  el.className = "news-article";
  el.innerHTML =
    `<div class="news-article-scroll">` +
    `<p class="news-headline">${escapeHtml(item.title)}</p>` +
    `<p class="news-summary">${escapeHtml(item.summary)}</p>` +
    `</div>`;

  if (old) {
    if (animateOut) {
      old.classList.add("leaving");
      setTimeout(() => old.remove(), 520);
    } else {
      old.remove();
    }
  }
  viewport.appendChild(el);

  // 見出し・本文が枠の高さに収まらない場合、切り捨てる代わりに
  // ゆっくり縦スクロールして最後まで見せてから次のニュースへ切り替える
  requestAnimationFrame(() => {
    const scrollEl = el.querySelector(".news-article-scroll");
    const overflow = scrollEl.scrollHeight - viewport.clientHeight;
    if (overflow > 4) {
      scrollEl.style.setProperty("--scroll-distance", `-${overflow}px`);
      scrollEl.style.animationDuration = `${CONFIG.news.rotateIntervalMs}ms`;
      scrollEl.classList.add("auto-scroll");
    }
  });

  document.querySelectorAll("#news-dots span").forEach((d, i) => d.classList.toggle("active", i === index));
  resetNewsProgress();
}

function startNewsRotation() {
  if (newsState.timer) clearInterval(newsState.timer);
  newsState.timer = setInterval(() => {
    if (newsState.items.length === 0) return;
    newsState.index = (newsState.index + 1) % newsState.items.length;
    showNewsItem(newsState.index, true);
  }, CONFIG.news.rotateIntervalMs);
}

async function initNews() {
  newsState.items = await fetchNews();
  newsState.index = 0;
  buildNewsDots();
  showNewsItem(0, false);
  startNewsRotation();
}

async function refetchNews() {
  const fresh = await fetchNews();
  newsState.items = fresh;
  if (newsState.index >= fresh.length) newsState.index = 0;
  buildNewsDots();
}

/* ==========================================================================
   サウンド（Web Audio APIで生成する2種類のチャイム／外部音声ファイル不要）
   ブラウザの自動再生制限のため、初回のユーザー操作で有効化する。
   ========================================================================== */
let audioCtx = null;
function ensureAudioCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
function playTone(freq, startTime, duration, gainPeak, type) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type || "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.05);
}
function playChime() {
  if (!ensureAudioCtx()) return;
  const now = audioCtx.currentTime;
  playTone(880, now, 0.5, 0.1, "sine");
  playTone(1318.5, now + 0.16, 0.6, 0.09, "sine");
}
function playAlertTone() {
  if (!ensureAudioCtx()) return;
  const now = audioCtx.currentTime;
  playTone(660, now, 0.26, 0.13, "triangle");
  playTone(660, now + 0.32, 0.26, 0.13, "triangle");
  playTone(880, now + 0.64, 0.55, 0.15, "triangle");
}

function setupSound() {
  // 常時稼働のミラーには「押すためのボタン」を置けない。まず直接有効化を試み、
  // ブラウザの自動再生ポリシーでブロックされた場合は無音のまま動作を続ける
  // （キオスク用ブラウザ側で自動再生を許可しておくと確実。例：Chromiumで
  //  --autoplay-policy=no-user-gesture-required を指定する、または当サイトの
  //  「サウンド」設定を事前に「許可」にしておく）。
  ensureAudioCtx();
  // 万一マウスやキーボードでの操作が発生した場合に備えた保険（必須ではない）
  ["pointerdown", "keydown"].forEach((evt) => window.addEventListener(evt, () => ensureAudioCtx(), { once: true }));
}

/* ==========================================================================
   天気急変アラートUI
   ボタン操作を前提にできないため、表示・収納ともに完全自動。
   ========================================================================== */
const ALERT_COLLAPSE_DELAY_MS = 9000;
let alertCollapseTimer = null;

function showWeatherAlert(alertInfo) {
  const overlay = document.getElementById("alert-overlay");
  document.getElementById("alert-title").textContent = "この後、天気が崩れる可能性があります";
  const onset = alertInfo.onsetTime ? `\n${formatOnset(alertInfo.onsetTime)}` : "";
  document.getElementById("alert-body").textContent = alertInfo.reasons.join("\n") + onset;
  document.getElementById("alert-compact-text").textContent = alertInfo.onsetTime
    ? `天気急変のおそれ（${formatOnset(alertInfo.onsetTime)}〜）`
    : "天気急変のおそれ";

  overlay.classList.remove("collapsed");
  overlay.classList.add("visible");
  overlay.setAttribute("aria-hidden", "false");
  playAlertTone();
  document.getElementById("status-dot").className = "status-dot danger";

  if (alertCollapseTimer) clearTimeout(alertCollapseTimer);
  alertCollapseTimer = setTimeout(() => {
    overlay.classList.add("collapsed");
  }, ALERT_COLLAPSE_DELAY_MS);
}

function hideWeatherAlert() {
  const overlay = document.getElementById("alert-overlay");
  overlay.classList.remove("visible", "collapsed");
  overlay.setAttribute("aria-hidden", "true");
  if (alertCollapseTimer) { clearTimeout(alertCollapseTimer); alertCollapseTimer = null; }
}

/* ==========================================================================
   タスク（Supabase realtime 同期）
   ========================================================================== */
function renderAgenda(todos) {
  const container = document.getElementById("todo-list");
  if (!todos || todos.length === 0) {
    container.innerHTML = '<p class="agenda-empty">タスクはありません</p>';
    return;
  }
  container.innerHTML = "";
  todos.forEach((todo) => {
    const item = document.createElement("div");
    item.className = "agenda-item" + (todo.is_checked ? " done" : "");

    const check = document.createElement("span");
    check.className = "agenda-check";
    check.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 9 18 20 6"/></svg>';

    const text = document.createElement("span");
    text.className = "agenda-text";
    text.textContent = todo.task;

    item.append(check, text);
    container.appendChild(item);
  });
}

async function initAgenda() {
  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    const supabase = createClient(CONFIG.supabase.url, CONFIG.supabase.anonKey);

    async function fetchTodos() {
      try {
        const { data, error } = await supabase
          .from(CONFIG.supabase.table)
          .select("*")
          .order("is_checked", { ascending: true })
          .limit(8);
        if (error) { console.error(error); return; }
        renderAgenda(data);
      } catch (err) {
        console.error(err);
      }
    }

    supabase
      .channel(`${CONFIG.supabase.table}_changes`)
      .on("postgres_changes", { event: "*", schema: "public", table: CONFIG.supabase.table }, fetchTodos)
      .subscribe();

    fetchTodos();
  } catch (err) {
    console.warn("agenda sync unavailable", err);
    document.getElementById("todo-list").innerHTML = '<p class="agenda-empty">タスクを読み込めませんでした</p>';
  }
}

/* ==========================================================================
   位置情報
   ========================================================================== */
function resolveLocation() {
  return new Promise((resolve) => {
    if (!CONFIG.useGeolocation || !navigator.geolocation) {
      resolve(CONFIG.location);
      return;
    }
    const timer = setTimeout(() => resolve(CONFIG.location), 4000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({ name: "現在地", lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      () => { clearTimeout(timer); resolve(CONFIG.location); },
      { timeout: 3800 }
    );
  });
}

/* ==========================================================================
   初期化
   ========================================================================== */
async function init() {
  setupSound();

  tickClock();
  setInterval(tickClock, 1000);

  state.location = await resolveLocation();
  document.getElementById("location-label").textContent = state.location.name;

  await scheduleWeatherRefresh();

  await initNews();
  setInterval(refetchNews, CONFIG.news.refetchIntervalMs);

  initAgenda();
}

document.addEventListener("DOMContentLoaded", init);
