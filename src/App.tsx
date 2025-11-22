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

interface ChatInfo {
  name: string
  created_at: string
  message_count: any
  csv_path: any
}

export default function MimirApp() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false)
  const [isCheckingAuth, setIsCheckingAuth] = useState<boolean>(true)
  const [username, setUsername] = useState<string>("")
  
  // Login form state
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

  const [csvPath, setCsvPath] = useState<string>("")
  const [fileName, setFileName] = useState<string>("")
  const [query, setQuery] = useState<string>("")
  const [loading, setLoading] = useState<boolean>(false)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [isDragging, setIsDragging] = useState<boolean>(false)

  const [theme, setTheme] = useState<"light" | "dark">("dark")

  // Chat management state
  const [chats, setChats] = useState<ChatInfo[]>([])
  const [currentChat, setCurrentChat] = useState<string>("default")
  const [showChatSidebar, setShowChatSidebar] = useState<boolean>(true)
  const [showNewChatModal, setShowNewChatModal] = useState<boolean>(false)
  const [newChatName, setNewChatName] = useState<string>("")

  const [globalRecommendedPrompts, setGlobalRecommendedPrompts] = useState<string[]>([])

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const historyContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [history])

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark")
    document.documentElement.classList.toggle("light", theme === "light")
  }, [theme])

  // Check for auto-login on mount
  useEffect(() => {
    checkAutoLogin()
  }, [])

  // Load data when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      loadCurrentChat()
      loadChatList()
      loadGlobalRecommendedPrompts()
    }
  }, [isAuthenticated])

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
      
      // Reset login form
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
    // Use Tauri's invoke instead of fetch
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
    } catch (err) {
      console.error("Logout error:", err)
    }
  }

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
    } catch (err) {
      alert(`Failed to create chat: ${err}`)
    }
  }

  const handleSwitchChat = async (chatName: string) => {
    try {
      await invoke("switch_chat", { chatName })
      setCurrentChat(chatName)
      await loadCurrentChat()
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

  useEffect(() => {
    const unlisten = listen("backend-log", (event) => {
      console.log("Backend says:", event.payload)
    })

    return () => {
      unlisten.then((f) => f())
    }
  }, [])

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
    const csvFile: any = files.find((file) => file.name.toLowerCase().endsWith(".csv"))

    if (csvFile) {
      try {
        await setCsvPathForChat(csvFile.path)
      } catch (err) {
        console.error("Failed to load CSV:", err)
        alert("Failed to load CSV file. Please try again.")
      }
    } else {
      alert("Please drop a CSV file.")
    }
  }

  useEffect(() => {
    const mainWindow = new Window("main")

    let cleanup: (() => void) | undefined

    mainWindow
      .onDragDropEvent(async (event) => {
        const payload = event.payload as FileDropPayload

        if (payload.type === "drop" && payload.paths.length > 0) {
          const filePath = payload.paths[0]
          try {
            await setCsvPathForChat(filePath)
          } catch (err) {
            console.error("Failed to load CSV:", err)
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

  const ChartRenderer = ({ chartJson }: { chartJson?: string }) => {
    const chartRef = useRef<HTMLDivElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
      if (!chartJson || !chartRef.current) {
        console.log("ChartRenderer: No chartJson or chartRef")
        return
      }

      try {
        const config = JSON.parse(chartJson)
        console.log("ChartRenderer: Parsed config:", config)

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
          xAxis: config.xAxis
            ? Array.isArray(config.xAxis)
              ? config.xAxis.map((axis: any) => ({
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
                }))
              : {
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
                }
            : undefined,
          yAxis: config.yAxis
            ? Array.isArray(config.yAxis)
              ? config.yAxis.map((axis: any) => ({
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
                }))
              : {
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
                }
            : undefined,
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
    const promptsToShow =
      item.response.recommended_prompts && item.response.recommended_prompts.length > 0
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

  // Show loading screen while checking auth
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

  // Show forgot password page
  if (showForgotPassword) {
    return (
      <div className={`min-h-screen bg-background animated-gradient flex items-center justify-center p-4 ${theme}`}>
        <div className="w-full max-w-md">
          <div className="bg-card/95 backdrop-blur-sm border-2 border-border rounded-2xl p-8 shadow-2xl">
            {/* Back to login */}
            <button
              onClick={() => setShowForgotPassword(false)}
              className="flex items-center gap-2 text-muted-foreground hover:text-foreground mb-6 transition-colors"
            >
              <ChevronUp className="w-4 h-4 rotate-90" />
              Back to login
            </button>

            {/* Logo and Title */}
            <div className="text-center mb-8">
              <Key className="w-16 h-16 text-primary mx-auto mb-4 drop-shadow-lg" />
              <h1 className="text-3xl font-bold text-foreground mb-2">Reset Password</h1>
              <p className="text-muted-foreground">Enter your email to receive a reset link</p>
            </div>

            {/* Reset Form */}
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

  // Show login page if not authenticated
  if (!isAuthenticated) {
    return (
      <div className={`min-h-screen bg-background animated-gradient flex items-center justify-center p-4 ${theme}`}>
        <div className="w-full max-w-md">
          <div className="bg-card/95 backdrop-blur-sm border-2 border-border rounded-2xl p-8 shadow-2xl">
            {/* Logo and Title */}
            <div className="text-center mb-8">
              <Brain className="w-16 h-16 text-primary mx-auto mb-4 drop-shadow-lg" />
              <h1 className="text-3xl font-bold text-foreground mb-2">Welcome to Mimir</h1>
              <p className="text-muted-foreground">AI-Powered Data Analysis Assistant</p>
            </div>

            {/* Login Form */}
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

            {/* Theme Toggle */}
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

  // Main authenticated app
  return (
    <div className={`min-h-screen bg-background animated-gradient flex overflow-hidden ${theme}`}>
      {/* Chat Sidebar */}
      <Drawer open={showChatSidebar} onOpenChange={setShowChatSidebar} direction="left">
        <DrawerContent className="w-80 bg-sidebar/95 backdrop-blur-sm border-r-2 border-sidebar-border">
          {/* Sidebar Header */}
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

            {/* User Info */}
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

            {/* Current Chat Info */}
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

          {/* Chat List */}
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

          {/* Sidebar Footer */}
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
                <p className="text-foreground font-semibold text-lg mb-2">Drop your CSV or Excel file here</p>
                <p className="text-muted-foreground/70 text-xs mt-2">Supports .csv, .xls and .xlsx files</p>
              </div>

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
              className="w-full px-3 py-2 bg-input border-2 border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary mb-4 text-foreground placeholder:text-muted-foreground transition-all shadow-sm"
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
    </div>
  )
}
