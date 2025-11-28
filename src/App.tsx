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
} from "lucide-react"
import { Window } from "@tauri-apps/api/window"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import "./App.css"
import { Drawer, DrawerContent, DrawerHeader, DrawerFooter, DrawerTitle } from "./components/ui/drawer"
import { check } from "@tauri-apps/plugin-updater"
import type { Update } from "@tauri-apps/plugin-updater"

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

// ========== MAIN COMPONENT ==========

export default function MimirApp() {
  // ========== STATE ==========
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false)
  const [isCheckingAuth, setIsCheckingAuth] = useState<boolean>(true)
  const [username, setUsername] = useState<string>("")
  
  // Auth state
  const [loginUsername, setLoginUsername] = useState<string>("")
  const [loginPassword, setLoginPassword] = useState<string>("")
  const [rememberMe, setRememberMe] = useState<boolean>(true)
  const [loginError, setLoginError] = useState<string>("")
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false)

  // Forgot password state
  const [showForgotPassword, setShowForgotPassword] = useState<boolean>(false)
  const [resetEmail, setResetEmail] = useState<string>("")
  const [isResetting, setIsResetting] = useState<boolean>(false)
  const [resetMessage, setResetMessage] = useState<string>("")
  const [resetError, setResetError] = useState<string>("")

  // App state
  const [csvPath, setCsvPath] = useState<string>("")
  const [fileName, setFileName] = useState<string>("")
  const [query, setQuery] = useState<string>("")
  const [loading, setLoading] = useState<boolean>(false)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [isDragging, setIsDragging] = useState<boolean>(false)
  const [theme, setTheme] = useState<"light" | "dark">("dark")

  // Chat state
  const [chats, setChats] = useState<ChatInfo[]>([])
  const [currentChat, setCurrentChat] = useState<string>("default")
  const [showChatSidebar, setShowChatSidebar] = useState<boolean>(true)
  const [showNewChatModal, setShowNewChatModal] = useState<boolean>(false)
  const [newChatName, setNewChatName] = useState<string>("")

  // File management state
  const [uploadedFiles, setUploadedFiles] = useState<FileInfo[]>([])
  const [showMergeModal, setShowMergeModal] = useState<boolean>(false)
  const [matchingColumns, setMatchingColumns] = useState<string[]>([])
  const [mergeConfig, setMergeConfig] = useState<MergeConfig>({
    primaryFile: '',
    filesToMerge: []
  })

  // Update state
  const [globalRecommendedPrompts, setGlobalRecommendedPrompts] = useState<string[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const historyContainerRef = useRef<HTMLDivElement>(null)
  const [updateInfo, setUpdateInfo] = useState<Update | null>(null)
  const [updating, setUpdating] = useState(false)
  const [showUpdateNotification, setShowUpdateNotification] = useState<boolean>(false)

  // ========== USE EFFECTS ==========

  useEffect(() => {
    checkForUpdates()
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [history])

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark")
    document.documentElement.classList.toggle("light", theme === "light")
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
      console.log("Backend says:", event.payload)
    })

    return () => {
      unlisten.then((f) => f())
    }
  }, [])

  useEffect(() => {
    const mainWindow = new Window("main")
    let cleanup: (() => void) | undefined

    mainWindow
      .onDragDropEvent(async (event) => {
        const payload = event.payload as FileDropPayload
        if (payload.type === "drop" && payload.paths.length > 0) {
          const filePaths = payload.paths
          if (filePaths.length === 1) {
            try {
              await setCsvPathForChat(filePaths[0])
            } catch (err) {
              console.error("Failed to load CSV:", err)
            }
          } else {
            await handleMultipleFilesDropFromPaths(filePaths)
          }
        }
      })
      .then((unlisten) => {
        cleanup = unlisten
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
      let totalDownloaded = 0
      let lastLoggedSize = 0
      
      await updateInfo.downloadAndInstall((event) => {
        if (event.event === "Progress") {
          totalDownloaded += event.data.chunkLength
          if (totalDownloaded - lastLoggedSize >= 64 * 1024) {
            console.log(`Downloaded: ${(totalDownloaded / (1024 * 1024)).toFixed(2)} MB`)
            lastLoggedSize = totalDownloaded
          }
        }
      })
      
      console.log("Update installed successfully!")
      setUpdating(false)
      setUpdateInfo(null)
      setShowUpdateNotification(true)
    } catch (err) {
      console.error("Update failed:", err)
      setUpdating(false)
      setShowUpdateNotification(true)
    }
  }

  // ========== AUTH FUNCTIONS ==========

  const checkAutoLogin = async () => {
    setIsCheckingAuth(true)
    try {
      const result = await invoke<string>("try_auto_login")
      console.log("Auto-login successful:", result)
      setUsername(result)
      setIsAuthenticated(true)
    } catch (err) {
      console.log("No auto-login available:", err)
      setIsAuthenticated(false)
    } finally {
      setIsCheckingAuth(false)
    }
  }

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
      
      console.log("Login successful:", result)
      setUsername(result)
      setIsAuthenticated(true)
      setLoginUsername("")
      setLoginPassword("")
    } catch (err) {
      console.error("Login error:", err)
      setLoginError(err as string)
    } finally {
      setIsLoggingIn(false)
    }
  }

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
      console.error("Password reset error:", err)
      setResetError(err as string || "Failed to send reset email. Please try again.")
    } finally {
      setIsResetting(false)
    }
  }

  const handleLogout = async () => {
    try {
      await invoke("logout")
      console.log("Logout successful")
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

  const handleDeleteChat = async (chatName: string) => {
    if (!confirm(`Are you sure you want to delete chat "${chatName}"?`)) return

    try {
      await invoke("delete_chat", { chatName })
      await loadChatList()
      if (currentChat === chatName) {
        const remainingChats = chats.filter((chat) => chat.name !== chatName)
        if (remainingChats.length > 0) {
          await handleSwitchChat(remainingChats[0].name)
        } else {
          await invoke("create_chat", { chatName: "default" })
          await loadChatList()
          await loadCurrentChatName()
        }
      }
    } catch (err) {
      alert(`Failed to delete chat: ${err}`)
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
      console.log("Invoking analyze_query with:", { csvPath, query })

      const response = await invoke<AnalysisResponse>("analyze_query", {
        csvPath,
        query,
      })

      console.log("Got response from backend:", response)

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

    const files = Array.from(e.dataTransfer.files)
    
    if (files.length === 1) {
      const csvFile: any = files.find((file) => 
        file.name.toLowerCase().endsWith(".csv") ||
        file.name.toLowerCase().match(/\.xlsx?$/)
      )

      if (csvFile) {
        try {
          await setCsvPathForChat(csvFile.path)
        } catch (err) {
          console.error("Failed to load CSV:", err)
          alert("Failed to load CSV file. Please try again.")
        }
      } else {
        alert("Please drop a CSV or Excel file.")
      }
    } else {
      await handleMultipleFilesDrop(e.dataTransfer.files)
    }
  }

  const handleMultipleFilesDrop = async (files: FileList) => {
    const csvFiles = Array.from(files).filter(file => 
      file.name.toLowerCase().endsWith('.csv') || 
      file.name.toLowerCase().match(/\.xlsx?$/)
    )

    if (csvFiles.length === 0) {
      alert('Please drop CSV or Excel files.')
      return
    }

    try {
      const newFiles: FileInfo[] = []
      for (const file of csvFiles) {
        const fileInfo = await loadFileInfo(file)
        newFiles.push(fileInfo)
      }
      
      updateUploadedFilesWithNewFiles(newFiles)
    } catch (err) {
      console.error('Failed to load files:', err)
      alert('Failed to load some files. Please try again.')
    }
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

  // Helper function to update state and check for merges
  const updateUploadedFilesWithNewFiles = (newFiles: FileInfo[]) => {
    setUploadedFiles(prev => {
      // Filter out duplicates by file path
      const existingPaths = new Set(prev.map(f => f.path))
      const uniqueNewFiles = newFiles.filter(file => !existingPaths.has(file.path))
      
      const updatedFiles = [...prev, ...uniqueNewFiles]
      
      // Check for merges if we have at least 2 files total
      if (updatedFiles.length >= 2) {
        findMatchingColumns(updatedFiles)
      }
      
      return updatedFiles
    })
  }

  const loadFileInfo = async (file: any): Promise<FileInfo> => {
    try {
      const preview = await invoke<Array<Array<string>>>("load_csv_info", {
        csvPath: file.path
      })
      
      const columns = preview.length > 0 ? preview[0] : []
      
      return {
        name: file.name,
        path: file.path,
        columns,
        preview: preview.slice(0, 5)
      }
    } catch (err) {
      console.error('Error loading file info:', err)
      throw new Error(`Failed to load file ${file.name}`)
    }
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
    
    if (files.length === 2 && matches.length > 0) {
      setMergeConfig({
        primaryFile: files[0].path,
        filesToMerge: [{
          file_path: files[1].path,
          merge_column: matches[0],
          merge_type: 'inner'
        }]
      })
      setShowMergeModal(true)
    }
  }

  const removeUploadedFile = (filePath: string) => {
    setUploadedFiles(prev => prev.filter(file => file.path !== filePath))
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
      const mergedPath = await invoke<string>("merge_multiple_files", {
        primaryPath: mergeConfig.primaryFile,
        mergeConfigs: mergeConfig.filesToMerge.map(config => ({
          file_path: config.file_path,
          merge_column: config.merge_column,
          merge_type: config.merge_type
        }))
      })

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
    }
  }

  // ========== COMPONENT RENDERERS ==========

  const ChartRenderer = ({ chartJson }: { chartJson?: string }) => {
    const chartRef = useRef<HTMLDivElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
      if (!chartJson || !chartRef.current) return

      try {
        const config = JSON.parse(chartJson)
        const chart = echarts.init(chartRef.current, theme === "dark" ? "dark" : undefined)

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
        }
      } catch (err) {
        console.error("ChartRenderer: Failed to render chart:", err)
      }
    }, [chartJson, theme])

    if (!chartJson) return null

    return (
      <div className="bg-card border-2 border-primary/20 rounded-xl p-6 shadow-lg shadow-primary/5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" />
            <h3 className="font-semibold text-foreground">Visualization</h3>
          </div>
          <div className="text-xs text-muted-foreground">Drag to pan • Scroll to zoom</div>
        </div>
        <div ref={containerRef} className="w-full overflow-x-auto">
          <div
            ref={chartRef}
            className="w-full h-[400px] min-w-[600px] bg-gradient-to-br from-secondary/50 to-accent/30 rounded-lg border border-border"
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
      <section className="bg-gradient-to-br from-primary/5 to-primary/10 border-2 border-primary/30 rounded-xl p-4 sm:p-6 mt-4 shadow-md">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Lightbulb className="w-5 h-5 text-primary" />
            <h3 className="font-semibold text-foreground">Suggested Follow-up Questions</h3>
          </div>
          <button
            onClick={() => toggleItemRecommendedPrompts(item.id)}
            className="p-1.5 text-primary hover:bg-primary/20 rounded-lg transition-all"
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
              className="text-left p-3 bg-card hover:bg-accent rounded-lg border-2 border-border hover:border-primary/50 transition-all text-sm text-foreground group shadow-sm hover:shadow-md"
            >
              <div className="flex items-start gap-2">
                <Sparkles className="w-4 h-4 text-primary mt-0.5 flex-shrink-0 group-hover:scale-110 transition-transform" />
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
      <section className="bg-gradient-to-br from-primary/5 to-primary/10 border-2 border-primary/30 rounded-xl p-4 sm:p-6 mb-6 shadow-md">
        <div className="flex items-center gap-2 mb-4">
          <Lightbulb className="w-5 h-5 text-primary" />
          <h3 className="font-semibold text-foreground">Suggested Questions</h3>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {globalRecommendedPrompts.map((prompt, index) => (
            <button
              key={index}
              onClick={() => handlePromptClick(prompt)}
              className="text-left p-3 bg-card hover:bg-accent rounded-lg border-2 border-border hover:border-primary/50 transition-all text-sm text-foreground group shadow-sm hover:shadow-md"
            >
              <div className="flex items-start gap-2">
                <Sparkles className="w-4 h-4 text-primary mt-0.5 flex-shrink-0 group-hover:scale-110 transition-transform" />
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
      <div className="bg-gradient-to-br from-primary/5 to-accent/10 border-2 border-primary/30 rounded-xl p-6 shadow-md">
        <div className="flex items-center gap-2 mb-4">
          <Brain className="w-5 h-5 text-primary" />
          <h3 className="font-semibold text-foreground">Mimir Recommends</h3>
        </div>
        <div className="space-y-3">
          {recommendations.map((recommendation, index) => (
            <div key={index} className="flex items-start gap-3 p-3 bg-card rounded-lg border-2 border-border shadow-sm">
             <div className="w-2 h-2 bg-primary rounded-full mt-2 flex-shrink-0 shadow-sm shadow-primary/50" />
              <p className="text-sm text-foreground flex-1 break-words">{recommendation}</p>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // ========== AUTH SCREENS ==========

  if (isCheckingAuth) {
    return (
      <div className={`min-h-screen bg-background animated-gradient flex items-center justify-center ${theme}`}>
        <div className="text-center">
          <Brain className="w-16 h-16 text-primary mx-auto mb-4 animate-pulse" />
          <p className="text-foreground text-lg">Loading Mimir...</p>
        </div>
      </div>
    )
  }

  if (showForgotPassword) {
    return (
      <div className={`min-h-screen bg-background animated-gradient flex items-center justify-center p-4 ${theme}`}>
        <div className="w-full max-w-md">
          <div className="bg-card border-2 border-border rounded-2xl p-8 shadow-2xl">
            <button
              onClick={() => setShowForgotPassword(false)}
              className="flex items-center gap-2 text-muted-foreground hover:text-foreground mb-6 transition-colors"
            >
              <ChevronUp className="w-4 h-4 rotate-90" />
              Back to login
            </button>

            <div className="text-center mb-8">
              <Key className="w-16 h-16 text-primary mx-auto mb-4 drop-shadow-lg" />
              <h1 className="text-3xl font-bold text-foreground mb-2">Reset Password</h1>
              <p className="text-muted-foreground">Enter your email to receive a reset link</p>
            </div>

            <form onSubmit={handleForgotPassword} className="space-y-4">
              {resetError && (
                <div className="bg-destructive/10 border-2 border-destructive/50 rounded-lg p-3 text-destructive text-sm">
                  {resetError}
                </div>
              )}

              {resetMessage && (
                <div className="bg-primary/10 border-2 border-primary/50 rounded-lg p-3 text-primary text-sm">
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
                  className="w-full px-4 py-3 bg-input border-2 border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary text-foreground placeholder:text-muted-foreground transition-all"
                  placeholder="Enter your email address"
                  required
                  disabled={isResetting}
                />
              </div>

              <button
                type="submit"
                disabled={isResetting}
                className="w-full py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed font-bold transition-all shadow-lg hover:shadow-xl hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-2"
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
      <div className={`min-h-screen bg-background animated-gradient flex items-center justify-center p-4 ${theme}`}>
        <div className="w-full max-w-md">
          <div className="bg-card border-2 border-border rounded-2xl p-8 shadow-2xl">
            <div className="text-center mb-8">
              <Brain className="w-16 h-16 text-primary mx-auto mb-4 drop-shadow-lg" />
              <h1 className="text-3xl font-bold text-foreground mb-2">Welcome to Mimir</h1>
              <p className="text-muted-foreground">AI-Powered Data Analysis Assistant</p>
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              {loginError && (
                <div className="bg-destructive/10 border-2 border-destructive/50 rounded-lg p-3 text-destructive text-sm">
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
                  className="w-full px-4 py-3 bg-input border-2 border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary text-foreground placeholder:text-muted-foreground transition-all"
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
                  className="w-full px-4 py-3 bg-input border-2 border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary text-foreground placeholder:text-muted-foreground transition-all"
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
                    className="w-4 h-4 text-primary bg-input border-border rounded focus:ring-2 focus:ring-primary"
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
                className="w-full py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed font-bold transition-all shadow-lg hover:shadow-xl hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-2"
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
    <div className={`min-h-screen bg-background animated-gradient flex overflow-hidden ${theme}`}>
      
      {/* Update Notification */}
      {showUpdateNotification && (
        <div className="fixed top-4 right-4 w-80 bg-card border-2 border-primary/40 rounded-xl p-4 shadow-2xl shadow-primary/20 z-50 backdrop-blur-sm animate-in slide-in-from-right-full duration-500">
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
                  <h4 className="font-bold text-foreground text-sm mb-1">Installing Update...</h4>
                  <p className="text-muted-foreground text-xs mb-3">This may take a few moments</p>
                  <div className="w-full bg-secondary rounded-full h-1.5 mb-2">
                    <div className="bg-primary h-1.5 rounded-full animate-pulse" />
                  </div>
                </>
              ) : updateInfo ? (
                <>
                  <h4 className="font-bold text-foreground text-sm mb-1">Update Available! 🎉</h4>
                  <p className="text-muted-foreground text-xs mb-3">Version {updateInfo.version} is ready to install</p>
                  <div className="flex gap-2">
                    <button
                      onClick={performUpdate}
                      className="flex-1 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-all shadow-md hover:shadow-lg flex items-center justify-center gap-2"
                    >
                      <Zap className="w-3 h-3" />
                      Install Now
                    </button>
                    <button
                      onClick={dismissUpdate}
                      className="px-3 py-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-all text-sm"
                    >
                      Later
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h4 className="font-bold text-foreground text-sm mb-1">Update Installed! ✅</h4>
                  <p className="text-muted-foreground text-xs mb-3">Please restart the app to apply changes</p>
                  <div className="bg-primary/10 border border-primary/30 rounded-lg p-3">
                    <p className="text-primary text-xs font-medium text-center">
                      Close and reopen Mimir to complete the update
                    </p>
                  </div>
                  <div className="flex justify-end mt-3">
                    <button
                      onClick={dismissUpdate}
                      className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-all shadow-md hover:shadow-lg"
                    >
                      Got it!
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
        <DrawerContent className="w-80 bg-sidebar/95 backdrop-blur-sm border-r-2 border-sidebar-border">
          <DrawerHeader className="p-4 border-b-2 border-sidebar-border bg-gradient-to-br from-sidebar to-sidebar-accent/30">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Brain className="w-6 h-6 text-primary drop-shadow-sm" />
                <DrawerTitle className="text-lg font-bold text-sidebar-foreground">Mimir</DrawerTitle>
              </div>
              <button
                onClick={() => setShowNewChatModal(true)}
                className="p-2 text-primary hover:bg-primary/20 rounded-lg transition-all shadow-sm hover:shadow-md"
                title="New Chat"
              >
                <Plus className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-primary/15 border-2 border-primary/40 p-3 rounded-xl shadow-md mb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <User className="w-4 h-4 text-primary flex-shrink-0" />
                  <span className="text-sm font-medium text-sidebar-foreground truncate">{username}</span>
                </div>
                <button
                  onClick={handleLogout}
                  className="p-1.5 text-sidebar-foreground/60 hover:text-destructive transition-colors cursor-pointer"
                  title="Logout"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="bg-primary/15 border-2 border-primary/40 p-3 rounded-xl shadow-md">
              <p className="text-xs font-medium text-sidebar-foreground/70">Current Chat</p>
              <p className="text-lg font-bold text-primary truncate">{currentChat}</p>
              <p className="text-xs text-sidebar-foreground/70 mt-1">
                {history.length} message{history.length !== 1 ? "s" : ""}
              </p>
              {csvPath && (
                <p className="text-xs text-primary/90 mt-1 truncate flex items-center gap-1" title={csvPath}>
                  <Database className="w-3 h-3" />
                  {fileName}
                </p>
              )}
            </div>
          </DrawerHeader>

          <div className="flex-1 overflow-y-auto">
            {chats.map((chat) => (
              <div
                key={chat.name}
                className={`p-3 border-b border-sidebar-border cursor-pointer hover:bg-sidebar-accent transition-all ${
                  currentChat === chat.name ? "bg-primary/15 border-l-4 border-l-primary shadow-inner" : ""
                }`}
                onClick={() => handleSwitchChat(chat.name)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <MessageSquare className="w-4 h-4 text-sidebar-foreground/60 flex-shrink-0" />
                    <span className="font-medium text-sidebar-foreground truncate">{chat.name}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-sidebar-foreground/60 bg-sidebar-accent px-2 py-1 rounded-md shadow-sm">
                      {chat.message_count}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteChat(chat.name)
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
                    <Database className="w-3 h-3" />
                    {chat.csv_path.split(/[\\/]/).pop()}
                  </p>
                )}
              </div>
            ))}
          </div>

          <DrawerFooter className="p-4 border-t-2 border-sidebar-border bg-gradient-to-br from-sidebar to-sidebar-accent/30">
            <button
              onClick={() => setShowChatSidebar(false)}
              className="w-full p-2 text-sidebar-foreground/70 hover:bg-sidebar-accent rounded-lg transition-all flex items-center justify-center gap-2 shadow-sm hover:shadow-md"
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
        <div className="bg-card/95 backdrop-blur-sm border-b-2 border-border p-4 flex-shrink-0 shadow-md">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              {!showChatSidebar && (
                <button
                  onClick={() => setShowChatSidebar(true)}
                  className="p-2 text-muted-foreground hover:bg-accent rounded-lg transition-all shadow-sm hover:shadow-md"
                  title="Show Chats"
                >
                  <Menu className="w-5 h-5" />
                </button>
              )}
              <Brain className="w-7 h-7 text-primary flex-shrink-0 drop-shadow-sm" />
              <div className="min-w-0">
                <h1 className="text-xl font-bold text-foreground">Mimir</h1>
                <p className="text-xs text-muted-foreground hidden sm:block">AI-Powered Data Analysis Assistant</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                className="p-2 text-muted-foreground hover:bg-accent rounded-lg transition-all shadow-sm hover:shadow-md"
                title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              >
                {theme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>
              <div className="text-sm text-muted-foreground flex items-center gap-2 sm:gap-4 min-w-0">
                <span className="flex items-center gap-2 min-w-0">
                  <MessageSquare className="w-4 h-4 text-primary flex-shrink-0" />
                  <span className="font-semibold text-primary truncate hidden sm:inline">{currentChat}</span>
                </span>
                {csvPath && (
                  <span className="flex items-center gap-2 min-w-0">
                    <Database className="w-4 h-4 text-primary flex-shrink-0" />
                    <span className="font-semibold text-primary truncate hidden md:inline">{fileName}</span>
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-6xl mx-auto p-4 sm:p-6 w-full">
            
            {/* File Upload Section */}
            <header className="bg-card/90 border-2 border-border rounded-xl p-4 sm:p-6 mb-6 shadow-lg">
              <div
                className={`flex flex-col items-center justify-center border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all duration-300 ${
                  isDragging
                    ? "border-primary bg-primary/20 scale-[1.02] shadow-lg shadow-primary/20"
                    : "border-primary/40 bg-gradient-to-br from-secondary/50 to-accent/30 hover:bg-accent/50 hover:border-primary/60 hover:shadow-md"
                }`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <FileDown
                  className={`w-12 h-12 text-primary mb-4 transition-transform ${isDragging ? "scale-110" : ""}`}
                />
                <p className="text-foreground font-semibold text-lg mb-2">
                  Drop your CSV or Excel file here
                </p>
                <p className="text-muted-foreground/70 text-xs mt-2">
                  Supports .csv, .xls and .xlsx files • Drop multiple files to merge them
                </p>
              </div>

              {/* Uploaded Files List */}
              {uploadedFiles.length > 0 && (
                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-foreground">Uploaded Files</h3>
                    {matchingColumns.length > 0 && (
                      <button
                        onClick={() => setShowMergeModal(true)}
                        className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-all font-medium text-sm flex items-center gap-2"
                      >
                        <Database className="w-4 h-4" />
                        Merge Files ({matchingColumns.length} matching columns)
                      </button>
                    )}
                  </div>
                  
                  {uploadedFiles.map((file) => (
                    <div key={file.path} className="bg-gradient-to-br from-primary/15 to-primary/5 border-2 border-primary/30 rounded-xl p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <Database className="w-5 h-5 text-primary flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="font-bold text-primary truncate">{file.name}</p>
                            <p className="text-xs text-muted-foreground mt-1">
                              {file.columns.length} columns • {file.preview.length - 1} rows
                            </p>
                            <div className="flex flex-wrap gap-1 mt-2">
                              {file.columns.slice(0, 4).map((col, idx) => (
                                <span key={idx} className="px-2 py-1 bg-primary/20 text-primary text-xs rounded-md">
                                  {col}
                                </span>
                              ))}
                              {file.columns.length > 4 && (
                                <span className="px-2 py-1 bg-primary/10 text-primary text-xs rounded-md">
                                  +{file.columns.length - 4} more
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={() => removeUploadedFile(file.path)}
                          className="p-2 text-destructive hover:bg-destructive/20 rounded-lg transition-all ml-2"
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
                <div className="mt-4 p-4 bg-gradient-to-br from-primary/15 to-primary/5 border-2 border-primary/30 rounded-xl shadow-md">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Database className="w-5 h-5 text-primary" />
                      <div>
                        <p className="font-bold text-primary">{fileName}</p>
                        <p className="text-xs text-muted-foreground mt-1">Ready for analysis</p>
                      </div>
                    </div>
                    <span className="px-3 py-1 bg-primary/20 text-primary text-sm rounded-full font-medium">
                      Active Dataset
                    </span>
                  </div>
                </div>
              )}
            </header>

            {/* Initial Recommended Prompts Section */}
            {renderInitialRecommendedPrompts()}

            {/* Query Input */}
            <section className="bg-card/90 border-2 border-border rounded-xl p-4 sm:p-6 mb-6 flex flex-col sm:flex-row gap-3 shadow-lg">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Ask a question about your data..."
                className="flex-1 px-4 py-3 bg-input border-2 border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary text-base sm:text-lg text-foreground placeholder:text-muted-foreground min-w-0 transition-all shadow-sm"
                disabled={loading}
                onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
              />
              <button
                onClick={handleAnalyze}
                disabled={loading || !query.trim() || !csvPath}
                className="px-6 sm:px-8 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-bold transition-all whitespace-nowrap shadow-md hover:shadow-lg hover:scale-[1.02] active:scale-[0.98]"
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
                  className="bg-card/90 border-2 border-border rounded-xl overflow-hidden shadow-lg hover:shadow-xl transition-shadow"
                >
                  <header className="bg-gradient-to-r from-primary/20 to-primary/10 border-b-2 border-primary/30 p-4">
                    <p className="text-foreground font-bold break-words">{item.query}</p>
                    <time className="text-muted-foreground text-sm mt-1">{item.timestamp}</time>
                  </header>

                  {item.response.error ? (
                    <div className="p-4 bg-destructive/10 border-l-4 border-destructive">
                      <p className="text-destructive font-bold">Error:</p>
                      <p className="text-destructive/80 text-sm mt-1 break-words">{item.response.error}</p>
                    </div>
                  ) : (
                    <div className="p-4 sm:p-6 space-y-6">
                      {/* Results Section */}
                      <div className="space-y-4">
                        <div className="flex items-center gap-2">
                          <BarChart3 className="w-5 h-5 text-primary" />
                          <h3 className="font-bold text-foreground">Results</h3>
                        </div>
                        <div className="bg-secondary/50 border-2 border-border p-4 rounded-lg shadow-inner">
                          <pre className="text-sm font-mono text-foreground whitespace-pre-wrap break-words">
                            {item.response.result}
                          </pre>
                        </div>
                        <ChartRenderer chartJson={item.response.chart} />
                      </div>

                      {/* Summary Section */}
                      <div className="space-y-4">
                        <div className="flex items-center gap-2">
                          <FileText className="w-5 h-5 text-primary" />
                          <h3 className="font-bold text-foreground">Summary</h3>
                        </div>
                        <p className="text-foreground leading-relaxed break-words bg-gradient-to-br from-secondary/40 to-accent/20 border-2 border-border p-4 rounded-lg shadow-sm">
                          {item.response.summary}
                        </p>
                      </div>

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
          <div className="bg-card border-2 border-border rounded-xl p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-lg font-bold mb-4 text-foreground">Create New Chat</h3>
            <input
              type="text"
              value={newChatName}
              onChange={(e) => setNewChatName(e.target.value)}
              placeholder="Enter chat name..."
              className="w-full px-3 py-2 bg-input border-2 border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary text-foreground placeholder:text-muted-foreground transition-all shadow-sm"
              onKeyDown={(e) => e.key === "Enter" && handleCreateChat()}
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowNewChatModal(false)}
                className="px-4 py-2 text-muted-foreground hover:bg-accent rounded-lg transition-all shadow-sm hover:shadow-md"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateChat}
                disabled={!newChatName.trim()}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all font-bold shadow-md hover:shadow-lg"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Enhanced Merge Files Modal */}
      {showMergeModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-card border-2 border-border rounded-xl p-6 w-full max-w-4xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-bold mb-4 text-foreground">Merge Multiple Files</h3>
            
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
                    className="flex-1 px-3 py-2 bg-input border-2 border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary text-foreground placeholder:text-muted-foreground"
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
                      className="p-2 text-destructive hover:bg-destructive/20 rounded-lg transition-all"
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
                    <div className="mb-4 p-3 bg-primary/10 border border-primary/30 rounded-lg">
                      <p className="text-sm text-foreground mb-2">Add files to merge:</p>
                      <div className="flex flex-wrap gap-2">
                        {uploadedFiles
                          .filter(f => f.path !== mergeConfig.primaryFile && 
                            !mergeConfig.filesToMerge.some(mf => mf.file_path === f.path))
                          .map(file => (
                            <button
                              key={file.path}
                              onClick={() => addFileToMerge(file.path)}
                              className="px-3 py-1 bg-primary/20 hover:bg-primary/30 text-primary text-sm rounded-lg transition-all flex items-center gap-2"
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
                          <div key={mergeFile.file_path} className="border-2 border-border rounded-lg p-4 bg-secondary/20">
                            <div className="flex items-start justify-between mb-3">
                              <div className="flex-1">
                                <h4 className="font-medium text-foreground text-sm mb-1">
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
                                  className="w-full px-2 py-1 bg-input border border-border rounded text-xs text-foreground focus:ring-1 focus:ring-primary focus:border-primary"
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
                                  Merge Type
                                </label>
                                <select
                                  value={mergeFile.merge_type}
                                  onChange={(e) => updateMergeConfigForFile(mergeFile.file_path, { 
                                    merge_type: e.target.value as any 
                                  })}
                                  className="w-full px-2 py-1 bg-input border border-border rounded text-xs text-foreground focus:ring-1 focus:ring-primary focus:border-primary"
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
                    <div className="text-center py-8 text-muted-foreground border-2 border-dashed border-border rounded-lg">
                      <Database className="w-8 h-8 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">No files selected for merging</p>
                      <p className="text-xs mt-1">Click on files above to add them</p>
                    </div>
                  )}
                </div>
              )}

              {/* Summary */}
              {mergeConfig.primaryFile && mergeConfig.filesToMerge.length > 0 && (
                <div className="bg-primary/10 border border-primary/30 rounded-lg p-4">
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
                  className="px-4 py-2 text-muted-foreground hover:bg-accent rounded-lg transition-all shadow-sm hover:shadow-md"
                >
                  Cancel
                </button>
                <button
                  onClick={handleMergeFiles}
                  disabled={!mergeConfig.primaryFile || mergeConfig.filesToMerge.length === 0 || 
                    mergeConfig.filesToMerge.some(f => !f.merge_column)}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all font-bold shadow-md hover:shadow-lg flex items-center gap-2"
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
