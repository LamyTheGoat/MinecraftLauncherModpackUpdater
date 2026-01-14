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

const MC_ROOT = path.join(app.getPath('userData'), 'minecraft_instance')
if (!fs.existsSync(MC_ROOT)) fs.mkdirSync(MC_ROOT, { recursive: true })

// Store for Auth
const store = new Store()

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

    // Use the same UUID as the access_token for simplicity and uniqueness
    const accessToken = hex

    // Client token should be unique to the installation to avoid session conflicts
    let clientToken: string = store.get('client_token') as string
    if (!clientToken) {
      clientToken = crypto.randomBytes(16).toString('hex')
      store.set('client_token', clientToken)
    }

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
  } else {
    // Use Deterministic Offline Auth instead of MCLC's random one
    auth = getOfflineAuth(username)
    console.log(`Generated deterministic offline auth for ${username}: ${auth.uuid}`)
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
      // Check if Fabric JSON already exists to skip installer (prevents network crash)
      const fabVersion = `fabric-loader-${activeManifest.fabric}-${activeManifest.minecraft}`
      const jsonPath = path.join(MC_ROOT, 'versions', fabVersion, `${fabVersion}.json`)
      const installerPath = path.join(MC_ROOT, 'fabric-installer.jar')

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
        const javaHandler = new JavaHandler(MC_ROOT)
        const javaPath = await javaHandler.ensureJava()

        // Run Installer
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
      }

      // 2.7 Ensure the PARENT version JSON (1.21.8) exists and is patched
      // This is crucial because Fabric inherits from it, and MCLC might fail to resolve it if missing.
      const parentVersion = activeManifest.minecraft
      const parentDir = path.join(MC_ROOT, 'versions', parentVersion)
      const parentJsonPath = path.join(parentDir, `${parentVersion}.json`)

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
                console.log(`Manually installed official metadata for ${parentVersion}`)
              }
            }
          }
        } catch (e) {
          console.error("Failed to fetch parent metadata", e)
        }
      }

      if (fs.existsSync(parentJsonPath)) {
        try {
          let parentContent = JSON.parse(fs.readFileSync(parentJsonPath, 'utf-8'))
          let saveParent = false;

          // 1. Ensure 'downloads.client' matches LOCAL file SHA1
          if (!parentContent.downloads) parentContent.downloads = {}

          const localJarPath = path.join(parentDir, `${parentVersion}.jar`)
          if (fs.existsSync(localJarPath)) {
            const buffer = fs.readFileSync(localJarPath)
            const hash = crypto.createHash('sha1').update(buffer).digest('hex')

            if (!parentContent.downloads.client || parentContent.downloads.client.sha1 !== hash) {
              parentContent.downloads.client = {
                url: parentContent.downloads.client?.url || "https://piston-meta.mojang.com/v1/objects/a19d9badbea944a4369fd0059e53bf7286597576/client.jar",
                sha1: hash,
                size: fs.statSync(localJarPath).size
              }
              saveParent = true
              console.log("Patched Parent JSON downloads.client with local SHA1")
            }
          } else {
            // If JAR is missing, ensure the URL is valid so MCLC can download it
            if (!parentContent.downloads.client || !parentContent.downloads.client.url) {
              parentContent.downloads.client = {
                url: `https://piston-data.mojang.com/v1/objects/a19d9badbea944a4369fd0059e53bf7286597576/client.jar`,
                sha1: "a19d9badbea944a4369fd0059e53bf7286597576",
                size: 29525242
              }
              saveParent = true
            }
          }

          // 2. Ensure 'assetIndex' exists and is correct for 1.21.8
          if (!parentContent.assetIndex || parentContent.assetIndex.id === "19") {
            parentContent.assetIndex = {
              id: "26",
              sha1: "049a3e050c815d484afb2773cb3df18af4f264a5",
              size: 491076,
              totalSize: 436719737,
              url: "https://piston-meta.mojang.com/v1/packages/049a3e050c815d484afb2773cb3df18af4f264a5/26.json"
            }
            saveParent = true
            console.log("Injected Official 1.21.8 Asset Index")
          }

          if (saveParent) {
            fs.writeFileSync(parentJsonPath, JSON.stringify(parentContent, null, 2))
          }
        } catch (e) {
          console.error("Parent patch error", e)
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
          const expectedFabricJar = path.join(MC_ROOT, 'versions', fabVersion, `${fabVersion}.jar`)
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
    // clientPackage: null, // Removed duplicate
    authorization: auth,
    root: MC_ROOT,
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
