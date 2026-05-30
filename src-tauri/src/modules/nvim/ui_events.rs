#[allow(non_camel_case_types)]
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type")]
pub enum NvimEvent {
    grid_resize {
        grid: u32,
        width: u64,
        height: u64,
    },
    grid_line {
        grid: u32,
        row: u64,
        col_start: u64,
        cells: Vec<CellData>,
    },
    grid_clear {
        grid: u32,
    },
    grid_cursor_goto {
        grid: u32,
        row: u64,
        col: u64,
    },
    grid_scroll {
        grid: u32,
        top: u64,
        bottom: u64,
        left: u64,
        right: u64,
        rows: i64,
    },
    flush,
    mode_change {
        mode: String,
    },
    default_colors_set {
        fg: u32,
        bg: u32,
    },
    set_title {
        title: String,
    },
    option_set {
        name: String,
        value: rmpv::Value,
    },
    dirty_change {
        bufnr: u32,
        modified: bool,
    },
}

#[derive(Clone, serde::Serialize)]
pub struct CellData {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hl_id: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repeat: Option<u16>,
}

pub fn parse_redraw(params: &[rmpv::Value]) -> Vec<NvimEvent> {
    let mut events = Vec::new();

    for update_group in params {
        let Some(arr) = update_group.as_array() else {
            continue;
        };
        if arr.is_empty() {
            continue;
        }

        let Some(event_name) = arr[0].as_str() else {
            continue;
        };

        for args in &arr[1..] {
            match event_name {
                "grid_resize" => {
                    if let Some(a) = args.as_array() {
                        if a.len() >= 3 {
                            events.push(NvimEvent::grid_resize {
                                grid: a[0].as_u64().unwrap_or(0) as u32,
                                width: a[1].as_u64().unwrap_or(0),
                                height: a[2].as_u64().unwrap_or(0),
                            });
                        }
                    }
                }
                "grid_line" => {
                    if let Some(a) = args.as_array() {
                        if a.len() >= 4 {
                            events.push(NvimEvent::grid_line {
                                grid: a[0].as_u64().unwrap_or(0) as u32,
                                row: a[1].as_u64().unwrap_or(0),
                                col_start: a[2].as_u64().unwrap_or(0),
                                cells: parse_cells(&a[3]),
                            });
                        }
                    }
                }
                "grid_clear" => {
                    if let Some(a) = args.as_array() {
                        if !a.is_empty() {
                            events.push(NvimEvent::grid_clear {
                                grid: a[0].as_u64().unwrap_or(0) as u32,
                            });
                        }
                    }
                }
                "grid_cursor_goto" => {
                    if let Some(a) = args.as_array() {
                        if a.len() >= 3 {
                            events.push(NvimEvent::grid_cursor_goto {
                                grid: a[0].as_u64().unwrap_or(0) as u32,
                                row: a[1].as_u64().unwrap_or(0),
                                col: a[2].as_u64().unwrap_or(0),
                            });
                        }
                    }
                }
                "grid_scroll" => {
                    if let Some(a) = args.as_array() {
                        if a.len() >= 6 {
                            events.push(NvimEvent::grid_scroll {
                                grid: a[0].as_u64().unwrap_or(0) as u32,
                                top: a[1].as_u64().unwrap_or(0),
                                bottom: a[2].as_u64().unwrap_or(0),
                                left: a[3].as_u64().unwrap_or(0),
                                right: a[4].as_u64().unwrap_or(0),
                                rows: a[5].as_i64().unwrap_or(0),
                            });
                        }
                    }
                }
                "flush" => {
                    events.push(NvimEvent::flush);
                }
                "mode_change" => {
                    if let Some(a) = args.as_array() {
                        if !a.is_empty() {
                            events.push(NvimEvent::mode_change {
                                mode: a[0].as_str().unwrap_or("").to_string(),
                            });
                        }
                    }
                }
                "default_colors_set" => {
                    if let Some(a) = args.as_array() {
                        if a.len() >= 2 {
                            events.push(NvimEvent::default_colors_set {
                                fg: a[0].as_u64().unwrap_or(0) as u32,
                                bg: a[1].as_u64().unwrap_or(0) as u32,
                            });
                        }
                    }
                }
                "set_title" => {
                    if let Some(a) = args.as_array() {
                        if !a.is_empty() {
                            events.push(NvimEvent::set_title {
                                title: a[0].as_str().unwrap_or("").to_string(),
                            });
                        }
                    }
                }
                "option_set" => {
                    if let Some(a) = args.as_array() {
                        if a.len() >= 2 {
                            events.push(NvimEvent::option_set {
                                name: a[0].as_str().unwrap_or("").to_string(),
                                value: a[1].clone(),
                            });
                        }
                    }
                }
                _ => {
                    log::debug!("unhandled redraw event: {event_name}");
                }
            }
        }
    }

    events
}

fn parse_cells(value: &rmpv::Value) -> Vec<CellData> {
    let mut cells = Vec::new();
    let Some(arr) = value.as_array() else {
        return cells;
    };

    for cell in arr {
        let Some(cell_arr) = cell.as_array() else {
            continue;
        };
        if cell_arr.is_empty() {
            continue;
        }

        cells.push(CellData {
            text: cell_arr[0].as_str().unwrap_or("").to_string(),
            hl_id: cell_arr.get(1).and_then(|v| v.as_u64()).map(|v| v as u16),
            repeat: cell_arr.get(2).and_then(|v| v.as_u64()).map(|v| v as u16),
        });
    }

    cells
}
