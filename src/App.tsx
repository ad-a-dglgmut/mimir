"use client"

import type React from "react"
import { useState, useEffect, useRef } from "react"
import * as echarts from "echarts"
import {
  FileText,
  BarChart3,
  Loader2,
  Database,
  Plus,
  MessageSquare,
  Trash2,
  Lightbulb,
  Brain,
  Sparkles,
  ChevronUp,
  Menu,
  X,
  Zap,
  Activity,
  FileDown,
  Moon,
  Sun,
  LogOut,
  User,
  Key,
  Download,
  Image,
  FileSpreadsheet,
} from "lucide-react"
import { Window } from "@tauri-apps/api/window"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import "./App.css"
import { Drawer, DrawerContent, DrawerHeader, DrawerFooter, DrawerTitle } from "./components/ui/drawer"
import { check } from "@tauri-apps/plugin-updater"
import type { Update } from "@tauri-apps/plugin-updater"
import LightIcon from "./assets/logo_notext_light.png"
import DarkIcon from "./assets/logo_notext.png"

// ========== INTERFACES ==========

interface AnalysisResponse {
  raw_output: string
  code: string
  result: string
  summary: string
  chart?: string
  error?: string
  recommended_prompts?: string[]
  mimir_recommends?: string[]
}

type FileDropPayload = {
  type: "over" | "drop" | "cancel"
  paths: string[]
}

interface HistoryItem {
  id: number
  query: string
  response: AnalysisResponse
  timestamp: string
  showRecommendedPrompts?: boolean
}

interface FileInfo {
  name: string
  path: string
  columns: string[]
  preview: string[][]
}

interface MergeFileConfig {
  file_path: string
  merge_column: string
  merge_type: 'inner' | 'left' | 'right' | 'outer'
}

interface MergeConfig {
  primaryFile: string
  filesToMerge: MergeFileConfig[]
}

interface ChatInfo {
  name: string
  created_at: string
  message_count: any
  csv_path: any
}

interface ExportModalState {
  isOpen: boolean;
  type: 'png' | 'svg' | 'csv' | null;
  dataUrl?: string;
  chartJson?: string;
  fileName?: string;
  fileContent?: string;
}

// ========== Tauri-specific file handling ==========

declare global {
  interface File {
    path?: string;
  }
}

// ========== MAIN COMPONENT ==========

export default function MimirApp() {
  // ========== STATE ==========
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false)
  const [isCheckingAuth, setIsCheckingAuth] = useState<boolean>(true)
  const [username, setUsername] = useState<string>("")
  
  const [loginUsername, setLoginUsername] = useState<string>("")
  const [loginPassword, setLoginPassword] = useState<string>("")
  const [rememberMe, setRememberMe] = useState<boolean>(true)
  const [loginError, setLoginError] = useState<string>("")
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false)

  const [showForgotPassword, setShowForgotPassword] = useState<boolean>(false)
  const [resetEmail, setResetEmail] = useState<string>("")
  const [isResetting, setIsResetting] = useState<boolean>(false)
  const [resetMessage, setResetMessage] = useState<string>("")
  const [resetError, setResetError] = useState<string>("")

  const [csvPath, setCsvPath] = useState<string>("")
  const [fileName, setFileName] = useState<string>("")
  const [query, setQuery] = useState<string>("")
  const [loading, setLoading] = useState<boolean>(false)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [isDragging, setIsDragging] = useState<boolean>(false)
  const [theme, setTheme] = useState<"light" | "dark">("dark")

  const [chats, setChats] = useState<ChatInfo[]>([])
  const [currentChat, setCurrentChat] = useState<string>("default")
  const [showChatSidebar, setShowChatSidebar] = useState<boolean>(true)
  const [showNewChatModal, setShowNewChatModal] = useState<boolean>(false)
  const [newChatName, setNewChatName] = useState<string>("")

  const [uploadedFiles, setUploadedFiles] = useState<FileInfo[]>([])
  const [showMergeModal, setShowMergeModal] = useState<boolean>(false)
  const [matchingColumns, setMatchingColumns] = useState<string[]>([])
  const [chatToDelete, setChatToDelete] = useState<string | null>(null)

  const [mergeConfig, setMergeConfig] = useState<MergeConfig>({
    primaryFile: '',
    filesToMerge: []
  })

  const [globalRecommendedPrompts, setGlobalRecommendedPrompts] = useState<string[]>([])
  const [exportModal, setExportModal] = useState<ExportModalState>({
    isOpen: false,
    type: null
  })

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const historyContainerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [updateInfo, setUpdateInfo] = useState<Update | null>(null)
  const [updating, setUpdating] = useState(false)
  const [showUpdateNotification, setShowUpdateNotification] = useState<boolean>(false)

  // ========== LOGO CONFIG ==========
  const logoPath = theme === "dark" ? DarkIcon : LightIcon 
  const iconPath = theme === "dark" ? DarkIcon : LightIcon

  // ========== USE EFFECTS ==========

  useEffect(() => {
    checkForUpdates()
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [history])

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark")
  }, [theme])

  useEffect(() => {
    checkAutoLogin()
  }, [])

  useEffect(() => {
    if (isAuthenticated) {
      loadCurrentChat()
      loadChatList()
      loadGlobalRecommendedPrompts()
    }
  }, [isAuthenticated])

  useEffect(() => {
    const unlisten = listen("backend-log", (event) => {
      console.log("Backend log:", event.payload)
    })

    return () => {
      unlisten.then((f) => f())
    }
  }, [])

  useEffect(() => {
    const mainWindow = new Window("main")
    
    const setupDragDrop = async () => {
      const unlisten = await mainWindow.onDragDropEvent((event) => {
        const payload = event.payload as FileDropPayload
        console.log('Drag drop event:', payload.type, payload.paths)
        
        if (payload.type === "drop" && payload.paths.length > 0) {
          const filePaths = payload.paths
          console.log('Files dropped:', filePaths)
          
          if (filePaths.length === 1) {
            handleFileDropFromPath(filePaths[0])
          } else if (filePaths.length > 1) {
            handleMultipleFilesDropFromPaths(filePaths)
          }
        }
      })
      return unlisten
    }
    
    let cleanup: (() => void) | undefined
    
    setupDragDrop().then((unlisten) => {
      cleanup = unlisten
    }).catch(err => {
      console.error("Failed to setup drag drop:", err)
    })
    
    return () => {
      if (cleanup) cleanup()
    }
  }, [])

  // ========== UTILITY FUNCTIONS ==========

  const checkForUpdates = async () => {
    try {
      const update = await check()
      if (update !== null) {
        setUpdateInfo(update)
        setShowUpdateNotification(true)
      }
    } catch (err) {
      console.error("Update check failed:", err)
    }
  }

  const dismissUpdate = () => {
    setShowUpdateNotification(false)
  }

  const performUpdate = async () => {
    if (!updateInfo) return
    setUpdating(true)

    try {
      await updateInfo.downloadAndInstall()
      console.log("Update installed successfully!")
      setUpdating(false)
      setUpdateInfo(null)
      setShowUpdateNotification(true)
    } catch (err) {
      console.error("Update failed:", err)
      setUpdating(false)
    }
  }

  // ========== AUTH FUNCTIONS ==========

  const checkAutoLogin = async () => {
    setIsCheckingAuth(true)
    try {
      const result = await invoke<string>("try_auto_login")
      setUsername(result)
      setIsAuthenticated(true)
    } catch (err) {
      setIsAuthenticated(false)
    } finally {
      setIsCheckingAuth(false)
    }
  }

  const getLoginErrorMessage = (error: string): string => {
    const errorLower = error.toLowerCase();
    
    if (errorLower.includes('invalid credentials') || errorLower.includes('wrong password')) {
      return 'Invalid username or password. Please try again.';
    }
    
    if (errorLower.includes('user not found')) {
      return 'No account found with this username. Please check your credentials.';
    }
    
    if (errorLower.includes('network') || errorLower.includes('connection')) {
      return 'Network connection failed. Please check your internet connection.';
    }
    
    if (errorLower.includes('rate limit')) {
      return 'Too many login attempts. Please wait a few minutes and try again.';
    }
    
    if (errorLower.includes('database') || errorLower.includes('server')) {
      return 'Temporary server issue. Please try again in a moment.';
    }
    
    if (errorLower.includes('locked') || errorLower.includes('suspended')) {
      return 'Account temporarily locked. Please try again later or reset your password.';
    }
    
    return 'Login failed. Please check your credentials and try again.';
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoginError("")
    setIsLoggingIn(true)

    try {
      const result = await invoke<string>("login", {
        loginInfo: {
          username: loginUsername,
          password: loginPassword,
        },
        saveLoginBoolean: rememberMe,
      })
      
      setUsername(result)
      setIsAuthenticated(true)
      setLoginUsername("")
      setLoginPassword("")
    } catch (err) {
      const errorMessage = getLoginErrorMessage(err as string)
      setLoginError(errorMessage)
      setLoginPassword("")
    } finally {
      setIsLoggingIn(false)
    }
  }

  const getPasswordResetErrorMessage = (error: string): string => {
    const errorLower = error.toLowerCase();
    
    if (errorLower.includes('user not found') || errorLower.includes('email not found')) {
      return 'No account found with this email address.';
    }
    
    if (errorLower.includes('rate limit')) {
      return 'Too many reset attempts. Please wait before trying again.';
    }
    
    if (errorLower.includes('invalid email')) {
      return 'Please enter a valid email address.';
    }
    
    if (errorLower.includes('network') || errorLower.includes('connection')) {
      return 'Network connection failed. Please check your internet connection.';
    }
    
    return 'Failed to send reset email. Please try again.';
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!resetEmail.trim()) {
      setResetError("Please enter your email address")
      return
    }

    setIsResetting(true)
    setResetError("")
    setResetMessage("")

    try {
      //@ts-ignore
      const result = await invoke<string>("request_password_reset", {
        email: resetEmail,
      })
      
      setResetMessage("Password reset email sent. Please check your inbox.")
      setResetEmail("")
      setTimeout(() => {
        setShowForgotPassword(false)
        setResetMessage("")
      }, 3000)
    } catch (err) {
      const errorMessage = getPasswordResetErrorMessage(err as string)
      setResetError(errorMessage)
    } finally {
      setIsResetting(false)
    }
  }

  const handleLogout = async () => {
    try {
      await invoke("logout")
      setIsAuthenticated(false)
      setUsername("")
      setHistory([])
      setChats([])
      setCsvPath("")
      setFileName("")
      setUploadedFiles([])
    } catch (err) {
      console.error("Logout error:", err)
    }
  }

  // ========== EXPORT FUNCTIONS ==========

  const exportChartAsPNG = async (chartInstance: echarts.ECharts | null) => {
    if (!chartInstance) return
    
    try {
      const dataUrl = chartInstance.getDataURL({
        type: 'png',
        pixelRatio: 2,
        backgroundColor: theme === "dark" ? '#1a1a1a' : '#ffffff'
      })
      
      setExportModal({
        isOpen: true,
        type: 'png',
        dataUrl,
        fileName: `chart-${new Date().getTime()}.png`
      })
    } catch (err) {
      console.error('Failed to export chart:', err)
      alert('Failed to export chart. Please try again.')
    }
  }

  const exportChartAsSVG = async (chartInstance: echarts.ECharts | null) => {
    if (!chartInstance) return
    
    try {
      const svgDataUrl = chartInstance.getDataURL({
        type: 'svg',
        backgroundColor: theme === "dark" ? '#1a1a1a' : '#ffffff'
      })
      
      // Extract SVG content from data URL
      const svgContent = atob(svgDataUrl.split(',')[1])
      
      setExportModal({
        isOpen: true,
        type: 'svg',
        fileContent: svgContent,
        fileName: `chart-${new Date().getTime()}.svg`
      })
    } catch (err) {
      console.error('Failed to export chart as SVG:', err)
      alert('Failed to export chart. Please try again.')
    }
  }

  const exportChartDataAsCSV = async (chartJson?: string) => {
    if (!chartJson) return
    
    try {
      const config = JSON.parse(chartJson)
      let csvContent = ''
      
      // Extract data from chart configuration
      if (config.dataset && config.dataset.source) {
        const data = config.dataset.source
        if (Array.isArray(data) && data.length > 0) {
          // Assuming first row is headers
          const headers = data[0]
          const rows = data.slice(1)
          
          csvContent = headers.join(',') + '\n'
          rows.forEach(row => {
            csvContent += row.join(',') + '\n'
          })
        }
      } else if (config.series && config.series[0] && config.series[0].data) {
        // For simple charts, try to extract data from series
        const series = config.series[0]
        if (series.data && Array.isArray(series.data)) {
          if (config.xAxis && config.xAxis.data) {
            // For charts with xAxis categories
            csvContent = 'Category,Value\n'
            config.xAxis.data.forEach((category: string, index: number) => {
              const value = series.data[index]
              csvContent += `"${category}",${value}\n`
            })
          } else {
            // For numeric data
            csvContent = 'Value\n'
            series.data.forEach((value: number) => {
              csvContent += `${value}\n`
            })
          }
        }
      }
      
      if (csvContent) {
        setExportModal({
          isOpen: true,
          type: 'csv',
          fileContent: csvContent,
          fileName: `chart-data-${new Date().getTime()}.csv`
        })
      } else {
        alert('No data available to export from this chart.')
      }
    } catch (err) {
      console.error('Failed to export chart data:', err)
      alert('Failed to export chart data. Please try again.')
    }
  }

  const handleExportDownload = async () => {
    const { type, dataUrl, fileContent, fileName } = exportModal
    
    try {
      if (type === 'png' && dataUrl) {
        // For PNG, create download link
        const link = document.createElement('a')
        link.href = dataUrl
        link.download = fileName || 'chart.png'
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
      } else if ((type === 'svg' || type === 'csv') && fileContent) {
        // For SVG and CSV, create blob and download
        const blob = new Blob([fileContent], { 
          type: type === 'svg' ? 'image/svg+xml' : 'text/csv' 
        })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = fileName || `chart.${type}`
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)
      }
      
      // Close modal after download
      setExportModal({ isOpen: false, type: null })
      
    } catch (err) {
      console.error('Download failed:', err)
      alert('Download failed. Please try again.')
    }
  }

  // ========== FILE UPLOAD FUNCTIONS ==========

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (!files || files.length === 0) return

    console.log('Files selected via browser:', files.length, Array.from(files).map(f => f.name))

    try {
      const newFiles: FileInfo[] = []
      let firstFilePath = ""
      
      // Process each file
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        
        // Check if it's a supported file type
        if (file.name.toLowerCase().endsWith(".csv") || file.name.toLowerCase().match(/\.xlsx?$/)) {
          console.log(`Processing file ${i + 1}/${files.length}: ${file.name}`)
          
          try {
            // Use Tauri's upload_file command
            const filePath = await invoke<string>("upload_file", {
              fileName: file.name,
              fileData: await file.arrayBuffer()
            })
            
            if (filePath) {
              console.log(`File saved to: ${filePath}`)
              
              // Load file info
              const fileInfo = await loadFileInfoFromPath(filePath)
              newFiles.push(fileInfo)
              
              // Save the first file path to set as CSV path
              if (i === 0) {
                firstFilePath = filePath
              }
            }
          } catch (err) {
            console.error(`Failed to process file ${file.name}:`, err)
            alert(`Failed to process file "${file.name}". Please try again.`)
          }
        } else {
          alert(`File "${file.name}" is not a supported file type. Please select CSV or Excel files.`)
        }
      }
      
      // Update uploaded files state with all new files
      if (newFiles.length > 0) {
        setUploadedFiles(prev => {
          const existingPaths = new Set(prev.map(f => f.path))
          const uniqueNewFiles = newFiles.filter(file => !existingPaths.has(file.path))
          
          const updatedFiles = [...prev, ...uniqueNewFiles]
          
          if (updatedFiles.length >= 2) {
            findMatchingColumns(updatedFiles)
          }
          
          return updatedFiles
        })
        
        // Set the first file as the CSV path
        if (firstFilePath) {
          await setCsvPathForChat(firstFilePath)
        }
      }
      
    } catch (err) {
      console.error("Failed to load files:", err)
      alert("Failed to load files. Please try again.")
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
    }
  }

  const handleUploadAreaClick = () => {
    console.log('Upload area clicked')
    if (fileInputRef.current) {
      fileInputRef.current.click()
    }
  }

  const handleFileDropFromPath = async (filePath: string) => {
    try {
      await setCsvPathForChat(filePath)
      const fileInfo = await loadFileInfoFromPath(filePath)
      setUploadedFiles(prev => {
        const existingPaths = new Set(prev.map(f => f.path))
        if (!existingPaths.has(fileInfo.path)) {
          const updated = [...prev, fileInfo]
          if (updated.length >= 2) {
            findMatchingColumns(updated)
          }
          return updated
        }
        return prev
      })
    } catch (err) {
      console.error("Failed to load CSV:", err)
      alert("Failed to load CSV file. Please try again.")
    }
  }

  // ========== CHAT MANAGEMENT ==========

  const loadGlobalRecommendedPrompts = async () => {
    const generalPrompts = [
      "Show me the first 5 rows of the dataset",
      "What are the column names and data types?",
      "Show basic statistics for numeric columns",
      "Are there any missing values in the dataset?",
      "What are the most common values in each column?",
      "Show me correlations between numeric columns",
      "What are the unique values in categorical columns?",
      "Display the distribution of a specific column",
    ]
    setGlobalRecommendedPrompts(generalPrompts)
  }

  const loadCurrentChat = async () => {
    try {
      const history = await invoke<HistoryItem[]>("get_history")
      const reversedHistory = history.reverse().map((item) => ({
        ...item,
        showRecommendedPrompts: item.showRecommendedPrompts ?? true,
      }))
      setHistory(reversedHistory)

      const csvPath = await invoke<string | null>("get_csv_path")
      if (csvPath) {
        setCsvPath(csvPath)
        setFileName(csvPath.split(/[\\/]/).pop() || "")
      } else {
        clearCsvInfo()
      }
    } catch (err) {
      console.error("Failed to load current chat:", err)
      clearCsvInfo()
    }
  }

  const clearCsvInfo = () => {
    setFileName("")
    setCsvPath("")
  }

  const loadChatList = async () => {
    try {
      const chatList = await invoke<ChatInfo[]>("list_chats")
      setChats(chatList)
    } catch (err) {
      console.error("Failed to load chats:", err)
    }
  }

  const loadCurrentChatName = async () => {
    try {
      const chatName = await invoke<string>("get_current_chat")
      setCurrentChat(chatName)
    } catch (err) {
      console.error("Failed to get current chat:", err)
    }
  }

  const handleCreateChat = async () => {
    if (!newChatName.trim()) return

    try {
      await invoke("create_chat", { chatName: newChatName })
      setNewChatName("")
      setShowNewChatModal(false)
      await loadChatList()
      await loadCurrentChatName()
      await loadCurrentChat()
      clearCsvInfo()
      setUploadedFiles([])
    } catch (err) {
      alert(`Failed to create chat: ${err}`)
    }
  }

  const handleSwitchChat = async (chatName: string) => {
    try {
      await invoke("switch_chat", { chatName })
      setCurrentChat(chatName)
      await loadCurrentChat()
      setUploadedFiles([])
    } catch (err) {
      console.error("Failed to switch chat:", err)
    }
  }

  const setCsvPathForChat = async (path: string) => {
    try {
      await invoke("set_csv_path", { csvPath: path })
      setCsvPath(path)
      setFileName(path.split(/[\\/]/).pop() || "")
    } catch (err) {
      console.error("Failed to set CSV path:", err)
    }
  }

  // ========== ANALYSIS FUNCTIONS ==========

  const handleAnalyze = async () => {
    if (!query.trim()) return
    if (!csvPath) {
      alert("Please load a CSV file first")
      return
    }

    setLoading(true)
    try {
      const response = await invoke<AnalysisResponse>("analyze_query", {
        csvPath,
        query,
      })

      const newItem: HistoryItem = {
        id: Date.now(),
        query,
        response,
        timestamp: new Date().toLocaleTimeString(),
        showRecommendedPrompts: true,
      }

      setHistory((prev) => [newItem, ...prev])
      setQuery("")
      setTimeout(() => {
        historyContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" })
      }, 100)
    } catch (err) {
      console.error("Analyze error:", err)
      const errorItem: HistoryItem = {
        id: Date.now(),
        query,
        response: {
          error: (err as any)?.toString() ?? "Unknown error",
          raw_output: "",
          code: "",
          result: "",
          summary: "",
        },
        timestamp: new Date().toLocaleTimeString(),
        showRecommendedPrompts: true,
      }
      setHistory((prev) => [errorItem, ...prev])
    } finally {
      setLoading(false)
    }
  }

  const handlePromptClick = (prompt: string) => {
    setQuery(prompt)
  }

  const toggleItemRecommendedPrompts = (itemId: number) => {
    setHistory((prev) =>
      prev.map((item) =>
        item.id === itemId ? { ...item, showRecommendedPrompts: !item.showRecommendedPrompts } : item,
      ),
    )
  }

  // ========== FILE MANAGEMENT ==========

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)

    // For Tauri, we handle OS drag-and-drop through the Tauri event listener
    // The HTML5 drag-and-drop won't give us file paths
    console.log('HTML5 drag drop event - using Tauri handler instead')
    
    // In Tauri, OS drag-and-drop is handled by the Window event listener above
    // So we don't need to handle it here
  }

  const handleMultipleFilesDropFromPaths = async (filePaths: string[]) => {
    try {
      const newFiles: FileInfo[] = []
      for (const filePath of filePaths) {
        const fileInfo = await loadFileInfoFromPath(filePath)
        newFiles.push(fileInfo)
      }
      
      updateUploadedFilesWithNewFiles(newFiles)
    } catch (err) {
      console.error('Failed to load files:', err)
      alert('Failed to load some files. Please try again.')
    }
  }

  const updateUploadedFilesWithNewFiles = (newFiles: FileInfo[]) => {
    setUploadedFiles(prev => {
      const existingPaths = new Set(prev.map(f => f.path))
      const uniqueNewFiles = newFiles.filter(file => !existingPaths.has(file.path))
      
      const updatedFiles = [...prev, ...uniqueNewFiles]
      
      if (updatedFiles.length >= 2) {
        findMatchingColumns(updatedFiles)
      }
      
      return updatedFiles
    })
  }

  const loadFileInfoFromPath = async (filePath: string): Promise<FileInfo> => {
    try {
      const preview = await invoke<Array<Array<string>>>("load_csv_info", {
        csvPath: filePath
      })
      
      const columns = preview.length > 0 ? preview[0] : []
      
      return {
        name: filePath.split(/[\\/]/).pop() || filePath,
        path: filePath,
        columns,
        preview: preview.slice(0, 5)
      }
    } catch (err) {
      console.error('Error loading file info:', err)
      throw new Error(`Failed to load file ${filePath}`)
    }
  }

  const findMatchingColumns = (files: FileInfo[]) => {
    if (files.length < 2) return

    const allColumns = files.flatMap(file => file.columns)
    const columnCounts: Record<string, number> = {}
    
    allColumns.forEach(col => {
      columnCounts[col] = (columnCounts[col] || 0) + 1
    })
    
    const matches = Object.entries(columnCounts)
      .filter(([_, count]) => count >= 2)
      .map(([col]) => col)
    
    setMatchingColumns(matches)
    
    // Initialize merge config if we have exactly 2 files and matches
    if (files.length === 2 && matches.length > 0) {
      setMergeConfig({
        primaryFile: files[0].path,
        filesToMerge: [{
          file_path: files[1].path,
          merge_column: matches[0],
          merge_type: 'inner'
        }]
      })
    }
  }

  const removeUploadedFile = (filePath: string) => {
    setUploadedFiles(prev => prev.filter(file => file.path !== filePath))
    // Recalculate matching columns after removal
    if (uploadedFiles.length > 1) {
      const remainingFiles = uploadedFiles.filter(file => file.path !== filePath)
      if (remainingFiles.length >= 2) {
        findMatchingColumns(remainingFiles)
      } else {
        setMatchingColumns([])
      }
    } else {
      setMatchingColumns([])
    }
  }

  // ========== MERGE FUNCTIONS ==========

  const addFileToMerge = (filePath: string) => {
    if (!mergeConfig.primaryFile) {
      setMergeConfig({
        primaryFile: filePath,
        filesToMerge: []
      })
    } else {
      const file = uploadedFiles.find(f => f.path === filePath)
      const availableColumns = file ? getMatchingColumns(mergeConfig.primaryFile, filePath) : []
      
      setMergeConfig(prev => ({
        ...prev,
        filesToMerge: [
          ...prev.filesToMerge,
          {
            file_path: filePath,
            merge_column: availableColumns[0] || '',
            merge_type: 'inner'
          }
        ]
      }))
    }
  }

  const removeFileFromMerge = (filePath: string) => {
    if (filePath === mergeConfig.primaryFile) {
      setMergeConfig({
        primaryFile: '',
        filesToMerge: []
      })
    } else {
      setMergeConfig(prev => ({
        ...prev,
        filesToMerge: prev.filesToMerge.filter(f => f.file_path !== filePath)
      }))
    }
  }

  const updateMergeConfigForFile = (filePath: string, updates: Partial<MergeFileConfig>) => {
    setMergeConfig(prev => ({
      ...prev,
      filesToMerge: prev.filesToMerge.map(file => 
        file.file_path === filePath ? { ...file, ...updates } : file
      )
    }))
  }

  const getMatchingColumns = (primaryFilePath: string, secondaryFilePath: string): string[] => {
    const primaryFile = uploadedFiles.find(f => f.path === primaryFilePath)
    const secondaryFile = uploadedFiles.find(f => f.path === secondaryFilePath)
    
    if (!primaryFile || !secondaryFile) return []
    
    return primaryFile.columns.filter(col => 
      secondaryFile.columns.includes(col)
    )
  }

const handleMergeFiles = async () => {
  if (!mergeConfig.primaryFile || mergeConfig.filesToMerge.length === 0) {
    alert('Please select a primary file and at least one file to merge')
    return
  }

  const missingColumns = mergeConfig.filesToMerge.filter(file => !file.merge_column)
  if (missingColumns.length > 0) {
    alert('Please select merge columns for all files')
    return
  }

  try {
    console.log('Merging files:', mergeConfig)
    
    const mergedPath = await invoke<string>("merge_multiple_files", {
      primaryPath: mergeConfig.primaryFile,
      mergeConfigs: mergeConfig.filesToMerge.map(config => ({
        file_path: config.file_path,
        merge_column: config.merge_column,
        merge_type: config.merge_type
      }))
      // Note: app_handle is automatically passed by Tauri
    })

    console.log('Merge successful! Path:', mergedPath)
    
    await setCsvPathForChat(mergedPath)
    
    const mergedFilePaths = [
      mergeConfig.primaryFile,
      ...mergeConfig.filesToMerge.map(f => f.file_path)
    ]
    
    setUploadedFiles(prev => 
      prev.filter(file => !mergedFilePaths.includes(file.path))
    )
    
    setShowMergeModal(false)
    setMatchingColumns([])
    setMergeConfig({
      primaryFile: '',
      filesToMerge: []
    })
    
    alert(`Files merged successfully! Using: ${mergedPath.split(/[\\/]/).pop()}`)
  } catch (err) {
    console.error('Merge failed:', err)
    alert(`Merge failed: ${err}`)
    
    // Show more detailed error
    if (err instanceof Error) {
      console.error('Error details:', err.message, err.stack)
    }
  }
}

  // ========== COMPONENT RENDERERS ==========

  const ChartRenderer = ({ chartJson }: { chartJson?: string }) => {
    const chartRef = useRef<HTMLDivElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const chartInstance = useRef<echarts.ECharts | null>(null)

    useEffect(() => {
      if (!chartJson || !chartRef.current) return

      try {
        const config = JSON.parse(chartJson)
        
        // Handle text-only charts
        if (config.type === 'text' || config.text) {
          return
        }

        const chart = echarts.init(chartRef.current, theme === "dark" ? "dark" : undefined)
        chartInstance.current = chart

        const enhancedConfig = {
          ...config,
          backgroundColor: "transparent",
          textStyle: {
            color: theme === "dark" ? "#F9F9F9" : "#1a1a1a",
            fontSize: 12,
          },
          dataZoom: [
            {
              type: "slider",
              show: true,
              xAxisIndex: 0,
              left: "3%",
              right: "4%",
              bottom: "3%",
              height: 20,
              borderColor: theme === "dark" ? "hsl(220 15% 18%)" : "hsl(220 15% 85%)",
              textStyle: {
                color: theme === "dark" ? "#F9F9F9" : "#1a1a1a",
              },
              handleStyle: {
                color: theme === "dark" ? "hsl(220 15% 18%)" : "#0093F8",
                borderColor: theme === "dark" ? "#F9F9F9" : "#0093F8",
              },
            },
            {
              type: "inside",
              xAxisIndex: 0,
              zoomOnMouseWheel: false,
              moveOnMouseMove: true,
              moveOnMouseWheel: true,
            },
          ],
          tooltip: {
            trigger: "axis",
            backgroundColor: theme === "dark" ? "rgba(0, 0, 0, 0.8)" : "rgba(255, 255, 255, 0.95)",
            borderColor: theme === "dark" ? "hsl(220 15% 18%)" : "#0093F8",
            textStyle: {
              color: theme === "dark" ? "#F9F9F9" : "#1a1a1a",
            },
            ...config.tooltip,
          },
          xAxis: config.xAxis ? (Array.isArray(config.xAxis) ? config.xAxis.map((axis: any) => ({
            ...axis,
            axisLabel: {
              color: theme === "dark" ? "#F9F9F9" : "#1a1a1a",
              fontSize: 11,
              interval: 0,
              rotate: axis.axisLabel?.rotate || (axis.data?.length > 10 ? 45 : 0),
              ...axis.axisLabel,
            },
            axisLine: {
              lineStyle: {
                color: theme === "dark" ? "hsl(220 15% 18%)" : "hsl(220 15% 85%)",
              },
              ...axis.axisLine,
            },
          })) : {
            ...config.xAxis,
            axisLabel: {
              color: theme === "dark" ? "#F9F9F9" : "#1a1a1a",
              fontSize: 11,
              interval: 0,
              rotate: config.xAxis.axisLabel?.rotate || (config.xAxis.data?.length > 10 ? 45 : 0),
              ...config.xAxis.axisLabel,
            },
            axisLine: {
              lineStyle: {
                color: theme === "dark" ? "hsl(220 15% 18%)" : "hsl(220 15% 85%)",
              },
              ...config.xAxis.axisLine,
            },
          }) : undefined,
          yAxis: config.yAxis ? (Array.isArray(config.yAxis) ? config.yAxis.map((axis: any) => ({
            ...axis,
            axisLabel: {
              color: theme === "dark" ? "#F9F9F9" : "#1a1a1a",
              fontSize: 11,
              ...axis.axisLabel,
            },
            axisLine: {
              lineStyle: {
                color: theme === "dark" ? "hsl(220 15% 18%)" : "hsl(220 15% 85%)",
              },
              ...axis.axisLine,
            },
          })) : {
            ...config.yAxis,
            axisLabel: {
              color: theme === "dark" ? "#F9F9F9" : "#1a1a1a",
              fontSize: 11,
              ...config.yAxis.axisLabel,
            },
            axisLine: {
              lineStyle: {
                color: theme === "dark" ? "hsl(220 15% 18%)" : "hsl(220 15% 85%)",
              },
              ...config.yAxis.axisLine,
            },
          }) : undefined,
          grid: {
            left: "3%",
            right: "4%",
            bottom: "15%",
            top: config.title ? "15%" : "3%",
            containLabel: true,
            ...config.grid,
          },
          series: config.series?.map((series: any) => ({
            ...series,
            large: true,
            progressive: 200,
            progressiveThreshold: 1000,
          })),
        }

        chart.setOption(enhancedConfig)

        const handleResize = () => chart.resize()
        window.addEventListener("resize", handleResize)

        setTimeout(() => chart.resize(), 100)

        return () => {
          window.removeEventListener("resize", handleResize)
          chart.dispose()
          chartInstance.current = null
        }
      } catch (err) {
        console.error("ChartRenderer: Failed to render chart:", err)
      }
    }, [chartJson, theme])

    if (!chartJson) return null

    try {
      const config = JSON.parse(chartJson)
      if (config.type === 'text' || config.text) {
        return (
          <div className="bg-card border rounded-lg p-6">
            <div className="flex items-center gap-2 mb-4">
              <FileText className="w-5 h-5 text-primary" />
              <h3 className="font-semibold text-foreground">Analysis Output</h3>
            </div>
            <div className="bg-secondary/50 border rounded p-4">
              <pre className="text-sm font-mono text-foreground whitespace-pre-wrap break-words">
                {config.text || chartJson}
              </pre>
            </div>
          </div>
        )
      }
    } catch {
      // Not a text chart, continue with visual chart
    }

    return (
      <div className="bg-card border rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" />
            <h3 className="font-semibold text-foreground">Visualization</h3>
          </div>
          
          {/* Export buttons */}
          <div className="flex items-center gap-2">
            <div className="text-xs text-muted-foreground mr-2">Drag to pan • Scroll to zoom</div>
            <div className="flex gap-1">
              <button
                onClick={() => exportChartAsPNG(chartInstance.current)}
                className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-all"
                title="Export as PNG"
              >
                <Image className="w-4 h-4" />
              </button>
              <button
                onClick={() => exportChartAsSVG(chartInstance.current)}
                className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-all"
                title="Export as SVG"
              >
                <FileDown className="w-4 h-4" />
              </button>
              <button
                onClick={() => exportChartDataAsCSV(chartJson)}
                className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-all"
                title="Export data as CSV"
              >
                <FileSpreadsheet className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
        
        <div ref={containerRef} className="w-full overflow-x-auto">
          <div
            ref={chartRef}
            className="w-full h-[400px] min-w-[600px] bg-secondary/20 rounded border"
            style={{ minHeight: "400px" }}
          />
        </div>
      </div>
    )
  }

  const renderItemRecommendedPrompts = (item: HistoryItem) => {
    const promptsToShow = item.response.recommended_prompts && item.response.recommended_prompts.length > 0
      ? item.response.recommended_prompts
      : globalRecommendedPrompts

    if (!item.showRecommendedPrompts || promptsToShow.length === 0) return null

    return (
      <section className="bg-primary/5 border border-primary/20 rounded-lg p-6 mt-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Lightbulb className="w-5 h-5 text-primary" />
            <h3 className="font-semibold text-foreground">Suggested Follow-up Questions</h3>
          </div>
          <button
            onClick={() => toggleItemRecommendedPrompts(item.id)}
            className="p-1.5 text-primary hover:bg-primary/20 rounded transition-all"
            title="Hide suggestions"
          >
            <ChevronUp className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {promptsToShow.map((prompt, index) => (
            <button
              key={index}
              onClick={() => handlePromptClick(prompt)}
              className="text-left p-3 bg-card hover:bg-accent rounded-lg border hover:border-primary/50 transition-all text-sm text-foreground group"
            >
              <div className="flex items-start gap-2">
                <Sparkles className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                <span className="flex-1 break-words">{prompt}</span>
              </div>
            </button>
          ))}
        </div>
      </section>
    )
  }

  const renderInitialRecommendedPrompts = () => {
    if (history.length > 0 || globalRecommendedPrompts.length === 0) return null

    return (
      <section className="bg-primary/5 border border-primary/20 rounded-lg p-6 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Lightbulb className="w-5 h-5 text-primary" />
          <h3 className="font-semibold text-foreground">Suggested Questions</h3>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {globalRecommendedPrompts.map((prompt, index) => (
            <button
              key={index}
              onClick={() => handlePromptClick(prompt)}
              className="text-left p-3 bg-card hover:bg-accent rounded-lg border hover:border-primary/50 transition-all text-sm text-foreground group"
            >
              <div className="flex items-start gap-2">
                <Sparkles className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                <span className="flex-1 break-words">{prompt}</span>
              </div>
            </button>
          ))}
        </div>
      </section>
    )
  }

  const renderMimirRecommends = (recommendations?: string[]) => {
    if (!recommendations || recommendations.length === 0) return null

    return (
      <div className="bg-primary/5 border border-primary/20 rounded-lg p-6">
        <div className="flex items-center gap-2 mb-4">
          <Brain className="w-5 h-5 text-primary" />
          <h3 className="font-semibold text-foreground">Mimir Recommends</h3>
        </div>
        <div className="space-y-3">
          {recommendations.map((recommendation, index) => (
            <div key={index} className="flex items-start gap-3 p-3 bg-card rounded-lg border">
              <div className="w-2 h-2 bg-primary rounded-full mt-2 flex-shrink-0" />
              <p className="text-sm text-foreground flex-1 break-words">{recommendation}</p>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // ========== EXPORT MODAL COMPONENT ==========

  const ExportModal = () => {
    if (!exportModal.isOpen) return null

    const getModalTitle = () => {
      switch (exportModal.type) {
        case 'png': return 'Export as PNG Image'
        case 'svg': return 'Export as SVG Vector'
        case 'csv': return 'Export Data as CSV'
        default: return 'Export'
      }
    }

    const getModalDescription = () => {
      switch (exportModal.type) {
        case 'png': return 'Download a high-quality PNG image of your chart.'
        case 'svg': return 'Download an SVG vector file for scalable graphics.'
        case 'csv': return 'Download the chart data as a CSV file for further analysis.'
        default: return ''
      }
    }

    const getFilePreview = () => {
      if (exportModal.type === 'png' && exportModal.dataUrl) {
        return (
          <div className="flex justify-center">
            <img 
              src={exportModal.dataUrl} 
              alt="Chart preview" 
              className="max-w-full h-48 object-contain border rounded bg-white"
            />
          </div>
        )
      } else if (exportModal.type === 'csv' && exportModal.fileContent) {
        return (
          <div className="max-h-48 overflow-auto bg-secondary/30 border rounded p-3">
            <pre className="text-xs font-mono text-foreground whitespace-pre-wrap">
              {exportModal.fileContent.split('\n').slice(0, 10).join('\n')}
              {exportModal.fileContent.split('\n').length > 10 && '\n...'}
            </pre>
          </div>
        )
      } else if (exportModal.type === 'svg' && exportModal.fileContent) {
        return (
          <div className="max-h-48 overflow-auto bg-secondary/30 border rounded p-3">
            <pre className="text-xs font-mono text-foreground whitespace-pre-wrap">
              {exportModal.fileContent.substring(0, 200)}
              {exportModal.fileContent.length > 200 && '...'}
            </pre>
          </div>
        )
      }
      return null
    }

    return (
      <div className="fixed inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center z-50 p-4">
        <div className="bg-card border rounded-lg p-6 w-full max-w-md">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-foreground">{getModalTitle()}</h3>
            <button
              onClick={() => setExportModal({ isOpen: false, type: null })}
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-all"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <p className="text-muted-foreground mb-4">{getModalDescription()}</p>

          {getFilePreview()}

          <div className="flex gap-2 justify-end mt-6">
            <button
              onClick={() => setExportModal({ isOpen: false, type: null })}
              className="px-4 py-2 text-muted-foreground hover:bg-accent rounded transition-all"
            >
              Cancel
            </button>
            <button
              onClick={handleExportDownload}
              className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-all font-bold flex items-center gap-2"
            >
              <Download className="w-4 h-4" />
              Download
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ========== AUTH SCREENS ==========

  if (isCheckingAuth) {
    return (
      <div className={`min-h-screen bg-background flex items-center justify-center ${theme}`}>
        <div className="text-center">
          <div className="w-16 h-16 rounded-lg mx-auto mb-4 flex items-center justify-center">
            <img src={iconPath} alt="Mimir" className="w-10 h-10" />
          </div>
          <p className="text-foreground text-lg">Loading Mimir...</p>
        </div>
      </div>
    )
  }

  if (showForgotPassword) {
    return (
      <div className={`min-h-screen bg-background flex items-center justify-center p-4 ${theme}`}>
        <div className="w-full max-w-md">
          <div className="bg-card border rounded-xl p-8">
            <button
              onClick={() => setShowForgotPassword(false)}
              className="flex items-center gap-2 text-muted-foreground hover:text-foreground mb-6 transition-colors"
            >
              <ChevronUp className="w-4 h-4 rotate-90" />
              Back to login
            </button>

            <div className="text-center mb-8">
              <Key className="w-16 h-16 text-primary mx-auto mb-4" />
              <h1 className="text-3xl font-bold text-foreground mb-2">Reset Password</h1>
              <p className="text-muted-foreground">Enter your email to receive a reset link</p>
            </div>

            <form onSubmit={handleForgotPassword} className="space-y-4">
              {resetError && (
                <div className="bg-destructive/10 border border-destructive/50 rounded-lg p-3 text-destructive text-sm">
                  {resetError}
                </div>
              )}

              {resetMessage && (
                <div className="bg-primary/10 border border-primary/50 rounded-lg p-3 text-primary text-sm">
                  {resetMessage}
                </div>
              )}

              <div>
                <label htmlFor="email" className="block text-sm font-medium text-foreground mb-2">
                  Email Address
                </label>
                <input
                  id="email"
                  type="email"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  className="w-full px-4 py-3 bg-input border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary text-foreground placeholder:text-muted-foreground transition-all"
                  placeholder="Enter your email address"
                  required
                  disabled={isResetting}
                />
              </div>

              <button
                type="submit"
                disabled={isResetting}
                className="w-full py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed font-bold transition-all flex items-center justify-center gap-2"
              >
                {isResetting ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Sending reset link...
                  </>
                ) : (
                  <>
                    <Key className="w-5 h-5" />
                    Send Reset Link
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return (
      <div className={`min-h-screen bg-background flex items-center justify-center p-4 ${theme}`}>
        <div className="w-full max-w-md">
          <div className="bg-card border rounded-xl p-8">
            <div className="text-center mb-8">
              <div className="w-16 h-16 rounded-lg mx-auto mb-4 flex items-center justify-center">
                <img src={logoPath} alt="Mimir" />
              </div>
              <h1 className="text-3xl font-bold text-foreground mb-2">Mimir</h1>
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              {loginError && (
                <div className="bg-destructive/10 border border-destructive/50 rounded-lg p-3 text-destructive text-sm">
                  {loginError}
                </div>
              )}

              <div>
                <label htmlFor="username" className="block text-sm font-medium text-foreground mb-2">
                  Username
                </label>
                <input
                  id="username"
                  type="text"
                  value={loginUsername}
                  onChange={(e) => setLoginUsername(e.target.value)}
                  className="w-full px-4 py-3 bg-input border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary text-foreground placeholder:text-muted-foreground transition-all"
                  placeholder="Enter your username"
                  required
                  disabled={isLoggingIn}
                />
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-foreground mb-2">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  className="w-full px-4 py-3 bg-input border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary text-foreground placeholder:text-muted-foreground transition-all"
                  placeholder="Enter your password"
                  required
                  disabled={isLoggingIn}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <input
                    id="remember"
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="w-4 h-4 text-primary bg-input border rounded focus:ring-2 focus:ring-primary"
                    disabled={isLoggingIn}
                  />
                  <label htmlFor="remember" className="ml-2 text-sm text-foreground">
                    Remember me
                  </label>
                </div>

                <button
                  type="button"
                  onClick={() => setShowForgotPassword(true)}
                  className="text-sm text-primary hover:text-primary/80 transition-colors"
                  disabled={isLoggingIn}
                >
                  Forgot password?
                </button>
              </div>

              <button
                type="submit"
                disabled={isLoggingIn}
                className="w-full py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed font-bold transition-all flex items-center justify-center gap-2"
              >
                {isLoggingIn ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Logging in...
                  </>
                ) : (
                  <>
                    <User className="w-5 h-5" />
                    Login
                  </>
                )}
              </button>
            </form>

            <div className="mt-6 text-center">
              <button
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-2"
              >
                {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                Switch to {theme === "dark" ? "light" : "dark"} mode
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ========== MAIN APP ==========

  return (
    <div className={`min-h-screen bg-background flex overflow-hidden ${theme}`}>
      {/* Delete Confirmation Modal */}
      {chatToDelete && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-card border rounded-lg p-6 w-full max-w-md">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-destructive" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-foreground">Delete Chat</h3>
                <p className="text-sm text-muted-foreground">This action cannot be undone</p>
              </div>
            </div>
            
            <p className="text-foreground mb-6">
              Are you sure you want to delete chat <span className="font-bold text-primary">"{chatToDelete}"</span>?
              All messages and data in this chat will be permanently deleted.
            </p>
            
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setChatToDelete(null)}
                className="px-4 py-2 text-muted-foreground hover:bg-accent rounded transition-all"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  try {
                    await invoke("delete_chat", { chatName: chatToDelete })
                    await loadChatList()
                    if (currentChat === chatToDelete) {
                      const remainingChats = chats.filter((chat) => chat.name !== chatToDelete)
                      if (remainingChats.length > 0) {
                        await handleSwitchChat(remainingChats[0].name)
                      } else {
                        await invoke("create_chat", { chatName: "default" })
                        await loadChatList()
                        await loadCurrentChatName()
                      }
                    }
                    setChatToDelete(null)
                  } catch (err) {
                    alert(`Failed to delete chat: ${err}`)
                    setChatToDelete(null)
                  }
                }}
                className="px-4 py-2 bg-destructive text-destructive-foreground rounded hover:bg-destructive/90 transition-all font-bold flex items-center gap-2"
              >
                <Trash2 className="w-4 h-4" />
                Delete Chat
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Hidden file input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileSelect}
        accept=".csv,.xls,.xlsx"
        multiple
        className="hidden"
        onClick={(e) => {
          // Reset the value to allow selecting the same file again
          e.currentTarget.value = ''
        }}
      />
      
      {/* Export Modal */}
      <ExportModal />
      
      {/* Update Notification */}
      {showUpdateNotification && (
        <div className="fixed top-4 right-4 w-80 bg-card border border-primary/40 rounded-lg p-4 shadow-lg z-50 backdrop-blur-sm">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-6 h-6 bg-primary rounded-full flex items-center justify-center">
              {updating ? (
                <Loader2 className="w-3 h-3 text-primary-foreground animate-spin" />
              ) : (
                <Sparkles className="w-3 h-3 text-primary-foreground" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              {updating ? (
                <>
                  <h4 className="font-bold text-foreground text-sm mb-1">Installing Update</h4>
                  <p className="text-muted-foreground text-xs mb-3">This may take a few moments</p>
                  <div className="w-full bg-secondary rounded-full h-1.5 mb-2">
                    <div className="bg-primary h-1.5 rounded-full animate-pulse" />
                  </div>
                </>
              ) : updateInfo ? (
                <>
                  <h4 className="font-bold text-foreground text-sm mb-1">Update Available</h4>
                  <p className="text-muted-foreground text-xs mb-3">Version {updateInfo.version} is ready to install</p>
                  <div className="flex gap-2">
                    <button
                      onClick={performUpdate}
                      className="flex-1 py-2 bg-primary text-primary-foreground text-sm font-medium rounded hover:bg-primary/90 transition-all flex items-center justify-center gap-2"
                    >
                      <Zap className="w-3 h-3" />
                      Install Now
                    </button>
                    <button
                      onClick={dismissUpdate}
                      className="px-3 py-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-all text-sm"
                    >
                      Later
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h4 className="font-bold text-foreground text-sm mb-1">Update Installed</h4>
                  <p className="text-muted-foreground text-xs mb-3">Please restart the app to apply changes</p>
                  <div className="bg-primary/10 border border-primary/30 rounded p-3">
                    <p className="text-primary text-xs font-medium text-center">
                      Close and reopen Mimir to complete the update
                    </p>
                  </div>
                  <div className="flex justify-end mt-3">
                    <button
                      onClick={dismissUpdate}
                      className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded hover:bg-primary/90 transition-all"
                    >
                      Got it
                    </button>
                  </div>
                </>
              )}
            </div>
            {!updating && (
              <button
                onClick={dismissUpdate}
                className="flex-shrink-0 w-5 h-5 text-muted-foreground hover:text-foreground hover:bg-accent rounded flex items-center justify-center transition-all"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      )}

{/* Chat Sidebar */}
<Drawer open={showChatSidebar} onOpenChange={setShowChatSidebar} direction="left">
  <DrawerContent className="w-80 bg-sidebar backdrop-blur-sm border-r border-sidebar-border flex flex-col h-full">
    <DrawerHeader className="p-4 border-b border-sidebar-border flex-shrink-0">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded flex items-center justify-center">
            <img src={logoPath} alt="Mimir" />
          </div>
          <DrawerTitle className="text-lg font-bold text-sidebar-foreground">Mimir</DrawerTitle>
        </div>
        <button
          onClick={() => setShowNewChatModal(true)}
          className="p-2 text-primary hover:bg-primary/20 rounded transition-all"
          title="New Chat"
        >
          <Plus className="w-5 h-5" />
        </button>
      </div>

      <div className="bg-primary/10 border border-primary/20 p-3 rounded-lg mb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <User className="w-4 h-4 text-primary flex-shrink-0" />
            <span className="text-sm font-medium text-sidebar-foreground truncate">{username}</span>
          </div>
          <button
            onClick={handleLogout}
            className="p-1.5 text-sidebar-foreground/60 hover:text-destructive transition-colors cursor-pointer flex-shrink-0"
            title="Logout"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="bg-primary/10 border border-primary/20 p-3 rounded-lg">
        <p className="text-xs font-medium text-sidebar-foreground/70">Current Session</p>
        <p className="text-lg font-bold text-primary truncate">{currentChat}</p>
        <p className="text-xs text-sidebar-foreground/70 mt-1">
          {history.length} message{history.length !== 1 ? "s" : ""}
        </p>
        {csvPath && (
          <p className="text-xs text-primary/90 mt-1 truncate flex items-center gap-1" title={csvPath}>
            <Database className="w-3 h-3 flex-shrink-0" />
            <span className="truncate block max-w-52 overflow-hidden text-ellipsis whitespace-nowrap">{fileName}</span>
          </p>
        )}
      </div>
    </DrawerHeader>

    <div className="flex-1 overflow-y-auto min-h-0">
      <div className="h-full overflow-y-auto pr-2 custom-scrollbar">
        {chats.map((chat) => (
          <div
            key={chat.name}
            className={`p-3 border-b border-sidebar-border cursor-pointer hover:bg-sidebar-accent transition-all ${
              currentChat === chat.name ? "bg-primary/10 border-l-4 border-l-primary" : ""
            }`}
            onClick={() => handleSwitchChat(chat.name)}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <MessageSquare className="w-4 h-4 text-sidebar-foreground/60 flex-shrink-0" />
                <span className="font-medium text-sidebar-foreground truncate block overflow-hidden text-ellipsis whitespace-nowrap">{chat.name}</span>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <span className="text-xs text-sidebar-foreground/60 bg-sidebar-accent px-2 py-1 rounded shadow-sm">
                  {chat.message_count}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setChatToDelete(chat.name)
                  }}
                  className="p-1 text-sidebar-foreground/60 hover:text-destructive transition-colors"
                  title="Delete Chat"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
            <p className="text-xs text-sidebar-foreground/60 mt-1">
              {new Date(chat.created_at).toLocaleDateString()}
            </p>
            {chat.csv_path && (
              <p className="text-xs text-primary/80 mt-1 truncate flex items-center gap-1" title={chat.csv_path}>
                <Database className="w-3 h-3 flex-shrink-0" />
                <span className="truncate block overflow-hidden text-ellipsis whitespace-nowrap">{chat.csv_path.split(/[\\/]/).pop()}</span>
              </p>
            )}
          </div>
        ))}
      </div>
    </div>

    <DrawerFooter className="p-4 border-t border-sidebar-border flex-shrink-0">
      <button
        onClick={() => setShowChatSidebar(false)}
        className="w-full p-2 text-sidebar-foreground/70 hover:bg-sidebar-accent rounded transition-all flex items-center justify-center gap-2"
      >
        <X className="w-4 h-4" />
        Hide Sidebar
      </button>
    </DrawerFooter>
  </DrawerContent>
</Drawer>

      {showChatSidebar && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden backdrop-blur-sm"
          onClick={() => setShowChatSidebar(false)}
        />
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Bar */}
        <div className="bg-card backdrop-blur-sm border-b border-border p-4 flex-shrink-0">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              {!showChatSidebar && (
                <button
                  onClick={() => setShowChatSidebar(true)}
                  className="p-2 text-muted-foreground hover:bg-accent rounded transition-all"
                  title="Show Sessions"
                >
                  <Menu className="w-5 h-5" />
                </button>
              )}
              <div className="w-7 h-7 rounded flex items-center justify-center">
                <img src={iconPath} alt="Mimir" className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h1 className="text-xl font-bold text-foreground">Mimir</h1>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                className="p-2 text-muted-foreground hover:bg-accent rounded transition-all"
                title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              >
                {theme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>
              <div className="text-sm text-muted-foreground flex items-center gap-2 sm:gap-4 min-w-0">
                <span className="flex items-center gap-2 min-w-0">
                  <MessageSquare className="w-4 h-4 text-primary flex-shrink-0" />
                  <span className="font-semibold text-primary truncate hidden sm:inline block overflow-hidden text-ellipsis whitespace-nowrap max-w-[120px]">{currentChat}</span>
                </span>
                {csvPath && (
                  <span className="flex items-center gap-2 min-w-0">
                    <Database className="w-4 h-4 text-primary flex-shrink-0" />
                    <span className="font-semibold text-primary truncate hidden md:inline block overflow-hidden text-ellipsis whitespace-nowrap max-w-[150px]">{fileName}</span>
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-6xl mx-auto p-4 sm:p-6 w-full">
            
            {/* File Upload Section */}
            <header className="bg-card border rounded-lg p-6 mb-6">
              <div
                className={`flex flex-col items-center justify-center border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-all duration-300 ${
                  isDragging
                    ? "border-primary bg-primary/20"
                    : "border-primary/40 bg-secondary/30 hover:bg-accent/50 hover:border-primary/60"
                }`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={handleUploadAreaClick}
              >
                <FileDown
                  className={`w-12 h-12 text-primary mb-4 ${isDragging ? "scale-110" : ""}`}
                />
                <p className="text-foreground font-semibold text-lg mb-2">
                  Select file or multiple files to analyze 
                </p>
                <p className="text-muted-foreground/70 text-sm mt-2">
                  Supports .csv, .xls and .xlsx files • Upload multiple files to merge them
                </p>
              </div>

              {/* Uploaded Files List */}
              {uploadedFiles.length > 0 && (
                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-foreground">Uploaded Files</h3>
                    {uploadedFiles.length >= 2 && (
                      <button
                        onClick={() => setShowMergeModal(true)}
                        className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-all font-medium text-sm flex items-center gap-2"
                      >
                        <Database className="w-4 h-4" />
                        Merge Files
                        {matchingColumns.length > 0 && (
                          <span className="text-xs bg-white/20 px-2 py-0.5 rounded">
                            ({matchingColumns.length} matching columns)
                          </span>
                        )}
                      </button>
                    )}
                  </div>
                  
                  {uploadedFiles.map((file) => (
                    <div key={file.path} className="bg-primary/10 border border-primary/20 rounded-lg p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <Database className="w-5 h-5 text-primary flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="font-bold text-primary truncate block overflow-hidden text-ellipsis whitespace-nowrap">{file.name}</p>
                            <p className="text-sm text-muted-foreground mt-1">
                              {file.columns.length} columns • {file.preview.length - 1} rows
                            </p>
                            <div className="flex flex-wrap gap-1 mt-2">
                              {file.columns.slice(0, 4).map((col, idx) => (
                                <span key={idx} className="px-2 py-1 bg-primary/20 text-primary text-xs rounded">
                                  {col}
                                </span>
                              ))}
                              {file.columns.length > 4 && (
                                <span className="px-2 py-1 bg-primary/10 text-primary text-xs rounded">
                                  +{file.columns.length - 4} more
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={() => removeUploadedFile(file.path)}
                          className="p-2 text-destructive hover:bg-destructive/20 rounded transition-all ml-2"
                          title="Remove file"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Current file info */}
              {fileName && (
                <div className="mt-4 p-4 bg-primary/10 border border-primary/20 rounded-lg">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Database className="w-5 h-5 text-primary" />
                      <div className="min-w-0 flex-1">
                        <p className="font-bold text-primary truncate block overflow-hidden text-ellipsis whitespace-nowrap">{fileName}</p>
                        <p className="text-sm text-muted-foreground mt-1">Ready for analysis</p>
                      </div>
                    </div>
                    <span className="px-3 py-1 bg-primary/20 text-primary text-sm rounded-full font-medium flex-shrink-0">
                      Active Dataset
                    </span>
                  </div>
                </div>
              )}
            </header>

            {/* Initial Recommended Prompts Section */}
            {renderInitialRecommendedPrompts()}

            {/* Query Input */}
            <section className="bg-card border rounded-lg p-6 mb-6 flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Ask a question about your data..."
                className="flex-1 px-4 py-3 bg-input border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary text-base sm:text-lg text-foreground placeholder:text-muted-foreground min-w-0 transition-all"
                disabled={loading}
                onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
              />
              <button
                onClick={handleAnalyze}
                disabled={loading || !query.trim() || !csvPath}
                className="px-6 sm:px-8 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-bold transition-all whitespace-nowrap"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" /> Analyzing...
                  </>
                ) : (
                  <>
                    <Zap className="w-5 h-5" /> Analyze
                  </>
                )}
              </button>
            </section>

            {/* History / Results */}
            <section ref={historyContainerRef} className="space-y-4 max-h-[calc(100vh-400px)] overflow-y-auto pr-2">
              {history.map((item) => (
                <article
                  key={item.id}
                  className="bg-card border rounded-lg overflow-hidden hover:shadow-md transition-shadow"
                >
                  <header className="bg-primary/10 border-b border-primary/20 p-4">
                    <p className="text-foreground font-bold break-words">{item.query}</p>
                    <time className="text-muted-foreground text-sm mt-1">{item.timestamp}</time>
                  </header>

                  {item.response.error ? (
                    <div className="p-4 bg-destructive/10 border-l-4 border-destructive">
                      <p className="text-destructive font-bold">Error:</p>
                      <p className="text-destructive/80 text-sm mt-1 break-words">{item.response.error}</p>
                    </div>
                  ) : (
                    <div className="p-6 space-y-6">
                      {/* Analysis Output */}
                      {item.response.result && (
                        <div className="space-y-4">
                          <div className="flex items-center gap-2">
                            <BarChart3 className="w-5 h-5 text-primary" />
                            <h3 className="font-bold text-foreground">Analysis</h3>
                          </div>
                          <div className="bg-secondary/50 border rounded p-4">
                            <pre className="text-sm font-mono text-foreground whitespace-pre-wrap break-words">
                              {item.response.result}
                            </pre>
                          </div>
                        </div>
                      )}

                      {/* Chart Visualization */}
                      <ChartRenderer chartJson={item.response.chart} />

                      {/* Summary Section */}
                      {item.response.summary && (
                        <div className="space-y-4">
                          <div className="flex items-center gap-2">
                            <FileText className="w-5 h-5 text-primary" />
                            <h3 className="font-bold text-foreground">Summary</h3>
                          </div>
                          <p className="text-foreground leading-relaxed break-words bg-secondary/40 border rounded p-4">
                            {item.response.summary}
                          </p>
                        </div>
                      )}

                      {/* Mimir Recommends Section */}
                      {item.response.mimir_recommends && item.response.mimir_recommends.length > 0 && (
                        <div className="space-y-4">{renderMimirRecommends(item.response.mimir_recommends)}</div>
                      )}
                    </div>
                  )}

                  {/* Recommended prompts for this specific item */}
                  {renderItemRecommendedPrompts(item)}
                </article>
              ))}
              <div ref={messagesEndRef} />
            </section>
          </div>
        </div>
      </div>

      {/* New Chat Modal */}
      {showNewChatModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-card border rounded-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-bold mb-4 text-foreground">Create New Session</h3>
            <input
              type="text"
              value={newChatName}
              onChange={(e) => setNewChatName(e.target.value)}
              placeholder="Enter session name..."
              className="w-full px-3 py-2 bg-input border rounded focus:ring-2 focus:ring-primary focus:border-primary text-foreground placeholder:text-muted-foreground transition-all"
              onKeyDown={(e) => e.key === "Enter" && handleCreateChat()}
            />
            <div className="flex gap-2 justify-end mt-4">
              <button
                onClick={() => setShowNewChatModal(false)}
                className="px-4 py-2 text-muted-foreground hover:bg-accent rounded transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateChat}
                disabled={!newChatName.trim()}
                className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all font-bold"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Merge Files Modal */}
      {showMergeModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-card border rounded-lg p-6 w-full max-w-4xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-bold mb-4 text-foreground">Merge Files</h3>
            
            <div className="space-y-6">
              {/* Primary File Selection */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  Primary File (Base Dataset)
                </label>
                <div className="flex gap-2 items-start">
                  <select
                    value={mergeConfig.primaryFile}
                    onChange={(e) => {
                      if (e.target.value) {
                        setMergeConfig({
                          primaryFile: e.target.value,
                          filesToMerge: []
                        })
                      } else {
                        setMergeConfig({
                          primaryFile: '',
                          filesToMerge: []
                        })
                      }
                    }}
                    className="flex-1 px-3 py-2 bg-input border rounded focus:ring-2 focus:ring-primary focus:border-primary text-foreground placeholder:text-muted-foreground"
                  >
                    <option value="">Select primary file</option>
                    {uploadedFiles.map(file => (
                      <option key={file.path} value={file.path}>
                        {file.name} ({file.columns.length} columns)
                      </option>
                    ))}
                  </select>
                  {mergeConfig.primaryFile && (
                    <button
                      onClick={() => removeFileFromMerge(mergeConfig.primaryFile)}
                      className="p-2 text-destructive hover:bg-destructive/20 rounded transition-all"
                      title="Remove as primary"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Files to Merge Section */}
              {mergeConfig.primaryFile && (
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <label className="block text-sm font-medium text-foreground">
                      Files to Merge with Primary
                    </label>
                    <div className="text-xs text-muted-foreground">
                      {uploadedFiles.filter(f => f.path !== mergeConfig.primaryFile && 
                        !mergeConfig.filesToMerge.some(mf => mf.file_path === f.path)).length} files available
                    </div>
                  </div>

                  {/* Available Files to Add */}
                  {uploadedFiles.filter(f => f.path !== mergeConfig.primaryFile && 
                    !mergeConfig.filesToMerge.some(mf => mf.file_path === f.path)).length > 0 && (
                    <div className="mb-4 p-3 bg-primary/10 border border-primary/20 rounded">
                      <p className="text-sm text-foreground mb-2">Add files to merge:</p>
                      <div className="flex flex-wrap gap-2">
                        {uploadedFiles
                          .filter(f => f.path !== mergeConfig.primaryFile && 
                            !mergeConfig.filesToMerge.some(mf => mf.file_path === f.path))
                          .map(file => (
                            <button
                              key={file.path}
                              onClick={() => addFileToMerge(file.path)}
                              className="px-3 py-1 bg-primary/20 hover:bg-primary/30 text-primary text-sm rounded transition-all flex items-center gap-2"
                            >
                              <Plus className="w-3 h-3" />
                              {file.name}
                              <span className="text-xs opacity-70">({file.columns.length} cols)</span>
                            </button>
                          ))}
                      </div>
                    </div>
                  )}

                  {/* Files Currently Being Merged */}
                  {mergeConfig.filesToMerge.length > 0 && (
                    <div className="space-y-4">
                      {mergeConfig.filesToMerge.map((mergeFile) => {
                        const file = uploadedFiles.find(f => f.path === mergeFile.file_path)
                        const matchingColumns = file ? getMatchingColumns(mergeConfig.primaryFile, mergeFile.file_path) : []
                        
                        return (
                          <div key={mergeFile.file_path} className="border rounded-lg p-4 bg-secondary/20">
                            <div className="flex items-start justify-between mb-3">
                              <div className="flex-1">
                                <h4 className="font-medium text-foreground text-sm mb-1 truncate block overflow-hidden text-ellipsis whitespace-nowrap">
                                  {file?.name}
                                </h4>
                                <p className="text-xs text-muted-foreground">
                                  {file?.columns.length} columns • {matchingColumns.length} matching columns
                                </p>
                              </div>
                              <button
                                onClick={() => removeFileFromMerge(mergeFile.file_path)}
                                className="p-1 text-destructive hover:bg-destructive/20 rounded transition-all ml-2"
                                title="Remove from merge"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs font-medium text-foreground mb-1">
                                  Merge Column
                                </label>
                                <select
                                  value={mergeFile.merge_column}
                                  onChange={(e) => updateMergeConfigForFile(mergeFile.file_path, { 
                                    merge_column: e.target.value 
                                  })}
                                  className="w-full px-2 py-1 bg-input border rounded text-xs text-foreground focus:ring-1 focus:ring-primary focus:border-primary"
                                >
                                  <option value="">Select column</option>
                                  {matchingColumns.map(col => (
                                    <option key={col} value={col}>
                                      {col}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              
                              <div>
                                <label className="block text-xs font-medium text-foreground mb-1">
                                  Merge Type (set this to Full Outer Join for most use cases)
                                </label>
                                <select
                                  value={mergeFile.merge_type}
                                  onChange={(e) => updateMergeConfigForFile(mergeFile.file_path, { 
                                    merge_type: e.target.value as any 
                                  })}
                                  className="w-full px-2 py-1 bg-input border rounded text-xs text-foreground focus:ring-1 focus:ring-primary focus:border-primary"
                                >
                                  <option value="inner">Inner Join</option>
                                  <option value="left">Left Join</option>
                                  <option value="right">Right Join</option>
                                  <option value="outer">Full Outer Join</option>
                                </select>
                              </div>
                            </div>

                            {/* Column Preview */}
                            {file && (
                              <div className="mt-3">
                                <details className="text-xs">
                                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                                    View columns ({file.columns.length})
                                  </summary>
                                  <div className="mt-2 flex flex-wrap gap-1">
                                    {file.columns.map((col, idx) => (
                                      <span
                                        key={idx}
                                        className={`px-2 py-1 rounded text-xs ${
                                          matchingColumns.includes(col)
                                            ? 'bg-primary/20 text-primary'
                                            : 'bg-secondary/50 text-muted-foreground'
                                        }`}
                                      >
                                        {col}
                                      </span>
                                    ))}
                                  </div>
                                </details>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* No files selected message */}
                  {mergeConfig.filesToMerge.length === 0 && (
                    <div className="text-center py-8 text-muted-foreground border-2 border-dashed border-border rounded">
                      <Database className="w-8 h-8 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">No files selected for merging</p>
                      <p className="text-xs mt-1">Click on files above to add them</p>
                    </div>
                  )}
                </div>
              )}

              {/* Summary */}
              {mergeConfig.primaryFile && mergeConfig.filesToMerge.length > 0 && (
                <div className="bg-primary/10 border border-primary/20 rounded p-4">
                  <h4 className="font-medium text-foreground text-sm mb-2">Merge Summary</h4>
                  <div className="text-xs space-y-1">
                    <p>Primary file: <strong>{uploadedFiles.find(f => f.path === mergeConfig.primaryFile)?.name}</strong></p>
                    <p>Merging with: <strong>{mergeConfig.filesToMerge.length} file(s)</strong></p>
                    <p>Total files: <strong>{mergeConfig.filesToMerge.length + 1}</strong></p>
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-2 justify-between items-center mt-6">
              <div className="text-sm text-muted-foreground">
                {mergeConfig.filesToMerge.length > 0 && (
                  <>Merging {mergeConfig.filesToMerge.length + 1} files</>
                )}
              </div>
              
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowMergeModal(false)
                    setMergeConfig({
                      primaryFile: '',
                      filesToMerge: []
                    })
                  }}
                  className="px-4 py-2 text-muted-foreground hover:bg-accent rounded transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={handleMergeFiles}
                  disabled={!mergeConfig.primaryFile || mergeConfig.filesToMerge.length === 0 || 
                    mergeConfig.filesToMerge.some(f => !f.merge_column)}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all font-bold flex items-center gap-2"
                >
                  <Database className="w-4 h-4" />
                  Merge {mergeConfig.filesToMerge.length + 1} Files
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
