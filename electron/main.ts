import { app, BrowserWindow, ipcMain } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as fs from 'fs'
import fetch from 'node-fetch'
import AdmZip from 'adm-zip'
import Store from 'electron-store'
import { UpdaterManager } from './updater'

const require = createRequire(import.meta.url)
const { Client, Authenticator } = require('minecraft-launcher-core')
const msmc = require('msmc')

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// App Data Path for Minecraft
const MC_ROOT = path.join(app.getPath('userData'), 'minecraft_instance')
if (!fs.existsSync(MC_ROOT)) fs.mkdirSync(MC_ROOT, { recursive: true })

// Store for Auth
const store = new Store()

// ----------------------------------------------------------------------
// CONFIGURATION (Placeholders)
// ----------------------------------------------------------------------
const MODPACK_URL = 'https://github.com/mehmetaltinsoy/modpack/releases/download/v1.0.0/modpack.zip' // TODO: REPLACE THIS
const SERVER_IP = 'play.example.com' // TODO: REPLACE THIS
const SERVER_PORT = 25565

// ----------------------------------------------------------------------
// MAIN WINDOW SETUP
// ----------------------------------------------------------------------
process.env.APP_ROOT = path.join(__dirname, '..')
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 600,
    frame: false, // Frameless for custom title bar
    titleBarStyle: 'hidden',
    backgroundColor: '#0d0d12',
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false
    },
  })

  // win.webContents.openDevTools()

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(createWindow)


// ----------------------------------------------------------------------
// IPC HANDLERS
// ----------------------------------------------------------------------

// 1. Check Previous Auth
ipcMain.handle('check-auth', async () => {
  const savedProfile = store.get('mc_profile')
  if (savedProfile) {
    return savedProfile
  }
  return null
})

// 2. Microsoft Login
ipcMain.handle('login-microsoft', async () => {
  try {
    const authManager = new msmc.Auth("select_account")
    // Use Electron window for auth
    const xboxManager = await authManager.launch("electron")
    const token = await xboxManager.getMinecraft()

    const profile = {
      name: token.mclc().name,
      uuid: token.mclc().uuid,
      access_token: token.mclc().access_token,
      user_properties: token.mclc().user_properties,
      meta: token.mclc().meta // msmc specific
    }

    store.set('mc_profile', profile)
    return profile
  } catch (e: any) {
    console.error("Auth Error:", e)
    throw e
  }
})

// 3. Launch Game
ipcMain.on('launch-game', async (_event, { username }) => {
  const launcher = new Client()

  // Auth setup
  let auth = {
    access_token: '',
    client_token: '',
    uuid: '',
    name: username,
    user_properties: '{}',
    meta: {}
  }

  const savedProfile: any = store.get('mc_profile')
  // If saved profile matches requested username (or if we just use saved profile for Online mode)
  if (savedProfile && savedProfile.name === username) {
    auth = savedProfile
  } else {
    // Offline / Cracked mode or just username
    auth = Authenticator.getAuth(username)
  }

  // ----------------------------------------------------------------------
  // UPDATE & DOWNLOAD LOGIC
  // ----------------------------------------------------------------------
  // ----------------------------------------------------------------------
  // UPDATE & DOWNLOAD LOGIC
  // ----------------------------------------------------------------------
  const updater = new UpdaterManager(win!, MC_ROOT)

  // 1. Check App Updates (Async, don't block)
  updater.checkForAppUpdates()

  // 2. Check Modpack Updates
  const startManifest = await updater.checkModpackUpdates() // Returns Manifest if update needed
  const modpackZipPath = path.join(MC_ROOT, 'modpack.zip')

  // Determine active manifest (New one if update, else local one)
  let activeManifest = startManifest || updater.getLocalManifest()

  // Fallback defaults if no local manifest exists yet
  if (!activeManifest) {
    activeManifest = {
      version: "1.0.0",
      minecraft: "1.20.1",
      forge: "47.2.0",
      url: MODPACK_URL
    }
  }

  // If update needed OR zip doesn't exist (fresh install), download it
  if (startManifest || !fs.existsSync(modpackZipPath)) {
    const downloadUrl = (startManifest && startManifest.url) || activeManifest.url || MODPACK_URL

    win?.webContents.send('status', 'Downloading Modpack...')

    try {
      const res = await fetch(downloadUrl)
      if (!res.ok) throw new Error(`Unexpected response ${res.statusText}`)
      if (!res.body) throw new Error('Response body is empty')

      const fileStream = fs.createWriteStream(modpackZipPath)

      await new Promise<void>((resolve, reject) => {
        if (!res.body) return reject(new Error('No body'))
        res.body.pipe(fileStream)
        res.body.on('error', reject)
        fileStream.on('finish', () => resolve())
      })

      win?.webContents.send('status', 'Extracting Modpack...')

      // Extract
      const zip = new AdmZip(modpackZipPath)
      zip.extractAllTo(MC_ROOT, true)

      // Update local manifest 
      if (activeManifest) {
        updater.updateLocalManifest(activeManifest)
      }

      win?.webContents.send('status', 'Modpack Installed.')

    } catch (e: any) {
      console.error(e)
      win?.webContents.send('status', 'Download Failed: ' + e.message)
      return // Stop launch
    }
  }

  // 3. Launch

  const opts = {
    clientPackage: null,
    authorization: auth,
    root: MC_ROOT,
    version: {
      number: activeManifest.minecraft,
      type: "release"
    },
    memory: {
      max: "4G",
      min: "2G"
    },
    forge: path.join(MC_ROOT, 'forge-installer.jar'),

    loader: activeManifest.forge ? {
      type: "forge",
      version: `${activeManifest.minecraft}-${activeManifest.forge}`
    } : undefined,

    quickPlay: {
      type: "multiplayer",
      address: SERVER_IP,
      port: SERVER_PORT
    }
  }

  // Event Listeners
  launcher.on('debug', (e: any) => console.log(e))
  launcher.on('data', (e: any) => console.log(e))
  launcher.on('progress', (e: any) => {
    // e: { type, task, total, current }
    win?.webContents.send('progress', e)
  })

  launcher.on('close', (code: any) => {
    console.log('Game closed', code)
    win?.webContents.send('game-closed')
  })

  console.log("Starting launcher with opts:", opts)
  win?.webContents.send('status', 'Launching Minecraft...')

  try {
    await launcher.launch(opts)
  } catch (e) {
    console.error("Launch Error", e)
    win?.webContents.send('status', 'Launch Error: ' + e)
  }
})
