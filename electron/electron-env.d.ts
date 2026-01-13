/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    APP_ROOT: string
    VITE_PUBLIC: string
  }
}

interface IpcHandler {
  on(channel: string, listener: (event: any, ...args: any[]) => void): () => void
  off(channel: string, ...args: any[]): void
  send(channel: string, ...args: any[]): void
  invoke(channel: string, ...args: any[]): Promise<any>
}

// Used in Renderer process, expose in `preload.ts`
interface Window {
  ipcRenderer: IpcHandler
}
