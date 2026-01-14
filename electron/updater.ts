
import { autoUpdater } from 'electron-updater'
import { BrowserWindow } from 'electron'
import fetch from 'node-fetch'
import * as fs from 'fs'
import path from 'path'

// ----------------------------------------------------------------------
// CONFIGURATION
// ----------------------------------------------------------------------
// URL to the raw JSON file containing modpack version info
// Example JSON: { "version": "1.0.1", "url": "https://.../modpack.zip" }
const MODPACK_MANIFEST_URL = 'https://raw.githubusercontent.com/LamyTheGoat/MinecraftLauncherModpackUpdater/main/modpack-manifest.json'

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

    sendStatus(text: string) {
        this.mainWindow.webContents.send('status', text)
    }

    // Check for App Updates
    checkForAppUpdates() {
        autoUpdater.checkForUpdatesAndNotify()
    }

    // Check for Modpack Updates
    async checkModpackUpdates(): Promise<any | null> {
        this.sendStatus('Checking modpack version...')
        try {
            const resp = await fetch(MODPACK_MANIFEST_URL)
            if (!resp.ok) throw new Error('Failed to fetch manifest')

            const manifest: any = await resp.json()
            const localManifestPath = path.join(this.modpackRoot, 'modpack-info.json')

            let localVersion = '0.0.0'
            if (fs.existsSync(localManifestPath)) {
                const localData = JSON.parse(fs.readFileSync(localManifestPath, 'utf-8'))
                localVersion = localData.version
            }

            if (manifest.version !== localVersion) {
                this.sendStatus(`New modpack version found: ${manifest.version}`)
                return manifest // Return full manifest
            }

            this.sendStatus('Modpack is up to date.')
            return null

        } catch (e: any) {
            console.error(e)
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
