import { useEffect, useState } from "react"
import { checkUpdate, installUpdate, onUpdaterEvent } from "@tauri-apps/api/updater"

export function useUpdater() {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<any>(null)

  useEffect(() => {
    const unlisten = onUpdaterEvent((event:any) => {
      console.log("Updater event:", event)
      if (event?.payload?.status === "pending") {
        setUpdateAvailable(true)
        setUpdateInfo(event.payload)
      }
    })

    checkUpdate()
      .then((res:any) => {
        console.log("Updater check result:", res)
        if (res?.shouldUpdate) {
          setUpdateAvailable(true)
          setUpdateInfo(res)
        }
      })
      .catch((err:any) => console.error("Updater check failed:", err))

    return () => {
      unlisten.then((f:any) => f())
    }
  }, [])

  const runUpdate = async () => {
    try {
      await installUpdate()
    } catch (err) {
      console.error("Failed to install update:", err)
    }
  }

  return { updateAvailable, updateInfo, runUpdate }
}

