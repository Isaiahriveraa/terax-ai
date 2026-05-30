pub mod rpc;
pub mod session;
pub mod ui_events;

use std::sync::{Arc, RwLock};
use session::NvimSession;
use tauri::ipc::Channel;
use ui_events::NvimEvent;

pub struct NvimState {
    pub session: RwLock<Option<Arc<NvimSession>>>,
}

impl Default for NvimState {
    fn default() -> Self {
        Self { session: RwLock::new(None) }
    }
}

#[tauri::command]
pub async fn nvim_open(
    state: tauri::State<'_, NvimState>,
    path: String,
    cols: u16,
    rows: u16,
    on_redraw: Channel<NvimEvent>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    // Get or create shared session
    let session = {
        let guard = state.session.read().map_err(|e| e.to_string())?;
        guard.clone()
    };
    let session = match session {
        Some(s) => s,
        None => {
            let s = session::NvimSession::spawn(cols, rows, on_redraw, on_exit)?;
            *state.session.write().map_err(|e| e.to_string())? = Some(s.clone());
            s
        }
    };

    // Open file as buffer
    let escaped_path = path.replace('\'', "'\\''");
    session.call(
        "nvim_command",
        vec![rmpv::Value::from(format!("edit '{}'", escaped_path))],
    )?;

    // Get buffer number for tab tracking
    let bufnr_value = session.call("nvim_get_current_buf", vec![])?;
    let bufnr = bufnr_value.as_u64().unwrap_or(0) as u32;
    Ok(bufnr)
}

#[tauri::command]
pub async fn nvim_switch_buffer(
    state: tauri::State<'_, NvimState>,
    bufnr: u32,
) -> Result<(), String> {
    let guard = state.session.read().map_err(|e| e.to_string())?;
    let session = guard.as_ref().ok_or_else(|| "no nvim session".to_string())?;
    session.call("nvim_command", vec![rmpv::Value::from(format!("buffer {}", bufnr))])?;
    Ok(())
}

#[tauri::command]
pub async fn nvim_input(
    state: tauri::State<'_, NvimState>,
    keys: String,
) -> Result<(), String> {
    let guard = state.session.read().map_err(|e| e.to_string())?;
    let session = guard.as_ref().ok_or_else(|| "no nvim session".to_string())?;
    session.input(&keys)
}

#[tauri::command]
pub async fn nvim_resize(
    state: tauri::State<'_, NvimState>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let guard = state.session.read().map_err(|e| e.to_string())?;
    let session = guard.as_ref().ok_or_else(|| "no nvim session".to_string())?;
    session.resize(cols, rows)
}

#[tauri::command]
pub async fn nvim_close(
    state: tauri::State<'_, NvimState>,
    bufnr: u32,
) -> Result<(), String> {
    let guard = state.session.read().map_err(|e| e.to_string())?;
    let session = guard.as_ref().ok_or_else(|| "no nvim session".to_string())?;
    session.call("nvim_command", vec![rmpv::Value::from(format!("bd! {}", bufnr))])?;
    Ok(())
}

#[tauri::command]
pub async fn nvim_shutdown(
    state: tauri::State<'_, NvimState>,
) -> Result<(), String> {
    let session = state.session.write().map_err(|e| e.to_string())?.take();
    if let Some(s) = session {
        s.close();
    }
    Ok(())
}

pub fn nvim_close_all(state: &tauri::State<NvimState>) -> Result<(), String> {
    let session = state.session.write().map_err(|e| e.to_string())?.take();
    if let Some(s) = session {
        s.close();
    }
    Ok(())
}
