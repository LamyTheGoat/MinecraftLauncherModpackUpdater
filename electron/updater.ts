
import { autoUpdater } from 'electron-updater'
import { BrowserWindow } from 'electron'
import fetch from 'node-fetch'
import * as fs from 'fs'
import path from 'path'

// ----------------------------------------------------------------------
// URL to the GitHub API for modpack manifest (bypasses CDN caching)
const GITHUB_API_MANIFEST_URL = 'https://api.github.com/repos/LamyTheGoat/MinecraftLauncherModpackUpdater/contents/modpack-manifest.json'

export class UpdaterManager {
    private mainWindow: BrowserWindow
    private modpackRoot: string

    constructor(window: BrowserWindow, modpackRoot: string) {
        this.mainWindow = window
        this.modpackRoot = modpackRoot

        // Electron Updater Events
        autoUpdater.on('checking-for-update', () => {
            this.sendStatus('Checking for app updates...')
        })
        autoUpdater.on('update-available', (_info) => {
            this.sendStatus('App update available. Downloading...')
        })
        autoUpdater.on('update-not-available', (_info) => {
            this.sendStatus('App is up to date.')
        })
        autoUpdater.on('error', (err) => {
            this.sendStatus('Error in auto-updater: ' + err)
        })
        autoUpdater.on('download-progress', (progressObj) => {
            let log_message = "Download speed: " + progressObj.bytesPerSecond
            log_message = log_message + ' - Downloaded ' + progressObj.percent + '%'
            log_message = log_message + ' (' + progressObj.transferred + "/" + progressObj.total + ')'
            this.sendStatus(log_message)
        })
        autoUpdater.on('update-downloaded', (_info) => {
            this.sendStatus('Update downloaded. Restarting...')
            autoUpdater.quitAndInstall()
        })
    }

    private sendStatus(msg: string) {
        this.mainWindow.webContents.send('status', msg)
    }

    // Check for App Updates
    async checkForAppUpdates() {
        autoUpdater.checkForUpdatesAndNotify()
    }

    // Check for Modpack Updates
    async checkModpackUpdates(): Promise<any | null> {
        try {
            console.log("[UPDATER] Fetching manifest via GitHub API...")
            const resp = await fetch(GITHUB_API_MANIFEST_URL, {
                headers: {
                    'Accept': 'application/vnd.github.v3+json',
                    'User-Agent': 'Minecraft-Launcher-Updater'
                }
            })

            if (!resp.ok) {
                const errorData = await resp.text();
                throw new Error(`Failed to fetch manifest: ${resp.status} ${resp.statusText} - ${errorData}`)
            }

            const apiData: any = await resp.json()
            if (!apiData.content) throw new Error("Manifest content field is missing from API response")

            // Base64 Decode
            const decodedContent = Buffer.from(apiData.content, 'base64').toString('utf-8')
            const manifest = JSON.parse(decodedContent)

            const localManifestPath = path.join(this.modpackRoot, 'modpack-info.json')
            let localVersion = '0.0.0'
            let localData: any = null

            if (fs.existsSync(localManifestPath)) {
                localData = JSON.parse(fs.readFileSync(localManifestPath, 'utf-8'))
                localVersion = localData.version
            }

            // Normalize URLs for comparison (empty is preserved as "")
            const remoteUrl = (manifest.url || "").trim()
            const localUrl = (localData?.url || "").trim()

            let isDifferent = manifest.version !== localVersion

            // Check if other fields changed too
            if (!isDifferent && localData) {
                if (remoteUrl !== localUrl) isDifferent = true
                if (manifest.minecraft !== (localData.minecraft || "")) isDifferent = true
                if (manifest.fabric !== (localData.fabric || "")) isDifferent = true
            }

            console.log(`[UPDATER] Comparing Manifests (API Source):`)
            console.log(`  - Remote: v${manifest.version}, url: "${remoteUrl}"`)
            console.log(`  - Local:  v${localVersion}, url: "${localUrl}"`)
            console.log(`  - result: ${isDifferent ? 'UPDATE NEEDED' : 'UP TO DATE'}`)

            if (isDifferent) {
                this.sendStatus(`Update found! (Manifest changed)`)
                return manifest
            }

            this.sendStatus('Modpack is up to date.')
            return null

        } catch (e: any) {
            console.error("MANIFEST FETCH ERROR:", e)
            this.sendStatus('Failed to check modpack updates: ' + e.message)
            return null
        }
    }

    getLocalManifest(): any {
        const localManifestPath = path.join(this.modpackRoot, 'modpack-info.json')
        if (fs.existsSync(localManifestPath)) {
            return JSON.parse(fs.readFileSync(localManifestPath, 'utf-8'))
        }
        return null
    }

    updateLocalManifest(manifest: any) {
        const localManifestPath = path.join(this.modpackRoot, 'modpack-info.json')
        fs.writeFileSync(localManifestPath, JSON.stringify(manifest, null, 2))
    }
}
