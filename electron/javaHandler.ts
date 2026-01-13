
import path from 'path'
import fs from 'fs'
import fetch from 'node-fetch'
import os from 'os'
import { exec } from 'child_process'
import util from 'util'
import AdmZip from 'adm-zip'

const execAsync = util.promisify(exec)

export class JavaHandler {
    private rootDir: string
    private runtimeDir: string

    constructor(dataRoot: string) {
        this.rootDir = dataRoot
        this.runtimeDir = path.join(dataRoot, 'runtime', 'java17')
    }

    async ensureJava17(): Promise<string> {
        const platform = os.platform()
        const arch = os.arch()

        // 1. Determine executable path based on OS
        let javaExec = ''
        if (platform === 'win32') {
            javaExec = path.join(this.runtimeDir, 'bin', 'java.exe')
        } else if (platform === 'darwin') {
            javaExec = path.join(this.runtimeDir, 'Contents', 'Home', 'bin', 'java')
        } else { // linux
            javaExec = path.join(this.runtimeDir, 'bin', 'java')
        }

        // 2. Check if exists and is valid (simple existence check for now)
        if (this.isValid(javaExec)) {
            return javaExec
        }

        // 3. Download if missing
        console.log(`Java 17 not found at ${javaExec}. Downloading...`)

        // Clean up old dir if exists
        if (fs.existsSync(this.runtimeDir)) {
            fs.rmSync(this.runtimeDir, { recursive: true, force: true })
        }
        fs.mkdirSync(this.runtimeDir, { recursive: true })

        const downloadUrl = this.getDownloadUrl(platform, arch)
        if (!downloadUrl) throw new Error(`Unsupported Platform/Arch: ${platform}/${arch}`)

        const archiveName = platform === 'win32' ? 'java.zip' : 'java.tar.gz'
        const archivePath = path.join(this.rootDir, 'runtime', archiveName)

        console.log(`Downloading JDK from ${downloadUrl}`)

        await this.downloadFile(downloadUrl, archivePath)

        console.log('Extracting Java...')
        await this.extractArchive(archivePath, this.runtimeDir, platform)

        // Cleanup zip/tar
        fs.unlinkSync(archivePath)

        // Verify again
        // Note: Extraction often creates a top-level directory (e.g. jdk-17.0.1/...)
        // We might need to handle strip-components or find the directory.
        // Adoptium usually has a top folder. Let's find it and verify path.

        // const children = fs.readdirSync(this.runtimeDir)
        // If there is only one child and it's a directory, move content up or Adjust path?
        // Easier: Find the java executable dynamically inside the extracted structure.

        const realExecPath = this.findJavaExec(this.runtimeDir, platform)
        if (!realExecPath) throw new Error("Java executable not found after extraction")

        // Make executable (Linux/Mac)
        if (platform !== 'win32') {
            await execAsync(`chmod +x "${realExecPath}"`)
        }

        return realExecPath
    }

    private isValid(execPath: string): boolean {
        return fs.existsSync(execPath)
    }

    private findJavaExec(baseDir: string, platform: string): string | null {
        // Recursive search for bin/java or bin/java.exe
        const target = platform === 'win32' ? 'java.exe' : 'java'

        // Check standard depth to avoid deep scan?
        // Let's do a quick BFS/DFS
        const queue = [baseDir]
        while (queue.length > 0) {
            const current = queue.shift()!
            if (!fs.existsSync(current)) continue;

            const stats = fs.statSync(current)
            if (!stats.isDirectory()) continue;

            const files = fs.readdirSync(current)
            for (const f of files) {
                const full = path.join(current, f)
                if (f === 'bin') {
                    const execPath = path.join(full, target)
                    if (fs.existsSync(execPath)) return execPath
                } else if (fs.statSync(full).isDirectory()) {
                    queue.push(full)
                }
            }
        }
        return null
    }

    private getDownloadUrl(platform: string, arch: string): string | null {
        // Adoptium API or direct links
        // Using generic 'latest' API for JDK 17
        const baseUrl = "https://api.adoptium.net/v3/binary/latest/17/ga"

        let osName = ''
        if (platform === 'win32') osName = 'windows'
        else if (platform === 'darwin') osName = 'mac'
        else if (platform === 'linux') osName = 'linux'

        let archName = ''
        if (arch === 'x64') archName = 'x64'
        else if (arch === 'arm64') archName = 'aarch64'

        if (!osName || !archName) return null

        return `${baseUrl}/${osName}/${archName}/jdk/hotspot/normal/eclipse?project=jdk`
    }

    private async downloadFile(url: string, dest: string) {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`Failed to download Java: ${res.statusText}`)
        if (!res.body) throw new Error('No body')

        const fileStream = fs.createWriteStream(dest)
        await new Promise<void>((resolve, reject) => {
            if (!res.body) return reject(new Error('No body'))
            res.body.pipe(fileStream)
            res.body.on('error', reject)
            fileStream.on('finish', () => resolve())
        })
    }

    private async extractArchive(archivePath: string, dest: string, platform: string) {
        if (platform === 'win32') {
            const zip = new AdmZip(archivePath)
            zip.extractAllTo(dest, true)
        } else {
            // Use tar for .tar.gz
            await execAsync(`tar -xzf "${archivePath}" -C "${dest}"`)
        }
    }
}
