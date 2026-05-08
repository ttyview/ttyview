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
}

// === Storage helpers ===

fn plugins_dir() -> PathBuf {
    // ~/.config/ttyview/plugins/. Falls back to /tmp if HOME is unset
    // (containers, sandbox tests). Failure to write here = install fails
    // with a 500, which is the right behavior — better than silently
    // writing to /tmp where the user can't find it.
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join(".config/ttyview/plugins")
}

fn installed_index_path() -> PathBuf {
    plugins_dir().join("installed.json")
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
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct InstalledIndex {
    #[serde(default = "default_schema")]
    pub schema: u8,
    #[serde(default)]
    pub plugins: Vec<InstalledPlugin>,
}

fn default_schema() -> u8 { 1 }

async fn read_installed_index() -> InstalledIndex {
    let path = installed_index_path();
    match fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => InstalledIndex::default(),
    }
}

async fn write_installed_index(idx: &InstalledIndex) -> Result<(), String> {
    let dir = plugins_dir();
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("create_dir_all({}): {e}", dir.display()))?;
    let path = installed_index_path();
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

async fn get_registry() -> Result<Response, StatusCode> {
    let entry = CommunityPlugins::get("registry.json").ok_or(StatusCode::NOT_FOUND)?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(axum::body::Body::from(entry.data.into_owned()))
        .unwrap())
}

/// Serve a bundled plugin's JS source. The :id corresponds to the `id`
/// field in registry.json; we look up the matching `source` filename
/// instead of trusting the URL path so an attacker can't `../` out.
async fn get_registry_source(Path(id): Path<String>) -> Result<Response, StatusCode> {
    let registry = load_registry().await?;
    let entry = registry
        .plugins
        .iter()
        .find(|p| p.id == id)
        .ok_or(StatusCode::NOT_FOUND)?;
    let asset = CommunityPlugins::get(&entry.source).ok_or(StatusCode::NOT_FOUND)?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/javascript")
        .header(header::CACHE_CONTROL, "no-store")
        .body(axum::body::Body::from(asset.data.into_owned()))
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

async fn load_registry() -> Result<RegistryFile, StatusCode> {
    let entry = CommunityPlugins::get("registry.json").ok_or(StatusCode::NOT_FOUND)?;
    serde_json::from_slice(&entry.data).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

// === Installed handlers ===

async fn list_installed() -> Json<InstalledIndex> {
    Json(read_installed_index().await)
}

async fn get_installed_source(Path(id): Path<String>) -> Result<Response, StatusCode> {
    // Look up the entry to find its source filename — same anti-traversal
    // pattern as get_registry_source. The id must match an installed
    // entry; we never serve arbitrary files from plugins_dir().
    let idx = read_installed_index().await;
    let entry = idx.plugins.iter().find(|p| p.id == id).ok_or(StatusCode::NOT_FOUND)?;
    let path = plugins_dir().join(&entry.source);
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
    State(_app): State<Arc<AppState>>,
    Json(req): Json<InstallReq>,
) -> impl IntoResponse {
    match install_inner(&req.id).await {
        Ok(plugin) => (StatusCode::OK, Json(InstallResp { ok: true, plugin: Some(plugin), error: None })),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(InstallResp { ok: false, plugin: None, error: Some(e) })),
    }
}

async fn install_inner(id: &str) -> Result<InstalledPlugin, String> {
    let registry = load_registry().await.map_err(|s| format!("load registry: {s:?}"))?;
    let entry = registry
        .plugins
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("registry: no plugin with id {id}"))?;
    let asset = CommunityPlugins::get(&entry.source)
        .ok_or_else(|| format!("registry: source file {} not in bundle", entry.source))?;

    let dir = plugins_dir();
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("create_dir_all({}): {e}", dir.display()))?;
    // Always write under <id>.js — the registry source filename is just a
    // bundling detail, not part of the on-disk contract. Avoids name
    // collisions if two registry plugins shipped with the same source name.
    let installed_filename = format!("{id}.js");
    let path = dir.join(&installed_filename);
    fs::write(&path, asset.data.as_ref())
        .await
        .map_err(|e| format!("write {}: {e}", path.display()))?;

    let mut idx = read_installed_index().await;
    idx.schema = 1;
    idx.plugins.retain(|p| p.id != entry.id);  // dedupe — reinstall replaces
    let plugin = InstalledPlugin {
        id: entry.id.clone(),
        name: entry.name.clone(),
        description: entry.description.clone(),
        version: entry.version.clone(),
        kind: entry.kind.clone(),
        source: installed_filename,
        installed_at: now_ms(),
    };
    idx.plugins.push(plugin.clone());
    write_installed_index(&idx).await?;
    Ok(plugin)
}

#[derive(Debug, Serialize)]
struct UninstallResp {
    ok: bool,
    error: Option<String>,
}

async fn uninstall_plugin(Path(id): Path<String>) -> impl IntoResponse {
    match uninstall_inner(&id).await {
        Ok(()) => (StatusCode::OK, Json(UninstallResp { ok: true, error: None })),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(UninstallResp { ok: false, error: Some(e) })),
    }
}

async fn uninstall_inner(id: &str) -> Result<(), String> {
    let mut idx = read_installed_index().await;
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
    write_installed_index(&idx).await?;
    let dir = plugins_dir();
    for f in to_delete {
        let _ = fs::remove_file(dir.join(f)).await;  // best-effort
    }
    Ok(())
}
