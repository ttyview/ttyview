//! Plugin install/uninstall endpoints.
//!
//! Two stores:
//!   * **registry** — bundled at compile-time via rust-embed. Read-only,
//!     served from `community-plugins/`. v1 ships with two demo plugins.
//!   * **installed** — filesystem at `~/.config/ttyview/plugins/`. JS source
//!     files + an `installed.json` index. Survives daemon restarts; plugins
//!     are auto-loaded by the client at boot.
//!
//! The install flow copies a registry plugin's source file into the
//! installed directory. v2 will fetch from a remote (GitHub raw), but
//! v1 keeps everything offline + auditable so the platform shape can
//! stabilize before exposing remote-eval as an attack surface.
//!
//! Wire shape: GET /plugins/registry returns { schema, plugins: [...] };
//! each plugin entry has { id, name, description, version, author, kind,
//! source }. The `source` field is a filename inside the bundled dir
//! (registry side) or `<id>.js` (installed side).

use crate::api::AppState;
use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::{delete, get, post},
    Router,
};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs;

#[derive(RustEmbed)]
#[folder = "community-plugins/"]
struct CommunityPlugins;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/plugins/registry", get(get_registry))
        .route("/plugins/registry/:id/source", get(get_registry_source))
        .route("/plugins/installed", get(list_installed))
        .route("/plugins/installed/:id/source", get(get_installed_source))
        .route("/plugins/install", post(install_plugin))
        .route("/plugins/uninstall/:id", delete(uninstall_plugin))
        .route("/plugins/installed/:id/enabled", post(set_enabled))
}

// === Storage helpers ===

/// Resolve the per-instance plugins directory from AppState's config_dir.
/// Two daemons with different `--config-dir` values share zero state.
fn plugins_dir_for(config_dir: &std::path::Path) -> PathBuf {
    config_dir.join("plugins")
}

fn installed_index_path_for(config_dir: &std::path::Path) -> PathBuf {
    plugins_dir_for(config_dir).join("installed.json")
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InstalledPlugin {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub kind: String,
    /// Source filename inside `plugins_dir()`. Always `<id>.js` in v1.
    pub source: String,
    /// Unix epoch ms when this install succeeded.
    pub installed_at: u64,
    /// Plugin is loaded + active when true. When false, the source
    /// stays on disk and the entry stays in the index, but the boot
    /// loader skips eval'ing it. The user can flip this back without
    /// losing per-plugin storage state. Default true (preserves old
    /// behavior for installed.json files written before this field
    /// existed).
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}
fn default_enabled() -> bool { true }

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct InstalledIndex {
    #[serde(default = "default_schema")]
    pub schema: u8,
    #[serde(default)]
    pub plugins: Vec<InstalledPlugin>,
}

fn default_schema() -> u8 { 1 }

async fn read_installed_index(config_dir: &std::path::Path) -> InstalledIndex {
    let path = installed_index_path_for(config_dir);
    match fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => InstalledIndex::default(),
    }
}

async fn write_installed_index(config_dir: &std::path::Path, idx: &InstalledIndex) -> Result<(), String> {
    let dir = plugins_dir_for(config_dir);
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("create_dir_all({}): {e}", dir.display()))?;
    let path = installed_index_path_for(config_dir);
    let json = serde_json::to_vec_pretty(idx)
        .map_err(|e| format!("serialize index: {e}"))?;
    fs::write(&path, json)
        .await
        .map_err(|e| format!("write {}: {e}", path.display()))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// === Registry handlers ===

async fn get_registry(State(app): State<Arc<AppState>>) -> Result<Response, StatusCode> {
    // If a remote registry URL is configured, try it first; fall back to
    // the bundle on any error (network failure, non-200, parse error).
    // The fallback is deliberate — a misconfigured URL shouldn't break
    // the Discover tab entirely.
    if let Some(url) = &app.registry_url {
        match fetch_remote_json(url).await {
            Ok(bytes) => {
                return Ok(Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::CACHE_CONTROL, "no-store")
                    .header("x-ttyview-registry-source", "remote")
                    .body(axum::body::Body::from(bytes))
                    .unwrap());
            }
            Err(e) => {
                tracing::warn!(target: "ttyview::plugins",
                    "remote registry fetch failed ({url}); falling back to bundled: {e}");
            }
        }
    }
    let entry = CommunityPlugins::get("registry.json").ok_or(StatusCode::NOT_FOUND)?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-ttyview-registry-source", "bundled")
        .body(axum::body::Body::from(entry.data.into_owned()))
        .unwrap())
}

async fn fetch_remote_json(url: &str) -> Result<Vec<u8>, String> {
    let resp = reqwest::Client::builder()
        .user_agent("ttyview-daemon")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("build client: {e}"))?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("send {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} from {url}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;
    // Cheap validity check — registry must parse as the expected shape
    // before we hand it to the client. Otherwise fall back to bundle.
    serde_json::from_slice::<RegistryFile>(&bytes)
        .map_err(|e| format!("registry parse failed: {e}"))?;
    Ok(bytes.to_vec())
}

async fn fetch_remote_text(url: &str) -> Result<Vec<u8>, String> {
    let resp = reqwest::Client::builder()
        .user_agent("ttyview-daemon")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("build client: {e}"))?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("send {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} from {url}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;
    Ok(bytes.to_vec())
}

/// Serve a bundled OR remote plugin's JS source. The :id corresponds
/// to the `id` field in the active registry (remote if configured,
/// bundle otherwise). For each entry, the `source` field is either:
///   - a relative filename → served from the bundled community-plugins
///     directory (anti-traversal: looked up via the registry, never
///     directly from the URL path)
///   - an absolute http(s) URL → fetched and proxied through the daemon
///     so the client doesn't need to deal with CORS / cross-origin TLS
async fn get_registry_source(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, StatusCode> {
    let registry = load_registry(app.clone()).await?;
    let entry = registry
        .plugins
        .iter()
        .find(|p| p.id == id)
        .ok_or(StatusCode::NOT_FOUND)?;
    let body = if entry.source.starts_with("http://") || entry.source.starts_with("https://") {
        match fetch_remote_text(&entry.source).await {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(target: "ttyview::plugins",
                    "remote source fetch failed ({}): {e}", entry.source);
                return Err(StatusCode::BAD_GATEWAY);
            }
        }
    } else {
        let asset = CommunityPlugins::get(&entry.source).ok_or(StatusCode::NOT_FOUND)?;
        asset.data.into_owned()
    };
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/javascript")
        .header(header::CACHE_CONTROL, "no-store")
        .body(axum::body::Body::from(body))
        .unwrap())
}

#[derive(Debug, Deserialize)]
struct RegistryEntry {
    id: String,
    name: String,
    description: String,
    version: String,
    #[allow(dead_code)]
    author: String,
    kind: String,
    source: String,
}

#[derive(Debug, Deserialize)]
struct RegistryFile {
    #[allow(dead_code)]
    schema: u8,
    plugins: Vec<RegistryEntry>,
}

async fn load_registry(app: Arc<AppState>) -> Result<RegistryFile, StatusCode> {
    if let Some(url) = &app.registry_url {
        if let Ok(bytes) = fetch_remote_json(url).await {
            if let Ok(reg) = serde_json::from_slice::<RegistryFile>(&bytes) {
                return Ok(reg);
            }
        }
        // fall through to bundled
    }
    let entry = CommunityPlugins::get("registry.json").ok_or(StatusCode::NOT_FOUND)?;
    serde_json::from_slice(&entry.data).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

// === Installed handlers ===

async fn list_installed(State(app): State<Arc<AppState>>) -> Json<InstalledIndex> {
    Json(read_installed_index(&app.config_dir).await)
}

async fn get_installed_source(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, StatusCode> {
    // Look up the entry to find its source filename — same anti-traversal
    // pattern as get_registry_source. The id must match an installed
    // entry; we never serve arbitrary files from plugins_dir().
    let idx = read_installed_index(&app.config_dir).await;
    let entry = idx.plugins.iter().find(|p| p.id == id).ok_or(StatusCode::NOT_FOUND)?;
    let path = plugins_dir_for(&app.config_dir).join(&entry.source);
    let bytes = fs::read(&path).await.map_err(|_| StatusCode::NOT_FOUND)?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/javascript")
        .header(header::CACHE_CONTROL, "no-store")
        .body(axum::body::Body::from(bytes))
        .unwrap())
}

#[derive(Debug, Deserialize)]
struct InstallReq {
    /// Registry plugin id to install.
    id: String,
}

#[derive(Debug, Serialize)]
struct InstallResp {
    ok: bool,
    plugin: Option<InstalledPlugin>,
    error: Option<String>,
}

async fn install_plugin(
    State(app): State<Arc<AppState>>,
    Json(req): Json<InstallReq>,
) -> impl IntoResponse {
    if app.read_only {
        return (
            StatusCode::FORBIDDEN,
            Json(InstallResp { ok: false, plugin: None, error: Some("read-only mode: install disabled".into()) }),
        );
    }
    match install_inner(app, &req.id).await {
        Ok(plugin) => (StatusCode::OK, Json(InstallResp { ok: true, plugin: Some(plugin), error: None })),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(InstallResp { ok: false, plugin: None, error: Some(e) })),
    }
}

/// Auto-install a curated set of plugins for `--demo` mode so visitors
/// land on a presentable page without any clicks. Best-effort: any
/// failure logs + falls through (the page still works, just less rich).
pub async fn demo_install_curated(config_dir: &std::path::Path) -> Result<(), String> {
    for id in ["ttyview-cc", "ttyview-terminal-green"] {
        match install_from_bundle(config_dir, id).await {
            Ok(_) => tracing::info!(target: "ttyview::demo", "auto-installed: {id}"),
            Err(e) => tracing::warn!(target: "ttyview::demo", "auto-install {id}: {e}"),
        }
    }
    Ok(())
}

/// Bundle-only install path — used by demo_install_curated() to avoid
/// the AppState requirement of install_inner. Identical write behavior;
/// no remote-source fallback (demo runs offline by construction).
async fn install_from_bundle(config_dir: &std::path::Path, id: &str) -> Result<InstalledPlugin, String> {
    let registry_bytes = CommunityPlugins::get("registry.json")
        .ok_or_else(|| "no bundled registry.json".to_string())?;
    let registry: RegistryFile = serde_json::from_slice(&registry_bytes.data)
        .map_err(|e| format!("parse bundled registry: {e}"))?;
    let entry = registry
        .plugins
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("not in registry: {id}"))?;
    let asset = CommunityPlugins::get(&entry.source)
        .ok_or_else(|| format!("source {} not in bundle", entry.source))?;
    let dir = plugins_dir_for(config_dir);
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("create_dir_all: {e}"))?;
    let installed_filename = format!("{id}.js");
    let path = dir.join(&installed_filename);
    fs::write(&path, asset.data.as_ref())
        .await
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    let mut idx = read_installed_index(config_dir).await;
    idx.schema = 1;
    // Preserve enabled state across reinstall — user might have
    // disabled a plugin and is just refreshing the source.
    let prev_enabled = idx.plugins.iter().find(|p| p.id == entry.id).map(|p| p.enabled);
    idx.plugins.retain(|p| p.id != entry.id);
    let plugin = InstalledPlugin {
        id: entry.id.clone(),
        name: entry.name.clone(),
        description: entry.description.clone(),
        version: entry.version.clone(),
        kind: entry.kind.clone(),
        source: installed_filename,
        installed_at: now_ms(),
        enabled: prev_enabled.unwrap_or(true),
    };
    idx.plugins.push(plugin.clone());
    write_installed_index(config_dir, &idx).await?;
    Ok(plugin)
}

async fn install_inner(app: Arc<AppState>, id: &str) -> Result<InstalledPlugin, String> {
    let config_dir = app.config_dir.clone();
    let registry = load_registry(app).await.map_err(|s| format!("load registry: {s:?}"))?;
    let entry = registry
        .plugins
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("registry: no plugin with id {id}"))?;
    // Resolve the source — either fetch a remote URL or read from the
    // bundled assets. Either path produces a Vec<u8> we then write.
    let bytes: Vec<u8> = if entry.source.starts_with("http://") || entry.source.starts_with("https://") {
        fetch_remote_text(&entry.source).await
            .map_err(|e| format!("fetch remote source {}: {e}", entry.source))?
    } else {
        CommunityPlugins::get(&entry.source)
            .ok_or_else(|| format!("registry: source file {} not in bundle", entry.source))?
            .data
            .into_owned()
    };

    let dir = plugins_dir_for(&config_dir);
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("create_dir_all({}): {e}", dir.display()))?;
    // Always write under <id>.js — the registry source filename is just a
    // bundling detail, not part of the on-disk contract. Avoids name
    // collisions if two registry plugins shipped with the same source name.
    let installed_filename = format!("{id}.js");
    let path = dir.join(&installed_filename);
    fs::write(&path, &bytes)
        .await
        .map_err(|e| format!("write {}: {e}", path.display()))?;

    let mut idx = read_installed_index(&config_dir).await;
    idx.schema = 1;
    // Preserve enabled state on reinstall (Reinstall button is for
    // refreshing the source, not toggling enable).
    let prev_enabled = idx.plugins.iter().find(|p| p.id == entry.id).map(|p| p.enabled);
    idx.plugins.retain(|p| p.id != entry.id);
    let plugin = InstalledPlugin {
        id: entry.id.clone(),
        name: entry.name.clone(),
        description: entry.description.clone(),
        version: entry.version.clone(),
        kind: entry.kind.clone(),
        source: installed_filename,
        installed_at: now_ms(),
        enabled: prev_enabled.unwrap_or(true),
    };
    idx.plugins.push(plugin.clone());
    write_installed_index(&config_dir, &idx).await?;
    Ok(plugin)
}

#[derive(Debug, Serialize)]
struct UninstallResp {
    ok: bool,
    error: Option<String>,
}

async fn uninstall_plugin(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if app.read_only {
        return (
            StatusCode::FORBIDDEN,
            Json(UninstallResp { ok: false, error: Some("read-only mode: uninstall disabled".into()) }),
        );
    }
    match uninstall_inner(&app.config_dir, &id).await {
        Ok(()) => (StatusCode::OK, Json(UninstallResp { ok: true, error: None })),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(UninstallResp { ok: false, error: Some(e) })),
    }
}

// === Enable / disable ===
//
// Disable: keeps the source on disk and the index entry intact, just
// flips `enabled: false` so the boot loader skips evaluating it. The
// client also tears down live contributions for an instant effect.
// Enable: flips back to true; client re-fetches + re-evals the source.
// Per-plugin storage (window.ttyview.storage('<id>')) is not touched
// in either direction — the win over uninstall is exactly that.

#[derive(Debug, Deserialize)]
struct SetEnabledReq { enabled: bool }

#[derive(Debug, Serialize)]
struct SetEnabledResp {
    ok: bool,
    enabled: Option<bool>,
    error: Option<String>,
}

async fn set_enabled(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<SetEnabledReq>,
) -> impl IntoResponse {
    if app.read_only {
        return (
            StatusCode::FORBIDDEN,
            Json(SetEnabledResp { ok: false, enabled: None, error: Some("read-only mode: enable/disable disabled".into()) }),
        );
    }
    let mut idx = read_installed_index(&app.config_dir).await;
    let mut found = false;
    for p in idx.plugins.iter_mut() {
        if p.id == id { p.enabled = req.enabled; found = true; break; }
    }
    if !found {
        return (
            StatusCode::NOT_FOUND,
            Json(SetEnabledResp { ok: false, enabled: None, error: Some(format!("not installed: {id}")) }),
        );
    }
    if let Err(e) = write_installed_index(&app.config_dir, &idx).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(SetEnabledResp { ok: false, enabled: None, error: Some(e) }),
        );
    }
    (StatusCode::OK, Json(SetEnabledResp { ok: true, enabled: Some(req.enabled), error: None }))
}

async fn uninstall_inner(config_dir: &std::path::Path, id: &str) -> Result<(), String> {
    let mut idx = read_installed_index(config_dir).await;
    let before = idx.plugins.len();
    let mut to_delete: Vec<String> = Vec::new();
    idx.plugins.retain(|p| {
        if p.id == id {
            to_delete.push(p.source.clone());
            false
        } else {
            true
        }
    });
    if idx.plugins.len() == before {
        return Err(format!("not installed: {id}"));
    }
    write_installed_index(config_dir, &idx).await?;
    let dir = plugins_dir_for(config_dir);
    for f in to_delete {
        let _ = fs::remove_file(dir.join(f)).await;  // best-effort
    }
    Ok(())
}
