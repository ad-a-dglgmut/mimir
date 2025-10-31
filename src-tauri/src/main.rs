// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::collections::HashMap;
use tauri::{AppHandle, State, Emitter, Manager};
use serde::{Deserialize, Serialize};
use dirs;

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

fn save_chat_data_blocking(
    app_handle: &tauri::AppHandle,
    chat_name: &str,
    chat_data: &ChatData,
) -> Result<(), String> {
    let chat_json = serde_json::to_string_pretty(chat_data)
        .map_err(|e| format!("Failed to serialize chat data: {}", e))?;
    
    let app_dir = app_handle.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    
    std::fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;
    
    let chat_path = app_dir.join(format!("{}.json", chat_name));
    
    std::fs::write(&chat_path, chat_json)
        .map_err(|e| format!("Failed to save chat data: {}", e))?;
    
    Ok(())
}

fn load_chat_data_blocking(
    app_handle: &tauri::AppHandle,
    chat_name: &str,
) -> Result<ChatData, String> {
    let app_dir = app_handle.path()
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
    chats: Mutex<HashMap<String, ChatData>>, // Chat name -> ChatData
    current_chat: Mutex<String>, // Current active chat name
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
    recommended_prompts: Option<Vec<String>>,     // Add this
    mimir_recommends: Option<Vec<String>>,        // Add this
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
    state: State<'_, AppState>
) -> Result<String, String> {
    let mut chats = state.chats.lock().unwrap();
    
    if chats.contains_key(&chat_name) {
        return Err(format!("Chat '{}' already exists", chat_name));
    }
    
    // Create empty chat
    let chat_data = ChatData {
        history: Vec::new(),
        csv_path: None,
    };
    
    chats.insert(chat_name.clone(), chat_data);
    
    // Set as current chat
    let mut current_chat = state.current_chat.lock().unwrap();
    *current_chat = chat_name.clone();
    
    // Save empty chat to file
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
async fn switch_chat(
    chat_name: String,
    state: State<'_, AppState>
) -> Result<String, String> {
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
    state: State<'_, AppState>
) -> Result<String, String> {
    let mut chats = state.chats.lock().unwrap();
    
    if !chats.contains_key(&chat_name) {
        return Err(format!("Chat '{}' not found", chat_name));
    }
    
    // Don't allow deleting the current chat
    let current_chat = state.current_chat.lock().unwrap();
    if *current_chat == chat_name {
        return Err("Cannot delete the current chat. Switch to another chat first.".to_string());
    }
    
    chats.remove(&chat_name);
    
    // Delete the file
    let app_dir = app_handle.path()
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
    state: State<'_, AppState>
) -> Result<String, String> {
    let current_chat = state.current_chat.lock().unwrap();
    let mut chats = state.chats.lock().unwrap();
    
    if let Some(chat_data) = chats.get_mut(&*current_chat) {
        chat_data.csv_path = Some(csv_path.clone());
        
        // Save updated chat data
        let app_handle_clone = app_handle.clone();
        let current_chat_clone = current_chat.clone();
        let chat_data_clone = chat_data.clone();
        
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) = save_chat_data_blocking(&app_handle_clone, &current_chat_clone, &chat_data_clone) {
                eprintln!("Warning: Could not save CSV path: {}", e);
            }
        });
        
        Ok(format!("CSV path set to '{}' for chat '{}'", csv_path, current_chat))
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
    state: State<'_, AppState>
) -> Result<String, String> {
    let current_chat = state.current_chat.lock().unwrap();
    let mut chats = state.chats.lock().unwrap();
    
    if let Some(chat_data) = chats.get_mut(&*current_chat) {
        let count = chat_data.history.len();
        chat_data.history.clear();
        
        // Save updated chat data
        let app_handle_clone = app_handle.clone();
        let current_chat_clone = current_chat.clone();
        let chat_data_clone = chat_data.clone();
        
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) = save_chat_data_blocking(&app_handle_clone, &current_chat_clone, &chat_data_clone) {
                eprintln!("Warning: Could not save cleared history: {}", e);
            }
        });
        
        Ok(format!("Cleared {} history items from chat '{}'", count, current_chat))
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
    state: State<'_, AppState>
) -> Result<String, String> {
    let current_chat = state.current_chat.lock().unwrap();
    let chats = state.chats.lock().unwrap();
    
    if let Some(chat_data) = chats.get(&*current_chat) {
        let app_handle_clone = app_handle.clone();
        let current_chat_clone = current_chat.clone();
        let chat_data_clone = chat_data.clone();
        
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) = save_chat_data_blocking(&app_handle_clone, &current_chat_clone, &chat_data_clone) {
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
async fn start_python_service(app_handle: tauri::AppHandle, state: State<'_, PythonProcess>) -> Result<String, String> {
    let mut process_lock = state.process.lock().unwrap();
    
    if process_lock.is_some() {
        return Ok("Python service already running".to_string());
    }

    // Get the path to the Python analyzer script
    let analyzer_path = get_python_analyzer_path(&app_handle)
        .map_err(|e| format!("Failed to get Python analyzer path: {}", e))?;

    let child = Command::new("python")
        .arg(&analyzer_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start Python: {}", e))?;

    *process_lock = Some(child);
    Ok("Python service started".to_string())
}

#[tauri::command]
async fn stop_python_service(state: State<'_, PythonProcess>) -> Result<String, String> {
    let mut process_lock = state.process.lock().unwrap();
    
    if let Some(mut child) = process_lock.take() {
        child.kill().map_err(|e| format!("Failed to stop Python: {}", e))?;
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
    state: State<'_, AppState>
) -> Result<AnalysisResponse, String> {
    log_to_frontend(&app_handle, &format!("Analyzing: {}", query));

    // Get the path to the Python executable and analyzer script
    let (python_bin, analyzer_path) = get_python_paths(&app_handle)
        .map_err(|e| format!("Failed to get Python paths: {}", e))?;

    // Get current chat and its history
    let current_chat = state.current_chat.lock().unwrap();
    let mut chats = state.chats.lock().unwrap();
    
    let chat_data = chats.get_mut(&*current_chat)
        .ok_or("Current chat not found".to_string())?;
    
    // Update CSV path for this chat
    chat_data.csv_path = Some(csv_path.clone());
    
    let history_json = serde_json::to_string(&chat_data.history)
        .map_err(|e| format!("Failed to serialize history: {}", e))?;

    // Pass the CSV path, query, AND history to Python
    let mut command = Command::new(&python_bin);
    command.arg(&analyzer_path);
    command.arg(csv_path.clone());
    command.arg(query.clone());
    command.arg(history_json);

    if let Ok(api_key) = std::env::var("GROQ_API_KEY") {
        command.env("GROQ_API_KEY", api_key);
    }

    let output = command.output()
        .map_err(|e| format!("Failed to execute Python: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    println!("=== Python STDOUT ===");
    println!("{}", stdout);
    println!("=== Python STDERR ===");
    println!("{}", stderr);
    println!("=====================");

    let response = parse_python_output(&stdout, &stderr);

    // Add to history
    chat_data.history.push(QueryHistory {
        query: query.clone(),
        response: response.clone(),
        timestamp: chrono::Local::now().to_rfc3339(),
    });

    // Auto-save chat data (including history and CSV path)
    let app_handle_clone = app_handle.clone();
    let current_chat_clone = current_chat.clone();
    let chat_data_clone = chat_data.clone();
    
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = save_chat_data_blocking(&app_handle_clone, &current_chat_clone, &chat_data_clone) {
            eprintln!("Warning: Could not save chat data: {}", e);
        }
    });

    Ok(response)
}

#[tauri::command]
async fn load_csv_info(app_handle: tauri::AppHandle, csv_path: String) -> Result<Vec<Vec<String>>, String> {
    use std::path::Path;
    use std::process::Command;

    // Get the path to the Python executable
    let (python_bin, _) = get_python_paths(&app_handle)
        .map_err(|e| format!("Failed to get Python paths: {}", e))?;

    // Determine file extension (case-insensitive)
    let ext = Path::new(&csv_path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Choose how to load based on extension
    let read_cmd = match ext.as_str() {
        "csv" => format!("pd.read_csv(r'{}')", csv_path),
        "xlsx" | "xls" => format!("pd.read_excel(r'{}')", csv_path),
        _ => return Err(format!("Unsupported file type: .{}", ext)),
    };

    // Python code that dynamically reads CSV or Excel
    let python_code = format!(r#"
import pandas as pd
import json
import sys

try:
    df = {}
    data = df.head(5).astype(str).values.tolist()
    print(json.dumps(data))
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
"#, read_cmd);

    // Run Python
    let output = Command::new(&python_bin)
        .arg("-c")
        .arg(python_code)
        .output()
        .map_err(|e| format!("Failed to run Python: {}", e))?;

    // Check for Python-side errors
    if !output.status.success() {
        return Err(format!(
            "Python error: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // Parse JSON back into Vec<Vec<String>>
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse JSON output: {}", e))
}

// Helper function to get Python paths
fn get_python_paths(app_handle: &AppHandle) -> Result<(String, String), String> {
    let resource_dir = app_handle.path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource directory: {}", e))?;

    // In development, the Python files are in src-tauri/python/
    // In production, they're in the resources directory
    let python_dir = resource_dir.join("python");
    
    if !python_dir.exists() {
        return Err("Python directory not found in resources".to_string());
    }

    // First try to find Python in the virtual environment
    let venv_python_bin = if cfg!(target_os = "windows") {
        python_dir.join("venv/bin/python.exe")
    } else {
        python_dir.join("venv/bin/python")
    };

    let analyzer_path = python_dir.join("analyzer.py");

    if !analyzer_path.exists() {
        return Err(format!("Analyzer script not found at: {:?}", analyzer_path));
    }

    // Check if venv Python exists, if not fall back to system Python
    let python_bin = if venv_python_bin.exists() {
        venv_python_bin.to_string_lossy().to_string()
    } else {
        println!("Virtual environment Python not found at {:?}, falling back to system Python", venv_python_bin);
        
        // Try to find system Python
        if cfg!(target_os = "windows") {
            // On Windows, try common Python locations and commands
            find_system_python().map_err(|e| format!("Failed to find system Python: {}", e))?
        } else {
            // On Unix-like systems, try 'python3' or 'python'
            "python3".to_string()
        }
    };

    // Verify the Python command works
    if !verify_python_command(&python_bin) {
        return Err(format!("Python command '{}' is not working. Please ensure Python is installed and in your PATH.", python_bin));
    }

    Ok((python_bin, analyzer_path.to_string_lossy().to_string()))
}

// Helper function to find system Python on Windows
fn find_system_python() -> Result<String, String> {
    // Try different Python commands in order of preference
    let commands = ["python", "python3", "py"];
    
    for cmd in commands.iter() {
        if verify_python_command(cmd) {
            println!("Found working Python command: {}", cmd);
            return Ok(cmd.to_string());
        }
    }
    
    // If no command works, try to find Python in common installation directories
    if let Some(install_path) = find_python_in_program_files() {
        println!("Found Python installation at: {}", install_path);
        return Ok(install_path);
    }
    
    Err("Could not find a working Python installation. Please install Python and ensure it's in your PATH.".to_string())
}

// Helper function to verify if a Python command works
fn verify_python_command(command: &str) -> bool {
    let output = Command::new(command)
        .arg("--version")
        .output();
    
    match output {
        Ok(output) => output.status.success(),
        Err(_) => false,
    }
}

// Helper function to find Python in Windows Program Files directories
fn find_python_in_program_files() -> Option<String> {
    let possible_paths = [
        r"C:\Program Files\Python311\python.exe",
        r"C:\Program Files\Python310\python.exe",
        r"C:\Program Files\Python39\python.exe",
        r"C:\Program Files\Python38\python.exe",
        r"C:\Program Files (x86)\Python311\python.exe",
        r"C:\Program Files (x86)\Python310\python.exe",
        r"C:\Program Files (x86)\Python39\python.exe",
        r"C:\Program Files (x86)\Python38\python.exe",
        r"C:\Users\*\AppData\Local\Programs\Python\Python311\python.exe",
        r"C:\Users\*\AppData\Local\Programs\Python\Python310\python.exe",
        r"C:\Users\*\AppData\Local\Programs\Python\Python39\python.exe",
        r"C:\Users\*\AppData\Local\Programs\Python\Python38\python.exe",
    ];

    for path_pattern in possible_paths.iter() {
        // Handle paths with wildcards for user directories
        if path_pattern.contains('*') {
            if let Some(home_dir) = dirs::home_dir() {
                let path = path_pattern.replace('*', &home_dir.to_string_lossy());
                if std::path::Path::new(&path).exists() {
                    return Some(path);
                }
            }
        } else if std::path::Path::new(path_pattern).exists() {
            return Some(path_pattern.to_string());
        }
    }

    None
}

// Helper function to get just the analyzer path
fn get_python_analyzer_path(app_handle: &AppHandle) -> Result<String, String> {
    let resource_dir = app_handle.path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource directory: {}", e))?;

    let python_dir = resource_dir.join("python");
    let analyzer_path = python_dir.join("analyzer.py");

    if !analyzer_path.exists() {
        return Err(format!("Analyzer script not found at: {:?}", analyzer_path));
    }

    Ok(analyzer_path.to_string_lossy().to_string())
}

fn parse_python_output(stdout: &str, stderr: &str) -> AnalysisResponse {
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

    // Helper function to extract section safely
    fn extract_section(stdout: &str, marker: &str) -> String {
        if let Some(start) = stdout.find(marker) {
            let content_start = start + marker.len();
            let remaining = &stdout[content_start..];
            
            // Find the next section marker or use the end
            let end = remaining.find("===")
                .unwrap_or(remaining.len());
            
            remaining[..end].trim().to_string()
        } else {
            String::new()
        }
    }

    // Extract sections safely
    response.code = extract_section(stdout, "=== Cleaned code ===");
    response.result = extract_section(stdout, "=== 📊 Result ===");
    response.summary = extract_section(stdout, "=== Analysis Summary ===");
    
    // Extract chart section
    if let Some(chart_start) = stdout.find("=== ECharts JSON ===") {
        let chart_content = &stdout[chart_start + 20..];
        let chart_end = chart_content.find("===")
            .unwrap_or(chart_content.len());
        let chart_text = chart_content[..chart_end].trim();
        if !chart_text.is_empty() {
            response.chart = Some(chart_text.to_string());
        }
    }

    // Extract recommended prompts - EXACT MATCH TO PYTHON OUTPUT
    if let Some(prompts_start) = stdout.find("=== Recommended Prompts JSON ===") {
        let prompts_content = &stdout[prompts_start + 31..];
        let prompts_end = prompts_content.find("===").unwrap_or(prompts_content.len());
        let prompts_text = prompts_content[..prompts_end].trim();
        
        println!("Found recommended prompts JSON text: '{}'", prompts_text);
        
        if !prompts_text.is_empty() {
            match serde_json::from_str::<Vec<String>>(prompts_text) {
                Ok(prompts) => {
                    println!("Successfully parsed {} recommended prompts", prompts.len());
                    response.recommended_prompts = Some(prompts);
                },
                Err(e) => {
                    println!("Failed to parse recommended prompts JSON '{}': {}", prompts_text, e);
                    // Try to extract array from malformed JSON
                    if let Some(array_start) = prompts_text.find('[') {
                        if let Some(array_end) = prompts_text.find(']') {
                            let array_text = &prompts_text[array_start..=array_end];
                            println!("Trying to extract array from: '{}'", array_text);
                            if let Ok(prompts) = serde_json::from_str::<Vec<String>>(array_text) {
                                println!("Successfully extracted {} prompts from malformed JSON", prompts.len());
                                response.recommended_prompts = Some(prompts);
                            }
                        }
                    }
                },
            }
        }
    } else {
        println!("Could not find '=== Recommended Prompts JSON ===' section");
        // Try alternative patterns
        if stdout.contains("Recommended Prompts JSON") {
            println!("Found alternative 'Recommended Prompts JSON' text, trying to extract...");
            // Look for any JSON array after this text
            if let Some(json_start) = stdout.find("[\"") {
                if let Some(json_end) = stdout[json_start..].find(']') {
                    let array_text = &stdout[json_start..=json_start + json_end];
                    println!("Found potential JSON array: '{}'", array_text);
                    if let Ok(prompts) = serde_json::from_str::<Vec<String>>(array_text) {
                        println!("Successfully parsed {} prompts from alternative location", prompts.len());
                        response.recommended_prompts = Some(prompts);
                    }
                }
            }
        }
    }

    // Extract Mimir recommends - EXACT MATCH TO PYTHON OUTPUT
    if let Some(recommends_start) = stdout.find("=== Mimir Recommends JSON ===") {
        let recommends_content = &stdout[recommends_start + 28..];
        let recommends_end = recommends_content.find("===").unwrap_or(recommends_content.len());
        let recommends_text = recommends_content[..recommends_end].trim();
        
        println!("Found Mimir recommends JSON text: '{}'", recommends_text);
        
        if !recommends_text.is_empty() {
            match serde_json::from_str::<Vec<String>>(recommends_text) {
                Ok(recommends) => {
                    println!("Successfully parsed {} Mimir recommends", recommends.len());
                    response.mimir_recommends = Some(recommends);
                },
                Err(e) => {
                    println!("Failed to parse Mimir recommends JSON '{}': {}", recommends_text, e);
                    // Try to extract array from malformed JSON
                    if let Some(array_start) = recommends_text.find('[') {
                        if let Some(array_end) = recommends_text.find(']') {
                            let array_text = &recommends_text[array_start..=array_end];
                            println!("Trying to extract array from: '{}'", array_text);
                            if let Ok(recommends) = serde_json::from_str::<Vec<String>>(array_text) {
                                println!("Successfully extracted {} recommends from malformed JSON", recommends.len());
                                response.mimir_recommends = Some(recommends);
                            }
                        }
                    }
                },
            }
        }
    } else {
        println!("Could not find '=== Mimir Recommends JSON ===' section");
        // Try alternative patterns
        if stdout.contains("Mimir Recommends JSON") {
            println!("Found alternative 'Mimir Recommends JSON' text, trying to extract...");
            // Look for any JSON array after this text
            if let Some(json_start) = stdout.find("[\"") {
                if let Some(json_end) = stdout[json_start..].find(']') {
                    let array_text = &stdout[json_start..=json_start + json_end];
                    println!("Found potential JSON array: '{}'", array_text);
                    if let Ok(recommends) = serde_json::from_str::<Vec<String>>(array_text) {
                        println!("Successfully parsed {} recommends from alternative location", recommends.len());
                        response.mimir_recommends = Some(recommends);
                    }
                }
            }
        }
    }

    // Debug output to see what we found
    println!("=== PARSED RESPONSE SUMMARY ===");
    println!("Code length: {}", response.code.len());
    println!("Result length: {}", response.result.len());
    println!("Summary length: {}", response.summary.len());
    println!("Chart: {}", response.chart.as_ref().map(|c| c.len()).unwrap_or(0));
    println!("Recommended prompts: {:?}", response.recommended_prompts.as_ref().map(|v| v.len()));
    println!("Mimir recommends: {:?}", response.mimir_recommends.as_ref().map(|v| v.len()));
    println!("=================================");

    response
}

fn main() {
    dotenv::dotenv().ok(); 
    tauri::Builder::default()
        .manage(AppState::default())
        .manage(PythonProcess::default())
        .setup(|app| {
            let app_handle = app.handle();
            let state = app_handle.state::<AppState>();
            
            // Initialize with a default chat
            let mut chats = state.chats.lock().unwrap();
            chats.insert("default".to_string(), ChatData {
                history: Vec::new(),
                csv_path: None,
            });
            drop(chats);
            
            let mut current_chat = state.current_chat.lock().unwrap();
            *current_chat = "default".to_string();
            drop(current_chat);
            
            // Try to load existing chats
            if let Err(e) = load_chats_sync(&app_handle, state) {
                println!("Could not load existing chats: {}", e);
            }
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Chat management
            create_chat,
            switch_chat,
            get_current_chat,
            list_chats,
            delete_chat,
            
            // CSV path management
            set_csv_path,
            get_csv_path,
            
            // History management
            clear_history,
            get_history,
            save_history,
            
            // Python service
            start_python_service,
            stop_python_service,
            analyze_query,
            load_csv_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn load_chats_sync(app_handle: &tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let app_dir = app_handle.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    
    if !app_dir.exists() {
        return Ok(());
    }
    
    let mut chats = state.chats.lock().unwrap();
    let mut current_chat = state.current_chat.lock().unwrap();
    
    // Read all JSON files in the app data directory
    for entry in std::fs::read_dir(&app_dir)
        .map_err(|e| format!("Failed to read app directory: {}", e))? 
    {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();
        
        if path.extension().map_or(false, |ext| ext == "json") {
            if let Some(chat_name) = path.file_stem().and_then(|s| s.to_str()) {
                match load_chat_data_blocking(app_handle, chat_name) {
                    Ok(chat_data) => {
                        chats.insert(chat_name.to_string(), chat_data);
                        println!("Loaded chat '{}'", chat_name);
                    }
                    Err(e) => {
                        println!("Failed to load chat '{}': {}", chat_name, e);
                    }
                }
            }
        }
    }
    
    // Set current chat to the first available chat, or keep "default"
    if !chats.is_empty() && !chats.contains_key(&*current_chat) {
        if let Some(first_chat) = chats.keys().next() {
            *current_chat = first_chat.clone();
        }
    }
    
    Ok(())
}
