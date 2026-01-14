import { app, BrowserWindow, ipcMain } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as fs from 'fs'
import fetch from 'node-fetch'
import AdmZip from 'adm-zip'
import Store from 'electron-store'
import { UpdaterManager } from './updater'
import { JavaHandler } from './javaHandler'

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
const SERVER_IP = '93.113.57.69' // TODO: REPLACE THIS
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
      version: "1.0.8",
      minecraft: "1.21.8",
      fabric: "0.18.4",
      url: MODPACK_URL
    }
  }

  // Determine loader type from manifest
  const loaderType = activeManifest.fabric ? 'fabric' : (activeManifest.forge ? 'forge' : null)
  console.log(`Detected loader type: ${loaderType || 'vanilla'}`)

  // If update needed OR zip doesn't exist (fresh install), download it
  if (startManifest || !fs.existsSync(modpackZipPath)) {
    const downloadUrl = (startManifest && startManifest.url) || activeManifest.url || MODPACK_URL
    const tempZipPath = path.join(MC_ROOT, 'modpack_temp.zip')

    win?.webContents.send('status', 'Downloading Modpack...')

    try {
      const res = await fetch(downloadUrl)
      if (!res.ok) throw new Error(`Unexpected response ${res.statusText}`)
      if (!res.body) throw new Error('Response body is empty')

      // Download to temp file first
      const fileStream = fs.createWriteStream(tempZipPath)

      await new Promise<void>((resolve, reject) => {
        if (!res.body) return reject(new Error('No body'))
        res.body.pipe(fileStream)
        res.body.on('error', reject)
        fileStream.on('finish', () => resolve())
      })

      win?.webContents.send('status', 'Cleaning up old modpack files...')

      // Delete old modpack folders before extracting new one
      const foldersToClean = ['mods', 'config', 'resourcepacks', 'shaderpacks']
      for (const folder of foldersToClean) {
        const folderPath = path.join(MC_ROOT, folder)
        if (fs.existsSync(folderPath)) {
          fs.rmSync(folderPath, { recursive: true, force: true })
          console.log(`Deleted old ${folder} folder`)
        }
      }

      // Delete old modpack.zip if exists
      if (fs.existsSync(modpackZipPath)) {
        fs.unlinkSync(modpackZipPath)
      }

      // Move temp file to final location
      fs.renameSync(tempZipPath, modpackZipPath)

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

  // 2.5 Ensure Loader Installer Exists (Forge or Fabric)
  if (loaderType === 'forge' && activeManifest.forge) {
    const forgeInstallerPath = path.join(MC_ROOT, 'forge-installer.jar')
    if (!fs.existsSync(forgeInstallerPath)) {
      win?.webContents.send('status', 'Downloading Forge Installer...')
      try {
        // URL format: https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar
        const forgeVersion = `${activeManifest.minecraft}-${activeManifest.forge}`
        const forgeUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${forgeVersion}/forge-${forgeVersion}-installer.jar`

        const res = await fetch(forgeUrl)
        if (!res.ok) throw new Error(`Forge download failed: ${res.statusText}`)

        const fileStream = fs.createWriteStream(forgeInstallerPath)
        await new Promise<void>((resolve, reject) => {
          if (!res.body) return reject(new Error('No body'))
          res.body.pipe(fileStream)
          res.body.on('error', reject)
          fileStream.on('finish', () => resolve())
        })
      } catch (e: any) {
        console.error("Forge Download Error", e)
        win?.webContents.send('status', 'Forge Download Failed: ' + e.message)
      }
    }
  } else if (loaderType === 'fabric' && activeManifest.fabric) {
    // Manual Fabric Installation
    win?.webContents.send('status', 'Installing Fabric Loader...')
    try {
      const installerPath = path.join(MC_ROOT, 'fabric-installer.jar')
      // Download installer if missing
      if (!fs.existsSync(installerPath)) {
        // Fetch latest installer version
        const metaRes = await fetch('https://meta.fabricmc.net/v2/versions/installer')
        if (!metaRes.ok) throw new Error('Failed to fetch fabric installer meta')
        const meta: any = await metaRes.json()
        const installerUrl = meta[0].url

        const res = await fetch(installerUrl)
        if (!res.ok) throw new Error('Failed to download fabric installer')

        const fileStream = fs.createWriteStream(installerPath)
        await new Promise<void>((resolve, reject) => {
          if (!res.body) return reject(new Error('No body'))
          res.body.pipe(fileStream)
          res.body.on('error', reject)
          fileStream.on('finish', () => resolve())
        })
      }

      // Ensure Java is ready
      const javaHandler = new JavaHandler(MC_ROOT)
      const javaPath = await javaHandler.ensureJava()

      // Run Installer
      // java -jar installer.jar client -dir "..." -mcversion ... -loader ... -noprofile
      const installCmd = `"${javaPath}" -jar "${installerPath}" client -dir "${MC_ROOT}" -mcversion ${activeManifest.minecraft} -loader ${activeManifest.fabric} -noprofile`
      console.log('Running Fabric Installer:', installCmd)

      const { exec } = require('child_process')
      await new Promise<void>((resolve, reject) => {
        exec(installCmd, (err: any, stdout: any, stderr: any) => {
          if (err) {
            console.error(stderr)
            reject(err)
          } else {
            console.log(stdout)
            resolve()
          }
        })
      })

      // Patch the generated JSON to prevent MCLC crash ("reading 'client'")
      const fabVersion = `fabric-loader-${activeManifest.fabric}-${activeManifest.minecraft}`
      const jsonPath = path.join(MC_ROOT, 'versions', fabVersion, `${fabVersion}.json`)

      if (fs.existsSync(jsonPath)) {
        const jsonContent = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
        if (!jsonContent.downloads) {
          jsonContent.downloads = {}
        }
        if (!jsonContent.downloads.client) {
          // Inject dummy client to satisfy MCLC checks. 
          // Inheritance means it uses the parent jar, but MCLC 3.18 check might be strict on the child JSON.
          jsonContent.downloads.client = {
            url: "https://invalid.url/dummy-client.jar",
            sha1: "0000000000000000000000000000000000000000",
            size: 0
          }
        }
        fs.writeFileSync(jsonPath, JSON.stringify(jsonContent, null, 2))
        console.log(`Patched Fabric JSON at ${jsonPath}`)
      }

      win?.webContents.send('status', 'Fabric Installed.')

    } catch (e: any) {
      console.error("Fabric Install Error", e)
      win?.webContents.send('status', 'Fabric Install Failed: ' + e.message)
    }
  }

  // 3. Launch

  // Ensure Java 17
  const javaHandler = new JavaHandler(MC_ROOT)
  let javaPath = 'java' // Default to system java if check fails, but we expect check to work
  try {
    win?.webContents.send('status', 'Checking Java Runtime...')
    javaPath = await javaHandler.ensureJava()
  } catch (e: any) {
    console.error("Java Setup Failed:", e)
    win?.webContents.send('status', 'Java Setup Failed: ' + e.message)
    return
  }

  // Build loader configuration based on detected type
  let loaderConfig: any = undefined
  let forgeConfig: string | undefined = undefined

  if (loaderType === 'forge' && activeManifest.forge) {
    forgeConfig = path.join(MC_ROOT, 'forge-installer.jar')
    loaderConfig = {
      type: "forge",
      version: `${activeManifest.minecraft}-${activeManifest.forge}`
    }
  } else if (loaderType === 'fabric' && activeManifest.fabric) {
    // For Fabric, we manually installed it, so we target the version directly
    // Format: fabric-loader-{loader_version}-{game_version}
    loaderConfig = undefined // Do NOT let MCLC try to install it again
  }

  // Custom version override for Fabric
  const customVersion = (loaderType === 'fabric')
    ? `fabric-loader-${activeManifest.fabric}-${activeManifest.minecraft}`
    : activeManifest.minecraft

  const opts = {
    clientPackage: null,
    authorization: auth,
    root: MC_ROOT,
    javaPath: javaPath,
    version: {
      number: customVersion,
      type: "release",
      custom: (loaderType === 'fabric') ? customVersion : undefined
    },
    memory: {
      max: "4G",
      min: "2G"
    },
    forge: forgeConfig,
    loader: loaderConfig,
    quickPlay: {
      type: "multiplayer",
      identifier: `${SERVER_IP}:${SERVER_PORT}`
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
  const typeStr = loaderType ? `${loaderType} (v${loaderType === 'fabric' ? activeManifest.fabric : activeManifest.forge})` : 'Vanilla'
  win?.webContents.send('status', `Launching Minecraft ${activeManifest.minecraft} (${typeStr})...`)

  try {
    await launcher.launch(opts)
  } catch (e) {
    console.error("Launch Error", e)
    win?.webContents.send('status', 'Launch Error: ' + e)
  }
})
