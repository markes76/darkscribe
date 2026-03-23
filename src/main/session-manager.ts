import fs from 'fs'
import path from 'path'
import { app, ipcMain } from 'electron'
import crypto from 'crypto'

export interface CallRecord {
  date: string
  durationMinutes?: number
  transcriptFile?: string
  summaryFile?: string
  tags?: string[]
  segmentCount?: number
  audioFile?: string
  vaultNotePath?: string
  originalSummary?: string
}

export interface Session {
  id: string
  name?: string
  calls: CallRecord[]
  createdAt: string
  updatedAt: string
}

function sessionsFile(): string {
  return path.join(app.getPath('userData'), 'sessions.json')
}

function sessionDir(id: string): string {
  return path.join(app.getPath('userData'), 'sessions', id)
}

function readSessions(): Session[] {
  try {
    const file = sessionsFile()
    if (!fs.existsSync(file)) return []
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return []
  }
}

function writeSessions(sessions: Session[]): void {
  const file = sessionsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(sessions, null, 2))
}

export function createSession(data: { name?: string }): Session {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const session: Session = {
    id,
    name: data.name,
    calls: [],
    createdAt: now,
    updatedAt: now
  }
  fs.mkdirSync(sessionDir(id), { recursive: true })
  const sessions = readSessions()
  sessions.unshift(session)
  writeSessions(sessions)
  return session
}

export function listSessions(): Session[] {
  return readSessions()
}

export function getSession(id: string): Session | null {
  return readSessions().find(s => s.id === id) ?? null
}

export function updateSession(id: string, updates: Partial<Omit<Session, 'id' | 'createdAt'>>): Session | null {
  const sessions = readSessions()
  const idx = sessions.findIndex(s => s.id === id)
  if (idx === -1) return null
  sessions[idx] = { ...sessions[idx], ...updates, updatedAt: new Date().toISOString() }
  writeSessions(sessions)
  return sessions[idx]
}

export function addCallToSession(id: string, call: CallRecord): Session | null {
  const sessions = readSessions()
  const idx = sessions.findIndex(s => s.id === id)
  if (idx === -1) return null
  sessions[idx].calls.push(call)
  sessions[idx].updatedAt = new Date().toISOString()
  writeSessions(sessions)
  return sessions[idx]
}

export function deleteSession(id: string): boolean {
  const sessions = readSessions()
  const idx = sessions.findIndex(s => s.id === id)
  if (idx === -1) return false
  sessions.splice(idx, 1)
  writeSessions(sessions)
  const dir = sessionDir(id)
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return true
}

export function getSessionDir(id: string): string {
  const dir = sessionDir(id)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function setupSessionIpc(): void {
  ipcMain.handle('session:create', (_e, data) => createSession(data))
  ipcMain.handle('session:list', () => listSessions())
  ipcMain.handle('session:get', (_e, id: string) => getSession(id))
  ipcMain.handle('session:update', (_e, id: string, updates) => updateSession(id, updates))
  ipcMain.handle('session:delete', (_e, id: string) => deleteSession(id))
  ipcMain.handle('session:add-call', (_e, id: string, call: CallRecord) => addCallToSession(id, call))

  ipcMain.handle('session:update-call', (_e, sessionId: string, callIndex: number, updates: Partial<CallRecord>) => {
    const sessions = readSessions()
    const idx = sessions.findIndex(s => s.id === sessionId)
    if (idx === -1 || callIndex < 0 || callIndex >= sessions[idx].calls.length) return null
    sessions[idx].calls[callIndex] = { ...sessions[idx].calls[callIndex], ...updates }
    sessions[idx].updatedAt = new Date().toISOString()
    writeSessions(sessions)
    return sessions[idx]
  })
}
