use serde::{Deserialize, Serialize};
use tauri::Manager;
use std::sync::Mutex;
use chrono::Utc;
use base64::Engine;

// ==================== 数据结构 ====================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HistoryRecord {
    pub id: i64,
    pub method: String,
    pub url: String,
    pub request_data: String,
    pub response_data: Option<String>,
    pub timestamp: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CollectionRequest {
    pub id: String,
    pub name: String,
    pub method: String,
    pub url: String,
    pub request_data: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CollectionFolder {
    pub id: String,
    pub name: String,
    pub children: Vec<CollectionRequest>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RequestData {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub body_base64: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ResponseData {
    pub status: u16,
    pub status_text: String,
    pub headers: std::collections::HashMap<String, String>,
    pub body: String,
    pub body_base64: Option<String>,
    pub duration: u64,
    pub size: usize,
}

// ==================== 应用状态 ====================

pub struct AppState {
    data_dir: Mutex<String>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            data_dir: Mutex::new(String::new()),
        }
    }
}

// ==================== HTTP 请求 ====================

#[tauri::command]
async fn send_http_request(request: RequestData) -> Result<ResponseData, String> {
    let client = reqwest::Client::new();
    let start_time = std::time::Instant::now();
    
    let mut req_builder = match request.method.as_str() {
        "GET" => client.get(&request.url),
        "POST" => client.post(&request.url),
        "PUT" => client.put(&request.url),
        "DELETE" => client.delete(&request.url),
        "PATCH" => client.patch(&request.url),
        "HEAD" => client.head(&request.url),
        "OPTIONS" => client.request(reqwest::Method::OPTIONS, &request.url),
        _ => client.get(&request.url),
    };
    
    // 添加请求头
    for (key, value) in request.headers {
        req_builder = req_builder.header(&key, &value);
    }
    
    // 添加请求体
    if let Some(body_base64) = request.body_base64 {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(body_base64)
            .map_err(|e| format!("Invalid base64 request body: {}", e))?;
        req_builder = req_builder.body(bytes);
    } else if let Some(body) = request.body {
        req_builder = req_builder.body(body);
    }
    
    let response = req_builder.send().await.map_err(|e| e.to_string())?;
    let duration = start_time.elapsed().as_millis() as u64;
    
    let status = response.status();
    let status_code = status.as_u16();
    let status_text = status.canonical_reason().unwrap_or("Unknown").to_string();
    
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    // 收集响应头
    let mut headers = std::collections::HashMap::new();
    for (key, value) in response.headers() {
        if let Ok(val) = value.to_str() {
            headers.insert(key.to_string(), val.to_string());
        }
    }
    
    // 获取响应体
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let size = bytes.len();

    let body_base64 = if bytes.is_empty() {
        None
    } else {
        Some(base64::engine::general_purpose::STANDARD.encode(&bytes))
    };

    let is_text_like = content_type.starts_with("text/")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.contains("html")
        || content_type.contains("javascript")
        || content_type.contains("ecmascript")
        || content_type.contains("x-www-form-urlencoded");

    let body = if is_text_like {
        String::from_utf8(bytes.to_vec()).unwrap_or_else(|_| String::from_utf8_lossy(&bytes).to_string())
    } else {
        String::from_utf8(bytes.to_vec()).unwrap_or_default()
    };
    
    Ok(ResponseData {
        status: status_code,
        status_text,
        headers,
        body,
        body_base64,
        duration,
        size,
    })
}

// ==================== 历史记录 ====================

#[tauri::command]
async fn save_history(
    state: tauri::State<'_, AppState>,
    method: String,
    url: String,
    request_data: String,
    response_data: String,
) -> Result<i64, String> {
    let data_dir = state.data_dir.lock().map_err(|e| e.to_string())?;
    
    if data_dir.is_empty() {
        return Err("Data directory not initialized".to_string());
    }
    
    let history_file = std::path::Path::new(&*data_dir).join("history.json");
    
    let mut records: Vec<serde_json::Value> = if history_file.exists() {
        let content = std::fs::read_to_string(&history_file).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).unwrap_or_else(|_| Vec::new())
    } else {
        Vec::new()
    };
    
    let id = records
        .iter()
        .filter_map(|record| record["id"].as_i64())
        .max()
        .unwrap_or(0)
        + 1;
    let timestamp = Utc::now().to_rfc3339();
    
    let record = serde_json::json!({
        "id": id,
        "method": method,
        "url": url,
        "request_data": request_data,
        "response_data": response_data,
        "timestamp": timestamp
    });
    
    records.insert(0, record);
    
    // 只保留最近 100 条
    if records.len() > 100 {
        records.truncate(100);
    }
    
    let content = serde_json::to_string_pretty(&records).map_err(|e| e.to_string())?;
    std::fs::write(&history_file, content).map_err(|e| e.to_string())?;
    
    Ok(id)
}

#[tauri::command]
async fn get_history(state: tauri::State<'_, AppState>) -> Result<Vec<HistoryRecord>, String> {
    let data_dir = state.data_dir.lock().map_err(|e| e.to_string())?;
    
    if data_dir.is_empty() {
        return Ok(Vec::new());
    }
    
    let history_file = std::path::Path::new(&*data_dir).join("history.json");
    
    if !history_file.exists() {
        return Ok(Vec::new());
    }
    
    let content = std::fs::read_to_string(&history_file).map_err(|e| e.to_string())?;
    let records: Vec<serde_json::Value> = serde_json::from_str(&content).unwrap_or_else(|_| Vec::new());
    
    let mut history = Vec::new();
    for record in records {
        history.push(HistoryRecord {
            id: record["id"].as_i64().unwrap_or(0),
            method: record["method"].as_str().unwrap_or("").to_string(),
            url: record["url"].as_str().unwrap_or("").to_string(),
            request_data: record["request_data"].as_str().unwrap_or("").to_string(),
            response_data: record["response_data"].as_str().map(|s| s.to_string()),
            timestamp: record["timestamp"].as_str().unwrap_or("").to_string(),
        });
    }
    
    Ok(history)
}

#[tauri::command]
async fn clear_history(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let data_dir = state.data_dir.lock().map_err(|e| e.to_string())?;
    
    if data_dir.is_empty() {
        return Ok(());
    }
    
    let history_file = std::path::Path::new(&*data_dir).join("history.json");
    
    if history_file.exists() {
        std::fs::remove_file(&history_file).map_err(|e| e.to_string())?;
    }
    
    Ok(())
}

// ==================== Collections ====================

#[tauri::command]
async fn get_collections(state: tauri::State<'_, AppState>) -> Result<Vec<CollectionFolder>, String> {
    let data_dir = state.data_dir.lock().map_err(|e| e.to_string())?;
    
    if data_dir.is_empty() {
        return Ok(Vec::new());
    }
    
    let collections_file = std::path::Path::new(&*data_dir).join("collections.json");
    
    if !collections_file.exists() {
        // 返回默认数据
        return Ok(vec![
            CollectionFolder {
                id: "1".to_string(),
                name: "chat".to_string(),
                children: vec![
                    CollectionRequest {
                        id: "1-1".to_string(),
                        name: "获取消息列表".to_string(),
                        method: "GET".to_string(),
                        url: "/api/chat/messages".to_string(),
                        request_data: "{}".to_string(),
                    },
                    CollectionRequest {
                        id: "1-2".to_string(),
                        name: "发送消息".to_string(),
                        method: "POST".to_string(),
                        url: "/api/chat/send".to_string(),
                        request_data: "{}".to_string(),
                    },
                ],
            },
            CollectionFolder {
                id: "2".to_string(),
                name: "common".to_string(),
                children: vec![
                    CollectionRequest {
                        id: "2-1".to_string(),
                        name: "获取配置".to_string(),
                        method: "GET".to_string(),
                        url: "/api/config".to_string(),
                        request_data: "{}".to_string(),
                    },
                ],
            },
        ]);
    }
    
    let content = std::fs::read_to_string(&collections_file).map_err(|e| e.to_string())?;
    let folders: Vec<CollectionFolder> = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    
    Ok(folders)
}

#[tauri::command]
async fn save_collection(
    state: tauri::State<'_, AppState>,
    folder_id: String,
    request: CollectionRequest,
) -> Result<(), String> {
    let data_dir = state.data_dir.lock().map_err(|e| e.to_string())?;
    
    if data_dir.is_empty() {
        return Err("Data directory not initialized".to_string());
    }
    
    let collections_file = std::path::Path::new(&*data_dir).join("collections.json");
    
    let mut folders: Vec<CollectionFolder> = if collections_file.exists() {
        let content = std::fs::read_to_string(&collections_file).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).unwrap_or_else(|_| Vec::new())
    } else {
        Vec::new()
    };
    
    // 查找或创建文件夹
    let folder = folders.iter_mut().find(|f| f.id == folder_id);
    if let Some(folder) = folder {
        // 检查是否已存在
        if let Some(existing) = folder.children.iter_mut().find(|r| r.id == request.id) {
            *existing = request;
        } else {
            folder.children.push(request);
        }
    } else {
        // 创建新文件夹
        folders.push(CollectionFolder {
            id: folder_id,
            name: "New Folder".to_string(),
            children: vec![request],
        });
    }
    
    let content = serde_json::to_string_pretty(&folders).map_err(|e| e.to_string())?;
    std::fs::write(&collections_file, content).map_err(|e| e.to_string())?;
    
    Ok(())
}

// ==================== 应用入口 ====================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .manage(AppState::new())
        .setup(|app| {
            let app_handle = app.handle().clone();
            
            // 初始化数据目录
            if let Ok(app_dir) = app_handle.path().app_data_dir() {
                std::fs::create_dir_all(&app_dir).ok();
                
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Ok(mut data_dir) = state.data_dir.lock() {
                        *data_dir = app_dir.to_string_lossy().to_string();
                    }
                }
                
                log::info!("App data directory: {:?}", app_dir);
            }
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            send_http_request,
            save_history,
            get_history,
            clear_history,
            get_collections,
            save_collection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
