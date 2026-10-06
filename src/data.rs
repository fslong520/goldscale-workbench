//! 行情数据接入：多源聚合、失败降级、两级缓存
//!
//! K 线主源 xaus.com（真 OHLC 多周期）；现价 xaus.com → gold-api.com →
//! standardbullion.com 依次降级。
//!
//! 数据必须真实：三源皆挂时，有旧缓存就返回旧缓存并明确标注 stale/error，
//! 没有缓存则直接报错——绝不返回编造或模拟的数据。
//!
//! 缓存分两层：
//! - 内存：K 线按周期 TTL（5m 15 秒 ~ 1d 5 分钟），现价 5 秒；同 key 并发回源用闸门去重
//! - 磁盘：data/market_cache.json 落盘，重启秒开（TTL 内直接命中，过期再回源）

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::config::Settings;

// ---------- 数据结构 ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bar {
    pub t: i64,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
    pub v: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Series {
    pub bars: Vec<Bar>,
    pub stale: bool,
    pub simulated: bool,
    pub source: String,
    pub fetched_at: i64,
    pub interval: String,
    pub points: usize,
    /// 上游报错时的说明，正常为 null
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Spot {
    pub price: f64,
    pub ask: Option<f64>,
    pub bid: Option<f64>,
    pub spread_points: f64,
    pub prev_close: Option<f64>,
    pub change_today: Option<f64>,
    pub change_pct: Option<f64>,
    pub silver: Option<f64>,
    pub gold_silver_ratio: Option<f64>,
    pub source: String,
    pub t: i64,
    pub fresh: bool,
}

// 上游响应（只取需要的字段）

#[derive(Debug, Deserialize)]
struct XausPoint {
    t: i64,
    o: f64,
    h: f64,
    l: f64,
    c: f64,
    #[serde(default)]
    v: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct XausChart {
    #[serde(default)]
    points: Vec<XausPoint>,
    #[serde(default)]
    data_state: Option<XausState>,
}

#[derive(Debug, Deserialize)]
struct XausState {
    #[serde(default)]
    status: Option<String>,
    /// 上游数据时刻（RFC3339），复核实际是否断更
    #[serde(default)]
    as_of: Option<String>,
}

#[derive(Debug, Deserialize)]
struct XausSpot {
    spot_usd_oz: Option<f64>,
    xau: Option<XauOnly>,
    silver_usd_oz: Option<f64>,
    gold_silver_ratio: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct XauOnly {
    price: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct GoldApiSpot {
    price: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct BullionResp {
    metals: Vec<BullionMetal>,
}

#[derive(Debug, Deserialize)]
struct BullionMetal {
    symbol: String,
    ask: f64,
    bid: f64,
    #[serde(rename = "changeToday")]
    change_today: Option<ChangeVal>,
}

#[derive(Debug, Deserialize)]
struct ChangeVal {
    amount: Option<f64>,
    percent: Option<f64>,
}

// ---------- 缓存 ----------

/// 单源快速超时（秒）。三源串行，主源挂了不能干等 15 秒。
const SOURCE_TIMEOUT: Duration = Duration::from_secs(4);

/// K 线单次请求超时（秒）。响应比现价大，放宽到 8 秒，最多重试 2 次。
const CHART_TIMEOUT: Duration = Duration::from_secs(8);

/// 现价内存缓存有效期（秒）：挡住多页面并发轮询重复打上游
const SPOT_TTL: i64 = 5;

/// 各周期 K 线缓存有效期（秒）。周期越大越容忍更新延迟。
fn series_ttl(interval: &str) -> i64 {
    match interval {
        "5m" => 15,
        "15m" => 30,
        "1h" => 60,
        "4h" => 120,
        "1d" => 300,
        _ => 30,
    }
}

/// 周期长度（秒）——判上游断更用
fn interval_secs(interval: &str) -> i64 {
    match interval {
        "5m" => 300,
        "15m" => 900,
        "1h" => 3600,
        "4h" => 14400,
        "1d" => 86400,
        _ => 300,
    }
}

/// 磁盘缓存快照
#[derive(Debug, Default, Serialize, Deserialize)]
struct DiskCache {
    #[serde(default)]
    series: HashMap<String, Series>,
    #[serde(default)]
    spot: Option<Spot>,
    #[serde(default)]
    prev_close: Option<f64>,
}

pub struct Hub {
    client: reqwest::Client,
    series: Mutex<HashMap<String, Series>>,
    spot: Mutex<Option<Spot>>,
    prev_close: Mutex<Option<f64>>,
    /// 回源闸门：同一 key 的并发请求只有一个真正打上游，其余等它写完缓存直接读
    gates: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    cache_file: std::path::PathBuf,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl Hub {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("goldscale/1.0")
            .build()
            .expect("构建 HTTP 客户端失败");
        let mut hub = Hub {
            client,
            series: Mutex::new(HashMap::new()),
            spot: Mutex::new(None),
            prev_close: Mutex::new(None),
            gates: Mutex::new(HashMap::new()),
            cache_file: Settings::data_dir().join("market_cache.json"),
        };
        hub.load_disk();
        hub
    }

    /// 取（或创建）某 key 的回源闸门
    fn gate_for(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut m = self.gates.lock().unwrap();
        m.entry(key.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// 内存缓存未过期则返回
    fn cache_fresh(&self, key: &str, ttl: i64) -> Option<Series> {
        let map = self.series.lock().unwrap();
        let ser = map.get(key)?;
        if now_secs() - ser.fetched_at <= ttl {
            Some(ser.clone())
        } else {
            None
        }
    }

    /// 有缓存就返回（含过期的）：页面宁拿旧数据也不干等上游
    /// 秒回的过期缓存：诚实标注 stale，界面能看出数据非新鲜
    fn cache_peek(&self, key: &str) -> Option<Series> {
        let map = self.series.lock().unwrap();
        let mut c = map.get(key)?.clone();
        c.stale = true;
        c.error = Some("上游待刷新，返回缓存（后台续期后自动更新）".into());
        Some(c)
    }

    /// 启动时载入磁盘缓存，重启后 TTL 内直接秒开
    fn load_disk(&mut self) {
        let Ok(txt) = std::fs::read_to_string(&self.cache_file) else {
            return;
        };
        match serde_json::from_str::<DiskCache>(&txt) {
            Ok(d) => {
                let n = d.series.len();
                if n > 0 {
                    *self.series.lock().unwrap() = d.series;
                }
                if d.spot.is_some() {
                    *self.spot.lock().unwrap() = d.spot;
                    *self.prev_close.lock().unwrap() = d.prev_close;
                }
                tracing::info!("载入磁盘行情缓存：{} 组 K 线", n);
            }
            Err(e) => tracing::warn!("行情缓存文件损坏，忽略: {}", e),
        }
    }

    /// 落盘（临时文件 + rename，避免写一半被读到）
    fn persist(&self) {
        let snap = DiskCache {
            series: self.series.lock().unwrap().clone(),
            spot: self.spot.lock().unwrap().clone(),
            prev_close: *self.prev_close.lock().unwrap(),
        };
        let Ok(txt) = serde_json::to_string(&snap) else {
            return;
        };
        let tmp = self.cache_file.with_extension("json.tmp");
        if std::fs::write(&tmp, txt).is_ok() {
            let _ = std::fs::rename(&tmp, &self.cache_file);
        }
    }

    /// 启动预热：并行把五个周期与现价拉一遍，之后页面请求全走内存缓存
    pub async fn prewarm(&self, s: &Settings) {
        let (a, b, c, d, e, f) = tokio::join!(
            self.series("5m", s, false),
            self.series("15m", s, false),
            self.series("1h", s, false),
            self.series("4h", s, false),
            self.series("1d", s, false),
            self.spot(s),
        );
        let ok = [a, b, c, d, e].iter().filter(|r| r.is_ok()).count();
        tracing::info!(
            "行情预热完成：K 线 {}/5 组，现价 {}",
            ok,
            if f.is_ok() { "已就绪" } else { "待回源" }
        );
    }

    // ---------- K 线 ----------

    /// 前台读：过期可秒回旧数据（回源交给盯盘续期循环），页面永不干等上游；
    /// K 线源陈旧且现货新鲜时动态追加一根现货十字根（不入缓存），让图与现价对得上
    pub async fn series(&self, interval: &str, s: &Settings, force: bool) -> Result<Series> {
        let ser = self.series_inner(interval, s, force, true).await?;
        Ok(self.with_live_bar(ser))
    }

    /// 后台刷新专用：过期必须真正回源，绝不"返旧了事"——否则缓存内容永远卡死在初始时刻，
    /// 前台 30s 轮询拿到的永远是同一份旧数据（行情不刷新的根因）
    pub async fn series_refresh(&self, interval: &str, s: &Settings) -> Result<Series> {
        self.series_inner(interval, s, false, false).await
    }

    /// K 线源陈旧而现货源新鲜时，追加一根「现货十字根」——
    /// 图上给出真实现价的位置，与现价卡对齐；老根一概不动（不画跨源假针）。
    /// 单价一字线如实表达「只知道此刻价、不知道路径」；不入缓存，每轮返回时动态补。
    fn with_live_bar(&self, mut ser: Series) -> Series {
        if !ser.stale || ser.bars.is_empty() {
            return ser;
        }
        let sp = match self.cached_spot() {
            Some(sp) if now_secs() - sp.t <= 60 => sp,
            _ => return ser, // 现货不新鲜：宁可脱节，不补可疑根
        };
        let last = match ser.bars.last() {
            Some(b) => b.clone(),
            None => return ser,
        };
        // 末根已接近现货（上游追上了）：无需补
        if (last.c - sp.price).abs() <= last.c.abs() * 0.0005 {
            return ser;
        }
        let iv = interval_secs(&ser.interval);
        ser.bars.push(Bar {
            t: last.t + iv,
            o: sp.price,
            h: sp.price,
            l: sp.price,
            c: sp.price,
            v: 0.0,
        });
        ser.points = ser.bars.len();
        let tm = chrono::DateTime::from_timestamp(last.t + iv, 0)
            .map(|d| d.with_timezone(&chrono::Local).format("%H:%M").to_string())
            .unwrap_or_default();
        let note = format!("末根 {} 为现货合成", tm);
        ser.error = Some(match ser.error.take() {
            Some(e) => format!("{}；{}", e, note),
            None => note,
        });
        ser
    }

    async fn series_inner(
        &self,
        interval: &str,
        s: &Settings,
        force: bool,
        allow_stale: bool,
    ) -> Result<Series> {
        let range = s.range_for(interval);
        let key = format!("{}:{}:{}", s.symbol, interval, range);
        let ttl = series_ttl(interval);

        if !force {
            // 1) 新鲜缓存秒回
            if let Some(v) = self.cache_fresh(&key, ttl) {
                return Ok(v);
            }
            // 2) 过期但有旧数据也立即返回——回源交给盯盘续期循环（每 cycle_sec 一轮），
            //    页面请求绝不干等上游；数据新鲜度由续期保证，界面用 fetched_at 显示更新时间。
            //    后台续期（allow_stale=false）不走此捷径，必须往下真回源
            if allow_stale {
                if let Some(old) = self.cache_peek(&key) {
                    return Ok(old);
                }
            }
            // 3) 完全无缓存（首载/新品种）才走回源
        }

        // 回源闸门：并发同 key 只放一个打上游
        let gate = self.gate_for(&key);
        let _g = gate.lock().await;

        // 拿到闸门后重查——可能刚才已有并发请求填好缓存
        if !force {
            if let Some(v) = self.cache_fresh(&key, ttl) {
                return Ok(v);
            }
            if allow_stale {
                if let Some(old) = self.cache_peek(&key) {
                    return Ok(old);
                }
            }
        }

        match self.fetch_chart(interval, range).await {
            Ok(ser) => {
                if let Ok(mut map) = self.series.lock() {
                    map.insert(key, ser.clone());
                }
                self.persist();
                Ok(ser)
            }
            Err(e) => {
                tracing::warn!("K 线回源失败: {}", e);
                // 有旧缓存就返回旧数据并明确标注，绝不返回编造数据
                if let Ok(map) = self.series.lock() {
                    if let Some(old) = map.get(&key) {
                        let mut c = old.clone();
                        c.stale = true;
                        c.error = Some(format!("行情源失败，返回旧数据: {}", e));
                        return Ok(c);
                    }
                }
                // 无任何真实数据：直接报错，宁缺毋假
                Err(anyhow!("行情源不可用且无缓存: {}", e))
            }
        }
    }

    async fn fetch_chart(&self, interval: &str, range: &str) -> Result<Series> {
        let url = format!(
            "https://xaus.com/api/v1/chart?symbol=xau&range={}&interval={}",
            range, interval
        );

        let mut last_err = String::new();
        for attempt in 0..2 {
            // 单次请求限时 8 秒：主源挂了不能干等 15 秒级的整段超时
            match self.client.get(&url).timeout(CHART_TIMEOUT).send().await {
                Ok(resp) => {
                    let text = resp.text().await?;
                    // 优先正常解析；失败则尝试修补截断的 JSON
                    match serde_json::from_str::<XausChart>(&text) {
                        Ok(d) => return self.parse_chart(d, interval, range),
                        Err(e) => {
                            if let Some(fixed) = repair_json(&text) {
                                match serde_json::from_str::<XausChart>(&fixed) {
                                    Ok(d) => {
                                        tracing::warn!("上游返回截断，已修补");
                                        return self.parse_chart(d, interval, range);
                                    }
                                    Err(_) => {
                                        last_err = format!("解析失败: {} ({} 字节)", e, text.len())
                                    }
                                }
                            } else {
                                last_err = format!("解析失败: {} ({} 字节)", e, text.len());
                            }
                        }
                    }
                }
                Err(e) => last_err = e.to_string(),
            }
            if attempt < 1 {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
        Err(anyhow!(last_err))
    }

    fn parse_chart(&self, d: XausChart, interval: &str, _range: &str) -> Result<Series> {
        let mut pts = d.points;
        if pts.is_empty() {
            return Err(anyhow!("上游返回空数据"));
        }
        pts.sort_by_key(|p| p.t);
        pts.dedup_by_key(|p| p.t);

        let mut bars: Vec<Bar> = pts
            .into_iter()
            .map(|p| Bar { t: p.t, o: p.o, h: p.h, l: p.l, c: p.c, v: p.v.unwrap_or(0.0) })
            .collect();

        let mut stale = d
            .data_state
            .as_ref()
            .and_then(|s| s.status.as_deref())
            .map(|s| s == "stale")
            .unwrap_or(false);
        // 上游自称 fresh 也可能实际断更：按 as_of 年龄复核（超过 2×周期即陈旧）
        let iv_secs = interval_secs(interval);
        let mut err: Option<String> = None;
        if let Some(as_of) = d.data_state.as_ref().and_then(|s| s.as_of.as_deref()) {
            if let Ok(ts) = chrono::DateTime::parse_from_rfc3339(as_of) {
                let age = now_secs() - ts.timestamp();
                if age > (iv_secs * 2).max(600) {
                    stale = true;
                    let msg = format!(
                        "K 线源自 {} 起未更新（{} 分钟），显示断更前数据",
                        ts.with_timezone(&chrono::Local).format("%H:%M"),
                        age / 60
                    );
                    tracing::warn!("{}", msg);
                    err = Some(msg);
                }
            }
        }

        // 用最新现价修正末根收盘价：仅限小偏离平滑（≤0.15%，正常缓存滞后场景）。
        // 两源大幅背离时拒绝覆盖——单点现货价拉进整根 bar 只改 c/l 不改 o/h，
        // 会画出跨源假针（2026-10-06 实测：K线源断更 4167、现货源 4143，背离 0.57% 画出 23 刀假暴跌柱）。
        if !stale {
            if let Some(sp) = self.spot.lock().unwrap().as_ref() {
                if let Some(last) = bars.last_mut() {
                    let gap = (sp.price - last.c).abs();
                    let tol = last.c.abs() * 0.0015; // 0.15%
                    if gap <= tol {
                        last.c = sp.price;
                        if sp.price > last.h {
                            last.h = sp.price;
                        }
                        if sp.price < last.l {
                            last.l = sp.price;
                        }
                    } else {
                        tracing::warn!(
                            "现价 {:.2} 与末根 {:.2} 偏离 {:.2}% 超阈值，拒绝跨源覆盖末根",
                            sp.price,
                            last.c,
                            gap / last.c * 100.0
                        );
                    }
                }
            }
        }

        Ok(Series {
            points: bars.len(),
            bars,
            stale,
            simulated: false,
            source: "xaus.com".into(),
            fetched_at: now_secs(),
            interval: interval.into(),
            error: err,
        })
    }

    // ---------- 现价 ----------

    pub async fn spot(&self, s: &Settings) -> Result<Spot> {
        // 0 缓存未过期直接返回（TTL 内的并发轮询不再重复打上游）
        if let Some(v) = self.spot.lock().unwrap().clone() {
            if v.fresh && now_secs() - v.t <= SPOT_TTL {
                return Ok(v);
            }
        }

        let gate = self.gate_for("__spot__");

        // 0.5 闸门被占（后台/并发正回源）：有旧价立即返回，顶栏不干等上游。
        //     旧价 60 秒内仍标 fresh，超过则标数据陈旧。
        let held = gate.try_lock().ok();
        if held.is_none() {
            if let Some(mut v) = self.spot.lock().unwrap().clone() {
                v.fresh = now_secs() - v.t <= 60;
                return Ok(v);
            }
        }

        let _g = match held {
            Some(g) => g,
            None => gate.lock().await,
        };

        // 拿到闸门后重查：并发请求可能刚拿到新价
        if let Some(v) = self.spot.lock().unwrap().clone() {
            if v.fresh && now_secs() - v.t <= SPOT_TTL {
                return Ok(v);
            }
        }

        // 1 主源
        if let Ok(v) = self.try_xaus(s).await {
            self.persist();
            return Ok(v);
        }
        tracing::warn!("xaus 主源失败，尝试 gold-api");
        // 2 次源
        if let Ok(v) = self.try_goldapi(s).await {
            self.persist();
            return Ok(v);
        }
        tracing::warn!("gold-api 失败，尝试 standardbullion");
        // 3 末源，能拿到真实买卖价差
        if let Ok(v) = self.try_bullion(s).await {
            self.persist();
            return Ok(v);
        }

        // 全部失败：返回旧价并标 stale（真实历史价，绝不编造）
        let cached = self.spot.lock().unwrap().clone();
        match cached {
            Some(mut v) => {
                v.fresh = false;
                Ok(v)
            }
            None => Err(anyhow!("全部行情源不可用")),
        }
    }

    async fn try_xaus(&self, s: &Settings) -> Result<Spot> {
        let d: XausSpot = self
            .client
            .get("https://xaus.com/api/v1/spot?compact=1")
            .timeout(SOURCE_TIMEOUT)
            .send()
            .await?
            .json()
            .await?;
        let price = d
            .spot_usd_oz
            .or_else(|| d.xau.and_then(|x| x.price))
            .ok_or_else(|| anyhow!("无价格字段"))?;
        let mut sp = Spot {
            price,
            ask: None,
            bid: None,
            spread_points: s.spread_points,
            prev_close: *self.prev_close.lock().unwrap(),
            change_today: None,
            change_pct: None,
            silver: d.silver_usd_oz,
            gold_silver_ratio: d.gold_silver_ratio,
            source: "xaus.com".into(),
            t: now_secs(),
            fresh: true,
        };
        if let Some(prev) = self.spot.lock().unwrap().as_ref() {
            sp.prev_close = Some(prev.price);
        }
        *self.spot.lock().unwrap() = Some(sp.clone());
        Ok(sp)
    }

    async fn try_goldapi(&self, s: &Settings) -> Result<Spot> {
        let d: GoldApiSpot = self
            .client
            .get(format!("https://api.gold-api.com/price/{}", s.symbol))
            .timeout(SOURCE_TIMEOUT)
            .send()
            .await?
            .json()
            .await?;
        let price = d.price.ok_or_else(|| anyhow!("无价格"))?;
        let mut sp = Spot {
            price,
            ask: None,
            bid: None,
            spread_points: s.spread_points,
            prev_close: self.spot.lock().unwrap().as_ref().map(|p| p.price),
            change_today: None,
            change_pct: None,
            silver: None,
            gold_silver_ratio: None,
            source: "gold-api.com".into(),
            t: now_secs(),
            fresh: true,
        };
        if let Some(prev) = self.spot.lock().unwrap().as_ref() {
            sp.prev_close = Some(prev.price);
        }
        *self.spot.lock().unwrap() = Some(sp.clone());
        Ok(sp)
    }

    async fn try_bullion(&self, s: &Settings) -> Result<Spot> {
        let d: BullionResp = self
            .client
            .get("https://standardbullion.com/spot-prices.json")
            .timeout(SOURCE_TIMEOUT)
            .send()
            .await?
            .json()
            .await?;
        let m = d
            .metals
            .iter()
            .find(|m| m.symbol == s.symbol)
            .ok_or_else(|| anyhow!("无 {} 数据", s.symbol))?;
        let spread_usd = m.ask - m.bid;
        // 点数 = 价差 / pointValue
        let sp = Spot {
            price: (m.ask + m.bid) / 2.0,
            ask: Some(m.ask),
            bid: Some(m.bid),
            spread_points: spread_usd / s.point_value,
            prev_close: self.spot.lock().unwrap().as_ref().map(|p| p.price),
            change_today: m.change_today.as_ref().and_then(|c| c.amount),
            change_pct: m.change_today.as_ref().and_then(|c| c.percent),
            silver: None,
            gold_silver_ratio: None,
            source: "standardbullion.com".into(),
            t: now_secs(),
            fresh: true,
        };
        *self.spot.lock().unwrap() = Some(sp.clone());
        Ok(sp)
    }

    pub fn cached_spot(&self) -> Option<Spot> {
        self.spot.lock().unwrap().clone()
    }
}

/// 修补上游被截断的 JSON。
/// 两步：先尝试补齐末尾括号；失败则在 points 数组内做花括号深度扫描，
/// 砍到最后一个完整对象后封口。
pub fn repair_json(text: &str) -> Option<String> {
    let t = text.trim_end();

    // 情况一：整体只是末尾少几个括号，逐个补齐
    for attempt in 1..=6 {
        let mut cand = String::with_capacity(t.len() + attempt);
        cand.push_str(t);
        cand.push_str(&"}]".repeat(attempt));
        if serde_json::from_str::<serde_json::Value>(&cand).is_ok() {
            return Some(cand);
        }
    }

    // 情况二：数组中途被截断
    let key = "\"points\":[";
    let arr_start = text.find(key)? + key.len();
    let rest = &text[arr_start..];

    // 花括号深度扫描，记录每个顶层对象闭合后的位置
    let mut depth = 0i32;
    let mut last_close = None;
    for (i, ch) in rest.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    last_close = Some(i);
                }
            }
            _ => {}
        }
    }
    // depth 回到 0 说明数组已正常结束，那是情况一的事
    let cut = last_close?;
    if cut == 0 {
        return None;
    }

    let mut rebuilt = String::with_capacity(arr_start + cut + 4);
    rebuilt.push_str(&text[..arr_start]);
    rebuilt.push_str(&rest[..=cut]);
    rebuilt.push(']');
    rebuilt.push('}');
    serde_json::from_str::<serde_json::Value>(&rebuilt).ok()?;
    Some(rebuilt)
}