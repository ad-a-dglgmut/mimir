declare module "@tauri-apps/api/updater" {
  export interface UpdateResult {
    shouldUpdate: boolean
    version: string
    body?: string
  }

  export interface UpdateEvent {
    error?: string
    status?: string
    payload?: any
  }

  export function checkUpdate(): Promise<UpdateResult>
  export function installUpdate(): Promise<void>
  export function onUpdaterEvent(callback: (event: UpdateEvent) => void): Promise<() => void>
}

