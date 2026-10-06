//! 技术指标与形态识别。输入按时间升序的 K 线。

use crate::data::Bar;

/// 返回与输入等长的序列，前置不足处为 None
pub fn sma(bars: &[Bar], period: usize) -> Vec<Option<f64>> {
    let mut out = vec![None; bars.len()];
    if period == 0 || bars.len() < period {
        return out;
    }
    let mut sum = 0.0;
    for i in 0..bars.len() {
        sum += bars[i].c;
        if i >= period {
            sum -= bars[i - period].c;
        }
        if i + 1 >= period {
            out[i] = Some(sum / period as f64);
        }
    }
    out
}

pub fn ema(bars: &[Bar], period: usize) -> Vec<Option<f64>> {
    let mut out = vec![None; bars.len()];
    if period == 0 || bars.len() < period {
        return out;
    }
    let k = 2.0 / (period as f64 + 1.0);
    let mut seed = 0.0;
    for b in bars.iter().take(period) {
        seed += b.c;
    }
    let mut prev = seed / period as f64;
    out[period - 1] = Some(prev);
    for i in period..bars.len() {
        prev = bars[i].c * k + prev * (1.0 - k);
        out[i] = Some(prev);
    }
    out
}

pub fn rsi(bars: &[Bar], period: usize) -> Vec<Option<f64>> {
    let mut out = vec![None; bars.len()];
    if bars.len() <= period {
        return out;
    }
    let mut gain = 0.0;
    let mut loss = 0.0;
    for i in 1..=period {
        let d = bars[i].c - bars[i - 1].c;
        if d >= 0.0 {
            gain += d;
        } else {
            loss -= d;
        }
    }
    let p = period as f64;
    let mut ag = gain / p;
    let mut al = loss / p;
    out[period] = Some(if al == 0.0 { 100.0 } else { 100.0 - 100.0 / (1.0 + ag / al) });
    for i in period + 1..bars.len() {
        let d = bars[i].c - bars[i - 1].c;
        let (g, l) = if d > 0.0 { (d, 0.0) } else { (0.0, -d) };
        ag = (ag * (p - 1.0) + g) / p;
        al = (al * (p - 1.0) + l) / p;
        out[i] = Some(if al == 0.0 { 100.0 } else { 100.0 - 100.0 / (1.0 + ag / al) });
    }
    out
}

pub fn atr(bars: &[Bar], period: usize) -> Vec<Option<f64>> {
    let mut out = vec![None; bars.len()];
    if bars.len() <= period {
        return out;
    }
    let tr: Vec<f64> = bars
        .iter()
        .enumerate()
        .map(|(i, b)| {
            if i == 0 {
                b.h - b.l
            } else {
                let pc = bars[i - 1].c;
                (b.h - b.l).max((b.h - pc).abs()).max((b.l - pc).abs())
            }
        })
        .collect();

    let p = period as f64;
    let mut sum = 0.0;
    for i in 1..=period {
        sum += tr[i];
    }
    let mut prev = sum / p;
    out[period] = Some(prev);
    for i in period + 1..bars.len() {
        prev = (prev * (p - 1.0) + tr[i]) / p;
        out[i] = Some(prev);
    }
    out
}

pub fn macd(bars: &[Bar], fast: usize, slow: usize, signal: usize) -> (Vec<Option<f64>>, Vec<Option<f64>>, Vec<Option<f64>>) {
    let n = bars.len();
    let ef = ema(bars, fast);
    let es = ema(bars, slow);
    let mut dif: Vec<Option<f64>> = (0..n)
        .map(|i| match (ef[i], es[i]) {
            (Some(a), Some(b)) => Some(a - b),
            _ => None,
        })
        .collect();

    let mut dea: Vec<Option<f64>> = vec![None; n];
    let mut hist: Vec<Option<f64>> = vec![None; n];

    let start = dif.iter().position(|v| v.is_some());
    if let Some(s) = start {
        if n >= s + signal {
            let k = 2.0 / (signal as f64 + 1.0);
            let mut seed = 0.0;
            for i in s..s + signal {
                seed += dif[i].unwrap_or(0.0);
            }
            let mut prev = seed / signal as f64;
            let si = s + signal - 1;
            dea[si] = Some(prev);
            for i in si + 1..n {
                let d = dif[i].unwrap_or(0.0);
                prev = d * k + prev * (1.0 - k);
                dea[i] = Some(prev);
            }
            for i in 0..n {
                if let (Some(d), Some(sg)) = (dif[i], dea[i]) {
                    hist[i] = Some((d - sg) * 2.0);
                }
            }
        }
    }
    dif.iter_mut().for_each(|v| *v = v.filter(|x| x.is_finite()));
    (dif, dea, hist)
}

pub struct Boll {
    pub mid: Vec<Option<f64>>,
    pub upper: Vec<Option<f64>>,
    pub lower: Vec<Option<f64>>,
}

pub fn boll(bars: &[Bar], period: usize, mult: f64) -> Boll {
    let n = bars.len();
    let mid = sma(bars, period);
    let mut upper = vec![None; n];
    let mut lower = vec![None; n];
    if n >= period && period > 0 {
        for i in (period - 1)..n {
            if let Some(m) = mid[i] {
                let mut var_sum = 0.0;
                for j in (i + 1 - period)..=i {
                    let d = bars[j].c - m;
                    var_sum += d * d;
                }
                let sd = (var_sum / period as f64).sqrt();
                upper[i] = Some(m + mult * sd);
                lower[i] = Some(m - mult * sd);
            }
        }
    }
    Boll { mid, upper, lower }
}

/// 最近 lookback 根的最低价
pub fn swing_low(bars: &[Bar], i: usize, lookback: usize) -> f64 {
    let from = i.saturating_sub(lookback - 1);
    bars[from..=i].iter().map(|b| b.l).fold(f64::INFINITY, f64::min)
}

/// 最近 lookback 根的最高价
pub fn swing_high(bars: &[Bar], i: usize, lookback: usize) -> f64 {
    let from = i.saturating_sub(lookback - 1);
    bars[from..=i].iter().map(|b| b.h).fold(f64::NEG_INFINITY, f64::max)
}

pub fn bullish_engulf(bars: &[Bar], i: usize) -> bool {
    if i == 0 {
        return false;
    }
    let p = &bars[i - 1];
    let c = &bars[i];
    let p_hi = p.o.max(p.c);
    let p_lo = p.o.min(p.c);
    let c_hi = c.o.max(c.c);
    let c_lo = c.o.min(c.c);
    p.c < p.o && c.c > c.o && c_hi >= p_hi && c_lo <= p_lo && (c_hi - c_lo) > (p_hi - p_lo)
}

pub fn bearish_engulf(bars: &[Bar], i: usize) -> bool {
    if i == 0 {
        return false;
    }
    let p = &bars[i - 1];
    let c = &bars[i];
    let p_hi = p.o.max(p.c);
    let p_lo = p.o.min(p.c);
    let c_hi = c.o.max(c.c);
    let c_lo = c.o.min(c.c);
    // 前阳本阴，本阴实体上沿不低于前阳上沿、下沿不高于前阳下沿
    p.c > p.o && c.c < c.o && c_hi >= p_hi && c_lo <= p_lo && (c_hi - c_lo) > (p_hi - p_lo)
}

pub struct Pullback {
    pub hit: bool,
    pub dist_pct: Option<f64>,
}

/// 价格回踩均线后收回上方
pub fn pullback_to(bars: &[Bar], i: usize, line: &[Option<f64>], lookback: usize, tol_pct: f64) -> Pullback {
    let cur = match line.get(i).and_then(|v| *v) {
        Some(v) if v > 0.0 => v,
        _ => return Pullback { hit: false, dist_pct: None },
    };
    let from = i.saturating_sub(lookback - 1);
    for j in from..=i {
        if let Some(lv) = line.get(j).and_then(|v| *v) {
            if lv <= 0.0 {
                continue;
            }
            let tol = lv * tol_pct / 100.0;
            if bars[j].l <= lv + tol && bars[i].c >= lv {
                return Pullback { hit: true, dist_pct: Some((bars[i].c - lv) / lv * 100.0) };
            }
        }
    }
    Pullback { hit: false, dist_pct: Some((bars[i].c - cur) / cur * 100.0) }
}

pub struct Trend {
    pub dir: i32, // 1 多 / -1 空 / 0 不明
    pub strength: f64,
    pub slope_pct: f64,
}

/// 收盘价与均线位置 + 均线斜率
pub fn trend(bars: &[Bar], ema_line: &[Option<f64>], i: usize) -> Trend {
    if i == 0 {
        return Trend { dir: 0, strength: 0.0, slope_pct: 0.0 };
    }
    let cur = ema_line.get(i).and_then(|v| *v);
    let prev = if i > 0 { ema_line.get(i - 1).and_then(|v| *v) } else { None };
    let (cur, prev) = match (cur, prev) {
        (Some(a), Some(b)) if a > 0.0 => (a, b),
        _ => return Trend { dir: 0, strength: 0.0, slope_pct: 0.0 },
    };
    let slope = (cur - prev) / prev * 100.0;
    let above = bars[i].c > cur;
    let dir = if above && slope > 0.0 {
        1
    } else if !above && slope < 0.0 {
        -1
    } else {
        0
    };
    let strength = ((slope.abs() * 200.0 + if above { 20.0 } else { 0.0 } + 20.0) as f64).min(100.0);
    Trend { dir, strength, slope_pct: slope }
}