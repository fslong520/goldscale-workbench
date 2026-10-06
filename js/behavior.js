/* 行为层共享件：GSEvent（行为事件上报 8788/api/event）、Behavior（今日可亏钱口径）、
 * Cooldown（亏损冷却本机配置）。三者被持仓页 / 风控页 / 总览插件共用，是核心公共插座。
 *
 * 来历：本段原与到价提醒同处一个已加载的前端模块（该模块本轮随迁移整体删除）。本轮提醒
 * 整体迁入 plugins/price-alerts/ 插件，本段与提醒无干、且插件可被停用，故原样拆到这里随核心
 * 一起加载：正文一字未改，只换了住处与文件名。
 */

/* ================= 行为层共享件（跨页；见文件头说明） =================
 * 产品哲学：代码只守钱闸、事件上报，话术归 agent。此处只做「报实况」与「算钱」，
 * 不写任何劝诫文案（人话由教练侧生成）。
 */

/** 行为事件上报：POST 8788/api/event，fire-and-forget。
 *  agentd 未就绪（404/拒绝/跨域/超时）一律静默——上报失败绝不打扰操盘、绝不刷 console。 */
window.GSEvent = {
  BASE: 'http://127.0.0.1:8788',
  post(type, payload) {
    const t = String(type || '').trim();
    if (!t) return;
    try {
      fetch(this.BASE + '/api/event', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: t, payload: payload || {} })
      }).catch(() => {});
    } catch { /* 静默：对方不在线不是错误 */ }
  }
};

/** 今日可亏额度（与后端 risk::gate_check 同一口径）：
 *  预算 = 权益 × daily_loss_budget_pct/100；剩余额度 = 预算 + daily_pnl（pnl 为负即扣减），clamp ≥0。
 *  权益取 /api/stats 的 equity（无则回退 settings.equity）。字段缺失 → missing，0 或负 → off。
 *  三处展示（风控卡 / 开仓表单 / 总览卡）共用此函数，保证同屏同值。 */
window.Behavior = {
  todayBudget(stats, risk, fallbackEquity) {
    const raw = risk ? risk.daily_loss_budget_pct : undefined;
    if (typeof raw !== 'number' || !isFinite(raw)) return { ok: false, why: 'missing' };
    if (!(raw > 0)) return { ok: false, why: 'off', pct: raw };
    // 已实现盈亏是「已亏」的分子：拿不到就不知道今天亏了多少，
    // 宁可显示 -- 让人知道未到手，绝不拿 0 冒充（宁缺毋假）。
    if (!stats || typeof stats.daily_pnl !== 'number' || !isFinite(stats.daily_pnl)) {
      return { ok: false, why: 'nodata', pct: raw };
    }
    const eq = stats.equity > 0 ? stats.equity
      : (fallbackEquity > 0 ? fallbackEquity : null);
    if (eq === null) return { ok: false, why: 'nodata', pct: raw };
    const pnl = stats.daily_pnl;
    const budget = eq * raw / 100;
    const loss = pnl < 0 ? -pnl : 0;
    return {
      ok: true, pct: raw, equity: eq, budget: budget, loss: loss,
      remaining: Math.max(budget - loss, 0),
      over: loss >= budget            // 已达/超预算：与后端拦截线一致（loss >= budget 即拦）
    };
  },
  /** 「按本金 Y% · 今日已亏 $Z」副文案（三处统一） */
  budgetNote(b) {
    return '按本金 ' + U.fx(b.pct, 1) + '% · 今日已亏 ' + this.usd(b.loss);
  },
  /** 美元写法统一在此：符号前缀只此一处 */
  usd(n) { return "$" + U.fx(n, 2); }
};

/** 亏损冷却（纯前端、只存本机浏览器，不入服务端设置）：
 *  gs_cooldown_on 默认开；gs_cooldown_min 默认 15 分钟；gs_cooldown_ack 为会话级已确认标记。 */
window.Cooldown = {
  ON_KEY: 'gs_cooldown_on',
  MIN_KEY: 'gs_cooldown_min',
  ACK_KEY: 'gs_cooldown_ack',
  DEFAULT_MIN: 15,
  MIN_MIN: 1,
  MAX_MIN: 120,

  on() {
    try { return localStorage.getItem(this.ON_KEY) !== '0'; }   // 缺省即开
    catch { return true; }                                      // 存储被禁：按默认开（不做暗改）
  },
  setOn(v) {
    try { localStorage.setItem(this.ON_KEY, v ? '1' : '0'); } catch { /* 静默 */ }
  },
  min() {
    try {
      const v = parseFloat(localStorage.getItem(this.MIN_KEY));
      if (isFinite(v) && v > 0) return Math.min(Math.max(v, this.MIN_MIN), this.MAX_MIN);
    } catch { /* 静默 */ }
    return this.DEFAULT_MIN;
  },
  setMin(v) {
    const n = Math.min(Math.max(Math.round(parseFloat(v) || this.DEFAULT_MIN), this.MIN_MIN), this.MAX_MIN);
    try { localStorage.setItem(this.MIN_KEY, String(n)); } catch { /* 静默 */ }
    return n;
  },
  acked() {
    try { return sessionStorage.getItem(this.ACK_KEY) === '1'; } catch { return false; }
  },
  ack() {
    try { sessionStorage.setItem(this.ACK_KEY, '1'); } catch { /* 静默 */ }
  }
};
