"use client"

import type React from "react"

import { useState, useEffect, useRef } from "react"
import Papa from "papaparse"
import * as echarts from "echarts"
import {
  FileText,
  BarChart3,
  Loader2,
  Upload,
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
} from "lucide-react"
import { Window } from "@tauri-apps/api/window"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import "./App.css"

// --- Types ---
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
  activeTab?: TabType // Individual tab state for each history item
}

interface ChatInfo {
  name: string
  created_at: string
  message_count: any
  csv_path: any
}

type TabType = "result" | "summary" | "mimir"

// --- Component ---
export default function MimirApp() {
  const [csvPath, setCsvPath] = useState<string>("")
  const [csvInfo, setCsvInfo] = useState<string>("")
  const [csvPreview, setCsvPreview] = useState<string[][]>([])
  const [fileName, setFileName] = useState<string>("")
  const [query, setQuery] = useState<string>("")
  const [loading, setLoading] = useState<boolean>(false)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [activeTab, setActiveTab] = useState<TabType>("result") // Fallback for new items
  const [isDragging, setIsDragging] = useState<boolean>(false) // Add this missing state

  // Chat management state
  const [chats, setChats] = useState<ChatInfo[]>([])
  const [currentChat, setCurrentChat] = useState<string>("default")
  const [showChatSidebar, setShowChatSidebar] = useState<boolean>(true)
  const [showNewChatModal, setShowNewChatModal] = useState<boolean>(false)
  const [newChatName, setNewChatName] = useState<string>("")

  const [globalRecommendedPrompts, setGlobalRecommendedPrompts] = useState<string[]>([])

  // Ref for scrolling to newest message
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const historyContainerRef = useRef<HTMLDivElement>(null)

  // --- Scroll to bottom when new message is added ---
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [history])

  // --- Load initial data ---
  useEffect(() => {
    loadCurrentChat()
    loadChatList()
    loadGlobalRecommendedPrompts()
  }, [])

  // --- Load global recommended prompts ---
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

  // --- Load current chat history and CSV path ---
  const loadCurrentChat = async () => {
    try {
      const history = await invoke<HistoryItem[]>("get_history")
      // Reverse the history so newest messages are first
      const reversedHistory = history.reverse().map((item) => ({
        ...item,
        showRecommendedPrompts: item.showRecommendedPrompts ?? true,
        activeTab: item.activeTab ?? "result", // Set default tab for each item
      }))
      setHistory(reversedHistory)

      const csvPath = await invoke<string | null>("get_csv_path")
      if (csvPath) {
        setCsvPath(csvPath)
        await loadCsvInfo(csvPath)
        await previewCsv(csvPath)
      } else {
        // Clear CSV preview when switching to a chat without CSV
        clearCsvPreview()
      }
    } catch (err) {
      console.error("Failed to load current chat:", err)
      clearCsvPreview()
    }
  }

  // --- Clear CSV preview ---
  const clearCsvPreview = () => {
    setCsvPreview([])
    setFileName("")
    setCsvInfo("")
  }

  // --- Load chat list ---
  const loadChatList = async () => {
    try {
      const chatList = await invoke<ChatInfo[]>("list_chats")
      setChats(chatList)
    } catch (err) {
      console.error("Failed to load chats:", err)
    }
  }

  // --- Get current chat name ---
  const loadCurrentChatName = async () => {
    try {
      const chatName = await invoke<string>("get_current_chat")
      setCurrentChat(chatName)
    } catch (err) {
      console.error("Failed to get current chat:", err)
    }
  }

  // --- Create new chat ---
  const handleCreateChat = async () => {
    if (!newChatName.trim()) return

    try {
      await invoke("create_chat", { chatName: newChatName })
      setNewChatName("")
      setShowNewChatModal(false)
      await loadChatList()
      await loadCurrentChatName()
      await loadCurrentChat()
      clearCsvPreview() // Clear CSV preview for new chat
    } catch (err) {
      alert(`Failed to create chat: ${err}`)
    }
  }

  // --- Switch chat ---
  const handleSwitchChat = async (chatName: string) => {
    try {
      await invoke("switch_chat", { chatName })
      setCurrentChat(chatName)
      await loadCurrentChat()
    } catch (err) {
      console.error("Failed to switch chat:", err)
    }
  }

  // --- Delete chat ---
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

  // --- Load CSV info from Rust backend ---
  const loadCsvInfo = async (path?: string) => {
    if (!path && !csvPath) return
    setLoading(true)
    try {
      const info = await invoke<string>("load_csv_info", { csvPath: path || csvPath })
      setCsvInfo(info)
    } catch (err) {
      setCsvInfo(`Error: ${err}`)
    } finally {
      setLoading(false)
    }
  }

  // --- Set CSV path for current chat ---
  const setCsvPathForChat = async (path: string) => {
    try {
      await invoke("set_csv_path", { csvPath: path })
      setCsvPath(path)
      await loadCsvInfo(path)
      await previewCsv(path)
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

  // --- Analyze query ---
  const handleAnalyze = async () => {
    if (!query.trim()) return
    if (!csvPath) {
      alert("Please load a CSV file first")
      return
    }

    setLoading(true)
    try {
      const response = await invoke<AnalysisResponse>("analyze_query", {
        query,
        csvPath,
      })

      await loadCurrentChat()

      setQuery("")
      
      // Scroll to the top to show the new question (since newest are at top)
      setTimeout(() => {
        historyContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      }, 100)

    } catch (err) {
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
        activeTab: "result",
      }
      // Add new error to the beginning of the array
      setHistory((prev) => [errorItem, ...prev])
      
      // Scroll to the top to show the new error
      setTimeout(() => {
        historyContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      }, 100)
    } finally {
      setLoading(false)
    }
  }

  // --- Handle recommended prompt click ---
  const handlePromptClick = (prompt: string) => {
    setQuery(prompt)
  }

  // --- Toggle recommended prompts visibility for a specific history item ---
  const toggleItemRecommendedPrompts = (itemId: number) => {
    setHistory((prev) =>
      prev.map((item) =>
        item.id === itemId ? { ...item, showRecommendedPrompts: !item.showRecommendedPrompts } : item,
      ),
    )
  }

  // --- Change tab for a specific history item ---
  const handleTabChange = (itemId: number, tab: TabType) => {
    setHistory((prev) =>
      prev.map((item) =>
        item.id === itemId ? { ...item, activeTab: tab } : item,
      ),
    )
  }

  // --- Handle CSV preview ---
  const previewCsv = async (filePath: string) => {
    try {
      const response = await fetch(`file://${filePath}`)
      const text = await response.text()
      const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true })
      setCsvPreview(parsed.data.slice(0, 10))
      setFileName(filePath.split(/[\\/]/).pop() || "")
    } catch (err) {
      console.error("Failed to preview CSV:", err)
      setCsvPreview([])
    }
  }

  // --- Enhanced drag and drop handlers ---
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
    const csvFile = files.find(file => file.name.toLowerCase().endsWith('.csv'))
    
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

  // --- Listen for file drops in Tauri ---
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

  // --- Tab button renderer for individual history items ---
  const renderTabButton = (itemId: number, tab: TabType, icon: React.ReactNode, label: string, isActive: boolean) => (
    <button
      onClick={() => handleTabChange(itemId, tab)}
      className={`px-6 py-3 flex items-center gap-2 transition-all relative ${
        isActive ? "text-primary" : "text-white/60 hover:text-white"
      }`}
    >
      {icon}
      {label}
      {isActive && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />}
    </button>
  )

  // --- Enhanced Chart renderer with ECharts ---
  const ChartRenderer = ({ chartJson }: { chartJson?: string }) => {
    const chartRef = useRef<HTMLDivElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const [chartError, setChartError] = useState<string>('')

    useEffect(() => {
      if (!chartJson || !chartRef.current) {
        console.log('ChartRenderer: No chartJson or chartRef')
        return
      }

      try {
        const config = JSON.parse(chartJson)
        console.log('ChartRenderer: Parsed config:', config)

        // Initialize chart
        const chart = echarts.init(chartRef.current, 'dark')

        // Enhanced config for better handling of large datasets and axis labels
        const enhancedConfig = {
          ...config,
          backgroundColor: 'transparent',
          textStyle: {
            color: '#ffffff',
            fontSize: 12,
          },
          dataZoom: [
            {
              type: 'slider',
              show: true,
              xAxisIndex: 0,
              left: '3%',
              right: '4%',
              bottom: '3%',
              height: 20,
              borderColor: 'hsl(220 15% 18%)',
              textStyle: {
                color: '#ffffff'
              },
              handleStyle: {
                color: 'hsl(220 15% 18%)',
                borderColor: '#ffffff'
              }
            },
            {
              type: 'inside',
              xAxisIndex: 0,
              zoomOnMouseWheel: false,
              moveOnMouseMove: true,
              moveOnMouseWheel: true
            }
          ],
          tooltip: {
            trigger: 'axis',
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            borderColor: 'hsl(220 15% 18%)',
            textStyle: {
              color: '#ffffff'
            },
            ...config.tooltip
          },
          // Enhanced axis label handling
          xAxis: config.xAxis ? (Array.isArray(config.xAxis) 
            ? config.xAxis.map((axis: any) => ({
                ...axis,
                axisLabel: {
                  color: '#ffffff',
                  fontSize: 11,
                  interval: 0, // Show all labels
                  rotate: axis.axisLabel?.rotate || (axis.data?.length > 10 ? 45 : 0), // Auto-rotate if many labels
                  ...axis.axisLabel,
                },
                axisLine: {
                  lineStyle: {
                    color: 'hsl(220 15% 18%)',
                  },
                  ...axis.axisLine,
                },
              }))
            : {
                ...config.xAxis,
                axisLabel: {
                  color: '#ffffff',
                  fontSize: 11,
                  interval: 0, // Show all labels
                  rotate: config.xAxis.axisLabel?.rotate || (config.xAxis.data?.length > 10 ? 45 : 0),
                  ...config.xAxis.axisLabel,
                },
                axisLine: {
                  lineStyle: {
                    color: 'hsl(220 15% 18%)',
                  },
                  ...config.xAxis.axisLine,
                },
              }) : undefined,
          yAxis: config.yAxis ? (Array.isArray(config.yAxis)
            ? config.yAxis.map((axis: any) => ({
                ...axis,
                axisLabel: {
                  color: '#ffffff',
                  fontSize: 11,
                  ...axis.axisLabel,
                },
                axisLine: {
                  lineStyle: {
                    color: 'hsl(220 15% 18%)',
                  },
                  ...axis.axisLine,
                },
              }))
            : {
                ...config.yAxis,
                axisLabel: {
                  color: '#ffffff',
                  fontSize: 11,
                  ...config.yAxis.axisLabel,
                },
                axisLine: {
                  lineStyle: {
                    color: 'hsl(220 15% 18%)',
                  },
                  ...config.yAxis.axisLine,
                },
              }) : undefined,
          grid: {
            left: '3%',
            right: '4%',
            bottom: '15%', // Extra space for data zoom
            top: config.title ? '15%' : '3%',
            containLabel: true,
            ...config.grid,
          },
          // Enhanced series for better performance
          series: config.series?.map((series: any) => ({
            ...series,
            large: true,
            progressive: 200,
            progressiveThreshold: 1000,
          }))
        }

        chart.setOption(enhancedConfig)

        const handleResize = () => chart.resize()
        window.addEventListener('resize', handleResize)

        // Initial resize
        setTimeout(() => chart.resize(), 100)

        return () => {
          window.removeEventListener('resize', handleResize)
          chart.dispose()
        }
      } catch (err) {
        console.error('ChartRenderer: Failed to render chart:', err)
        setChartError(`Failed to render chart: ${err instanceof Error ? err.message : 'Unknown error'}`)
      }
    }, [chartJson])

    if (!chartJson) return null

    return (
      <div className="bg-card border border-border rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" />
            <h3 className="font-semibold text-white">Visualization</h3>
          </div>
          <div className="text-xs text-white/60">
            Drag to pan • Scroll to zoom
          </div>
        </div>
        <div 
          ref={containerRef}
          className="w-full overflow-x-auto"
        >
          <div 
            ref={chartRef} 
            className="w-full h-[400px] min-w-[600px] bg-gradient-to-br from-secondary/30 to-secondary/10 rounded border border-border"
            style={{ minHeight: '400px' }}
          />
        </div>
      </div>
    )
  }

  // --- Render recommended prompts for a specific history item ---
  const renderItemRecommendedPrompts = (item: HistoryItem) => {
    const promptsToShow =
      item.response.recommended_prompts && item.response.recommended_prompts.length > 0
        ? item.response.recommended_prompts
        : globalRecommendedPrompts

    if (!item.showRecommendedPrompts || promptsToShow.length === 0) return null

    return (
      <section className="bg-card/80 border border-primary/20 rounded-lg p-4 sm:p-6 mt-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Lightbulb className="w-5 h-5 text-primary" />
            <h3 className="font-semibold text-white">Suggested Follow-up Questions</h3>
          </div>
          <button
            onClick={() => toggleItemRecommendedPrompts(item.id)}
            className="p-1 text-primary hover:bg-primary/10 rounded transition-colors"
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
              className="text-left p-3 bg-secondary hover:bg-secondary/80 rounded-lg border border-border transition-all text-sm text-white hover:border-primary/50 group"
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

  // --- Render initial recommended prompts ---
  const renderInitialRecommendedPrompts = () => {
    if (history.length > 0 || globalRecommendedPrompts.length === 0) return null

    return (
      <section className="bg-card/80 border border-primary/20 rounded-lg p-4 sm:p-6 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Lightbulb className="w-5 h-5 text-primary" />
          <h3 className="font-semibold text-white">Suggested Questions</h3>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {globalRecommendedPrompts.map((prompt, index) => (
            <button
              key={index}
              onClick={() => handlePromptClick(prompt)}
              className="text-left p-3 bg-secondary hover:bg-secondary/80 rounded-lg border border-border transition-all text-sm text-white hover:border-primary/50 group"
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

  // --- Render Mimir recommends ---
  const renderMimirRecommends = (recommendations?: string[]) => {
    if (!recommendations || recommendations.length === 0) return null

    return (
      <div className="bg-card/80 border border-primary/30 rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-4">
          <Brain className="w-5 h-5 text-primary" />
          <h3 className="font-semibold text-white">Mimir's Insights</h3>
        </div>
        <div className="space-y-3">
          {recommendations.map((recommendation, index) => (
            <div key={index} className="flex items-start gap-3 p-3 bg-secondary rounded-lg border border-border">
              <div className="w-2 h-2 bg-primary rounded-full mt-2 flex-shrink-0" />
              <p className="text-sm text-white flex-1 break-words">{recommendation}</p>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background animated-gradient flex overflow-hidden dark">
      {/* Chat Sidebar */}
      {showChatSidebar && (
        <div className="fixed lg:relative inset-y-0 left-0 z-40 w-80 bg-card/90 border-r border-border flex flex-col lg:flex">
          {/* Sidebar Header */}
          <div className="p-4 border-b border-border">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Brain className="w-6 h-6 text-primary" />
                <h2 className="text-lg font-semibold text-white">Mimir</h2>
              </div>
              <button
                onClick={() => setShowNewChatModal(true)}
                className="p-2 text-primary hover:bg-primary/10 rounded-lg transition-colors"
                title="New Chat"
              >
                <Plus className="w-5 h-5" />
              </button>
            </div>

            {/* Current Chat Info */}
            <div className="bg-primary/10 border border-primary/30 p-3 rounded-lg">
              <p className="text-xs font-medium text-white/60">Current Chat</p>
              <p className="text-lg font-semibold text-primary truncate">{currentChat}</p>
              <p className="text-xs text-white/60 mt-1">
                {history.length} message{history.length !== 1 ? "s" : ""}
              </p>
              {csvPath && (
                <p className="text-xs text-primary/80 mt-1 truncate flex items-center gap-1" title={csvPath}>
                  <Database className="w-3 h-3" />
                  {fileName || csvPath.split(/[\\/]/).pop()}
                </p>
              )}
            </div>
          </div>

          {/* Chat List */}
          <div className="flex-1 overflow-y-auto">
            {chats.map((chat) => (
              <div
                key={chat.name}
                className={`p-3 border-b border-border cursor-pointer hover:bg-secondary/50 transition-colors ${
                  currentChat === chat.name ? "bg-primary/10 border-primary/30" : ""
                }`}
                onClick={() => handleSwitchChat(chat.name)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <MessageSquare className="w-4 h-4 text-white/60 flex-shrink-0" />
                    <span className="font-medium text-white truncate">{chat.name}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-white/60 bg-secondary px-2 py-1 rounded">{chat.message_count}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteChat(chat.name)
                      }}
                      className="p-1 text-white/60 hover:text-destructive transition-colors"
                      title="Delete Chat"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-white/60 mt-1">{new Date(chat.created_at).toLocaleDateString()}</p>
                {chat.csv_path && (
                  <p className="text-xs text-primary/70 mt-1 truncate flex items-center gap-1" title={chat.csv_path}>
                    <Database className="w-3 h-3" />
                    {chat.csv_path.split(/[\\/]/).pop()}
                  </p>
                )}
              </div>
            ))}
          </div>

          {/* Sidebar Footer */}
          <div className="p-4 border-t border-border">
            <button
              onClick={() => setShowChatSidebar(false)}
              className="w-full p-2 text-white/60 hover:bg-secondary rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              <X className="w-4 h-4" />
              Hide Sidebar
            </button>
          </div>
        </div>
      )}

      {showChatSidebar && (
        <div className="fixed inset-0 bg-black/50 z-30 lg:hidden" onClick={() => setShowChatSidebar(false)} />
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Bar */}
        <div className="bg-card/90 border-b border-border p-4 flex-shrink-0">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              {!showChatSidebar && (
                <button
                  onClick={() => setShowChatSidebar(true)}
                  className="p-2 text-white/60 hover:bg-secondary rounded-lg transition-colors flex-shrink-0"
                  title="Show Chats"
                >
                  <Menu className="w-5 h-5" />
                </button>
              )}
              <Brain className="w-7 h-7 text-primary flex-shrink-0" />
              <div className="min-w-0">
                <h1 className="text-xl font-bold text-white">Mimir</h1>
                <p className="text-xs text-white/60 hidden sm:block">AI-Powered Data Analysis Assistant</p>
              </div>
            </div>
            <div className="text-sm text-white/60 flex items-center gap-2 sm:gap-4 min-w-0">
              <span className="flex items-center gap-2 min-w-0">
                <MessageSquare className="w-4 h-4 text-primary flex-shrink-0" />
                <span className="font-semibold text-primary truncate hidden sm:inline">{currentChat}</span>
              </span>
              {csvPath && (
                <span className="flex items-center gap-2 min-w-0">
                  <Database className="w-4 h-4 text-primary flex-shrink-0" />
                  <span className="font-semibold text-primary truncate hidden md:inline">
                    {fileName || csvPath.split(/[\\/]/).pop()}
                  </span>
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-6xl mx-auto p-4 sm:p-6 w-full">
            {/* Enhanced File Upload Section */}
            <header className="bg-card/80 border border-border rounded-lg p-4 sm:p-6 mb-6">
              <div 
                className={`flex flex-col items-center justify-center border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-all ${
                  isDragging 
                    ? "border-primary bg-primary/10 scale-105" 
                    : "border-primary/30 bg-secondary/30 hover:bg-secondary/50 hover:border-primary/50"
                }`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <FileDown className="w-12 h-12 text-primary mb-4" />
                <p className="text-white font-medium text-lg mb-2">Drop your CSV file here</p>
                <p className="text-white/60 text-sm">or click to browse files</p>
                <p className="text-white/40 text-xs mt-2">Supports .csv files</p>
              </div>

              {/* Current file info */}
              {fileName && (
                <div className="mt-4 p-3 bg-primary/10 border border-primary/20 rounded-lg">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Database className="w-4 h-4 text-primary" />
                      <span className="font-semibold text-primary truncate">{fileName}</span>
                    </div>
                    <div className="text-xs text-white/60">
                      Ready for analysis
                    </div>
                  </div>
                </div>
              )}

              {/* CSV Info */}
              {csvInfo && (
                <pre className="mt-4 p-4 bg-secondary/50 border border-border rounded-lg text-sm overflow-x-auto text-white font-mono max-h-40 overflow-y-auto">
                  {csvInfo}
                </pre>
              )}

              {/* Enhanced CSV Preview */}
              {csvPreview.length > 0 && (
                <div className="mt-4 border border-border rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between p-3 bg-secondary border-b border-border">
                    <div className="flex items-center gap-2">
                      <Database className="w-4 h-4 text-primary" />
                      <span className="text-sm font-medium text-white">CSV Preview (first 10 rows)</span>
                    </div>
                    <div className="text-xs text-white/60 bg-primary/20 px-2 py-1 rounded">
                      {csvPreview.length - 1} rows × {csvPreview[0]?.length || 0} columns
                    </div>
                  </div>
                  <div className="overflow-x-auto max-h-80">
                    <table className="w-full text-sm">
                      <thead className="bg-secondary/50 sticky top-0">
                        <tr>
                          {csvPreview[0]?.map((col, idx) => (
                            <th
                              key={idx}
                              className="px-4 py-3 text-left font-semibold text-primary border-r border-border whitespace-nowrap min-w-32"
                            >
                              <div className="flex items-center gap-2">
                                <span className="truncate" title={col}>
                                  {col}
                                </span>
                                <span className="text-xs text-white/40 bg-secondary px-1 rounded">
                                  {idx + 1}
                                </span>
                              </div>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {csvPreview.slice(1).map((row, i) => (
                          <tr 
                            key={i} 
                            className="border-b border-border hover:bg-secondary/20 transition-colors group"
                          >
                            {row.map((cell, j) => (
                              <td 
                                key={j} 
                                className="px-4 py-2 border-r border-border whitespace-nowrap text-white group-hover:bg-secondary/10 transition-colors"
                                title={cell}
                              >
                                <div className="truncate max-w-xs">
                                  {cell}
                                </div>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {csvPreview.length > 6 && (
                    <div className="p-2 bg-secondary/30 border-t border-border text-center">
                      <p className="text-xs text-white/60">
                        Scroll horizontally to see more columns • Showing first 10 rows
                      </p>
                    </div>
                  )}
                </div>
              )}
            </header>

            {/* Initial Recommended Prompts Section */}
            {renderInitialRecommendedPrompts()}

            {/* Query Input */}
            <section className="bg-card/80 border border-border rounded-lg p-4 sm:p-6 mb-6 flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Ask a question about your data..."
                className="flex-1 px-4 py-3 bg-secondary border border-border rounded-lg focus:ring-2 focus:ring-primary text-base sm:text-lg text-white placeholder:text-white/40 min-w-0"
                disabled={loading}
                onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
              />
              <button
                onClick={handleAnalyze}
                disabled={loading || !query.trim() || !csvPath}
                className="px-6 sm:px-8 py-3 bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-2 font-semibold transition-all whitespace-nowrap"
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

            {/* History / Results - Now with proper scrollbar and individual tab states */}
            <section 
              ref={historyContainerRef}
              className="space-y-4 max-h-[calc(100vh-400px)] overflow-y-auto pr-2"
            >
              {history.map((item) => {
                const itemActiveTab = item.activeTab || "result"
                
                return (
                  <article key={item.id} className="bg-card/80 border border-border rounded-lg overflow-hidden">
                    <header className="bg-primary/20 border-b border-primary/30 p-4">
                      <p className="text-white font-semibold break-words">{item.query}</p>
                      <time className="text-white/60 text-sm mt-1">{item.timestamp}</time>
                    </header>
                    {item.response.error ? (
                      <div className="p-4 bg-destructive/10 border-l-4 border-destructive">
                        <p className="text-destructive font-semibold">Error:</p>
                        <p className="text-destructive/80 text-sm mt-1 break-words">{item.response.error}</p>
                      </div>
                    ) : (
                      <>
                        <nav className="flex border-b border-border bg-secondary/30 overflow-x-auto">
                          {renderTabButton(item.id, "result", <BarChart3 className="w-4 h-4" />, "Results", itemActiveTab === "result")}
                          {renderTabButton(item.id, "summary", <FileText className="w-4 h-4" />, "Summary", itemActiveTab === "summary")}
                          {renderTabButton(item.id, "mimir", <Brain className="w-4 h-4" />, "Mimir Recommends", itemActiveTab === "mimir")}
                        </nav>
                        <div className="p-4 sm:p-6">
                          {itemActiveTab === "result" && (
                            <div className="space-y-4">
                              <div className="bg-secondary/50 border border-border p-4 rounded-lg">
                                <pre className="text-sm font-mono text-white whitespace-pre-wrap break-words">
                                  {item.response.result}
                                </pre>
                              </div>
                              <ChartRenderer chartJson={item.response.chart} />
                            </div>
                          )}
                          {itemActiveTab === "summary" && (
                            <p className="text-white leading-relaxed break-words">{item.response.summary}</p>
                          )}
                          {itemActiveTab === "mimir" && (
                            <div className="space-y-6">
                              {renderMimirRecommends(item.response.mimir_recommends)}
                              {(!item.response.mimir_recommends || item.response.mimir_recommends.length === 0) && (
                                <div className="text-center py-8 text-white/60">
                                  <Brain className="w-12 h-12 mx-auto mb-3 text-primary/50" />
                                  <p>No additional insights available for this analysis.</p>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </>
                    )}

                    {/* Recommended prompts for this specific item */}
                    {renderItemRecommendedPrompts(item)}
                  </article>
                )
              })}
              {/* Invisible element to scroll to */}
              <div ref={messagesEndRef} />
            </section>
          </div>
        </div>
      </div>

      {/* New Chat Modal */}
      {showNewChatModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border rounded-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold mb-4 text-white">Create New Chat</h3>
            <input
              type="text"
              value={newChatName}
              onChange={(e) => setNewChatName(e.target.value)}
              placeholder="Enter chat name..."
              className="w-full px-3 py-2 bg-secondary border border-border rounded-lg focus:ring-2 focus:ring-primary mb-4 text-white placeholder:text-white/40"
              onKeyDown={(e) => e.key === "Enter" && handleCreateChat()}
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowNewChatModal(false)}
                className="px-4 py-2 text-white/60 hover:bg-secondary rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateChat}
                disabled={!newChatName.trim()}
                className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors font-semibold"
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
