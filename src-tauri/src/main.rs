// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chrono;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater;
use calamine::{open_workbook, Reader, Xls, Xlsx};
use csv::ReaderBuilder;
use base64::{Engine as _, engine::general_purpose};

// Global API URL constant
const API_BASE_URL: &str = "https://api.mimiranalysis.com";

fn log_to_frontend(app_handle: &AppHandle, message: &str) {
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.emit("backend-log", message);
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct ChatData {
    history: Vec<QueryHistory>,
    csv_path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct LoginInfo {
    username: String,
    password: String,
}

#[derive(serde::Deserialize)]
struct MergeConfig {
    file_path: String,
    merge_column: String,
    merge_type: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct RefreshToken {
    #[serde(rename = "refreshToken")]
    refresh_token: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct LoginResponse {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "refreshToken")]
    refresh_token: String,
    username: String,
    email: String,
    roles: Vec<String>,
    #[serde(rename = "type")]
    token_type: String,
}

async fn get_api_key(jwt_token: String) -> Result<String, String> {
    if jwt_token.is_empty() {
        return Err("No JWT token provided".to_string());
    }

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("Failed to build client: {}", e))?;

    let response = client
        .get(format!("{}/api/", API_BASE_URL))
        .header("Authorization", format!("Bearer {}", jwt_token))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, error_body));
    }

    let api_key = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    Ok(api_key)
}

fn save_chat_data_blocking(
    app_handle: &tauri::AppHandle,
    chat_name: &str,
    chat_data: &ChatData,
) -> Result<(), String> {
    let chat_json = serde_json::to_string_pretty(chat_data)
        .map_err(|e| format!("Failed to serialize chat data: {}", e))?;

    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    std::fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    let chat_path = app_dir.join(format!("{}.json", chat_name));

    std::fs::write(&chat_path, chat_json)
        .map_err(|e| format!("Failed to save chat data: {}", e))?;

    Ok(())
}

fn save_login(app_handle: &AppHandle, login_info: &RefreshToken) -> Result<(), String> {
    let login_info_json = serde_json::to_string_pretty(login_info)
        .map_err(|e| format!("Failed to serialize login info: {}", e))?;

    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let login_path = app_dir.join("logininfo.json");

    std::fs::write(&login_path, login_info_json)
        .map_err(|e| format!("Failed to save login info: {}", e))?;

    Ok(())
}

fn load_login(app_handle: &AppHandle) -> Result<RefreshToken, String> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let login_path = app_dir.join("logininfo.json");

    if !login_path.exists() {
        return Err("No saved login found".to_string());
    }

    let data = std::fs::read_to_string(&login_path)
        .map_err(|e| format!("Failed to read login info: {}", e))?;

    let login_info: RefreshToken = serde_json::from_str(&data)
        .map_err(|e| format!("Failed to deserialize login info: {}", e))?;

    Ok(login_info)
}

fn load_chat_data_blocking(
    app_handle: &tauri::AppHandle,
    chat_name: &str,
) -> Result<ChatData, String> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let chat_path = app_dir.join(format!("{}.json", chat_name));

    if !chat_path.exists() {
        return Ok(ChatData {
            history: Vec::new(),
            csv_path: None,
        });
    }

    let chat_json = std::fs::read_to_string(&chat_path)
        .map_err(|e| format!("Failed to read chat data: {}", e))?;

    let chat_data: ChatData = serde_json::from_str(&chat_json)
        .map_err(|e| format!("Failed to parse chat data: {}", e))?;

    Ok(chat_data)
}

#[derive(Default)]
struct PythonProcess {
    process: Mutex<Option<std::process::Child>>,
}

#[derive(Default)]
struct AppState {
    chats: Mutex<HashMap<String, ChatData>>,
    current_chat: Mutex<String>,
    jwt_token: Mutex<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct QueryHistory {
    query: String,
    response: AnalysisResponse,
    timestamp: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct AnalysisResponse {
    raw_output: String,
    code: String,
    result: String,
    summary: String,
    chart: Option<String>,
    error: Option<String>,
    recommended_prompts: Option<Vec<String>>,
    mimir_recommends: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone)]
struct ChatInfo {
    name: String,
    created_at: String,
    message_count: usize,
    csv_path: Option<String>,
}

// ========== CHAT MANAGEMENT COMMANDS ==========

#[tauri::command]
async fn create_chat(
    app_handle: tauri::AppHandle,
    chat_name: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut chats = state.chats.lock().unwrap();

    if chats.contains_key(&chat_name) {
        return Err(format!("Chat '{}' already exists", chat_name));
    }

    let chat_data = ChatData {
        history: Vec::new(),
        csv_path: None,
    };

    chats.insert(chat_name.clone(), chat_data);

    let mut current_chat = state.current_chat.lock().unwrap();
    *current_chat = chat_name.clone();

    let app_handle_clone = app_handle.clone();
    let chat_name_clone = chat_name.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let empty_chat = ChatData {
            history: Vec::new(),
            csv_path: None,
        };
        if let Err(e) = save_chat_data_blocking(&app_handle_clone, &chat_name_clone, &empty_chat) {
            eprintln!("Warning: Could not save new chat: {}", e);
        }
    });

    Ok(format!("Chat '{}' created and set as active", chat_name))
}

#[tauri::command]
async fn switch_chat(chat_name: String, state: State<'_, AppState>) -> Result<String, String> {
    let chats = state.chats.lock().unwrap();

    if !chats.contains_key(&chat_name) {
        return Err(format!("Chat '{}' not found", chat_name));
    }

    let mut current_chat = state.current_chat.lock().unwrap();
    *current_chat = chat_name.clone();

    Ok(format!("Switched to chat '{}'", chat_name))
}

#[tauri::command]
async fn get_current_chat(state: State<'_, AppState>) -> Result<String, String> {
    let current_chat = state.current_chat.lock().unwrap();
    Ok(current_chat.clone())
}

#[tauri::command]
async fn list_chats(state: State<'_, AppState>) -> Result<Vec<ChatInfo>, String> {
    let chats = state.chats.lock().unwrap();
    let mut chat_list = Vec::new();

    for (name, chat_data) in chats.iter() {
        chat_list.push(ChatInfo {
            name: name.clone(),
            created_at: if let Some(first_msg) = chat_data.history.first() {
                first_msg.timestamp.clone()
            } else {
                chrono::Local::now().to_rfc3339()
            },
            message_count: chat_data.history.len(),
            csv_path: chat_data.csv_path.clone(),
        });
    }

    Ok(chat_list)
}

#[tauri::command]
async fn delete_chat(
    app_handle: tauri::AppHandle,
    chat_name: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut chats = state.chats.lock().unwrap();

    if !chats.contains_key(&chat_name) {
        return Err(format!("Chat '{}' not found", chat_name));
    }

    let current_chat = state.current_chat.lock().unwrap();
    if *current_chat == chat_name {
        return Err("Cannot delete the current chat. Switch to another chat first.".to_string());
    }

    chats.remove(&chat_name);

    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let chat_path = app_dir.join(format!("{}.json", chat_name));
    if chat_path.exists() {
        std::fs::remove_file(&chat_path)
            .map_err(|e| format!("Failed to delete chat file: {}", e))?;
    }

    Ok(format!("Chat '{}' deleted", chat_name))
}

// ========== CSV PATH MANAGEMENT ==========

#[tauri::command]
async fn set_csv_path(
    app_handle: tauri::AppHandle,
    csv_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let current_chat = state.current_chat.lock().unwrap();
    let mut chats = state.chats.lock().unwrap();

    if let Some(chat_data) = chats.get_mut(&*current_chat) {
        chat_data.csv_path = Some(csv_path.clone());

        let app_handle_clone = app_handle.clone();
        let current_chat_clone = current_chat.clone();
        let chat_data_clone = chat_data.clone();

        tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) =
                save_chat_data_blocking(&app_handle_clone, &current_chat_clone, &chat_data_clone)
            {
                eprintln!("Warning: Could not save CSV path: {}", e);
            }
        });

        Ok(format!(
            "CSV path set to '{}' for chat '{}'",
            csv_path, current_chat
        ))
    } else {
        Err("Current chat not found".to_string())
    }
}

#[tauri::command]
async fn get_csv_path(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let current_chat = state.current_chat.lock().unwrap();
    let chats = state.chats.lock().unwrap();

    if let Some(chat_data) = chats.get(&*current_chat) {
        Ok(chat_data.csv_path.clone())
    } else {
        Ok(None)
    }
}

// ========== HISTORY MANAGEMENT COMMANDS ==========

#[tauri::command]
async fn clear_history(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let current_chat = state.current_chat.lock().unwrap();
    let mut chats = state.chats.lock().unwrap();

    if let Some(chat_data) = chats.get_mut(&*current_chat) {
        let count = chat_data.history.len();
        chat_data.history.clear();

        let app_handle_clone = app_handle.clone();
        let current_chat_clone = current_chat.clone();
        let chat_data_clone = chat_data.clone();

        tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) =
                save_chat_data_blocking(&app_handle_clone, &current_chat_clone, &chat_data_clone)
            {
                eprintln!("Warning: Could not save cleared history: {}", e);
            }
        });

        Ok(format!(
            "Cleared {} history items from chat '{}'",
            count, current_chat
        ))
    } else {
        Err("Current chat not found".to_string())
    }
}

#[tauri::command]
async fn get_history(state: State<'_, AppState>) -> Result<Vec<QueryHistory>, String> {
    let current_chat = state.current_chat.lock().unwrap();
    let chats = state.chats.lock().unwrap();

    if let Some(chat_data) = chats.get(&*current_chat) {
        Ok(chat_data.history.clone())
    } else {
        Ok(Vec::new())
    }
}

#[tauri::command]
async fn save_history(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let current_chat = state.current_chat.lock().unwrap();
    let chats = state.chats.lock().unwrap();

    if let Some(chat_data) = chats.get(&*current_chat) {
        let app_handle_clone = app_handle.clone();
        let current_chat_clone = current_chat.clone();
        let chat_data_clone = chat_data.clone();

        tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) =
                save_chat_data_blocking(&app_handle_clone, &current_chat_clone, &chat_data_clone)
            {
                eprintln!("Failed to save history: {}", e);
            }
        });

        Ok(format!("History saved for chat '{}'", current_chat))
    } else {
        Err("Current chat not found".to_string())
    }
}

// ========== PYTHON SERVICE COMMANDS ==========

#[tauri::command]
async fn start_python_service(
    app_handle: tauri::AppHandle,
    state: State<'_, PythonProcess>,
) -> Result<String, String> {
    let mut process_lock = state.process.lock().unwrap();

    if process_lock.is_some() {
        return Ok("Python service already running".to_string());
    }

    let analyzer_path = get_python_analyzer_path(&app_handle)
        .map_err(|e| format!("Failed to get Python analyzer path: {}", e))?;

    let (python_bin, _) = get_python_paths(&app_handle)
        .map_err(|e| format!("Failed to get Python paths: {}", e))?;

    let mut command = Command::new(&python_bin);
    command.arg(&analyzer_path);
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command
        .spawn()
        .map_err(|e| format!("Failed to start Python: {}", e))?;

    *process_lock = Some(child);
    Ok("Python service started".to_string())
}

#[tauri::command]
async fn stop_python_service(state: State<'_, PythonProcess>) -> Result<String, String> {
    let mut process_lock = state.process.lock().unwrap();

    if let Some(mut child) = process_lock.take() {
        child
            .kill()
            .map_err(|e| format!("Failed to stop Python: {}", e))?;
        Ok("Python service stopped".to_string())
    } else {
        Err("Python service not running".to_string())
    }
}

// ========== MAIN ANALYSIS COMMAND ==========

#[tauri::command]
async fn analyze_query(
    app_handle: tauri::AppHandle,
    query: String,
    csv_path: String,
    state: State<'_, AppState>,
) -> Result<AnalysisResponse, String> {
    log_to_frontend(&app_handle, &format!("Analyzing: {}", query));

    let (python_bin, analyzer_path) =
        get_python_paths(&app_handle).map_err(|e| format!("Failed to get Python paths: {}", e))?;

    let jwt_token = {
        let token_guard = state.jwt_token.lock().unwrap();
        token_guard.clone()
    };

    let api_key = get_api_key(jwt_token).await?;

    let (_current_chat_name, history_json) = {
        let current_chat = state.current_chat.lock().unwrap();
        let mut chats = state.chats.lock().unwrap();

        let chat_data = chats
            .get_mut(&*current_chat)
            .ok_or("Current chat not found".to_string())?;

        chat_data.csv_path = Some(csv_path.clone());

        let history_json = serde_json::to_string(&chat_data.history)
            .map_err(|e| format!("Failed to serialize history: {}", e))?;

        (current_chat.clone(), history_json)
    };

    let mut tmp_path = std::env::temp_dir();
    let filename = format!(
        "mimir_history_{}.json",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    );
    tmp_path.push(&filename);

    if let Err(e) = std::fs::write(&tmp_path, &history_json) {
        eprintln!("Warning: Could not write history temp file: {}", e);
    }

    let mut command = Command::new(&python_bin);
    command.arg(&analyzer_path);
    command.arg(csv_path.clone());
    command.arg(query.clone());

    let history_arg = format!("@{}", tmp_path.to_string_lossy());
    command.arg(history_arg);

    command.env("GROQ_API_KEY", &api_key);
    command.env("PYTHONUTF8", "1");
    command.env("PYTHONIOENCODING", "utf-8");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command
        .output()
        .map_err(|e| format!("Failed to execute Python: {}", e))?;

    if tmp_path.exists() {
        let _ = std::fs::remove_file(&tmp_path);
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    println!("=== Python STDOUT ===");
    println!("{}", stdout);
    println!("=== Python STDERR ===");
    println!("{}", stderr);
    println!("=====================");

    let response = parse_python_output(&stdout, &stderr);

    {
        let current_chat = state.current_chat.lock().unwrap();
        let mut chats = state.chats.lock().unwrap();

        if let Some(chat_data) = chats.get_mut(&*current_chat) {
            chat_data.history.push(QueryHistory {
                query: query.clone(),
                response: response.clone(),
                timestamp: chrono::Local::now().to_rfc3339(),
            });

            let app_handle_clone = app_handle.clone();
            let current_chat_clone = current_chat.clone();
            let chat_data_clone = chat_data.clone();

            tauri::async_runtime::spawn_blocking(move || {
                if let Err(e) = save_chat_data_blocking(
                    &app_handle_clone,
                    &current_chat_clone,
                    &chat_data_clone,
                ) {
                    eprintln!("Warning: Could not save chat data: {}", e);
                }
            });
        }
    }

    Ok(response)
}


fn get_python_paths(app_handle: &AppHandle) -> Result<(String, String), String> {
    
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource directory: {}", e))?;
    
    
    let possible_python_dirs = vec![
        resource_dir.join("python-root"),  // Bundled location
        resource_dir.join("python"),       // Alternative location
        std::env::current_dir().unwrap().join("python-root"), // Development
        std::env::current_dir().unwrap().join("python"),      // Development
    ];
    
    let mut python_dir = None;
    for dir in possible_python_dirs {
        println!("Checking: {:?}", dir);
        if dir.exists() {
            println!("Found Python directory at: {:?}", dir);
            python_dir = Some(dir);
            break;
        }
    }
    
    let python_dir = python_dir.ok_or("Could not find Python directory in bundled resources")?;
    
    println!("Using Python directory: {:?}", python_dir);
    
    // Get OS-specific venv directory
    let venv_dir = if cfg!(target_os = "windows") {
        python_dir.join("windows-venv")
    } else if cfg!(target_os = "linux") {
        python_dir.join("linux-venv")
    } else if cfg!(target_os = "macos") {
        python_dir.join("macos-venv")
    } else {
        return Err(format!("Unsupported OS: {}", std::env::consts::OS));
    };
    
    println!("Venv directory: {:?}", venv_dir);
    
    // Get Python executable
    let python_bin = if cfg!(target_os = "windows") {
        venv_dir.join("Scripts").join("python.exe")
    } else {
        venv_dir.join("bin").join("python")
    };
    
    println!("Python binary: {:?}", python_bin);
    
    // Get analyzer script
    let analyzer_path = python_dir.join("analyzer.py");
    println!("Analyzer path: {:?}", analyzer_path);
    
    // Verify paths exist
    if !python_bin.exists() {
        println!("ERROR: Python binary not found!");
        println!("Directory contents:");
        if let Ok(entries) = std::fs::read_dir(&python_dir) {
            for entry in entries.flatten() {
                println!("  {:?}", entry.path());
            }
        }
        return Err(format!("Python binary not found at: {:?}", python_bin));
    }
    
    if !analyzer_path.exists() {
        return Err(format!("Analyzer script not found at: {:?}", analyzer_path));
    }
    
    println!("Testing Python...");
    match std::process::Command::new(&python_bin)
        .arg("-c")
        .arg("import sys; print(f'Python {sys.version} OK'); import pandas; print('Pandas OK')")
        .output()
    {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            println!("Python test successful: {}", stdout.trim());
            Ok((
                python_bin.to_string_lossy().to_string(),
                analyzer_path.to_string_lossy().to_string()
            ))
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            println!("Python test failed: {}", stderr);
            Err(format!("Python test failed: {}", stderr))
        }
        Err(e) => {
            println!("Failed to run Python: {}", e);
            Err(format!("Failed to run Python: {}", e))
        }
    }
}

fn parse_python_output(stdout_raw: &str, stderr_raw: &str) -> AnalysisResponse {
    let stdout = stdout_raw.replace("\r\n", "\n");
    let stderr = stderr_raw.replace("\r\n", "\n");

    let mut response = AnalysisResponse {
        raw_output: stdout.to_string(),
        code: String::new(),
        result: String::new(),
        summary: String::new(),
        chart: None,
        error: None,
        recommended_prompts: None,
        mimir_recommends: None,
    };

    if !stderr.is_empty() {
        response.error = Some(stderr.to_string());
    }

    fn extract_section(s: &str, start_marker: &str, end_marker: &str) -> String {
        if let Some(start) = s.find(start_marker) {
            let s = &s[start + start_marker.len()..];
            if let Some(end) = s.find(end_marker) {
                return s[..end].trim().to_string();
            }
        }
        String::new()
    }

    response.summary = extract_section(
        &stdout,
        "=== ANALYSIS_SUMMARY_START ===",
        "=== ANALYSIS_SUMMARY_END ===",
    );

    let prompts_text = extract_section(
        &stdout,
        "=== RECOMMENDED_PROMPTS_START ===",
        "=== RECOMMENDED_PROMPTS_END ===",
    );
    if !prompts_text.is_empty() {
        if let Ok(prompts) = serde_json::from_str::<Vec<String>>(&prompts_text) {
            response.recommended_prompts = Some(prompts);
        }
    }

    let mimir_text = extract_section(
        &stdout,
        "=== MIMIR_RECOMMENDS_START ===",
        "=== MIMIR_RECOMMENDS_END ===",
    );
    if !mimir_text.is_empty() {
        if let Ok(recommends) = serde_json::from_str::<Vec<String>>(&mimir_text) {
            response.mimir_recommends = Some(recommends);
        }
    }

    let chart_text = extract_section(
        &stdout,
        "=== CHART_DATA_START ===",
        "=== CHART_DATA_END ===",
    );
    if !chart_text.is_empty() && chart_text != "null" {
        response.chart = Some(chart_text);
    }

    let error_text = extract_section(
        &stdout,
        "=== ERROR_INFO_START ===",
        "=== ERROR_INFO_END ===",
    );
    if !error_text.is_empty() {
        response.error = Some(error_text);
    }

    response
}

// ========== AUTH COMMANDS ==========

#[tauri::command]
async fn login(
    login_info: LoginInfo,
    state: State<'_, AppState>,
    save_login_boolean: bool,
    app_handle: AppHandle,
) -> Result<String, String> {
    let client = reqwest::Client::new();

    let response = client
        .post(format!("{}/api/auth/login", API_BASE_URL))
        .json(&login_info)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, error_body));
    }

    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    println!("=== RAW LOGIN RESPONSE ===");
    println!("{}", response_text);
    println!("==========================");

    let login_response: LoginResponse = serde_json::from_str(&response_text).map_err(|e| {
        format!(
            "Failed to parse login response: {} | Raw response: {}",
            e, response_text
        )
    })?;

    let mut token_guard = state.jwt_token.lock().unwrap();
    *token_guard = login_response.access_token.clone();

    let refresh_token = RefreshToken {
        refresh_token: login_response.refresh_token.clone(),
    };

    if save_login_boolean {
        if let Err(e) = save_login(&app_handle, &refresh_token) {
            println!("Warning: Failed to save login info: {}", e);
        } else {
            println!("Login info saved successfully");
        }
    }

    Ok(login_response.username)
}

#[tauri::command]
async fn refresh_token(
    refresh_token: String,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let client = reqwest::Client::new();

    let response = client
        .post(format!("{}/api/auth/refresh", API_BASE_URL))
        .json(&RefreshToken { refresh_token })
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, error_body));
    }

    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    println!("=== RAW REFRESH RESPONSE ===");
    println!("{}", response_text);
    println!("============================");

    let login_response: LoginResponse = serde_json::from_str(&response_text).map_err(|e| {
        format!(
            "Failed to parse refresh response: {} | Raw response: {}",
            e, response_text
        )
    })?;

    let mut token_guard = state.jwt_token.lock().unwrap();
    *token_guard = login_response.access_token.clone();

    let new_refresh_token = RefreshToken {
        refresh_token: login_response.refresh_token.clone(),
    };

    if let Err(e) = save_login(&app_handle, &new_refresh_token) {
        println!("Warning: Failed to save new refresh token: {}", e);
    }

    Ok(login_response.username)
}

#[tauri::command]
async fn try_auto_login(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let refresh_token_data =
        load_login(&app_handle).map_err(|_| "No saved login found".to_string())?;

    refresh_token(refresh_token_data.refresh_token, state, app_handle).await
}

#[tauri::command]
async fn logout(app_handle: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let mut token_guard = state.jwt_token.lock().unwrap();
    *token_guard = String::new();

    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let login_path = app_dir.join("logininfo.json");

    if login_path.exists() {
        std::fs::remove_file(&login_path)
            .map_err(|e| format!("Failed to delete login info: {}", e))?;
    }

    Ok("Logged out successfully".to_string())
}

#[tauri::command]
async fn request_password_reset(app_handle: AppHandle, email: String) -> Result<String, String> {
    log_to_frontend(&app_handle, &email);
    let client = reqwest::Client::new();

    let json_body = serde_json::json!({
        "email": email
    });
    let response = client
        .post(format!("{}/api/auth/request-reset", API_BASE_URL))
        .json(&json_body)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, error_body));
    }

    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    Ok(response_text)
}

// ========== FILE UPLOAD AND PROCESSING COMMANDS ==========

// Helper function to sanitize filename
fn sanitize_filename(filename: &str) -> String {
    let sanitized: String = filename
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\' | '/' => '_',
            _ => c,
        })
        .collect();
    
    // Trim whitespace and limit length
    let trimmed = sanitized.trim();
    if trimmed.is_empty() {
        return "unnamed_file".to_string();
    }
    
    // Limit to 255 characters (common filesystem limit)
    if trimmed.len() > 255 {
        let stem = Path::new(trimmed)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("file");
        let ext = Path::new(trimmed)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        
        let max_stem_len = 255 - ext.len() - if ext.is_empty() { 0 } else { 1 };
        let truncated_stem = if stem.len() > max_stem_len {
            &stem[0..max_stem_len]
        } else {
            stem
        };
        
        if ext.is_empty() {
            truncated_stem.to_string()
        } else {
            format!("{}.{}", truncated_stem, ext)
        }
    } else {
        trimmed.to_string()
    }
}

// Helper function to get unique filename while preserving original name
fn get_unique_filename(directory: &Path, filename: &str) -> String {
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    
    let extension = Path::new(filename)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    
    let ext_with_dot = if extension.is_empty() {
        String::new()
    } else {
        format!(".{}", extension)
    };
    
    // Try original filename first
    if !directory.join(filename).exists() {
        return filename.to_string();
    }
    
    // Add counter if file exists
    let mut counter = 1;
    loop {
        let new_filename = format!("{}_{}{}", stem, counter, ext_with_dot);
        if !directory.join(&new_filename).exists() {
            return new_filename;
        }
        counter += 1;
    }
}

// Helper function to convert Excel to CSV
fn convert_excel_to_csv(excel_path: &Path, app_handle: &AppHandle) -> Result<PathBuf, String> {
    let csv_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?
        .join("csv_conversions");
    
    if !csv_dir.exists() {
        fs::create_dir_all(&csv_dir)
            .map_err(|e| format!("Failed to create CSV directory: {}", e))?;
    }

    // Get original filename without extension
    let file_stem = excel_path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("converted");
    
    // Check if CSV already exists and add counter if needed
    let csv_filename = get_unique_filename(&csv_dir, &format!("{}.csv", file_stem));
    let csv_path = csv_dir.join(&csv_filename);

    // Open Excel file
    if excel_path.extension().and_then(|ext| ext.to_str()) == Some("xlsx") {
        let mut workbook: Xlsx<_> = open_workbook(excel_path)
            .map_err(|e| format!("Failed to open Excel file: {}", e))?;
        
        if let Some(Ok(range)) = workbook.worksheet_range_at(0) {
            let mut wtr = csv::Writer::from_path(&csv_path)
                .map_err(|e| format!("Failed to create CSV writer: {}", e))?;
            
            for row in range.rows() {
                let record: Vec<String> = row.iter()
                    .map(|cell| cell.to_string())
                    .collect();
                wtr.write_record(&record)
                    .map_err(|e| format!("Failed to write CSV record: {}", e))?;
            }
            
            wtr.flush()
                .map_err(|e| format!("Failed to flush CSV writer: {}", e))?;
        }
    } else if excel_path.extension().and_then(|ext| ext.to_str()) == Some("xls") {
        let mut workbook: Xls<_> = open_workbook(excel_path)
            .map_err(|e| format!("Failed to open Excel file: {}", e))?;
        
        if let Some(Ok(range)) = workbook.worksheet_range_at(0) {
            let mut wtr = csv::Writer::from_path(&csv_path)
                .map_err(|e| format!("Failed to create CSV writer: {}", e))?;
            
            for row in range.rows() {
                let record: Vec<String> = row.iter()
                    .map(|cell| cell.to_string())
                    .collect();
                wtr.write_record(&record)
                    .map_err(|e| format!("Failed to write CSV record: {}", e))?;
            }
            
            wtr.flush()
                .map_err(|e| format!("Failed to flush CSV writer: {}", e))?;
        }
    }

    Ok(csv_path)
}

#[tauri::command]
async fn upload_file(
    app_handle: AppHandle,
    file_name: String,
    file_data: Vec<u8>,
) -> Result<String, String> {
    // Create uploads directory if it doesn't exist
    let uploads_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?
        .join("uploads");
    
    if !uploads_dir.exists() {
        fs::create_dir_all(&uploads_dir)
            .map_err(|e| format!("Failed to create uploads directory: {}", e))?;
    }

    // Sanitize the filename
    let sanitized_name = sanitize_filename(&file_name);
    
    // Check if file already exists and add counter if needed
    let unique_filename = get_unique_filename(&uploads_dir, &sanitized_name);
    let file_path = uploads_dir.join(&unique_filename);

    // Write file data
    fs::write(&file_path, &file_data)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    // Convert to CSV if it's an Excel file
    let file_extension = Path::new(&file_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("csv")
        .to_string()
        .to_lowercase();

    let final_path = if file_extension == "xlsx" || file_extension == "xls" {
        convert_excel_to_csv(&file_path, &app_handle)?
            .to_string_lossy()
            .to_string()
    } else {
        file_path.to_string_lossy().to_string()
    };

    Ok(final_path)
}

#[tauri::command]
async fn load_csv_info(
    csv_path: String,
) -> Result<Vec<Vec<String>>, String> {
    let path = Path::new(&csv_path);
    if !path.exists() {
        return Err("File does not exist".to_string());
    }

    // Check file extension
    let ext = path.extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext == "csv" {
        // Use CSV reader for CSV files
        let mut reader = ReaderBuilder::new()
            .has_headers(true)
            .from_path(path)
            .map_err(|e| format!("Failed to read CSV: {}", e))?;

        let mut result = Vec::new();
        
        // Read headers
        if let Some(headers) = reader.headers().ok() {
            let header_row: Vec<String> = headers.iter().map(|h| h.to_string()).collect();
            result.push(header_row);
        }

        // Read first 5 rows
        for (i, record) in reader.records().enumerate() {
            if i >= 5 {
                break;
            }
            
            match record {
                Ok(r) => {
                    let row: Vec<String> = r.iter().map(|field| field.to_string()).collect();
                    result.push(row);
                }
                Err(e) => {
                    return Err(format!("Error reading row {}: {}", i + 1, e));
                }
            }
        }

        Ok(result)
    } else if ext == "xlsx" || ext == "xls" {
        // Use Python to read Excel files (more reliable than calamine for all Excel features)
        // Helper function to create command with no window on Windows
        fn create_no_window_command(program: &str) -> Command {
            let mut command = Command::new(program);
            
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                command.creation_flags(CREATE_NO_WINDOW);
            }
            
            command
        }

        let output = create_no_window_command("python")
            .arg("-c")
            .arg(format!(
                r#"
import pandas as pd
import json
import sys

try:
    df = pd.read_excel(r'{}')
    # Get column names
    columns = df.columns.tolist()
    # Get first 5 rows as strings
    data = df.head(5).fillna('').astype(str).values.tolist()
    # Combine columns and data
    result = [columns] + data
    print(json.dumps(result))
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
"#,
                csv_path
            ))
            .output()
            .or_else(|_| {
                // Fallback to python3 if python doesn't work
                create_no_window_command("python3")
                    .arg("-c")
                    .arg(format!(
                        r#"
import pandas as pd
import json
import sys

try:
    df = pd.read_excel(r'{}')
    # Get column names
    columns = df.columns.tolist()
    # Get first 5 rows as strings
    data = df.head(5).fillna('').astype(str).values.tolist()
    # Combine columns and data
    result = [columns] + data
    print(json.dumps(result))
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
"#,
                        csv_path
                    ))
                    .output()
            })
            .map_err(|e| format!("Failed to run Python: {}", e))?;

        if !output.status.success() {
            return Err(format!(
                "Python error: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse JSON output: {}", e))
    } else {
        Err(format!("Unsupported file type: .{}", ext))
    }
}

#[tauri::command]
async fn merge_files(
    primary_path: String,
    secondary_path: String,
    merge_column: String,
    merge_type: String, // "inner", "left", "right", "outer"
) -> Result<String, String> {
    use uuid::Uuid;

    let output_dir = std::env::temp_dir();
    let output_filename = format!("merged_{}.csv", Uuid::new_v4());
    let output_path = output_dir.join(&output_filename);

    let python_code = format!(
        r#"
import pandas as pd
import sys

try:
    # Read both files
    df1 = pd.read_csv(r'{}') if r'{}'.endswith('.csv') else pd.read_excel(r'{}')
    df2 = pd.read_csv(r'{}') if r'{}'.endswith('.csv') else pd.read_excel(r'{}')
    
    # Ensure merge column exists in both dataframes
    if '{}' not in df1.columns:
        raise ValueError("Merge column '{}' not found in primary file")
    if '{}' not in df2.columns:
        raise ValueError("Merge column '{}' not found in secondary file")
    
    # Perform the merge
    merged = pd.merge(df1, df2, on='{}', how='{}', suffixes=('_primary', '_secondary'))
    
    # Save merged file
    merged.to_csv(r'{}', index=False)
    print(r'{}')
    
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
"#,
        primary_path, primary_path, primary_path,
        secondary_path, secondary_path, secondary_path,
        merge_column, merge_column,
        merge_column, merge_column,
        merge_column, merge_type,
        output_path.to_string_lossy(),
        output_path.to_string_lossy()
    );

    // Helper function to create command with no window on Windows
    fn create_no_window_command(program: &str) -> Command {
        let mut command = Command::new(program);
        
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        
        command.env("PYTHONUTF8", "1");
        command.env("PYTHONIOENCODING", "utf-8");
        
        command
    }

    let output = create_no_window_command("python")
        .arg("-c")
        .arg(&python_code)
        .output()
        .or_else(|_| {
            create_no_window_command("python3")
                .arg("-c")
                .arg(&python_code)
                .output()
        })
        .map_err(|e| format!("Failed to run Python: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Merge failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // Verify the file was created
    if !output_path.exists() {
        return Err("Merged file was not created".to_string());
    }

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn merge_multiple_files(
    primary_path: String,
    merge_configs: Vec<MergeConfig>,
    app_handle: AppHandle,
) -> Result<String, String> {
    // Generate output path
    let output_filename = format!("merged_{}.csv", chrono::Local::now().format("%Y%m%d_%H%M%S"));
    let output_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?
        .join("merged_files");
    
    if !output_dir.exists() {
        fs::create_dir_all(&output_dir)
            .map_err(|e| format!("Failed to create merged files directory: {}", e))?;
    }
    
    let output_path = output_dir.join(&output_filename);

    // Helper function to escape Windows paths
    fn escape_path(path: &str) -> String {
        path.replace('\\', "\\\\")
    }

    // Build Python code for merging multiple files
    let mut python_code = String::from(
        r#"
import pandas as pd
import sys
import os

try:
"#
    );

    // Add primary dataframe
    let primary_path_escaped = escape_path(&primary_path);
    
    python_code.push_str(&format!(
        "    # Read primary dataframe\n    primary_path = r'{}'\n",
        primary_path_escaped
    ));
    
    python_code.push_str(&format!(
        "    if not os.path.exists(primary_path):\n        raise FileNotFoundError(f\"Primary file not found: {{primary_path}}\")\n"
    ));
    
    python_code.push_str(&format!(
        "    df_merged = pd.read_csv(primary_path) if primary_path.lower().endswith('.csv') else pd.read_excel(primary_path)\n"
    ));

    // Add merge operations for each config
    for (i, config) in merge_configs.iter().enumerate() {
        let file_path_escaped = escape_path(&config.file_path);
        
        python_code.push_str(&format!(
            "\n    # Merge with file {}: {}\n",
            i + 1,
            config.file_path
        ));
        
        python_code.push_str(&format!(
            "    file_path{} = r'{}'\n",
            i,
            file_path_escaped
        ));
        
        python_code.push_str(&format!(
            "    if not os.path.exists(file_path{}):\n        raise FileNotFoundError(f\"File {{file_path{}}} not found\")\n",
            i, i
        ));
        
        python_code.push_str(&format!(
            "    df{} = pd.read_csv(file_path{}) if file_path{}.lower().endswith('.csv') else pd.read_excel(file_path{})\n",
            i, i, i, i
        ));
        
        python_code.push_str(&format!(
            "    # Verify merge column exists\n    if '{}' not in df_merged.columns:\n        raise ValueError(\"Merge column '{}' not found in merged dataframe. Available columns: {{}}\".format(list(df_merged.columns)))\n",
            config.merge_column, config.merge_column
        ));
        
        python_code.push_str(&format!(
            "    if '{}' not in df{}.columns:\n        raise ValueError(\"Merge column '{}' not found in file: {{}}. Available columns: {{}}\".format(file_path{}, list(df{}.columns)))\n",
            config.merge_column, i, config.merge_column, i, i
        ));
        
        python_code.push_str(&format!(
            "    df_merged = pd.merge(df_merged, df{}, on='{}', how='{}', suffixes=('', '_{}'))\n",
            i, config.merge_column, config.merge_type, i
        ));
    }

    let output_path_escaped = escape_path(&output_path.to_string_lossy());
    python_code.push_str(&format!(
        "\n    # Save merged file\n    output_path = r'{}'\n    df_merged.to_csv(output_path, index=False)\n    print('SUCCESS:' + output_path)\n",
        output_path_escaped
    ));

    python_code.push_str(
        r#"
except Exception as e:
    sys.stderr.write('ERROR: ' + str(e))
    sys.exit(1)
"#,
    );

    println!("=== MERGE PYTHON CODE ===");
    println!("{}", python_code);
    println!("=========================");

    // Helper function to create command with no window on Windows
    fn create_no_window_command(program: &str) -> Command {
        let mut command = Command::new(program);
        
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        
        // Add environment variables for consistent encoding
        command.env("PYTHONUTF8", "1");
        command.env("PYTHONIOENCODING", "utf-8");
        
        command
    }

    // Try to use the embedded Python first
    let python_bin = get_python_paths(&app_handle)
        .map(|(python_bin, _)| python_bin)
        .unwrap_or_else(|_| {
            println!("Warning: Could not get embedded Python, trying system Python");
            "python".to_string()
        });

    let mut command = create_no_window_command(&python_bin);
    command.arg("-c");
    command.arg(&python_code);

    let output = match command.output() {
        Ok(output) => output,
        Err(e) => {
            println!("Embedded Python failed: {}, trying system python", e);
            
            // Try with system python with no window flag
            let mut sys_command = create_no_window_command("python");
            sys_command.arg("-c");
            sys_command.arg(&python_code);
            
            match sys_command.output() {
                Ok(output) => output,
                Err(_) => {
                    // Try python3 as last resort with no window flag
                    let mut py3_command = create_no_window_command("python3");
                    py3_command.arg("-c");
                    py3_command.arg(&python_code);
                    
                    py3_command.output()
                        .map_err(|e| format!("All Python attempts failed: {}", e))?
                }
            }
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    
    println!("=== MERGE STDOUT ===");
    println!("{}", stdout);
    println!("=== MERGE STDERR ===");
    println!("{}", stderr);
    println!("====================");

    if !output.status.success() {
        return Err(format!(
            "Merge failed: {}",
            stderr
        ));
    }

    // Extract the success path from stdout
    if let Some(success_line) = stdout.lines().find(|line| line.starts_with("SUCCESS:")) {
        let path = success_line.trim_start_matches("SUCCESS:").trim();
        if std::path::Path::new(path).exists() {
            return Ok(path.to_string());
        }
    }

    // Fallback: check if the file was created
    if !output_path.exists() {
        return Err(format!("Merged file was not created. Python output: {}", stdout));
    }

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn save_and_process_file(
    app_handle: AppHandle,
    file_name: String,
    file_data: String,
    is_base64: bool,
) -> Result<String, String> {
    // Create uploads directory
    let uploads_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?
        .join("uploads");
    
    if !uploads_dir.exists() {
        fs::create_dir_all(&uploads_dir)
            .map_err(|e| format!("Failed to create uploads directory: {}", e))?;
    }

    // Sanitize and get unique filename
    let sanitized_name = sanitize_filename(&file_name);
    let unique_filename = get_unique_filename(&uploads_dir, &sanitized_name);
    let file_path = uploads_dir.join(&unique_filename);

    // Write the file
    let mut file = fs::File::create(&file_path)
        .map_err(|e| format!("Failed to create file: {}", e))?;
    
    if is_base64 {
        // Decode base64 data using the new API
        let decoded = general_purpose::STANDARD
            .decode(&file_data)
            .map_err(|e| format!("Failed to decode base64: {}", e))?;
        file.write_all(&decoded)
            .map_err(|e| format!("Failed to write file: {}", e))?;
    } else {
        // Write raw data
        file.write_all(file_data.as_bytes())
            .map_err(|e| format!("Failed to write file: {}", e))?;
    }

    // Convert to CSV if it's an Excel file
    let file_extension = Path::new(&file_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("csv")
        .to_string()
        .to_lowercase();

    let final_path = if file_extension == "xlsx" || file_extension == "xls" {
        convert_excel_to_csv(&file_path, &app_handle)?
            .to_string_lossy()
            .to_string()
    } else {
        file_path.to_string_lossy().to_string()
    };

    Ok(final_path)
}

fn main() {
    println!("Starting Mimir application");

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .manage(PythonProcess::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let app_handle = app.handle();
            let state = app_handle.state::<AppState>();

            let mut chats = state.chats.lock().unwrap();
            chats.insert(
                "default".to_string(),
                ChatData {
                    history: Vec::new(),
                    csv_path: None,
                },
            );
            drop(chats);

            let mut current_chat = state.current_chat.lock().unwrap();
            *current_chat = "default".to_string();
            drop(current_chat);

            if let Err(e) = load_chats_sync(&app_handle, state) {
                println!("Could not load existing chats: {}", e);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_chat,
            switch_chat,
            get_current_chat,
            list_chats,
            delete_chat,
            set_csv_path,
            get_csv_path,
            clear_history,
            get_history,
            save_history,
            start_python_service,
            stop_python_service,
            analyze_query,
            load_csv_info,
            merge_files,
            merge_multiple_files,
            upload_file,
            save_and_process_file,
            login,
            logout,
            refresh_token,
            try_auto_login,
            request_password_reset,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn load_chats_sync(
    app_handle: &tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    if !app_dir.exists() {
        return Ok(());
    }

    let mut chats = state.chats.lock().unwrap();
    let mut current_chat = state.current_chat.lock().unwrap();

    for entry in
        std::fs::read_dir(&app_dir).map_err(|e| format!("Failed to read app directory: {}", e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.extension().map_or(false, |ext| ext == "json") {
            if let Some(file_name) = path.file_stem().and_then(|s| s.to_str()) {
                // Skip logininfo.json
                if file_name == "logininfo" {
                    continue;
                }

                match load_chat_data_blocking(app_handle, file_name) {
                    Ok(chat_data) => {
                        chats.insert(file_name.to_string(), chat_data);
                        println!("Loaded chat '{}'", file_name);
                    }
                    Err(e) => {
                        println!("Failed to load chat '{}': {}", file_name, e);
                    }
                }
            }
        }
    }

    if !chats.is_empty() && !chats.contains_key(&*current_chat) {
        if let Some(first_chat) = chats.keys().next() {
            *current_chat = first_chat.clone();
        }
    }

    Ok(())
}
