import { app, ipcMain, shell, systemPreferences, nativeTheme } from 'electron'
import { keychainGet, keychainSet, keychainDelete } from './keychain'
import { readConfig, writeConfig } from './config'
import fs from 'fs'
import path from 'path'

export function setupIpcHandlers(): void {
  // Keychain
  ipcMain.handle('keychain:get', (_e, key: string) => keychainGet(key))
  ipcMain.handle('keychain:set', (_e, key: string, value: string) => keychainSet(key, value))
  ipcMain.handle('keychain:delete', (_e, key: string) => keychainDelete(key))

  // Config
  ipcMain.handle('config:read', () => readConfig())
  ipcMain.handle('config:write', (_e, updates: Record<string, unknown>) => writeConfig(updates as any))

  // Permissions
  ipcMain.handle('permissions:mic-status', () =>
    systemPreferences.getMediaAccessStatus('microphone')
  )
  ipcMain.handle('permissions:mic-request', async () => {
    return systemPreferences.askForMediaAccess('microphone')
  })
  ipcMain.handle('permissions:screen-status', () =>
    systemPreferences.getMediaAccessStatus('screen')
  )

  // Open system settings to a specific pane
  ipcMain.handle('shell:open-privacy-settings', async (_e, pane: string) => {
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
  })

  // Open external URL (supports http, https, and obsidian:// deep links)
  ipcMain.handle('shell:open-url', async (_e, url: string) => {
    if (url.startsWith('https://') || url.startsWith('http://') || url.startsWith('obsidian://')) {
      await shell.openExternal(url)
    }
  })

  // Open userData folder in Finder
  ipcMain.handle('app:open-data-folder', async () => {
    await shell.openPath(app.getPath('userData'))
  })

  ipcMain.handle('app:get-data-path', () => app.getPath('userData'))

  // Theme
  ipcMain.handle('app:set-theme', (_e, theme: 'light' | 'dark' | 'system') => {
    nativeTheme.themeSource = theme
    return { ok: true }
  })
  ipcMain.handle('app:get-theme', () => nativeTheme.themeSource)

  // Reset app
  ipcMain.handle('app:reset', async () => {
    const userData = app.getPath('userData')
    const filesToDelete = ['config.json', 'sessions.json', 'keychain.enc']
    const dirsToDelete = ['sessions']

    for (const f of filesToDelete) {
      const p = path.join(userData, f)
      if (fs.existsSync(p)) fs.unlinkSync(p)
    }
    for (const d of dirsToDelete) {
      const p = path.join(userData, d)
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
    }

    app.relaunch()
    app.exit(0)
  })

  // Directory picker (still useful for general purposes)
  ipcMain.handle('dialog:select-directory', async () => {
    const { dialog, BrowserWindow } = require('electron')
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Directory',
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })
}
