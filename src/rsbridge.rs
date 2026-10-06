//! rsrs（respire）记忆插件桥：把金秤的记忆读写整体委托给本机 `rsrs` CLI。
//!
//! 与 agent 共用同一套本机记忆库（树形判重、云同步、加密都由 rsrs 负责）；
//! 金秤侧不再自持明文记忆文件（旧 `~/.goldscale/memory.json` 开启时一次性导入）。
//!
//! 职责三件：
//! 1. 探测 CLI 与 runtime（`rsrs --client-only status`），未装时用官方 npm 包装 CLI 本体；
//! 2. 把 CLI 输出翻成产品需要的条目（list/recall → 条目；remember/update 写入；forget 删除）；
//! 3. 给 agent 对话拼一段召回注入块。
//!
//! 铁律：所有调用都带 `--client-only`——只连宿主 runtime，**绝不启停/安装/升级 runtime 服务**；
//! 「安装」只装 CLI 二进制本体（`@rsrsai/cli`，纯 npm 包，无 postinstall）。
//!
//! 本模块的函数都是阻塞的（CLI 要加载模型，单次几百毫秒到数秒），
//! 由调用方放进 `tokio::task::spawn_blocking`，别在 async 上下文里直接调。

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde::{Deserialize, Serialize};

/// 官方装机通道：npm 包（`rsrs update-check` 给出的也是这条）。
/// 包内 `bin/cli.js` 只是转发壳，真二进制在平台子包（`@rsrsai/linux-x64-gnu` 等）。
pub const NPM_PKG: &str = "@rsrsai/cli@latest";

/// 产品 UI 存下的记忆一律进主库（rsrs 重要度 >=60 才进召回主区）。
///
/// 不传重要度时 rsrs 按 trivial 处理，且在 `diary_mode=concise` 下会
/// 「追加进当天日记条目」而不是新建条目——用户在自己的列表里看不见刚存的东西。
/// 产品 UI 是用户明确意图，故显式给 70。
const UI_IMPORTANCE: u32 = 70;

/// 列表上限（产品管理卡一次最多看这么多）
const LIST_LIMIT: u32 = 200;
/// 搜索上限（语义召回前 N）
const SEARCH_LIMIT: u32 = 30;

/// 一条记忆（金秤侧视图；`body` 取自 rsrs 条目正文）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemItem {
    pub id: String,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    /// 更新时间，unix 秒（rsrs `updated_at` 是 RFC3339，取不到置 0）
    pub updated: i64,
}

/// 插件状态：`GET /api/memory/plugin` 的载荷
#[derive(Debug, Clone, Serialize)]
pub struct PluginStatus {
    /// CLI 是否可执行（PATH / ~/.local/bin / /usr/local/bin）
    pub installed: bool,
    /// runtime 是否在线（`status` 返回 ok）
    pub runtime_ok: bool,
    /// CLI 版本号，未装为空串
    pub version: String,
    /// 用户开关（落盘 settings.json 的 memory_enabled）
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ---------- 探测 ----------

fn is_exec(p: &Path) -> bool {
    if !p.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return p
            .metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    true
}

/// 按名字在 PATH 与常见用户目录里找一个可执行文件
fn which(name: &str) -> Option<PathBuf> {
    if let Some(paths) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&paths) {
            let p = d.join(name);
            if is_exec(&p) {
                return Some(p);
            }
        }
    }
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    [home.join(".local/bin").join(name), PathBuf::from("/usr/local/bin").join(name)]
        .into_iter()
        .find(|p| is_exec(p))
}

/// rsrs CLI 路径：`GOLDSCALE_RSRS` 覆盖 → PATH → `~/.local/bin/rsrs` → `/usr/local/bin/rsrs`
pub fn cli_path() -> Option<PathBuf> {
    if let Some(v) = std::env::var_os("GOLDSCALE_RSRS") {
        let p = PathBuf::from(v);
        if is_exec(&p) {
            return Some(p);
        }
    }
    which("rsrs")
}

/// CLI 版本号（`rsrs --version` 输出形如 `rsrs 1.0.6-dev.17`，只留末段）
pub fn version_of(cli: &Path) -> String {
    Command::new(cli)
        .arg("--client-only")
        .arg("--version")
        .output()
        .ok()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .split_whitespace()
                .last()
                .unwrap_or("")
                .to_string()
        })
        .unwrap_or_default()
}

// ---------- 调 CLI ----------

/// stderr/stdout 尾部若干字符，塞进错误文案里
fn tail(bytes: &[u8], n: usize) -> String {
    let s = String::from_utf8_lossy(bytes);
    let t = s.trim();
    let len = t.chars().count();
    if len <= n {
        t.to_string()
    } else {
        t.chars().skip(len - n).collect()
    }
}

/// 跑一次 `rsrs --client-only <args>`；stdin 关（CLI 不会等人输入）
fn run(args: &[String]) -> Result<Output, String> {
    let cli = cli_path().ok_or_else(|| "未检测到 rsrs 命令".to_string())?;
    Command::new(&cli)
        .arg("--client-only")
        .args(args)
        .env("NO_COLOR", "1")
        .output()
        .map_err(|e| format!("执行 {} 失败: {}", cli.display(), e))
}

/// 跑一次并解析 JSON；顶层 `status: error` 直接当失败（rsrs 的约定）
fn run_json(args: &[String]) -> Result<serde_json::Value, String> {
    let out = run(args)?;
    let txt = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = serde_json::from_str(txt.trim()).map_err(|e| {
        format!(
            "rsrs 输出不是 JSON（{e}）尾部: {}{}",
            tail(txt.as_bytes(), 120),
            if out.stderr.is_empty() { String::new() } else { format!("；stderr: {}", tail(&out.stderr, 200)) }
        )
    })?;
    if v.get("status").and_then(|s| s.as_str()) == Some("error") {
        return Err(format!("rsrs 报错: {}", tail(serde_json::to_string(&v["errors"]).unwrap_or_default().as_bytes(), 200)));
    }
    Ok(v)
}

// ---------- JSON 解析 ----------

/// 解析 rsrs `list` / `recall` / `show` 的 JSON。
///
/// - `list`：`details` 是完整条目数组（含 `content` / `tags` / `updated_at`）；
/// - `recall`：`details` 是 `{ancestors, entry, score}` 包装数组，条目在 `entry`；
/// - `show`：`details` 是对象，条目在 `details.entry`；
/// - 兜底：只有 `items`（`name`=短 id、`value`="分数 标题"）时只给标题，正文留空。
pub fn parse_items(v: &serde_json::Value) -> Vec<MemItem> {
    let details = v.get("details");
    if let Some(arr) = details.and_then(|d| d.as_array()) {
        let got: Vec<MemItem> = arr.iter().filter_map(details_item).collect();
        if !got.is_empty() {
            return got;
        }
    }
    if let Some(entry) = details.and_then(|d| d.get("entry")) {
        if let Some(it) = entry_to_item(entry) {
            return vec![it];
        }
    }
    v.get("items")
        .and_then(|i| i.as_array())
        .map(|arr| arr.iter().filter_map(short_item).collect())
        .unwrap_or_default()
}

/// `details[]` 的一个元素：`list` 给裸条目，`recall` 给 `{ancestors, entry, score}` 包装
fn details_item(e: &serde_json::Value) -> Option<MemItem> {
    if e.get("id").is_some() {
        return entry_to_item(e);
    }
    entry_to_item(e.get("entry")?)
}

/// `details[]` 里的完整条目
fn entry_to_item(e: &serde_json::Value) -> Option<MemItem> {
    let id = e.get("id").and_then(|x| x.as_str())?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    Some(MemItem {
        id,
        title: e.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        body: e.get("content").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        tags: e
            .get("tags")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|t| t.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
        updated: e.get("updated_at").and_then(|x| x.as_str()).map(parse_ts).unwrap_or(0),
    })
}

/// `items[]` 兜底：`name` 是 8 位短 id，`value` 可能是 `"0.548 标题"` 或 `"标题"`；
/// `write` / `entry` 这类状态项不是条目，跳过。
fn short_item(e: &serde_json::Value) -> Option<MemItem> {
    let name = e.get("name").and_then(|x| x.as_str())?.trim();
    if name.is_empty() || name == "write" || name == "entry" {
        return None;
    }
    let value = e.get("value").and_then(|x| x.as_str()).unwrap_or("").trim();
    let title = match value.split_once(' ') {
        Some((first, rest)) if !first.is_empty() && first.chars().all(|c| c.is_ascii_digit() || c == '.') => {
            rest.trim().to_string()
        }
        _ => value.to_string(),
    };
    if title.is_empty() {
        return None;
    }
    Some(MemItem { id: name.to_string(), title, body: String::new(), tags: Vec::new(), updated: 0 })
}

/// RFC3339 → unix 秒；解析不了给 0
fn parse_ts(s: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(s).map(|d| d.timestamp()).unwrap_or(0)
}

/// `remember` 回执里的新条目 id：先看 `summary.id`，退一步解析 `items[].value` 的 `id=...`
fn new_id_of(v: &serde_json::Value) -> Option<String> {
    if let Some(id) = v.get("summary").and_then(|s| s.get("id")).and_then(|x| x.as_str()) {
        if !id.trim().is_empty() {
            return Some(id.trim().to_string());
        }
    }
    v.get("items")?.as_array()?.iter().find_map(|i| {
        i.get("value")
            .and_then(|x| x.as_str())
            .and_then(|s| s.strip_prefix("id="))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    })
}

// ---------- 对外能力 ----------

/// runtime 是否在线：`rsrs --client-only status --json` 顶层 status == ok
pub fn runtime_ok() -> bool {
    let args = vec!["status".to_string(), "--json".to_string()];
    match run_json(&args) {
        Ok(v) => v.get("status").and_then(|s| s.as_str()) == Some("ok"),
        Err(_) => false,
    }
}

/// 探测插件状态（`enabled` 由调用方从设置里读，这里只做检测）
pub fn plugin_status(enabled: bool) -> PluginStatus {
    let Some(cli) = cli_path() else {
        return PluginStatus {
            installed: false,
            runtime_ok: false,
            version: String::new(),
            enabled,
            error: Some("未检测到 rsrs 命令".to_string()),
        };
    };
    let version = version_of(&cli);
    let ok = runtime_ok();
    PluginStatus {
        installed: true,
        runtime_ok: ok,
        version,
        enabled,
        error: (!ok).then(|| {
            "rsrs runtime 未就绪：本机 rsrs 服务未运行或未登录（金秤不代管 runtime，请自行启动/登录）"
                .to_string()
        }),
    }
}

/// 查：`q` 空走 `list`（最近条目），非空走 `recall`（语义召回）
#[allow(dead_code)] // 调用方是 agentd 记忆网关（金秤主服务已改代理转发，故本 crate 内未用）
pub fn list(q: &str) -> Result<Vec<MemItem>, String> {
    let q = q.trim();
    let args: Vec<String> = if q.is_empty() {
        vec!["list".into(), "--limit".into(), LIST_LIMIT.to_string(), "--json".into()]
    } else {
        vec!["recall".into(), q.to_string(), "--limit".into(), SEARCH_LIMIT.to_string(), "--json".into()]
    };
    let v = run_json(&args)?;
    Ok(parse_items(&v))
}

/// 存/改：`id` 有值走 `update`，无值走 `remember`（`--force`，见 `UI_IMPORTANCE` 注释）
pub fn save(id: Option<&str>, title: &str, body: &str, tags: &[String]) -> Result<MemItem, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("标题不能为空".to_string());
    }
    let clean: Vec<String> = tags
        .iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    let csv = clean.join(",");
    // rsrs 的 CONTENT 是位置参数且不允许空：正文为空时以标题充正文，保住「标题必填」的语义
    let content = if body.trim().is_empty() { title } else { body };

    match id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => {
            let args = vec![
                "update".into(),
                id.to_string(),
                "--title".into(),
                title.to_string(),
                "--content".into(),
                content.to_string(),
                "--tags".into(),
                csv,
                "--json".into(),
            ];
            run_json(&args)?;
            // update 不回条目原文，回读一次拿权威结果
            let v = run_json(&["show".into(), id.to_string(), "--json".into()])?;
            parse_items(&v).into_iter().next().ok_or_else(|| "已更新但回读条目失败".to_string())
        }
        None => remember_with(content, title, &clean, UI_IMPORTANCE, &[]),
    }
}

/// 标签清洗：去空、去首尾空白
fn clean_tags(tags: &[String]) -> Vec<String> {
    tags.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect()
}

/// `remember` 的参数拼装（纯函数，供单测锁定契约）：
/// 一律 `--force`（判重由调用方先做完，见各调用点注释）+ 显式 `--importance`；
/// `extra` 追加 `--parent` / `--merge-ids` 这类关系参数。
fn remember_args(
    content: &str,
    title: &str,
    tags: &[String],
    importance: u32,
    extra: &[String],
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "remember".into(),
        content.to_string(),
        "--title".into(),
        title.to_string(),
        "--tags".into(),
        clean_tags(tags).join(","),
        "--importance".into(),
        importance.to_string(),
        "--force".into(),
    ];
    args.extend(extra.iter().cloned());
    args.push("--json".into());
    args
}

/// `remember` 的公共执行：写入后回读一次，给调用方权威条目（id/title/body/tags/updated）
fn remember_with(
    content: &str,
    title: &str,
    tags: &[String],
    importance: u32,
    extra: &[String],
) -> Result<MemItem, String> {
    let args = remember_args(content, title, tags, importance, extra);
    let v = run_json(&args)?;
    let new_id = new_id_of(&v).ok_or_else(|| "rsrs 未返回新条目 id".to_string())?;
    let v = run_json(&["show".into(), new_id, "--json".into()])?;
    parse_items(&v).into_iter().next().ok_or_else(|| "已写入但回读条目失败".to_string())
}

/// 判重候选一条：相似度 + 旧条目
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    /// 余弦相似度（0~1）；解析不到给 0
    pub score: f64,
    pub item: MemItem,
}

/// 检索相似旧条目（记忆网关的判重依据）：rsrs `candidates <CONTENT>` 的判决票据（只读）。
///
/// 解析 `details.merge[]`（高相似：宜并入）与 `details.parent[]`（中相似：宜挂其下），
/// 按相似度降序、按 id 去重、截前 `limit` 条——给调用方做「要不要起 agent 裁决轮」的闸门。
/// 空内容直接返回空表，不发无意义的 CLI 调用。
#[allow(dead_code)] // 调用方是 agentd 记忆网关（金秤主服务已改代理转发，故本 crate 内未用）
pub fn candidates(content: &str, limit: usize) -> Result<Vec<Candidate>, String> {
    let c = content.trim();
    if c.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let args = vec!["candidates".into(), c.to_string(), "--json".into()];
    let v = run_json(&args)?;
    Ok(parse_candidates(&v, limit))
}

/// `candidates` 的 JSON → 候选表（纯函数，契约由单测锁死）：
/// 合 `details.merge[]` 与 `details.parent[]`，按相似度降序、同 id 先到（merge）先得、截前 `limit`。
fn parse_candidates(v: &serde_json::Value, limit: usize) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = Vec::new();
    for key in ["merge", "parent"] {
        let Some(arr) = v.get("details").and_then(|d| d.get(key)).and_then(|x| x.as_array()) else {
            continue;
        };
        for e in arr {
            let score = e.get("score").and_then(|s| s.as_f64()).unwrap_or(0.0);
            let Some(item) = entry_to_item(e.get("entry").unwrap_or(e)) else { continue };
            if out.iter().any(|c| c.item.id == item.id) {
                continue; // 两个来源可能重叠，先到（merge）为准
            }
            out.push(Candidate { score, item });
        }
    }
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(limit);
    out
}

/// 挂链存：新条目挂到 `parent` 之下（rsrs `--parent` 即因果挂链——父为因、子为果）。
/// 用于 agent 裁决「挂其下」分支：新内容是旧条目的后续/结果/细节。
#[allow(dead_code)] // 调用方是 agentd 记忆网关
pub fn save_attached(
    parent: &str,
    title: &str,
    body: &str,
    tags: &[String],
    importance: u32,
) -> Result<MemItem, String> {
    let parent = parent.trim();
    if parent.is_empty() {
        return Err("缺父条目 id".to_string());
    }
    let title = title.trim();
    if title.is_empty() {
        return Err("标题不能为空".to_string());
    }
    let content = if body.trim().is_empty() { title } else { body };
    let extra = vec!["--parent".to_string(), parent.to_string()];
    remember_with(content, title, tags, importance, &extra)
}

/// 并入：删掉 `old_ids` 那些旧条目，把这条作为合并后的整条写入
/// （rsrs `--merge-ids` 会继承第一条的因果链）。用于 agent 裁决「并入」分支。
#[allow(dead_code)] // 调用方是 agentd 记忆网关
pub fn merge_old(
    old_ids: &[String],
    title: &str,
    body: &str,
    tags: &[String],
    importance: u32,
) -> Result<MemItem, String> {
    let ids: Vec<String> = old_ids
        .iter()
        .map(|i| i.trim().to_string())
        .filter(|i| !i.is_empty())
        .collect();
    if ids.is_empty() {
        return Err("并入需要至少一个旧条目 id".to_string());
    }
    let title = title.trim();
    if title.is_empty() {
        return Err("标题不能为空".to_string());
    }
    let content = if body.trim().is_empty() { title } else { body };
    let extra = vec!["--merge-ids".to_string(), ids.join(",")];
    remember_with(content, title, tags, importance, &extra)
}

/// 删：rsrs 的 tombstone 删除（随云同步传播）
#[allow(dead_code)] // 调用方是 agentd 记忆网关（金秤主服务已改代理转发，故本 crate 内未用）
pub fn forget(id: &str) -> Result<bool, String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("缺少条目 id".to_string());
    }
    let v = run_json(&["forget".into(), id.to_string(), "--json".into()])?;
    Ok(v.get("summary").and_then(|s| s.get("deleted")).and_then(|d| d.as_bool()).unwrap_or(true))
}

/// 给 agent 对话的召回注入块：取前 `n` 条，正文截 400 字；拿不到正文就只给标题。
/// 返回 `(条数, 文本)`；任何失败都返回 None——注入是加分项，不该拖累对话。
#[allow(dead_code)] // 调用方是 agentd（金秤主服务不再拉 pi，故本 crate 内未用）
pub fn inject_block(prompt: &str, n: usize) -> Option<(usize, String)> {
    let p = prompt.trim();
    if p.is_empty() || n == 0 {
        return None;
    }
    let args = vec!["recall".into(), p.to_string(), "--limit".into(), n.to_string(), "--json".into()];
    let v = run_json(&args).ok()?;
    let items = parse_items(&v);
    let picked: Vec<&MemItem> = items.iter().filter(|i| !i.title.trim().is_empty()).take(n).collect();
    if picked.is_empty() {
        return None;
    }
    let block = picked
        .iter()
        .map(|i| {
            let body: String = i.body.chars().take(400).collect();
            if body.trim().is_empty() {
                format!("- {}", i.title)
            } else {
                format!("- {}：{}", i.title, body)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    Some((picked.len(), block))
}

/// 手动安装指引（自动安装失败时给用户照抄）
pub fn manual_install_hint() -> String {
    format!("npm i -g --prefix ~/.local {NPM_PKG}  （免 sudo；或 sudo npm i -g {NPM_PKG}）")
}

/// 装 CLI 本体：官方 npm 包，装到用户前缀 `~/.local`（免 sudo，`cli_path()` 正好会找到它）。
///
/// 只装 CLI 二进制，不动 runtime 服务——用户的 rsrs 守护进程与数据一概不碰。
pub fn install_cli() -> Result<String, String> {
    let npm = which("npm").ok_or_else(|| {
        format!("未找到 npm（需 Node.js >=16）。手动安装：{}", manual_install_hint())
    })?;
    let mut cmd = Command::new(&npm);
    cmd.arg("install").arg("-g");
    #[cfg(unix)]
    if let Some(home) = std::env::var_os("HOME") {
        let prefix = PathBuf::from(home).join(".local");
        if let Err(e) = std::fs::create_dir_all(&prefix) {
            return Err(format!("创建安装前缀 {} 失败: {}", prefix.display(), e));
        }
        cmd.arg("--prefix").arg(&prefix);
    }
    cmd.arg(NPM_PKG);
    let out = cmd.output().map_err(|e| format!("执行 npm 失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "npm 安装失败（{}）。手动安装：{}",
            tail(&out.stderr, 300),
            manual_install_hint()
        ));
    }
    let last = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .last()
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(last)
}

// ---------- 旧内置记忆迁移 ----------

#[derive(Deserialize)]
struct LegacyDb {
    #[serde(default)]
    items: Vec<LegacyItem>,
}

#[derive(Deserialize)]
struct LegacyItem {
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    tags: Vec<String>,
}

/// 同标题是否已在 rsrs 库里（迁移幂等：重复 enable 不会重复导入）
fn title_exists(title: &str) -> Result<bool, String> {
    let args = vec!["recall".into(), title.to_string(), "--limit".into(), "5".into(), "--json".into()];
    let v = run_json(&args)?;
    Ok(parse_items(&v).iter().any(|i| i.title.trim() == title))
}

/// 旧自研记忆（`~/.goldscale/memory.json`）一次性导入 rsrs，随后把原文件改名 `.migrated-<ts>`。
///
/// - 返回 `Ok(None)`：没有旧文件，无需迁移；
/// - 返回 `Ok(Some(path))`：已迁移，`path` 是备份文件名；
/// - 中间任一条导入失败 → 直接报错，**不动原文件**（下次 enable 再来）。
pub fn migrate_legacy() -> Result<Option<String>, String> {
    let path = crate::agent::agent_home().join("memory.json");
    if !path.is_file() {
        return Ok(None);
    }
    let txt =
        std::fs::read_to_string(&path).map_err(|e| format!("读旧记忆 {} 失败: {}", path.display(), e))?;
    let old: Vec<LegacyItem> = match serde_json::from_str::<LegacyDb>(&txt) {
        Ok(db) => db.items,
        Err(e) => {
            // 旧文件坏了：不猜、不删，改名留给用户
            let bak = path.with_extension(format!("json.bad-{}", chrono::Utc::now().timestamp()));
            std::fs::rename(&path, &bak)
                .map_err(|re| format!("旧记忆解析失败({e})且备份失败({re})"))?;
            return Ok(Some(bak.display().to_string()));
        }
    };
    let mut imported = 0usize;
    for it in &old {
        let title = it.title.trim();
        if title.is_empty() {
            continue;
        }
        if title_exists(title)? {
            continue;
        }
        save(None, title, &it.body, &it.tags)?;
        imported += 1;
    }
    let bak = path.with_extension(format!("json.migrated-{}", chrono::Utc::now().timestamp()));
    std::fs::rename(&path, &bak)
        .map_err(|e| format!("旧记忆已导入 {imported} 条，但备份改名失败: {e}"))?;
    Ok(Some(bak.display().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 精简的 `rsrs list --json` 样本（details 是完整条目数组）
    fn list_sample() -> serde_json::Value {
        serde_json::json!({
            "command": "list",
            "status": "ok",
            "summary": {"count": 1, "limit": 1},
            "items": [{"name": "4d06d09a", "status": "ok", "value": "活动轨迹 2026-10-06"}],
            "actions": [],
            "errors": [],
            "details": [{
                "computer": "ok/linux",
                "content": "【活动轨迹】2026-10-06\n【12:21】加策略归属与交易日志卡。",
                "created_at": "2026-10-06T04:21:05.686Z",
                "id": "4d06d09a-953c-5d0e-92b7-2a8a97901fc5",
                "importance": "trivial",
                "parent_id": "",
                "tags": ["活动轨迹"],
                "title": "活动轨迹 2026-10-06",
                "updated_at": "2026-10-06T04:21:05.686Z"
            }]
        })
    }

    #[test]
    fn parse_list_details_full_entry() {
        let items = parse_items(&list_sample());
        assert_eq!(items.len(), 1);
        let it = &items[0];
        assert_eq!(it.id, "4d06d09a-953c-5d0e-92b7-2a8a97901fc5");
        assert_eq!(it.title, "活动轨迹 2026-10-06");
        assert!(it.body.starts_with("【活动轨迹】"));
        assert_eq!(it.tags, vec!["活动轨迹".to_string()]);
        // 2026-10-06T04:21:05.686Z 的 unix 秒
        assert_eq!(it.updated, 1791260465);
    }

    #[test]
    fn parse_recall_keeps_order_and_body() {
        // recall 的 details[] 是 {ancestors, entry, score} 包装，正文在 entry 里
        let v = serde_json::json!({
            "command": "recall",
            "status": "ok",
            "items": [
                {"name": "0852f35c", "status": "ok", "value": "0.548 金秤内置记忆系统"},
                {"name": "a22c5e2f", "status": "ok", "value": "0.515 respire英文版PPT"}
            ],
            "details": [
                {
                    "ancestors": [{"id": "b4eafaed", "title": "编程开发"}],
                    "entry": {"id": "0852f35c-4764-4972-93f7-c14f05a0ac88", "title": "金秤内置记忆系统", "content": "正文甲", "tags": [], "updated_at": "2026-10-05T16:47:59.187Z"},
                    "score": 0.548
                },
                {
                    "ancestors": [],
                    "entry": {"id": "a22c5e2f-1111-2222-3333-444455556666", "title": "respire英文版PPT", "content": "正文乙", "tags": ["ppt"], "updated_at": "2026-10-03T01:00:00Z"},
                    "score": 0.515
                }
            ]
        });
        let items = parse_items(&v);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "金秤内置记忆系统");
        assert_eq!(items[0].body, "正文甲", "recall 的正文藏在 entry 里，必须取到");
        assert_eq!(items[1].tags, vec!["ppt".to_string()]);
        assert_eq!(items[1].updated, 1790989200);
    }

    #[test]
    fn parse_show_details_entry() {
        let v = serde_json::json!({
            "command": "show",
            "status": "ok",
            "summary": {"id": "0852f35c-4764-4972-93f7-c14f05a0ac88"},
            "items": [{"name": "entry", "status": "ok", "value": "0852f35c"}],
            "details": {
                "ancestors": [{"id": "x", "title": "编程开发"}],
                "children": [],
                "entry": {
                    "id": "0852f35c-4764-4972-93f7-c14f05a0ac88",
                    "title": "金秤内置记忆系统",
                    "content": "端到端通",
                    "tags": [],
                    "updated_at": "2026-10-05T16:47:59.187Z"
                }
            }
        });
        let items = parse_items(&v);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "金秤内置记忆系统");
        assert_eq!(items[0].body, "端到端通");
    }

    #[test]
    fn parse_items_falls_back_to_titles_without_details() {
        // details 缺失（或没有可用 id）时，只给标题，正文留空——宁缺勿假
        let v = serde_json::json!({
            "command": "recall",
            "status": "ok",
            "items": [
                {"name": "write", "status": "ok", "value": "id=abc"},
                {"name": "entry", "status": "ok", "value": "deleted"},
                {"name": "0852f35c", "status": "ok", "value": "0.548 金秤内置记忆系统"},
                {"name": "a22c5e2f", "status": "ok", "value": "无分数标题"}
            ]
        });
        let items = parse_items(&v);
        assert_eq!(items.len(), 2, "write/entry 状态项须跳过");
        assert_eq!(items[0].id, "0852f35c");
        assert_eq!(items[0].title, "金秤内置记忆系统");
        assert!(items[0].body.is_empty());
        assert_eq!(items[1].title, "无分数标题");
    }

    #[test]
    fn parse_items_ignores_garbage() {
        assert!(parse_items(&serde_json::json!({"status": "ok"})).is_empty());
        assert!(parse_items(&serde_json::json!({"details": []})).is_empty());
        // 条目缺 id → 丢掉，不造空 id
        let v = serde_json::json!({"details": [{"title": "无 id", "content": "x"}]});
        assert!(parse_items(&v).is_empty());
    }

    #[test]
    fn parse_ts_handles_bad_input() {
        assert_eq!(parse_ts("2026-10-06T04:21:05.686Z"), 1791260465);
        assert_eq!(parse_ts("2026-10-06T04:21:05+08:00"), 1791231665);
        assert_eq!(parse_ts("不是时间"), 0);
        assert_eq!(parse_ts(""), 0);
    }

    #[test]
    fn new_id_prefers_summary_then_items() {
        let v = serde_json::json!({
            "command": "remember",
            "status": "ok",
            "summary": {"action": "created", "id": "e1ac4803-fb99-46fa-a399-02dec550d68f"},
            "items": [{"name": "write", "status": "ok", "value": "id=e1ac4803-fb99-46fa-a399-02dec550d68f"}]
        });
        assert_eq!(new_id_of(&v).unwrap(), "e1ac4803-fb99-46fa-a399-02dec550d68f");

        // summary 里没有 id 时退到 items 的 "id=..."
        let v2 = serde_json::json!({
            "command": "remember",
            "status": "ok",
            "summary": {"action": "diary_appended"},
            "items": [{"name": "write", "status": "ok", "value": "id=4d06d09a-953c-5d0e-92b7-2a8a97901fc5"}]
        });
        assert_eq!(new_id_of(&v2).unwrap(), "4d06d09a-953c-5d0e-92b7-2a8a97901fc5");

        assert!(new_id_of(&serde_json::json!({"status": "ok", "items": []})).is_none());
    }

    #[test]
    fn is_exec_checks_exec_bit() {
        use std::io::Write;
        let dir = std::env::temp_dir();
        let p = dir.join(format!("goldscale-exec-{}-{}", std::process::id(), chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        std::fs::write(&p, b"#!/bin/sh\n").unwrap();
        assert!(!is_exec(&p), "普通文件不算可执行");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&p).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&p, perms).unwrap();
            assert!(is_exec(&p), "加了执行位就算");
        }
        let mut f = std::fs::File::create(&p).unwrap();
        let _ = f.write_all(b"x");
        drop(f);
        std::fs::remove_file(&p).unwrap();
        assert!(!is_exec(&p), "删掉后不算");
    }

    #[test]
    fn manual_hint_names_the_npm_package() {
        let h = manual_install_hint();
        assert!(h.contains(NPM_PKG));
        assert!(h.contains("npm i -g"));
    }

    /// `candidates` 的解析契约：merge/parent 两源合并、按相似度降序、同 id 去重、截断
    #[test]
    fn candidates_parse_sorted_and_deduped() {
        let v = serde_json::json!({
            "command": "candidates",
            "status": "ok",
            "summary": {"merge_count": 2, "parent_count": 1},
            "items": [{"name": "merge candidates", "status": "ok", "value": "2"}],
            "errors": [],
            "details": {
                "merge": [
                    {"entry": {"id": "aaaaaaaa-1111-2222-3333-444455556666", "title": "甲", "content": "正文甲", "tags": ["x"], "updated_at": "2026-10-06T04:21:05.686Z"}, "score": 0.86},
                    {"entry": {"id": "bbbbbbbb-1111-2222-3333-444455556666", "title": "乙", "content": "正文乙", "tags": [], "updated_at": ""}, "score": 0.61}
                ],
                "pair_notes": [],
                "parent": [
                    {"entry": {"id": "cccccccc-1111-2222-3333-444455556666", "title": "丙", "content": "正文丙", "tags": [], "updated_at": ""}, "score": 0.72},
                    {"entry": {"id": "aaaaaaaa-1111-2222-3333-444455556666", "title": "甲", "content": "正文甲", "tags": ["x"], "updated_at": ""}, "score": 0.30}
                ]
            }
        });
        let out = parse_candidates(&v, 3);
        assert_eq!(out.len(), 3, "同 id 去重后只剩三条");
        assert_eq!(out[0].item.title, "甲");
        assert!((out[0].score - 0.86).abs() < 1e-9);
        assert_eq!(out[1].item.title, "丙");
        assert_eq!(out[2].item.title, "乙");
        assert_eq!(out[0].item.body, "正文甲", "候选正文须取到，裁决轮要看全文");
        assert_eq!(out[0].item.updated, 1791260465);
    }

    /// `remember` 参数契约：force 必带、importance 显式、关系参数（parent/merge-ids）追加在 json 前
    #[test]
    fn remember_args_carry_relations() {
        let tags = vec![" 研判结论 ".to_string(), String::new(), "趋势回踩".to_string()];
        let base = remember_args("正文", "标题", &tags, 70, &[]);
        assert_eq!(base[0], "remember");
        assert!(base.contains(&"--force".to_string()), "判重已在上游做完，写入须 force");
        let imp = base.iter().position(|a| a == "--importance").unwrap();
        assert_eq!(base[imp + 1], "70");
        let tg = base.iter().position(|a| a == "--tags").unwrap();
        assert_eq!(base[tg + 1], "研判结论,趋势回踩", "空标签与空白须清掉");
        assert_eq!(base.last().unwrap(), "--json");

        let attached = remember_args("正文", "标题", &tags, 70, &["--parent".into(), "abc".into()]);
        let p = attached.iter().position(|a| a == "--parent").unwrap();
        assert_eq!(attached[p + 1], "abc");
        assert_eq!(attached.last().unwrap(), "--json", "json 必须收尾");

        let merged = remember_args("正文", "标题", &tags, 70, &["--merge-ids".into(), "a,b".into()]);
        let m = merged.iter().position(|a| a == "--merge-ids").unwrap();
        assert_eq!(merged[m + 1], "a,b");
    }

    /// 挂链/并入的空参数早失败（不把空 id 传给 rsrs）
    #[test]
    fn attach_and_merge_reject_empty_ids() {
        assert!(save_attached("", "标题", "正文", &[], 70).is_err());
        assert!(merge_old(&[], "标题", "正文", &[], 70).is_err());
        assert!(merge_old(&["   ".into()], "标题", "正文", &[], 70).is_err());
    }
}
