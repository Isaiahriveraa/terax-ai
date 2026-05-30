/// msgpack-RPC encode/decode for Neovim's --embed protocol.
/// Neovim uses standard msgpack-RPC:
///   Request:     [0, msgid, method_name, [params]]
///   Response:    [1, msgid, error, result]
///   Notification: [2, method_name, [params]]

use std::io::Read;

/// Encode a msgpack-RPC request
pub fn encode_request(msgid: u32, method: &str, params: Vec<rmpv::Value>) -> Vec<u8> {
    let mut buf = Vec::new();
    let msg = rmpv::Value::Array(vec![
        rmpv::Value::from(0u64),
        rmpv::Value::from(msgid as u64),
        rmpv::Value::from(method),
        rmpv::Value::Array(params),
    ]);
    let _ = rmp_serde::encode::write(&mut buf, &msg);
    buf
}

/// Encode a msgpack-RPC notification (fire-and-forget)
pub fn encode_notification(method: &str, params: Vec<rmpv::Value>) -> Vec<u8> {
    let mut buf = Vec::new();
    let msg = rmpv::Value::Array(vec![
        rmpv::Value::from(2u64),
        rmpv::Value::from(method),
        rmpv::Value::Array(params),
    ]);
    let _ = rmp_serde::encode::write(&mut buf, &msg);
    buf
}

/// Decode a single msgpack-RPC message from a byte reader.
/// Returns (RpcMessage, bytes_consumed) on success.
pub fn decode_message<R: Read>(reader: &mut R) -> Result<RpcMessage, String> {
    let value: rmpv::Value = rmpv::decode::read_value(reader)
        .map_err(|e| format!("msgpack decode: {e}"))?;

    let arr = value.as_array().ok_or_else(|| "expected array".to_string())?;
    if arr.is_empty() {
        return Err("empty array".into());
    }

    let kind = arr[0].as_u64().ok_or_else(|| "first element must be integer".to_string())?;

    match kind {
        0 => {
            let msgid = arr.get(1).and_then(|v| v.as_u64()).unwrap_or(0);
            let method = arr.get(2).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let params = arr.get(3).cloned().unwrap_or(rmpv::Value::Nil);
            Ok(RpcMessage::Request {
                msgid: msgid as u32,
                method,
                params: params.as_array().cloned().unwrap_or_default(),
            })
        }
        1 => {
            let msgid = arr.get(1).and_then(|v| v.as_u64()).unwrap_or(0);
            let error = arr.get(2).cloned();
            let result = arr.get(3).cloned();
            Ok(RpcMessage::Response {
                msgid: msgid as u32,
                error,
                result,
            })
        }
        2 => {
            let method = arr.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let params = arr.get(2).cloned().unwrap_or(rmpv::Value::Nil);
            Ok(RpcMessage::Notification {
                method,
                params: params.as_array().cloned().unwrap_or_default(),
            })
        }
        _ => Err(format!("unknown msgpack-RPC message type: {kind}")),
    }
}

#[derive(Debug)]
pub enum RpcMessage {
    Request { msgid: u32, method: String, params: Vec<rmpv::Value> },
    Response { msgid: u32, error: Option<rmpv::Value>, result: Option<rmpv::Value> },
    Notification { method: String, params: Vec<rmpv::Value> },
}
