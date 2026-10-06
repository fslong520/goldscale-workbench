//! 插件库：文件夹即安装的插件管理（Minecraft mod 式）
//!
//! 前端插件一直是「`plugins/<name>/` 两个文件 + `plugins/index.json` 登记」，但登记要靠手写。
//! 本模块把这件事做成可操作的产品能力：`.gsp` 包导入/导出、启停开关、覆盖升级（先备份）、
//! 删除、以及给管理页用的清单。
//!
//! ## .gsp 包契约（format = gsp1）
//! ```json
//! { "format": "gsp1",
//!   "plugin": { "manifest": { "name": "x", "title": "…", "order": 100, "version": "1.2.0" },
//!               "files": { "index.js": "…", "README.md": "…" } } }
//! ```
//!
//! ## 硬规则
//! - `name` 白名单 `^[a-z0-9][a-z0-9-]{0,31}$`，且等于目录名 / manifest.name；
//! - `files` 键只允许 `[A-Za-z0-9_./-]`，**禁 `..`、禁绝对路径**（zip-slip 面）；
//! - 落盘一律在项目根 `plugins/` 下，绝不越界；
//! - 覆盖已存在目录前先备份 `plugins/<name>.bak-<ts>`（只留最近一份），升级失败可回退；
//! - `index.json` 读改写走 serde_json，保留 `comment` 等未知字段（不吞用户的注释）。

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// 插件包格式标识：只认这一种
pub const FORMAT: &str = "gsp1";
/// 单包最多文件数
pub const MAX_FILES: usize = 10;
/// 单文件字节上限（文本）
pub const MAX_FILE_BYTES: usize = 200 * 1024;
/// order 缺省值（与 app.js 的兜底一致：排在内置页之后）
pub const DEF_ORDER: i64 = 900;
/// 备份目录标记
const BAK_MARK: &str = ".bak-";

/// 项目根：可执行文件同级 → 上两级（target/release → 项目根）→ 上一级 → 当前目录，
/// 取第一个含 index.html 的（与 main.rs 静态资源查找同一套候选顺序）。
pub fn project_root() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default();
    let cands = [
        exe_dir.clone(),
        exe_dir.join("../.."),
        exe_dir.join(".."),
        PathBuf::from("."),
    ];
    cands
        .iter()
        .find(|d| d.join("index.html").exists())
        .cloned()
        .unwrap_or(exe_dir)
}

/// 插件落盘根目录：项目根 `plugins/`
pub fn plugins_dir() -> PathBuf {
    project_root().join("plugins")
}

// ---------- 校验 ----------

/// 插件名白名单：1-32 位小写字母/数字/连字符，首字符为字母或数字
pub fn valid_name(name: &str) -> bool {
    let b = name.as_bytes();
    if b.is_empty() || b.len() > 32 {
        return false;
    }
    if !(b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) {
        return false;
    }
    b[1..]
        .iter()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// 包内相对路径白名单：只允许 `[A-Za-z0-9_./-]`，禁 `..`、禁绝对路径、禁空段
pub fn valid_rel_path(p: &str) -> bool {
    if p.is_empty() || p.len() > 200 {
        return false;
    }
    if p.contains("..") || p.starts_with('/') || p.contains('\\') {
        return false;
    }
    if p.split('/').any(|seg| seg.is_empty() || seg == ".") {
        return false;
    }
    p.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'))
}

/// 已校验的插件包
#[derive(Debug, Clone)]
pub struct Pack {
    pub name: String,
    pub manifest: Value,
    pub files: BTreeMap<String, String>,
}

#[derive(serde::Deserialize)]
struct RawPack {
    format: String,
    plugin: RawPlugin,
}

#[derive(serde::Deserialize)]
struct RawPlugin {
    manifest: Value,
    files: BTreeMap<String, String>,
}

/// 校验 .gsp 包（结构 → format → name → manifest 必填 → files 路径/体积）
pub fn validate(v: &Value) -> Result<Pack, String> {
    let raw: RawPack = serde_json::from_value(v.clone())
        .map_err(|e| format!("插件包结构不合契约（须为 {{format, plugin:{{manifest, files}}}}）：{e}"))?;
    if raw.format != FORMAT {
        return Err(format!(
            "不支持的插件包格式「{}」：本机只认 {FORMAT}",
            raw.format
        ));
    }
    let m = &raw.plugin.manifest;
    if !m.is_object() {
        return Err("插件清单 manifest 须为 JSON 对象".into());
    }
    let name = m.get("name").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    if !valid_name(&name) {
        return Err(format!(
            "非法插件名「{name}」：须为 1-32 位小写字母/数字/连字符，且以字母或数字开头"
        ));
    }
    let title = m.get("title").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    if title.is_empty() {
        return Err("插件清单缺少 title".into());
    }
    if m.get("order").and_then(|x| x.as_i64()).is_none() {
        return Err("插件清单缺少 order（整数）".into());
    }
    if raw.plugin.files.is_empty() {
        return Err("插件包没有任何文件".into());
    }
    if raw.plugin.files.len() > MAX_FILES {
        return Err(format!(
            "插件包文件数 {} 超过上限 {MAX_FILES}",
            raw.plugin.files.len()
        ));
    }
    if !raw.plugin.files.contains_key("index.js") {
        return Err("插件包缺少 index.js（插件页脚本）".into());
    }
    for (p, body) in &raw.plugin.files {
        if !valid_rel_path(p) {
            return Err(format!(
                "非法文件路径「{p}」：只允许字母数字与 _ . / -，禁 .. 与绝对路径"
            ));
        }
        if body.len() > MAX_FILE_BYTES {
            return Err(format!(
                "文件「{p}」{} 字节，超过单文件上限 {}KB",
                body.len(),
                MAX_FILE_BYTES / 1024
            ));
        }
    }
    Ok(Pack {
        name,
        manifest: raw.plugin.manifest,
        files: raw.plugin.files,
    })
}

// ---------- 注册表 index.json ----------

fn reg_path(root: &Path) -> PathBuf {
    root.join("index.json")
}

/// 读注册表：缺失/损坏/非对象 → 给一个空注册表（宁缺勿假，不编造登记行）
pub fn load_registry(root: &Path) -> Value {
    fs::read_to_string(reg_path(root))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| json!({ "plugins": [] }))
}

fn plugins_arr_mut(v: &mut Value) -> &mut Vec<Value> {
    if !v.get("plugins").map(|p| p.is_array()).unwrap_or(false) {
        v["plugins"] = json!([]);
    }
    v["plugins"].as_array_mut().expect("已保证为数组")
}

/// 写注册表：pretty + 末尾换行，保留 comment 等未知字段
fn save_registry(root: &Path, v: &Value) -> Result<(), String> {
    let s = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    fs::create_dir_all(root).map_err(|e| format!("建目录失败：{e}"))?;
    fs::write(reg_path(root), format!("{s}\n")).map_err(|e| format!("写 index.json 失败：{e}"))
}

// ---------- 清单（管理页一次拉取）----------

#[derive(Serialize)]
pub struct ManageItem {
    pub name: String,
    pub title: String,
    pub order: i64,
    pub version: String,
    pub author: String,
    pub enabled: bool,
    /// 需要的最低产品版本（manifest.min_app），缺省空串
    pub min_app: String,
    /// 目录缺失 / 缺 index.js 时为 true（前端据此显示红 chip）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_error: Option<bool>,
}

#[derive(Serialize)]
pub struct ManageView {
    pub items: Vec<ManageItem>,
    pub registry: Value,
}

fn read_manifest(dir: &Path) -> Option<Value> {
    let s = fs::read_to_string(dir.join("manifest.json")).ok()?;
    let v: Value = serde_json::from_str(&s).ok()?;
    if v.is_object() {
        Some(v)
    } else {
        None
    }
}

fn str_field(v: &Value, k: &str) -> Option<String> {
    v.get(k)
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 管理页清单：以注册表为准（真值随附），逐行合并磁盘上 manifest 的展示字段
pub fn manage(root: &Path) -> ManageView {
    let reg = load_registry(root);
    let rows = reg
        .get("plugins")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();
    let mut items = Vec::new();
    for row in rows {
        let name = str_field(&row, "name").unwrap_or_default();
        if !valid_name(&name) {
            continue; // 注册表脏行进不了列表，也不去动它
        }
        let dir = root.join(&name);
        let man = read_manifest(&dir);
        let enabled = row.get("enabled").and_then(|x| x.as_bool()).unwrap_or(true);
        let pick = |k: &str| man.as_ref().and_then(|m| str_field(m, k));
        let order = man
            .as_ref()
            .and_then(|m| m.get("order"))
            .and_then(|x| x.as_i64())
            .or_else(|| row.get("order").and_then(|x| x.as_i64()))
            .unwrap_or(DEF_ORDER);
        let broken = !dir.is_dir() || !dir.join("index.js").is_file();
        items.push(ManageItem {
            title: pick("title").or_else(|| str_field(&row, "title")).unwrap_or_else(|| name.clone()),
            version: pick("version").unwrap_or_default(),
            author: pick("author").unwrap_or_default(),
            min_app: pick("min_app").unwrap_or_default(),
            has_error: broken.then_some(true),
            name,
            order,
            enabled,
        });
    }
    // 列表顺序按 order（与导航里插件的先后一致），同 order 按名字
    items.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.name.cmp(&b.name)));
    ManageView { items, registry: reg }
}

// ---------- 安装 / 升级 ----------

#[derive(Serialize)]
pub struct InstallOutcome {
    pub installed: String,
    pub upgraded: bool,
}

fn backup_dir(root: &Path, name: &str) -> Result<PathBuf, String> {
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut dst = root.join(format!("{name}{BAK_MARK}{ts}"));
    if dst.exists() {
        dst = root.join(format!("{name}{BAK_MARK}{ts}-{}", std::process::id()));
    }
    fs::rename(root.join(name), &dst).map_err(|e| format!("备份旧插件目录失败：{e}"))?;
    // 只留最近一份：其余同名备份删掉（升级失败回退用不上更旧的）
    let prefix = format!("{name}{BAK_MARK}");
    if let Ok(rd) = fs::read_dir(root) {
        for e in rd.flatten() {
            let p = e.path();
            let base = e.file_name().to_string_lossy().to_string();
            if base.starts_with(&prefix) && p != dst {
                let _ = fs::remove_dir_all(&p);
            }
        }
    }
    Ok(dst)
}

fn write_pack(dir: &Path, pack: &Pack) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("建插件目录失败：{e}"))?;
    for (rel, body) in &pack.files {
        let full = dir.join(rel);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("建子目录失败：{e}"))?;
        }
        fs::write(&full, body).map_err(|e| format!("写文件 {rel} 失败：{e}"))?;
    }
    // manifest.json 以清单字段为准，最后落盘（files 里同名者不覆盖它）
    let man = serde_json::to_string_pretty(&pack.manifest).map_err(|e| e.to_string())?;
    fs::write(dir.join("manifest.json"), format!("{man}\n"))
        .map_err(|e| format!("写 manifest.json 失败：{e}"))
}

fn upsert_registry(root: &Path, pack: &Pack) -> Result<(), String> {
    let order = pack.manifest.get("order").and_then(|x| x.as_i64()).unwrap_or(DEF_ORDER);
    let mut reg = load_registry(root);
    let arr = plugins_arr_mut(&mut reg);
    let mut hit = false;
    for row in arr.iter_mut() {
        if row.get("name").and_then(|x| x.as_str()) == Some(pack.name.as_str()) {
            if !row.is_object() {
                *row = json!({ "name": pack.name });
            }
            row["order"] = json!(order);
            hit = true;
        }
    }
    if !hit {
        arr.push(json!({ "name": pack.name, "order": order }));
    }
    save_registry(root, &reg)
}

/// 安装（同名前先备份后覆盖，upgraded=true）。任何一步失败都尽力回滚到安装前。
pub fn install(root: &Path, v: &Value) -> Result<InstallOutcome, String> {
    let pack = validate(v)?;
    let dir = root.join(&pack.name);
    let upgraded = dir.is_dir();
    let bak = if upgraded {
        Some(backup_dir(root, &pack.name)?)
    } else {
        None
    };
    if let Err(e) = write_pack(&dir, &pack) {
        let _ = fs::remove_dir_all(&dir);
        if let Some(b) = &bak {
            let _ = fs::rename(b, &dir);
        }
        return Err(e);
    }
    if let Err(e) = upsert_registry(root, &pack) {
        // 文件已落盘但没登记 → 这个插件不会被加载；报清楚，别假装成功
        return Err(format!("插件已落盘，但登记 index.json 失败：{e}"));
    }
    Ok(InstallOutcome {
        installed: pack.name,
        upgraded,
    })
}

// ---------- 导出 ----------

fn collect_files(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) -> Result<(), String> {
    let rd = fs::read_dir(dir).map_err(|e| format!("读目录失败：{e}"))?;
    for e in rd {
        let e = e.map_err(|e| format!("读目录项失败：{e}"))?;
        let p = e.path();
        let rel = p
            .strip_prefix(root)
            .map_err(|_| "路径越界".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if p.is_dir() {
            collect_files(root, &p, out)?;
            continue;
        }
        if rel == "manifest.json" {
            continue; // 清单单独走 manifest 字段
        }
        if !valid_rel_path(&rel) {
            return Err(format!(
                "目录里有不能进包的文件名「{rel}」：只允许字母数字与 _ . / -"
            ));
        }
        if out.len() >= MAX_FILES {
            return Err(format!("文件数超过上限 {MAX_FILES}，无法导出"));
        }
        let meta = fs::metadata(&p).map_err(|e| format!("读文件信息失败：{e}"))?;
        if meta.len() as usize > MAX_FILE_BYTES {
            return Err(format!(
                "文件「{rel}」超过单文件上限 {}KB，无法导出",
                MAX_FILE_BYTES / 1024
            ));
        }
        let body = fs::read_to_string(&p)
            .map_err(|_| format!("文件「{rel}」不是文本，无法导出"))?;
        out.insert(rel, body);
    }
    Ok(())
}

/// 读目录拼 .gsp 包（manifest 取磁盘真值；缺失时用注册表 order + 目录名合成最小清单）
pub fn export(root: &Path, name: &str) -> Result<Value, String> {
    if !valid_name(name) {
        return Err(format!("非法插件名「{name}」"));
    }
    let dir = root.join(name);
    if !dir.is_dir() {
        return Err(format!("插件目录不存在：plugins/{name}/"));
    }
    let manifest = read_manifest(&dir).unwrap_or_else(|| {
        let order = load_registry(root)
            .get("plugins")
            .and_then(|p| p.as_array())
            .and_then(|a| {
                a.iter()
                    .find(|r| r.get("name").and_then(|x| x.as_str()) == Some(name))
                    .and_then(|r| r.get("order"))
                    .and_then(|x| x.as_i64())
            })
            .unwrap_or(DEF_ORDER);
        json!({ "name": name, "title": name, "order": order })
    });
    let mut files = BTreeMap::new();
    collect_files(&dir, &dir, &mut files)?;
    if files.is_empty() {
        return Err(format!("插件目录 plugins/{name}/ 里没有可导出的文件"));
    }
    Ok(json!({
        "format": FORMAT,
        "plugin": { "manifest": manifest, "files": files },
    }))
}

// ---------- 启停 / 删除 ----------

/// 改 index.json 该行的 enabled（缺行即报错，不静默插入）
pub fn toggle(root: &Path, name: &str, enabled: bool) -> Result<Value, String> {
    if !valid_name(name) {
        return Err(format!("非法插件名「{name}」"));
    }
    if !root.join(name).is_dir() {
        return Err(format!("插件目录不存在：plugins/{name}/"));
    }
    let mut reg = load_registry(root);
    let mut hit = false;
    {
        let arr = plugins_arr_mut(&mut reg);
        for row in arr.iter_mut() {
            if row.get("name").and_then(|x| x.as_str()) == Some(name) {
                if !row.is_object() {
                    *row = json!({ "name": name });
                }
                row["enabled"] = json!(enabled);
                hit = true;
            }
        }
    }
    if !hit {
        return Err(format!("插件 {name} 未登记在 index.json，无法切换"));
    }
    save_registry(root, &reg)?;
    Ok(json!({ "name": name, "enabled": enabled }))
}

/// 删除目录 + 摘登记（confirm 由前端做；这里再校验一次 name 白名单）
pub fn remove(root: &Path, name: &str) -> Result<Value, String> {
    if !valid_name(name) {
        return Err(format!("非法插件名「{name}」"));
    }
    let dir = root.join(name);
    if !dir.is_dir() {
        return Err(format!("插件目录不存在：plugins/{name}/"));
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("删除插件目录失败：{e}"))?;
    let mut reg = load_registry(root);
    plugins_arr_mut(&mut reg).retain(|row| row.get("name").and_then(|x| x.as_str()) != Some(name));
    save_registry(root, &reg)?;
    Ok(json!({ "removed": name }))
}

// ---------- 测试 ----------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 每次一个独立临时根目录（不引第三方依赖）
    fn tmp(tag: &str) -> PathBuf {
        let ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let d = std::env::temp_dir().join(format!("gs-plugstore-{}-{tag}-{ns}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn pack(name: &str, files: &[(&str, &str)], extra: Value) -> Value {
        let mut man = json!({ "name": name, "title": "测试插件", "order": 100 });
        if let Some(o) = extra.as_object() {
            for (k, v) in o {
                man[k] = v.clone();
            }
        }
        let mut fs_map = serde_json::Map::new();
        for (k, v) in files {
            fs_map.insert((*k).to_string(), json!(v));
        }
        json!({ "format": FORMAT, "plugin": { "manifest": man, "files": fs_map } })
    }

    fn hello(files: &[(&str, &str)]) -> Value {
        pack("hello", files, json!({ "version": "1.0.0", "author": "金秤" }))
    }

    #[test]
    fn test_name_whitelist() {
        assert!(valid_name("hello"));
        assert!(valid_name("gold-glance-2"));
        assert!(valid_name("a"));
        assert!(!valid_name(""));
        assert!(!valid_name("Hello"));
        assert!(!valid_name("-x"));
        assert!(!valid_name("_x"));
        assert!(!valid_name("a".repeat(33).as_str()));
        assert!(!valid_name("../evil"));
        assert!(!valid_name("a/b"));
    }

    #[test]
    fn test_rel_path_rejects_traversal_and_absolute() {
        assert!(valid_rel_path("index.js"));
        assert!(valid_rel_path("assets/img/logo.svg"));
        assert!(!valid_rel_path("../x.js"));
        assert!(!valid_rel_path("a/../../b.js"));
        assert!(!valid_rel_path("/etc/passwd"));
        assert!(!valid_rel_path("C:\\x.js"));
        assert!(!valid_rel_path("a//b.js"));
        assert!(!valid_rel_path(""));
    }

    #[test]
    fn test_validate_rejects_bad_name_format_path_and_manifest() {
        // format 不对
        let mut p = hello(&[("index.js", "window.Pages={}")]);
        p["format"] = json!("gsp2");
        assert!(validate(&p).unwrap_err().contains("不支持的插件包格式"));

        // name 非法
        let p = pack("../evil", &[("index.js", "x")], json!({}));
        assert!(validate(&p).unwrap_err().contains("非法插件名"));

        // 路径注入
        let p = hello(&[("../evil.js", "x"), ("index.js", "x")]);
        assert!(validate(&p).unwrap_err().contains("非法文件路径"));

        // 缺 title / order
        let mut p = hello(&[("index.js", "x")]);
        p["plugin"]["manifest"].as_object_mut().unwrap().remove("title");
        assert!(validate(&p).unwrap_err().contains("title"));
        let mut p = hello(&[("index.js", "x")]);
        p["plugin"]["manifest"].as_object_mut().unwrap().remove("order");
        assert!(validate(&p).unwrap_err().contains("order"));

        // 缺 index.js
        let p = hello(&[("README.md", "x")]);
        assert!(validate(&p).unwrap_err().contains("index.js"));

        // 文件过大 / 文件过多
        let big = "x".repeat(MAX_FILE_BYTES + 1);
        let p = hello(&[("index.js", big.as_str())]);
        assert!(validate(&p).unwrap_err().contains("超过单文件上限"));
        let many: Vec<(String, String)> = (0..(MAX_FILES + 1))
            .map(|i| (format!("f{i}.js"), "x".to_string()))
            .collect();
        let refs: Vec<(&str, &str)> = many.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let p = hello(&refs);
        assert!(validate(&p).unwrap_err().contains("超过上限"));
    }

    #[test]
    fn test_install_writes_dir_and_registry_preserving_comment() {
        let root = tmp("install");
        fs::write(
            root.join("index.json"),
            "{ \"comment\": \"插件静态注册表\", \"plugins\": [] }",
        )
        .unwrap();

        let out = install(&root, &hello(&[("index.js", "window.Pages.hello={}")])).unwrap();
        assert_eq!(out.installed, "hello");
        assert!(!out.upgraded);
        assert!(root.join("hello/index.js").is_file());
        assert!(root.join("hello/manifest.json").is_file());

        let reg = load_registry(&root);
        assert_eq!(reg["comment"], "插件静态注册表", "comment 必须保留");
        assert_eq!(reg["plugins"][0]["name"], "hello");
        assert_eq!(reg["plugins"][0]["order"], 100);

        // 清单落盘取 manifest 字段真值
        let man: Value =
            serde_json::from_str(&fs::read_to_string(root.join("hello/manifest.json")).unwrap())
                .unwrap();
        assert_eq!(man["title"], "测试插件");
        assert_eq!(man["version"], "1.0.0");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn test_install_export_roundtrip() {
        let a = tmp("rt-a");
        let b = tmp("rt-b");
        let files = [
            ("index.js", "window.Pages.hello = { render(v){ v.textContent='hi'; } };"),
            ("README.md", "# hello\n\n示例。"),
        ];
        fs::write(a.join("index.json"), "{\"comment\":\"c\",\"plugins\":[]}").unwrap();
        install(&a, &hello(&files)).unwrap();

        let gsp = export(&a, "hello").unwrap();
        assert_eq!(gsp["format"], FORMAT);
        assert_eq!(gsp["plugin"]["manifest"]["name"], "hello");
        assert_eq!(gsp["plugin"]["files"]["index.js"], files[0].1);
        assert_eq!(gsp["plugin"]["files"]["README.md"], files[1].1);

        install(&b, &gsp).unwrap();
        assert_eq!(
            fs::read_to_string(b.join("hello/index.js")).unwrap(),
            files[0].1
        );
        assert_eq!(
            fs::read_to_string(b.join("hello/README.md")).unwrap(),
            files[1].1
        );
        // 导出的包能通过同一套校验
        assert!(validate(&gsp).is_ok());

        fs::remove_dir_all(&a).ok();
        fs::remove_dir_all(&b).ok();
    }

    #[test]
    fn test_upgrade_backs_up_old_and_keeps_one_copy() {
        let root = tmp("upgrade");
        install(&root, &hello(&[("index.js", "v1")])).unwrap();
        let out = install(&root, &hello(&[("index.js", "v2")])).unwrap();
        assert!(out.upgraded);
        assert_eq!(fs::read_to_string(root.join("hello/index.js")).unwrap(), "v2");

        let baks: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("hello.bak-"))
            .collect();
        assert_eq!(baks.len(), 1, "只留最近一份备份，实际 {baks:?}");
        assert_eq!(
            fs::read_to_string(root.join(&baks[0]).join("index.js")).unwrap(),
            "v1",
            "备份里必须是升级前的旧版本"
        );

        // 再升一次仍只有一份备份
        install(&root, &hello(&[("index.js", "v3")])).unwrap();
        let n = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("hello.bak-"))
            .count();
        assert_eq!(n, 1);

        // 备份目录不是插件：不进管理清单
        let names: Vec<String> = manage(&root).items.into_iter().map(|i| i.name).collect();
        assert_eq!(names, vec!["hello".to_string()]);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn test_toggle_and_remove_touch_registry() {
        let root = tmp("toggle");
        fs::write(root.join("index.json"), "{\"comment\":\"c\",\"plugins\":[]}").unwrap();
        install(&root, &hello(&[("index.js", "x")])).unwrap();

        toggle(&root, "hello", false).unwrap();
        let reg = load_registry(&root);
        assert_eq!(reg["plugins"][0]["enabled"], json!(false));
        assert_eq!(manage(&root).items[0].enabled, false);

        toggle(&root, "hello", true).unwrap();
        assert_eq!(load_registry(&root)["plugins"][0]["enabled"], json!(true));
        assert!(manage(&root).items[0].enabled);

        // 未登记的名字不能切换
        fs::create_dir_all(root.join("ghost")).unwrap();
        assert!(toggle(&root, "ghost", false).unwrap_err().contains("未登记"));

        // 删除：目录没了、登记摘了
        remove(&root, "hello").unwrap();
        assert!(!root.join("hello").exists());
        assert_eq!(load_registry(&root)["plugins"].as_array().unwrap().len(), 0);
        assert!(remove(&root, "hello").unwrap_err().contains("不存在"));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn test_install_rejects_traversal_write_nothing() {
        let root = tmp("evil");
        let p = hello(&[("index.js", "x"), ("../pwn.js", "x")]);
        assert!(install(&root, &p).is_err());
        // 越界文件与目录都不该被创建
        assert!(!root.join("pwn.js").exists());
        assert!(!root.join("hello").exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn test_manage_reports_missing_dir_as_error() {
        let root = tmp("broken");
        fs::write(
            root.join("index.json"),
            "{\"plugins\":[{\"name\":\"gone\",\"order\":9}]}",
        )
        .unwrap();
        let v = manage(&root);
        assert_eq!(v.items.len(), 1);
        assert_eq!(v.items[0].has_error, Some(true));
        assert_eq!(v.registry["plugins"][0]["name"], "gone");
        fs::remove_dir_all(&root).ok();
    }
}
