use serde::{Deserialize, Serialize};
use tauri::Manager;
use std::sync::Mutex;
use std::collections::{HashMap, HashSet};
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
    #[serde(default)]
    pub parent_id: Option<String>,
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

fn parse_postman_description(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Object(map)) => map
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    }
}

fn split_raw_url(raw: &str) -> (String, String) {
    if let Some(index) = raw.find('?') {
        let base = raw[..index].to_string();
        let query = raw[index + 1..].to_string();
        return (base, query);
    }
    (raw.to_string(), String::new())
}

fn parse_query_string_to_params(query: &str) -> Vec<serde_json::Value> {
    let mut params = Vec::new();
    for segment in query.split('&') {
        let part = segment.trim();
        if part.is_empty() {
            continue;
        }
        let mut pieces = part.splitn(2, '=');
        let key = pieces.next().unwrap_or("").trim();
        let value = pieces.next().unwrap_or("").trim();
        if key.is_empty() {
            continue;
        }
        params.push(serde_json::json!({
            "key": key,
            "value": value,
            "description": "",
            "enabled": true
        }));
    }
    params
}

fn parse_postman_headers(header_value: Option<&serde_json::Value>) -> Vec<serde_json::Value> {
    let mut headers = Vec::new();
    let Some(serde_json::Value::Array(entries)) = header_value else {
        return headers;
    };

    for entry in entries {
        let key = entry.get("key").and_then(|v| v.as_str()).unwrap_or("").trim();
        if key.is_empty() {
            continue;
        }
        let value = entry.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let disabled = entry.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false);
        headers.push(serde_json::json!({
            "key": key,
            "value": value,
            "description": parse_postman_description(entry.get("description")),
            "enabled": !disabled
        }));
    }

    headers
}

fn parse_postman_kv_entries(entries_value: Option<&serde_json::Value>) -> Vec<serde_json::Value> {
    let mut fields = Vec::new();
    let Some(serde_json::Value::Array(entries)) = entries_value else {
        return fields;
    };

    for entry in entries {
        let key = entry.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let value = match entry.get("value") {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(other) if !other.is_null() => other.to_string(),
            _ => {
                if let Some(src) = entry.get("src").and_then(|v| v.as_str()) {
                    src.to_string()
                } else {
                    String::new()
                }
            }
        };
        let disabled = entry.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false);
        fields.push(serde_json::json!({
            "key": key,
            "value": value,
            "description": parse_postman_description(entry.get("description")),
            "enabled": !disabled
        }));
    }

    fields
}

fn parse_postman_query_params(query_value: Option<&serde_json::Value>) -> Vec<serde_json::Value> {
    let mut params = Vec::new();
    let Some(serde_json::Value::Array(entries)) = query_value else {
        return params;
    };

    for entry in entries {
        let key = entry.get("key").and_then(|v| v.as_str()).unwrap_or("").trim();
        if key.is_empty() {
            continue;
        }
        let value = entry.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let disabled = entry.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false);
        params.push(serde_json::json!({
            "key": key,
            "value": value,
            "description": parse_postman_description(entry.get("description")),
            "enabled": !disabled
        }));
    }

    params
}

fn infer_raw_format_from_headers(headers: &[serde_json::Value]) -> String {
    for header in headers {
        let key = header.get("key").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        if key != "content-type" {
            continue;
        }
        let value = header.get("value").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        if value.contains("javascript") || value.contains("ecmascript") {
            return "javascript".to_string();
        }
        if value.contains("json") {
            return "json".to_string();
        }
        if value.contains("html") {
            return "html".to_string();
        }
        if value.contains("xml") {
            return "xml".to_string();
        }
        if value.contains("text/plain") {
            return "text".to_string();
        }
    }
    "json".to_string()
}

fn map_postman_raw_language(language: &str, headers: &[serde_json::Value]) -> String {
    match language.trim().to_lowercase().as_str() {
        "text" => "text".to_string(),
        "javascript" | "js" | "ecmascript" => "javascript".to_string(),
        "json" => "json".to_string(),
        "html" => "html".to_string(),
        "xml" => "xml".to_string(),
        _ => infer_raw_format_from_headers(headers),
    }
}

fn build_postman_url_from_parts(url_obj: &serde_json::Map<String, serde_json::Value>) -> String {
    let protocol = url_obj
        .get("protocol")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let host = match url_obj.get("host") {
        Some(serde_json::Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.as_str())
            .collect::<Vec<&str>>()
            .join("."),
        Some(serde_json::Value::String(text)) => text.clone(),
        _ => String::new(),
    };

    let path = match url_obj.get("path") {
        Some(serde_json::Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.as_str())
            .collect::<Vec<&str>>()
            .join("/"),
        Some(serde_json::Value::String(text)) => text.trim_start_matches('/').to_string(),
        _ => String::new(),
    };

    let mut url = if !protocol.is_empty() && !host.is_empty() {
        format!("{}://{}", protocol, host)
    } else if !host.is_empty() {
        host
    } else {
        String::new()
    };

    if !path.is_empty() {
        if !url.ends_with('/') {
            url.push('/');
        }
        url.push_str(&path);
    }

    url
}

fn parse_postman_url(url_value: Option<&serde_json::Value>) -> (String, Vec<serde_json::Value>) {
    let Some(value) = url_value else {
        return (String::new(), Vec::new());
    };

    match value {
        serde_json::Value::String(raw) => {
            let (base, query) = split_raw_url(raw.trim());
            let params = parse_query_string_to_params(&query);
            (base, params)
        }
        serde_json::Value::Object(url_obj) => {
            let raw = url_obj
                .get("raw")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let fallback = build_postman_url_from_parts(url_obj);
            let source = if raw.is_empty() { fallback.as_str() } else { raw.as_str() };
            let (base, raw_query) = split_raw_url(source);
            let mut params = parse_postman_query_params(url_obj.get("query"));
            if params.is_empty() {
                params = parse_query_string_to_params(&raw_query);
            }
            let resolved_base = if base.is_empty() { fallback } else { base };
            (resolved_base, params)
        }
        _ => (String::new(), Vec::new()),
    }
}

fn parse_postman_body(
    body_value: Option<&serde_json::Value>,
    headers: &[serde_json::Value],
) -> (String, String, String, String, String, String, Vec<serde_json::Value>) {
    let mut body_type = "none".to_string();
    let mut raw_format = "json".to_string();
    let mut body = String::new();
    let mut binary_body = String::new();
    let mut graphql_query = String::new();
    let mut graphql_variables = "{}".to_string();
    let mut body_fields = Vec::new();

    let Some(body_obj) = body_value.and_then(|v| v.as_object()) else {
        return (
            body_type,
            raw_format,
            body,
            binary_body,
            graphql_query,
            graphql_variables,
            body_fields,
        );
    };

    let mode = body_obj
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("none")
        .to_lowercase();

    match mode.as_str() {
        "raw" => {
            body_type = "raw".to_string();
            body = body_obj.get("raw").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let language = body_obj
                .get("options")
                .and_then(|v| v.get("raw"))
                .and_then(|v| v.get("language"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            raw_format = map_postman_raw_language(language, headers);
        }
        "urlencoded" => {
            body_type = "x-www-form-urlencoded".to_string();
            body_fields = parse_postman_kv_entries(body_obj.get("urlencoded"));
        }
        "formdata" => {
            body_type = "form-data".to_string();
            body_fields = parse_postman_kv_entries(body_obj.get("formdata"));
        }
        "graphql" => {
            body_type = "graphql".to_string();
            let graphql_obj = body_obj.get("graphql");
            graphql_query = graphql_obj
                .and_then(|v| v.get("query"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            graphql_variables = match graphql_obj.and_then(|v| v.get("variables")) {
                Some(serde_json::Value::String(text)) => {
                    if text.trim().is_empty() {
                        "{}".to_string()
                    } else {
                        text.clone()
                    }
                }
                Some(other) if other.is_object() || other.is_array() => {
                    serde_json::to_string(other).unwrap_or_else(|_| "{}".to_string())
                }
                _ => "{}".to_string(),
            };
        }
        "file" => {
            body_type = "binary".to_string();
            binary_body = String::new();
        }
        _ => {}
    }

    (
        body_type,
        raw_format,
        body,
        binary_body,
        graphql_query,
        graphql_variables,
        body_fields,
    )
}

fn build_postman_collection_request(
    item: &serde_json::Value,
    request_counter: &mut usize,
) -> Option<CollectionRequest> {
    let request_obj = item.get("request")?;

    let method = request_obj
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("GET")
        .trim()
        .to_uppercase();
    let (url, query_params) = parse_postman_url(request_obj.get("url"));
    let headers = parse_postman_headers(request_obj.get("header"));
    let (body_type, raw_format, body, binary_body, graphql_query, graphql_variables, body_fields) =
        parse_postman_body(request_obj.get("body"), &headers);

    let imported_name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
    let request_name = if imported_name.is_empty() {
        if url.is_empty() {
            format!("Request {}", *request_counter)
        } else {
            url.clone()
        }
    } else {
        imported_name.to_string()
    };

    let request_id = format!("import-req-{}", *request_counter);
    *request_counter += 1;

    let request_payload = serde_json::json!({
        "id": request_id,
        "name": request_name,
        "method": method,
        "url": url,
        "queryParams": query_params,
        "headers": headers,
        "body": body,
        "bodyType": body_type,
        "rawFormat": raw_format,
        "bodyFields": body_fields,
        "binaryBody": binary_body,
        "graphqlQuery": graphql_query,
        "graphqlVariables": graphql_variables,
        "isCustomName": !imported_name.is_empty()
    });

    Some(CollectionRequest {
        id: request_id.clone(),
        name: request_name,
        method: request_payload
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("GET")
            .to_string(),
        url: request_payload
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        request_data: serde_json::to_string(&request_payload).unwrap_or_else(|_| "{}".to_string()),
    })
}

fn ensure_postman_root_requests_folder(
    folders: &mut Vec<CollectionFolder>,
    folder_counter: &mut usize,
    root_requests_folder_id: &mut Option<String>,
) -> String {
    if let Some(existing) = root_requests_folder_id.clone() {
        return existing;
    }

    let folder_id = format!("import-folder-{}", *folder_counter);
    *folder_counter += 1;
    folders.push(CollectionFolder {
        id: folder_id.clone(),
        name: "Requests".to_string(),
        parent_id: None,
        children: Vec::new(),
    });
    *root_requests_folder_id = Some(folder_id.clone());
    folder_id
}

fn collect_postman_items(
    items: &[serde_json::Value],
    parent_folder_id: Option<String>,
    folders: &mut Vec<CollectionFolder>,
    folder_counter: &mut usize,
    request_counter: &mut usize,
    unnamed_folder_counter: &mut usize,
    root_requests_folder_id: &mut Option<String>,
) {
    for item in items {
        if let Some(children) = item.get("item").and_then(|v| v.as_array()) {
            let folder_name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
            let resolved_folder_name = if folder_name.is_empty() {
                let generated = format!("Folder {}", *unnamed_folder_counter);
                *unnamed_folder_counter += 1;
                generated
            } else {
                folder_name.to_string()
            };

            let folder_id = format!("import-folder-{}", *folder_counter);
            *folder_counter += 1;
            folders.push(CollectionFolder {
                id: folder_id.clone(),
                name: resolved_folder_name,
                parent_id: parent_folder_id.clone(),
                children: Vec::new(),
            });

            collect_postman_items(
                children,
                Some(folder_id),
                folders,
                folder_counter,
                request_counter,
                unnamed_folder_counter,
                root_requests_folder_id,
            );
            continue;
        }

        let Some(request_record) = build_postman_collection_request(item, request_counter) else {
            continue;
        };

        let target_folder_id = if let Some(parent_id) = parent_folder_id.clone() {
            parent_id
        } else {
            ensure_postman_root_requests_folder(folders, folder_counter, root_requests_folder_id)
        };

        if let Some(folder) = folders.iter_mut().find(|folder| folder.id == target_folder_id) {
            folder.children.push(request_record);
        }
    }
}

fn parse_collection_import_json(value: &serde_json::Value) -> Result<Vec<CollectionFolder>, String> {
    if let Ok(folders) = serde_json::from_value::<Vec<CollectionFolder>>(value.clone()) {
        return Ok(folders);
    }

    if let Ok(folder) = serde_json::from_value::<CollectionFolder>(value.clone()) {
        return Ok(vec![folder]);
    }

    let items = value
        .get("item")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Unsupported import format. Please provide a Postman collection JSON file.".to_string())?;

    let mut folders = Vec::new();
    let mut folder_counter = 1usize;
    let mut request_counter = 1usize;
    let mut unnamed_folder_counter = 1usize;

    let mut root_requests_folder_id: Option<String> = None;
    collect_postman_items(
        items,
        None,
        &mut folders,
        &mut folder_counter,
        &mut request_counter,
        &mut unnamed_folder_counter,
        &mut root_requests_folder_id,
    );

    if folders.is_empty() {
        return Err("No request items found in this file".to_string());
    }

    Ok(folders)
}

fn load_collections_from_file(data_dir: &str) -> Result<Vec<CollectionFolder>, String> {
    let collections_file = std::path::Path::new(data_dir).join("collections.json");
    if !collections_file.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&collections_file).map_err(|e| e.to_string())?;
    let folders: Vec<CollectionFolder> = serde_json::from_str(&content).unwrap_or_else(|_| Vec::new());
    Ok(folders)
}

fn write_collections_to_file(data_dir: &str, folders: &[CollectionFolder]) -> Result<(), String> {
    let collections_file = std::path::Path::new(data_dir).join("collections.json");
    let content = serde_json::to_string_pretty(folders).map_err(|e| e.to_string())?;
    std::fs::write(&collections_file, content).map_err(|e| e.to_string())?;
    Ok(())
}

fn derive_import_collection_name(json_value: &serde_json::Value, source_name: &str) -> String {
    let info_name = json_value
        .get("info")
        .and_then(|info| info.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if !info_name.is_empty() {
        return info_name;
    }

    let stem = std::path::Path::new(source_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if !stem.is_empty() {
        return stem;
    }

    "Imported Collection".to_string()
}

fn build_unique_folder_name(existing: &[CollectionFolder], base_name: &str) -> String {
    let normalized_base = if base_name.trim().is_empty() {
        "Imported Collection".to_string()
    } else {
        base_name.trim().to_string()
    };

    let existing_names: HashSet<String> = existing
        .iter()
        .map(|folder| folder.name.trim().to_lowercase())
        .collect();

    if !existing_names.contains(&normalized_base.to_lowercase()) {
        return normalized_base;
    }

    let mut index = 2usize;
    loop {
        let candidate = format!("{} {}", normalized_base, index);
        if !existing_names.contains(&candidate.to_lowercase()) {
            return candidate;
        }
        index += 1;
    }
}

fn update_request_payload_for_record(request: &CollectionRequest) -> String {
    let mut value = serde_json::from_str::<serde_json::Value>(&request.request_data).unwrap_or_else(|_| serde_json::json!({}));
    if let serde_json::Value::Object(map) = &mut value {
        map.insert("id".to_string(), serde_json::json!(request.id));
        map.insert("name".to_string(), serde_json::json!(request.name));
        map.insert("method".to_string(), serde_json::json!(request.method));
        map.insert("url".to_string(), serde_json::json!(request.url));
    }
    serde_json::to_string(&value).unwrap_or_else(|_| request.request_data.clone())
}

fn merge_import_into_collections(
    mut existing: Vec<CollectionFolder>,
    imported_folders: Vec<CollectionFolder>,
    collection_name: &str,
) -> Vec<CollectionFolder> {
    let mut all_folder_ids: HashSet<String> = existing.iter().map(|folder| folder.id.clone()).collect();
    let mut all_request_ids: HashSet<String> = existing
        .iter()
        .flat_map(|folder| folder.children.iter().map(|request| request.id.clone()))
        .collect();

    let mut folder_seed = Utc::now().timestamp_millis();
    let folder_id = loop {
        let candidate = format!("import-folder-{}", folder_seed);
        if !all_folder_ids.contains(&candidate) {
            all_folder_ids.insert(candidate.clone());
            break candidate;
        }
        folder_seed += 1;
    };
    let root_folder_id = folder_id.clone();

    let mut folder_id_map: HashMap<String, String> = HashMap::new();
    for folder in &imported_folders {
        let source_id = folder.id.trim();
        if source_id.is_empty() {
            continue;
        }

        let mapped_id = loop {
            let candidate = format!("import-folder-{}", folder_seed);
            folder_seed += 1;
            if !all_folder_ids.contains(&candidate) {
                all_folder_ids.insert(candidate.clone());
                break candidate;
            }
        };
        folder_id_map.insert(source_id.to_string(), mapped_id);
    }

    existing.push(CollectionFolder {
        id: folder_id,
        name: collection_name.to_string(),
        parent_id: None,
        children: Vec::new(),
    });

    let mut request_seed = Utc::now().timestamp_millis();
    for (index, mut source_folder) in imported_folders.into_iter().enumerate() {
        let source_folder_id = source_folder.id.trim().to_string();
        let target_folder_id = if let Some(mapped) = folder_id_map.get(&source_folder_id) {
            mapped.clone()
        } else {
            let generated = loop {
                let candidate = format!("import-folder-{}-{}", folder_seed, index);
                folder_seed += 1;
                if !all_folder_ids.contains(&candidate) {
                    all_folder_ids.insert(candidate.clone());
                    break candidate;
                }
            };
            folder_id_map.insert(source_folder_id.clone(), generated.clone());
            generated
        };

        let mapped_parent = source_folder
            .parent_id
            .as_ref()
            .and_then(|parent| folder_id_map.get(parent).cloned());
        let target_parent = mapped_parent.or_else(|| Some(root_folder_id.clone()));

        let normalized_name = if source_folder.name.trim().is_empty() {
            format!("Folder {}", index + 1)
        } else {
            source_folder.name.clone()
        };

        let mut normalized_requests = Vec::new();
        for mut request in source_folder.children.drain(..) {
            if request.name.trim().is_empty() {
                request.name = if request.url.trim().is_empty() {
                    "Untitled request".to_string()
                } else {
                    request.url.clone()
                };
            }

            let request_id = loop {
                let candidate = format!("import-req-{}", request_seed);
                request_seed += 1;
                if !all_request_ids.contains(&candidate) {
                    all_request_ids.insert(candidate.clone());
                    break candidate;
                }
            };
            request.id = request_id;
            request.request_data = update_request_payload_for_record(&request);
            normalized_requests.push(request);
        }

        existing.push(CollectionFolder {
            id: target_folder_id,
            name: normalized_name,
            parent_id: target_parent,
            children: normalized_requests,
        });
    }

    existing
}

fn import_collection_from_json_text(
    data_dir: &str,
    json_text: &str,
    source_name: &str,
) -> Result<Vec<CollectionFolder>, String> {
    let json_value: serde_json::Value = serde_json::from_str(json_text)
        .map_err(|e| format!("Invalid JSON file: {}", e))?;
    let imported_folders = parse_collection_import_json(&json_value)?;
    let existing = load_collections_from_file(data_dir)?;
    let base_name = derive_import_collection_name(&json_value, source_name);
    let collection_name = build_unique_folder_name(&existing, &base_name);
    let merged = merge_import_into_collections(existing, imported_folders, &collection_name);
    write_collections_to_file(data_dir, &merged)?;
    Ok(merged)
}

#[tauri::command]
async fn import_collection_file(
    state: tauri::State<'_, AppState>,
    file_path: String,
) -> Result<Vec<CollectionFolder>, String> {
    let trimmed_path = file_path.trim();
    if trimmed_path.is_empty() {
        return Err("File path is required".to_string());
    }

    let data_dir = state.data_dir.lock().map_err(|e| e.to_string())?;
    if data_dir.is_empty() {
        return Err("Data directory not initialized".to_string());
    }

    let file_content = std::fs::read_to_string(std::path::Path::new(trimmed_path))
        .map_err(|e| format!("Failed to read file: {}", e))?;
    let source_name = std::path::Path::new(trimmed_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported Collection")
        .to_string();
    import_collection_from_json_text(&data_dir, &file_content, &source_name)
}

#[tauri::command]
async fn import_collection_json(
    state: tauri::State<'_, AppState>,
    json_text: String,
    source_name: String,
) -> Result<Vec<CollectionFolder>, String> {
    let data_dir = state.data_dir.lock().map_err(|e| e.to_string())?;
    if data_dir.is_empty() {
        return Err("Data directory not initialized".to_string());
    }
    let source = if source_name.trim().is_empty() {
        "Imported Collection".to_string()
    } else {
        source_name
    };
    import_collection_from_json_text(&data_dir, &json_text, &source)
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
                parent_id: None,
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
                parent_id: None,
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
            parent_id: None,
            children: vec![request],
        });
    }
    
    let content = serde_json::to_string_pretty(&folders).map_err(|e| e.to_string())?;
    std::fs::write(&collections_file, content).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
async fn replace_collections(
    state: tauri::State<'_, AppState>,
    collections: Vec<CollectionFolder>,
) -> Result<Vec<CollectionFolder>, String> {
    let data_dir = state.data_dir.lock().map_err(|e| e.to_string())?;
    if data_dir.is_empty() {
        return Err("Data directory not initialized".to_string());
    }

    write_collections_to_file(&data_dir, &collections)?;
    Ok(collections)
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
            replace_collections,
            import_collection_file,
            import_collection_json,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
