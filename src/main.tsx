import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

// Mock ipcRenderer if running in browser (non-Electron) environment
if (typeof window !== 'undefined' && !window.ipcRenderer) {
  console.log("Running in Browser Mode (Mocking ipcRenderer)")
  window.ipcRenderer = {
    on: (_channel: string, _listener: any) => {
      // Return a no-op cleanup function
      return () => { }
    },
    off: () => { },
    send: (channel: string, ...args: any[]) => {
      console.log(`[Mock Send] ${channel}:`, args)
    },
    invoke: (channel: string, ...args: any[]) => {
      console.log(`[Mock Invoke] ${channel}:`, args)
      return Promise.resolve(null)
    }
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Use contextBridge
window.ipcRenderer.on('main-process-message', (_event, message) => {
  console.log(message)
})
