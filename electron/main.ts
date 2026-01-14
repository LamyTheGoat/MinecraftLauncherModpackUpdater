console.log("Electron main process starting...")
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
import * as crypto from 'crypto'

const require = createRequire(import.meta.url)
const { Client } = require('minecraft-launcher-core')
const msmc = require('msmc')

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// App Data Path for Minecraft
let cachedMcRoot: string | null = null
function getMcRoot() {
  if (cachedMcRoot) return cachedMcRoot
  const root = path.join(app.getPath('userData'), 'minecraft_instance')
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true })
  cachedMcRoot = root
  return root
}


// Store for Auth
const store = new Store()

// Global Error Handlers for debugging
process.on('uncaughtException', (err) => {
  console.error('CRITICAL UNCAUGHT EXCEPTION:', err)
})
process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason)
})

// ----------------------------------------------------------------------
// CONFIGURATION (Placeholders)
// ----------------------------------------------------------------------
const MODPACK_URL = 'https://github.com/LamyTheGoat/MinecraftLauncherModpackUpdater/releases/download/modpackver1.0.2/modpack.zip' // UPDATED FROM MANIFEST
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

  // Handle modpack sync after UI is ready
  win.webContents.once('did-finish-load', () => {
    console.log("Main window loaded, starting background sync...")
    syncModpack(win!).catch(err => {
      console.error("Background sync failed:", err)
    })
  })
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

app.whenReady().then(() => {
  console.log("App Ready, creating window...")
  createWindow()
})

// ----------------------------------------------------------------------
// MODPACK SYNC LOGIC
// ----------------------------------------------------------------------
let syncPromise: Promise<any> | null = null

async function syncModpack(browserWindow: BrowserWindow) {
  if (syncPromise) {
    console.log("Sync already in progress, waiting for it...")
    return syncPromise
  }

  syncPromise = (async () => {
    try {
      console.log(`[SYNC] Starting sync in: ${getMcRoot()}`)
      const updater = new UpdaterManager(browserWindow, getMcRoot())

      // 1. Check App Updates (Async, don't block)
      updater.checkForAppUpdates()

      // 2. Check Modpack Updates
      const startManifest = await updater.checkModpackUpdates() // Returns Manifest if any field changed
      const modpackZipPath = path.join(getMcRoot(), 'modpack.zip')
      const modsPath = path.join(getMcRoot(), 'mods')

      // MERGE STRATEGY: Default <- Local <- Remote
      // This ensures we always have minecraft and fabric versions even if remote is partial
      const localManifest = updater.getLocalManifest()
      const DEFAULT_MANIFEST = {
        version: "1.0.8",
        minecraft: "1.21.8",
        fabric: "0.18.4",
        url: "" // Default to empty to allow forced reset
      }

      let activeManifest = {
        ...DEFAULT_MANIFEST,
        ...(localManifest || {}),
        ...(startManifest || {})
      }

      // If local is missing completely, we might want the hardcoded default
      if (!localManifest && !startManifest && !activeManifest.url) {
        activeManifest.url = MODPACK_URL
      }

      const zipExists = fs.existsSync(modpackZipPath)
      const modsExists = fs.existsSync(modsPath)
      const downloadUrl = (activeManifest.url || "").trim()

      console.log(`[SYNC] Check: updateDetected=${!!startManifest}, zipExists=${zipExists}, modsExists=${modsExists}`)
      console.log(`[SYNC] Resolved Versions: MC=${activeManifest.minecraft}, Fabric=${activeManifest.fabric}, Pack=${activeManifest.version}, URL="${downloadUrl}"`)

      // MANDATORY EMPTY URL CLEANUP: If URL is empty and mods exist, CLEAR THEM
      if (!downloadUrl) {
        if (modsExists || zipExists) {
          console.log("[SYNC] URL is empty but mods/zip exist. Clearing modpack state...")
          browserWindow.webContents.send('status', 'Clearing modpack (Empty URL)...')

          const keepList = ['versions', 'libraries', 'assets', 'runtime', 'java', 'modpack-info.json']
          const files = fs.readdirSync(getMcRoot())
          for (const file of files) {
            if (!keepList.includes(file)) {
              const fullPath = path.join(getMcRoot(), file)
              try { console.log(`[SYNC] Clearing: ${file}`); fs.rmSync(fullPath, { recursive: true, force: true }) } catch (e) { }
            }
          }

          browserWindow.webContents.send('status', 'Modpack Cleared.')
        } else {
          console.log("[SYNC] URL is empty and folder is already clean.")
        }

        updater.updateLocalManifest(activeManifest)
        return activeManifest // ALWAYS EXIT EARLY FOR EMPTY URL
      }

      if (startManifest || !zipExists || !modsExists) {
        console.log(`[SYNC] Update or Repair needed. Target Version: ${activeManifest.version}`)
        const tempZipPath = path.join(getMcRoot(), 'modpack_temp.zip')
        browserWindow.webContents.send('status', 'Downloading Modpack...')

        try {
          const zipCacheBuster = `?t=${Date.now()}`
          const finalUrl = downloadUrl.includes('?') ? `${downloadUrl}&${zipCacheBuster.substring(1)}` : `${downloadUrl}${zipCacheBuster}`

          console.log(`[SYNC] Fetching from: ${finalUrl}`)
          // Add a timeout for large zip
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 120000)

          const res = await fetch(finalUrl, { signal: controller.signal })
          clearTimeout(timeout)

          if (!res.ok) throw new Error(`Unexpected response ${res.statusText}`)
          if (!res.body) throw new Error('Response body is empty')

          console.log(`[SYNC] Download started, piping to ${tempZipPath}`)
          const fileStream = fs.createWriteStream(tempZipPath)

          await new Promise<void>((resolve, reject) => {
            if (!res.body) return reject(new Error('No body'))
            res.body.pipe(fileStream)
            res.body.on('error', (err) => { console.error("[SYNC] Stream error:", err); reject(err) })
            fileStream.on('error', (err) => { console.error("[SYNC] File stream error:", err); reject(err) })
            fileStream.on('finish', () => { console.log("[SYNC] Download finished."); resolve() })
          })

          browserWindow.webContents.send('status', 'Wiping existing modpack files...')

          // If the Minecraft version itself changed, we also wipe 'versions'
          const mcChanged = localManifest && activeManifest.minecraft !== localManifest.minecraft
          if (mcChanged) {
            console.log(`[SYNC] Minecraft version changed from ${localManifest.minecraft} to ${activeManifest.minecraft}. Nuclear wipe.`)
          }

          const keepList = ['libraries', 'assets', 'runtime', 'java', 'modpack-info.json', 'modpack.zip', 'modpack_temp.zip']
          if (!mcChanged) keepList.push('versions')

          const files = fs.readdirSync(getMcRoot())
          for (const file of files) {
            if (!keepList.includes(file)) {
              const fullPath = path.join(getMcRoot(), file)
              try { console.log(`Deep cleaning: Deleting ${file}`); fs.rmSync(fullPath, { recursive: true, force: true }) } catch (err) { }
            }
          }

          // Delete old modpack.zip if exists
          if (fs.existsSync(modpackZipPath)) {
            console.log("Replacing modpack.zip")
            fs.unlinkSync(modpackZipPath)
          }

          // Move temp file to final location
          fs.renameSync(tempZipPath, modpackZipPath)

          browserWindow.webContents.send('status', 'Extracting Modpack...')

          try {
            // Extract
            const zip = new AdmZip(modpackZipPath)
            zip.extractAllTo(getMcRoot(), true)
            console.log("Modpack extraction completed successfully.")
          } catch (zipErr) {
            console.error("Extraction failed!", zipErr)
            throw new Error("Modpack extraction failed: " + zipErr)
          }

          // Update local manifest 
          if (activeManifest) {
            updater.updateLocalManifest(activeManifest)
          }

          browserWindow.webContents.send('status', 'Modpack Installed.')

        } catch (e: any) {
          console.error("Download/Install failed:", e)
          browserWindow.webContents.send('status', 'Download Failed: ' + e.message)
          throw e
        }
      } else {
        console.log("Modpack is up to date.")
      }

      return activeManifest
    } finally {
      syncPromise = null
    }
  })()

  return syncPromise
}


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
  console.log("Starting Microsoft Login Flow...")
  try {
    const authManager = new msmc.Auth("select_account")
    // Use Electron window for auth
    const xboxManager = await authManager.launch("electron")
    console.log("Microsoft/Xbox Auth Success")
    const token = await xboxManager.getMinecraft()
    console.log(`Minecraft Profile Fetched: ${token.mclc().name} (${token.mclc().uuid})`)

    // Unified Client Token for consistency
    let clientToken: string = store.get('client_token') as string
    if (!clientToken) {
      clientToken = crypto.randomBytes(16).toString('hex')
      store.set('client_token', clientToken)
    }

    const profile = {
      name: token.mclc().name,
      uuid: token.mclc().uuid,
      access_token: token.mclc().access_token,
      client_token: clientToken, // Use unified token
      user_properties: token.mclc().user_properties,
      meta: { ...token.mclc().meta, type: 'msa' }
    }

    store.set('mc_profile', profile)
    return profile
  } catch (e: any) {
    console.error("Auth Error:", e)
    throw e
  }
})

ipcMain.handle('logout', async () => {
  console.log("PERFORMING HARD RESET: Clearing all local store data.")
  store.clear() // WIPE EVERYTHING
  return { success: true }
})

// 3. Launch Game
ipcMain.on('launch-game', async (_event, { username }) => {
  console.log(`LAUNCH REQUEST for username: "${username}"`)
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

  // 1.5 Helper for Deterministic Offline Auth
  function getOfflineAuth(username: string) {
    // Standard Minecraft Offline UUID is MD5 of "OfflinePlayer:Name"
    const hash = crypto.createHash('md5').update(`OfflinePlayer:${username}`).digest()

    // Set version to 3 (MD5 based)
    hash[6] = (hash[6] & 0x0f) | 0x30
    // Set variant to RFC 4122
    hash[8] = (hash[8] & 0x3f) | 0x80

    const hex = hash.toString('hex')
    const uuid = `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`

    // Deterministic Access Token based on username
    const accessToken = crypto.createHash('sha1').update(`Access:${username}:salt123`).digest('hex')

    // Deterministic Client Token based on username (unique to user, but static)
    const clientToken = crypto.createHash('sha1').update(`Client:${username}:salt456`).digest('hex')

    return {
      access_token: accessToken,
      client_token: clientToken,
      uuid: uuid,
      name: username,
      user_properties: '{}',
      meta: { type: 'offline' }
    }
  }

  const savedProfile: any = store.get('mc_profile')
  // If saved profile matches requested username (or if we just use saved profile for Online mode)
  if (savedProfile && savedProfile.name === username) {
    auth = savedProfile
    const type = (auth.meta as any)?.type || 'offline'
    console.log(`Using SAVED AUTH for ${username} (${type === 'offline' ? 'Offline' : 'Microsoft'})`)
  } else {
    // Use Deterministic Offline Auth instead of MCLC's random one
    auth = getOfflineAuth(username)
    console.log(`Using DETERMINISTIC OFFLINE AUTH for ${username}: ${auth.uuid}`)
  }

  console.log("FINAL AUTH CONFIG:", {
    name: auth.name,
    uuid: auth.uuid,
    authType: (auth.meta as any)?.type || 'offline',
    clientToken: auth.client_token
  })

  // Send back to renderer for the DEBUG IDENTITY box
  win?.webContents.send('auth-debug', {
    name: auth.name,
    uuid: auth.uuid,
    type: (auth.meta as any)?.type || 'offline',
    clientToken: auth.client_token?.substring(0, 8)
  })

  // ----------------------------------------------------------------------
  // UPDATE & DOWNLOAD LOGIC
  // ----------------------------------------------------------------------
  let activeManifest: any;
  try {
    activeManifest = await syncModpack(win!)
  } catch (e) {
    return // Stop launch if sync fails
  }

  // Determine loader type from manifest
  const loaderType = activeManifest.fabric ? 'fabric' : (activeManifest.forge ? 'forge' : null)
  console.log(`Detected loader type: ${loaderType || 'vanilla'}`)

  // 2.5 Ensure Loader Installer Exists (Forge or Fabric)
  if (loaderType === 'forge' && activeManifest.forge) {
    const forgeInstallerPath = path.join(getMcRoot(), 'forge-installer.jar')
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
      // Check if Fabric JSON already exists to skip installer (prevents network crash)
      const fabVersion = `fabric-loader-${activeManifest.fabric}-${activeManifest.minecraft}`
      const jsonPath = path.join(getMcRoot(), 'versions', fabVersion, `${fabVersion}.json`)
      const installerPath = path.join(getMcRoot(), 'fabric-installer.jar')

      if (!fs.existsSync(jsonPath)) {
        // Download installer if missing
        if (!fs.existsSync(installerPath)) {
          // ... (keep installer download logic)
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
        const javaHandler = new JavaHandler(getMcRoot())
        const javaPath = await javaHandler.ensureJava()

        // Run Installer
        const installCmd = `"${javaPath}" -jar "${installerPath}" client -dir "${getMcRoot()}" -mcversion ${activeManifest.minecraft} -loader ${activeManifest.fabric} -noprofile`
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
      }

      // 2.7 Ensure the PARENT version JSON exists and is valid
      const parentVersion = activeManifest.minecraft
      const parentDir = path.join(getMcRoot(), 'versions', parentVersion)
      const parentJsonPath = path.join(parentDir, `${parentVersion}.json`)

      if (fs.existsSync(parentJsonPath)) {
        try {
          let parentContent = JSON.parse(fs.readFileSync(parentJsonPath, 'utf-8'))
          if (parentContent.id !== parentVersion) {
            console.log(`[LAUNCHER] Metadata ID mismatch! Found ${parentContent.id}, expected ${parentVersion}. Deleting metadata...`)
            fs.unlinkSync(parentJsonPath)
          }
        } catch (e) {
          console.error("Parent metadata verification error", e)
        }
      }

      if (!fs.existsSync(parentJsonPath)) {
        win?.webContents.send('status', `Downloading base version metadata (${parentVersion})...`)
        try {
          if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true })

          const manifestRes = await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')
          if (manifestRes.ok) {
            const manifest: any = await manifestRes.json()
            const versionEntry = manifest.versions.find((v: any) => v.id === parentVersion)
            if (versionEntry) {
              const versionRes = await fetch(versionEntry.url)
              if (versionRes.ok) {
                const versionJson: any = await versionRes.json()
                fs.writeFileSync(parentJsonPath, JSON.stringify(versionJson, null, 2))
                console.log(`[LAUNCHER] Fetched official metadata for ${parentVersion}`)
              }
            }
          }
        } catch (e) {
          console.error("Failed to fetch parent metadata", e)
        }
      }

      // Verify and Patch Game JAR
      if (fs.existsSync(parentJsonPath)) {
        try {
          let parentContent = JSON.parse(fs.readFileSync(parentJsonPath, 'utf-8'))
          const localJarPath = path.join(parentDir, `${parentVersion}.jar`)

          // Verify SHA1 against official metadata
          if (fs.existsSync(localJarPath) && parentContent.downloads?.client?.sha1) {
            const buffer = fs.readFileSync(localJarPath)
            const localHash = crypto.createHash('sha1').update(buffer).digest('hex')
            const officialHash = parentContent.downloads.client.sha1

            if (localHash !== officialHash) {
              console.log(`[LAUNCHER] Version mismatch! Local JAR is ${localHash}, expected ${officialHash}. Deleting...`)
              fs.unlinkSync(localJarPath)
            } else {
              console.log(`[LAUNCHER] Game JAR verified for ${parentVersion}`)
            }
          }
        } catch (e) {
          console.error("Game JAR verification error", e)
        }
      }

      // Patch the Fabric JSON - Standalone Merge Strategy
      // This merges parent (Minecraft) into child (Fabric) to fix Classpath issues (ClassNotFoundException)
      if (fs.existsSync(jsonPath) && fs.existsSync(parentJsonPath)) {
        try {
          let jsonContent = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
          let parentContent = JSON.parse(fs.readFileSync(parentJsonPath, 'utf-8'))
          let saveChild = false

          console.log(`Starting deep merge for ${fabVersion} (Standalone mode)`)

          // 1. Merge Libraries (with aggressive deduplication)
          const getArtifactBase = (name: string) => {
            const parts = name.split(':')
            // name format: group:artifact:version[:classifier]
            // We want to deduplicate by group:artifact, but KEEP different classifiers (natives)
            if (parts.length >= 4) {
              return `${parts[0]}:${parts[1]}:${parts[3]}` // Includes classifier
            }
            return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : name
          }

          const libMap = new Map<string, any>()

          // Fabric libraries (added first, they take priority)
          if (jsonContent.libraries) {
            for (const lib of jsonContent.libraries) {
              const artBase = getArtifactBase(lib.name)
              if (!libMap.has(artBase)) {
                libMap.set(artBase, lib)
              } else {
                // If already duplicate, prioritize higher version or just keep the first one found (Fabric)
                console.log(`Found existing duplicate in child: ${lib.name}, keeping current one.`)
              }
            }
          }

          // Parent libraries (only added if missing)
          const initialChildLibCount = libMap.size
          if (parentContent.libraries) {
            for (const lib of parentContent.libraries) {
              const artBase = getArtifactBase(lib.name)
              if (!libMap.has(artBase)) {
                libMap.set(artBase, lib)
              } else {
                console.log(`Skipping parent library ${lib.name} because ${artBase} is already provided by child.`)
              }
            }
          }

          if (libMap.size !== initialChildLibCount || (jsonContent.libraries && jsonContent.libraries.length !== libMap.size)) {
            jsonContent.libraries = Array.from(libMap.values())
            saveChild = true
            console.log(`Merged and deduplicated libraries: ${jsonContent.libraries.length} total.`)
          }

          // 2. Merge Arguments (JVM and Game)
          if (parentContent.arguments) {
            if (!jsonContent.arguments) jsonContent.arguments = { game: [], jvm: [] }

            // Merge Game args
            const gameArgsSet = new Set(jsonContent.arguments.game.filter((a: any) => typeof a === 'string'))
            if (parentContent.arguments.game) {
              for (const arg of parentContent.arguments.game) {
                if (typeof arg === 'string' && !gameArgsSet.has(arg)) {
                  jsonContent.arguments.game.push(arg)
                  saveChild = true
                } else if (typeof arg === 'object') {
                  jsonContent.arguments.game.push(arg) // Complex rules, just add them
                  saveChild = true
                }
              }
            }

            // Merge JVM args
            const jvmArgsSet = new Set(jsonContent.arguments.jvm.filter((a: any) => typeof a === 'string'))
            if (parentContent.arguments.jvm) {
              for (const arg of parentContent.arguments.jvm) {
                if (typeof arg === 'string' && !jvmArgsSet.has(arg)) {
                  jsonContent.arguments.jvm.push(arg)
                  saveChild = true
                } else if (typeof arg === 'object') {
                  jsonContent.arguments.jvm.push(arg)
                  saveChild = true
                }
              }
            }
          }

          // 3. Copy essential fields if missing
          if (!jsonContent.downloads || Object.keys(jsonContent.downloads).length === 0) {
            jsonContent.downloads = parentContent.downloads
            saveChild = true
          }

          if (!jsonContent.assetIndex) {
            jsonContent.assetIndex = parentContent.assetIndex
            saveChild = true
          }

          if (!jsonContent.mainClass && parentContent.mainClass) {
            // Keep Fabric mainClass, but if somehow missing, fall back
          }

          // 4. Optionally clear inheritsFrom to make it truly standalone
          // This forces MCLC to stop trying to merge and just trust our JSON.
          if (jsonContent.inheritsFrom) {
            delete jsonContent.inheritsFrom
            saveChild = true
            console.log("Removed inheritsFrom to force standalone resolution")
          }

          if (saveChild) {
            fs.writeFileSync(jsonPath, JSON.stringify(jsonContent, null, 2))
          }

          // 5. Mirror the JAR file to the Fabric folder
          const expectedFabricJar = path.join(getMcRoot(), 'versions', fabVersion, `${fabVersion}.jar`)
          const sourceJarPath = path.join(parentDir, `${parentVersion}.jar`)

          if (!fs.existsSync(expectedFabricJar) && fs.existsSync(sourceJarPath)) {
            fs.copyFileSync(sourceJarPath, expectedFabricJar)
            console.log("Mirrored Minecraft JAR to Fabric folder")
          }
        } catch (e) {
          console.error("Fabric JSON standalone merge error", e)
        }
      }

      win?.webContents.send('status', 'Fabric Installed.')

    } catch (e: any) {
      console.error("Fabric Install Error", e)
      win?.webContents.send('status', 'Fabric Install Failed: ' + e.message)
    }
  }

  // 3. Launch

  // Ensure Java 17
  const javaHandler = new JavaHandler(getMcRoot())
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
    forgeConfig = path.join(getMcRoot(), 'forge-installer.jar')
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
    // clientPackage: null, // Removed duplicate
    authorization: auth,
    root: getMcRoot(),
    javaPath: javaPath,
    version: {
      number: customVersion,
      type: "release",
      custom: (loaderType === 'fabric') ? customVersion : undefined
    },
    // clientPackage removed to prevent "Invalid filename" error
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
