import { ipcMain } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readConfig } from './config'

// The obsidian-mcp vault name (derived from vault folder name, kebab-cased)
const VAULT_NAME = 'mark-mind'

// Get the vault subfolder prefix (e.g. "Work/Darkscribe")
export function getSubfolderPrefix(): string {
  const config = readConfig()
  return config.vault_subfolder ?? ''
}

// Prepend subfolder to a relative note path
export function vaultPath(relativePath: string): string {
  const prefix = getSubfolderPrefix()
  return prefix ? `${prefix}/${relativePath}` : relativePath
}

// Split a path like "Work/Darkscribe/Calls/note.md" into { folder: "Work/Darkscribe/Calls", filename: "note.md" }
function splitPath(notePath: string): { folder: string; filename: string } {
  const lastSlash = notePath.lastIndexOf('/')
  if (lastSlash === -1) return { folder: '', filename: notePath }
  return {
    folder: notePath.substring(0, lastSlash),
    filename: notePath.substring(lastSlash + 1)
  }
}

// Ensure filename has .md extension
function ensureMd(filename: string): string {
  return filename.endsWith('.md') ? filename : `${filename}.md`
}

let client: Client | null = null
let transport: StdioClientTransport | null = null
let connected = false
let currentVaultRoot: string | null = null

const CALL_TIMEOUT_MS = 15000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[ObsidianMCP] ${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (val) => { clearTimeout(timer); resolve(val) },
      (err) => { clearTimeout(timer); reject(err) }
    )
  })
}

export async function connectToVault(vaultRootPath: string): Promise<{ ok: boolean; error?: string }> {
  if (connected && client && currentVaultRoot === vaultRootPath) {
    console.log('[ObsidianMCP] Already connected to:', vaultRootPath)
    return { ok: true }
  }

  await disconnectFromVault()

  try {
    currentVaultRoot = vaultRootPath
    console.log('[ObsidianMCP] Spawning obsidian-mcp for vault:', vaultRootPath)

    transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', 'obsidian-mcp', vaultRootPath]
    })

    client = new Client({
      name: 'darkscribe',
      version: '1.0.0'
    })

    await withTimeout(client.connect(transport), 30000, 'connect')
    connected = true
    console.log('[ObsidianMCP] Connected successfully')
    return { ok: true }
  } catch (err) {
    console.error('[ObsidianMCP] Connection failed:', (err as Error).message)
    connected = false
    client = null
    transport = null
    return { ok: false, error: (err as Error).message }
  }
}

export async function disconnectFromVault(): Promise<void> {
  if (client) {
    try { await client.close() } catch {}
  }
  client = null
  transport = null
  connected = false
  currentVaultRoot = null
}

async function ensureConnected(): Promise<void> {
  if (connected && client) return
  const config = readConfig()
  if (!config.vault_path) throw new Error('No vault path configured')
  const result = await connectToVault(config.vault_path)
  if (!result.ok) throw new Error(result.error ?? 'Connection failed')
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  await ensureConnected()
  if (!client) throw new Error('Not connected to vault')

  console.log(`[ObsidianMCP] callTool: ${name}`, JSON.stringify(args).substring(0, 300))

  try {
    const result = await withTimeout(
      client.callTool({ name, arguments: args }),
      CALL_TIMEOUT_MS,
      `callTool(${name})`
    )

    if (result.content && Array.isArray(result.content)) {
      const isError = result.isError
      const textParts = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
      const text = textParts.join('\n')

      if (isError) {
        console.error(`[ObsidianMCP] Tool ${name} returned error:`, text)
        throw new Error(text)
      }

      console.log(`[ObsidianMCP] callTool ${name} OK (${text.length} chars)`)
      return text
    }

    console.log(`[ObsidianMCP] callTool ${name} OK (no content)`)
    return ''
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[ObsidianMCP] callTool ${name} FAILED:`, msg)

    if (msg.includes('closed') || msg.includes('timed out') || msg.includes('EPIPE')) {
      connected = false
      client = null
      transport = null
    }

    throw err
  }
}

// ─── Public tool wrappers ─────────────────────────────────────────────
// All tools require vault name. Paths are split into folder + filename.

export async function readNote(notePath: string): Promise<string> {
  const { folder, filename } = splitPath(notePath)
  const args: Record<string, unknown> = { vault: VAULT_NAME, filename: ensureMd(filename) }
  if (folder) args.folder = folder
  return await callTool('read-note', args)
}

export async function createNote(notePath: string, content: string): Promise<void> {
  const { folder, filename } = splitPath(notePath)
  const args: Record<string, unknown> = { vault: VAULT_NAME, filename: ensureMd(filename), content }
  if (folder) args.folder = folder
  await callTool('create-note', args)
}

export async function editNote(notePath: string, content: string): Promise<void> {
  const { folder, filename } = splitPath(notePath)
  const args: Record<string, unknown> = {
    vault: VAULT_NAME,
    filename: ensureMd(filename),
    operation: 'replace',
    content
  }
  if (folder) args.folder = folder
  await callTool('edit-note', args)
}

export async function deleteNote(notePath: string): Promise<void> {
  await callTool('delete-note', { vault: VAULT_NAME, path: notePath })
}

export async function searchVault(query: string, subPath?: string): Promise<Array<{ path: string; snippet: string }>> {
  const args: Record<string, unknown> = { vault: VAULT_NAME, query }
  if (subPath) args.path = subPath
  const text = await callTool('search-vault', args)
  if (!text || text === 'No results found.' || text === 'No results found') return []

  const results: Array<{ path: string; snippet: string }> = []
  const blocks = text.split('\n\n')
  for (const block of blocks) {
    const lines = block.trim().split('\n')
    if (lines.length > 0) {
      const p = lines[0].replace(/^#+\s*/, '').replace(/^File:\s*/, '').trim()
      const snippet = lines.slice(1).join(' ').trim().substring(0, 200)
      if (p && p.endsWith('.md')) {
        results.push({ path: p, snippet })
      }
    }
  }
  return results
}

export async function createDirectory(dirPath: string): Promise<void> {
  await callTool('create-directory', { vault: VAULT_NAME, path: dirPath })
}

export async function addTags(notePath: string, tags: string[]): Promise<void> {
  const { folder, filename } = splitPath(notePath)
  const fullFile = folder ? `${folder}/${ensureMd(filename)}` : ensureMd(filename)
  await callTool('add-tags', { vault: VAULT_NAME, files: [fullFile], tags })
}

export async function manageTags(): Promise<string> {
  // manage-tags is not in obsidian-mcp — use search for tags instead
  return await callTool('search-vault', { vault: VAULT_NAME, query: 'tag:' })
}

// Save note with automatic fallback: try create-note, if exists use edit-note
export async function saveNote(notePath: string, content: string): Promise<void> {
  try {
    await createNote(notePath, content)
  } catch (err) {
    const msg = (err as Error).message
    if (msg.includes('already exists') || msg.includes('exists')) {
      console.log(`[ObsidianMCP] Note exists, using edit-note: ${notePath}`)
      await editNote(notePath, content)
    } else {
      throw err
    }
  }
}

// ─── IPC Setup ────────────────────────────────────────────────────────

export function setupObsidianIpc(): void {
  ipcMain.handle('vault:connect', async (_e, vaultRootPath: string) => {
    return await connectToVault(vaultRootPath)
  })

  ipcMain.handle('vault:disconnect', async () => {
    await disconnectFromVault()
    return { ok: true }
  })

  ipcMain.handle('vault:status', () => {
    return { connected, vaultPath: currentVaultRoot }
  })

  ipcMain.handle('vault:read-note', async (_e, notePath: string) => {
    try {
      const content = await readNote(notePath)
      return { content }
    } catch (err) {
      console.error('[ObsidianMCP:IPC] read-note failed:', (err as Error).message)
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('vault:save-note', async (_e, notePath: string, content: string) => {
    try {
      await saveNote(notePath, content)
      return { ok: true }
    } catch (err) {
      console.error('[ObsidianMCP:IPC] save-note failed:', (err as Error).message)
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('vault:create-note', async (_e, notePath: string, content: string) => {
    try {
      await createNote(notePath, content)
      return { ok: true }
    } catch (err) {
      console.error('[ObsidianMCP:IPC] create-note failed:', (err as Error).message)
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('vault:edit-note', async (_e, notePath: string, content: string) => {
    try {
      await editNote(notePath, content)
      return { ok: true }
    } catch (err) {
      console.error('[ObsidianMCP:IPC] edit-note failed:', (err as Error).message)
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('vault:search', async (_e, query: string) => {
    try {
      // Default search scoped to Darkscribe subfolder
      const prefix = getSubfolderPrefix()
      const results = await searchVault(query, prefix || undefined)
      return { results }
    } catch (err) {
      console.error('[ObsidianMCP:IPC] search failed:', (err as Error).message)
      return { results: [], error: (err as Error).message }
    }
  })

  ipcMain.handle('vault:create-directory', async (_e, dirPath: string) => {
    try {
      await createDirectory(dirPath)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('vault:add-tags', async (_e, notePath: string, tags: string[]) => {
    try {
      await addTags(notePath, tags)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('vault:manage-tags', async () => {
    try {
      const tags = await manageTags()
      return { tags }
    } catch (err) {
      return { tags: null, error: (err as Error).message }
    }
  })
}

export async function autoConnect(): Promise<void> {
  const config = readConfig()
  if (config.vault_path) {
    console.log('[ObsidianMCP] Auto-connecting to vault:', config.vault_path)
    await connectToVault(config.vault_path)
  }
}
