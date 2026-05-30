use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use tauri::ipc::Channel;

use crate::modules::nvim::rpc;
use crate::modules::nvim::ui_events::{self, NvimEvent};

const STDERR_BUF: usize = 4 * 1024;

pub struct NvimSession {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    next_msgid: AtomicU32,
}

impl NvimSession {
    pub fn spawn(
        cols: u16,
        rows: u16,
        on_redraw: Channel<NvimEvent>,
        on_exit: Channel<i32>,
    ) -> Result<Arc<NvimSession>, String> {
        let mut cmd = Command::new("nvim");
        cmd.arg("--embed")
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        crate::modules::proc::hide_console(&mut cmd);

        let mut child = cmd.spawn().map_err(|e| format!("spawn nvim --embed: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "nvim stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "nvim stdout unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "nvim stderr unavailable".to_string())?;

        thread::Builder::new()
            .name("terax-nvim-stderr".into())
            .spawn(move || drain_stderr(stderr))
            .map_err(|e| format!("spawn nvim stderr thread: {e}"))?;

        let session = Arc::new(NvimSession {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            next_msgid: AtomicU32::new(1),
        });

        let reader_session = session.clone();
        thread::Builder::new()
            .name("terax-nvim-reader".into())
            .spawn(move || reader_thread(stdout, reader_session, on_redraw, on_exit))
            .map_err(|e| format!("spawn nvim reader thread: {e}"))?;

        session.call("nvim_get_api_info", vec![])?;
        session.call(
            "nvim_ui_attach",
            vec![
                rmpv::Value::from(cols as u64),
                rmpv::Value::from(rows as u64),
                rmpv::Value::Map(vec![
                    (rmpv::Value::from("rgb"), rmpv::Value::from(true)),
                    (rmpv::Value::from("ext_linegrid"), rmpv::Value::from(true)),
                ]),
            ],
        )?;
        session.call(
            "nvim_exec_lua",
            vec![rmpv::Value::from(clipboard_lua()), rmpv::Value::Array(vec![])],
        )?;
        session.call(
            "nvim_exec_lua",
            vec![rmpv::Value::from(dirty_lua()), rmpv::Value::Array(vec![])],
        )?;

        log::info!("nvim session spawned cols={cols} rows={rows}");
        Ok(session)
    }

    pub fn input(&self, keys: &str) -> Result<(), String> {
        self.call("nvim_input", vec![rmpv::Value::from(keys)])?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.call(
            "nvim_ui_try_resize",
            vec![rmpv::Value::from(cols as u64), rmpv::Value::from(rows as u64)],
        )?;
        Ok(())
    }

    pub fn call(&self, method: &str, params: Vec<rmpv::Value>) -> Result<rmpv::Value, String> {
        let msgid = self.next_msgid.fetch_add(1, Ordering::Relaxed);
        let bytes = rpc::encode_request(msgid, method, params);
        let result = {
            let mut stdin = self.stdin.lock().unwrap();
            stdin.write_all(&bytes).and_then(|_| stdin.flush())
        };
        result.map_err(|e| {
            log::debug!("nvim call {method} msgid={msgid} failed: {e}");
            e.to_string()
        })?;
        Ok(rmpv::Value::Nil)
    }

    pub fn close(&self) {
        if let Ok(mut stdin) = self.stdin.lock() {
            let msgid = self.next_msgid.fetch_add(1, Ordering::Relaxed);
            let bytes = rpc::encode_request(
                msgid,
                "nvim_command",
                vec![rmpv::Value::from("qa!")],
            );
            let _ = stdin.write_all(&bytes);
            let _ = stdin.flush();
        }

        if let Ok(mut child) = self.child.lock() {
            match child.try_wait() {
                Ok(Some(_)) => {}
                Ok(None) => {
                    if let Err(e) = child.kill() {
                        log::debug!("nvim close kill returned {e}");
                    }
                    let _ = child.wait();
                }
                Err(e) => log::debug!("nvim close try_wait failed: {e}"),
            }
        }
    }

    fn exit_code(&self) -> i32 {
        self.child
            .lock()
            .ok()
            .and_then(|mut child| child.try_wait().ok())
            .flatten()
            .and_then(|status| status.code())
            .unwrap_or(-1)
    }
}

impl Drop for NvimSession {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}

pub fn reader_thread(
    stdout: ChildStdout,
    session: Arc<NvimSession>,
    on_redraw: Channel<NvimEvent>,
    on_exit: Channel<i32>,
) {
    let mut reader = BufReader::new(stdout);
    loop {
        match rpc::decode_message(&mut reader) {
            Ok(rpc::RpcMessage::Notification { method, params }) => {
                handle_notification(method, params, &on_redraw);
            }
            Ok(rpc::RpcMessage::Response { msgid, error, result }) => {
                if let Some(error) = error.filter(|e| !e.is_nil()) {
                    log::debug!("nvim response msgid={msgid} error={error:?}");
                } else {
                    log::trace!("nvim response msgid={msgid} result={result:?}");
                }
            }
            Ok(rpc::RpcMessage::Request { msgid, method, params }) => {
                log::debug!("nvim request msgid={msgid} method={method} params={params:?}");
            }
            Err(e) => {
                log::debug!("nvim reader exiting: {e}");
                let code = session.exit_code();
                if let Err(send_err) = on_exit.send(code) {
                    log::debug!("nvim exit send failed: {send_err}");
                }
                break;
            }
        }
    }
}

fn handle_notification(method: String, params: Vec<rmpv::Value>, on_redraw: &Channel<NvimEvent>) {
    match method.as_str() {
        "redraw" => {
            for event in ui_events::parse_redraw(&params) {
                if let Err(e) = on_redraw.send(event) {
                    log::debug!("nvim redraw send failed: {e}");
                    break;
                }
            }
        }
        "clipboard_copy" => {
            if let Some(text) = params.first().and_then(|v| v.as_str()) {
                log::info!("nvim clipboard copy requested with {} byte(s)", text.len());
            } else {
                log::info!("nvim clipboard copy requested");
            }
        }
        "clipboard_paste" => {
            log::info!("nvim clipboard paste requested");
        }
        "buf_modified_set" => {
            log::debug!("nvim buf_modified_set notification: {params:?}");
            if let (Some(bufnr), Some(modified)) = (
                params.first().and_then(|v| v.as_u64()),
                params.get(1).and_then(|v| v.as_bool()),
            ) {
                if let Err(e) = on_redraw.send(NvimEvent::dirty_change {
                    bufnr: bufnr as u32,
                    modified,
                }) {
                    log::debug!("nvim dirty send failed: {e}");
                }
            }
        }
        _ => {
            log::debug!("nvim notification {method}: {params:?}");
        }
    }
}

fn drain_stderr(mut stderr: std::process::ChildStderr) {
    let mut buf = [0u8; STDERR_BUF];
    loop {
        match stderr.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let text = String::from_utf8_lossy(&buf[..n]);
                log::debug!("nvim stderr: {text}");
            }
            Err(e) => {
                log::debug!("nvim stderr drain ended: {e}");
                break;
            }
        }
    }
}

fn clipboard_lua() -> &'static str {
    r#"
vim.g.clipboard = {
  name = 'terax',
  copy = {
    ['+'] = function(lines, _)
      vim.rpcnotify(tonumber(vim.v.channel), 'clipboard_copy', table.concat(lines, '\n'))
    end,
    ['*'] = function(lines, _)
      vim.rpcnotify(tonumber(vim.v.channel), 'clipboard_copy', table.concat(lines, '\n'))
    end,
  },
  paste = {
    ['+'] = function()
      vim.rpcnotify(tonumber(vim.v.channel), 'clipboard_paste')
      return { '' }
    end,
    ['*'] = function()
      vim.rpcnotify(tonumber(vim.v.channel), 'clipboard_paste')
      return { '' }
    end,
  },
}
"#
}

fn dirty_lua() -> &'static str {
    r#"
vim.api.nvim_create_augroup('TeraxDirtyTracking', { clear = true })
vim.api.nvim_create_autocmd('BufModifiedSet', {
  group = 'TeraxDirtyTracking',
  callback = function(args)
    vim.rpcnotify(tonumber(vim.v.channel), 'buf_modified_set', args.buf, vim.bo[args.buf].modified)
  end,
})
"#
}
