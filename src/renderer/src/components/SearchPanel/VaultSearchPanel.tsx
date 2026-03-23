import React, { useState } from 'react'

interface SearchResult {
  path: string
  snippet: string
  source: 'vault' | 'web'
  url?: string
  title?: string
}

export default function VaultSearchPanel(): React.ReactElement {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchedVault, setSearchedVault] = useState(false)
  const [answer, setAnswer] = useState('')
  const [savingIdx, setSavingIdx] = useState<number | null>(null)
  const [webSource, setWebSource] = useState<string>('')

  const [searchError, setSearchError] = useState('')

  const searchVault = async () => {
    if (!query.trim()) return
    setSearching(true)
    setResults([])
    setAnswer('')
    setSearchedVault(true)
    setWebSource('')
    setSearchError('')

    try {
      // Check vault status first
      const status = await window.darkscribe.vault.status()
      if (!status.connected) {
        setSearchError('Vault not connected')
        setSearching(false)
        return
      }

      const res = await window.darkscribe.vault.search(query)
      if (res.error) {
        setSearchError(res.error)
      } else {
        const vaultResults: SearchResult[] = (res.results ?? []).map(r => ({
          path: r.path,
          snippet: r.snippet,
          source: 'vault' as const
        }))
        setResults(vaultResults)
      }
    } catch (e) {
      setSearchError((e as Error).message)
    }
    setSearching(false)
  }

  // Uses Tavily → OpenAI fallback chain automatically
  const searchWeb = async () => {
    if (!query.trim()) return
    setSearching(true)
    try {
      const res = await window.darkscribe.web.search(query)
      if (res.answer) setAnswer(res.answer)
      setWebSource((res as any).source ?? 'web')
      const webResults: SearchResult[] = (res.results ?? []).map(r => ({
        path: '',
        snippet: r.content,
        source: 'web' as const,
        url: r.url || undefined,
        title: r.title
      }))
      setResults(prev => [...prev, ...webResults])
    } catch {}
    setSearching(false)
  }

  const saveToVault = async (result: SearchResult, idx: number) => {
    setSavingIdx(idx)
    const config = await window.darkscribe.config.read()
    const prefix = (config.vault_subfolder as string) || ''
    const vp = (p: string) => prefix ? `${prefix}/${p}` : p

    const date = new Date().toISOString().split('T')[0]
    const safeName = query.trim().replace(/[/\\:*?"<>|]/g, '-').substring(0, 60)
    const path = vp(`Resources/References/${date}_${safeName}.md`)

    const content = `---
tags: [reference, web-search]
date: "${date}"
source_url: "${result.url ?? ''}"
query: "${query}"
---

# ${result.title ?? query}

${result.snippet}

${result.url ? `\nSource: ${result.url}` : ''}
`
    await window.darkscribe.vault.createNote(path, content)
    setSavingIdx(null)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 'var(--sp-3)' }}>
      <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 'var(--sp-2)' }}>
        Search
      </div>

      <div style={{ display: 'flex', gap: 'var(--sp-2)', marginBottom: 'var(--sp-3)' }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') searchVault() }}
          placeholder="Search vault or web..."
          style={{
            flex: 1, padding: '6px 10px', border: '1px solid var(--border-1)',
            borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)',
            background: 'var(--surface-2)', color: 'var(--ink-1)'
          }}
        />
        <button onClick={searchVault} disabled={searching} style={{
          padding: '6px 10px', background: 'var(--primary)', color: 'white',
          border: 'none', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)',
          fontWeight: 600, cursor: 'pointer', opacity: searching ? 0.6 : 1
        }}>
          Vault
        </button>
      </div>

      {/* Results */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {searching && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-4)', padding: 'var(--sp-2)' }}>Searching...</div>}

        {searchError && (
          <div style={{ padding: 'var(--sp-2)', background: 'var(--negative-subtle)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', color: 'var(--negative)', marginBottom: 'var(--sp-2)' }}>
            {searchError}
          </div>
        )}

        {answer && (
          <div style={{ padding: 'var(--sp-3)', background: 'var(--primary-subtle)', borderRadius: 'var(--radius-sm)', marginBottom: 'var(--sp-2)', fontSize: 'var(--text-xs)', color: 'var(--ink-1)', lineHeight: 1.6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ fontWeight: 700, color: 'var(--primary)' }}>Answer</span>
              {webSource && <span style={{ fontSize: 9, color: 'var(--ink-4)' }}>via {webSource}</span>}
            </div>
            {answer}
          </div>
        )}

        {results.map((r, i) => (
          <div key={i} style={{
            padding: 'var(--sp-2) var(--sp-3)', marginBottom: 'var(--sp-2)',
            background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: r.source === 'vault' ? 'var(--purple)' : 'var(--amber)', textTransform: 'uppercase' }}>
                {r.source === 'vault' ? 'Vault' : 'Web'}
              </span>
              {r.source === 'web' && (
                <button
                  onClick={() => saveToVault(r, i)}
                  disabled={savingIdx === i}
                  style={{
                    padding: '2px 8px', background: 'var(--surface-2)', border: '1px solid var(--border-1)',
                    borderRadius: 'var(--radius-xs)', fontSize: 9, color: 'var(--ink-3)', cursor: 'pointer'
                  }}
                >
                  {savingIdx === i ? 'Saved' : 'Save to Vault'}
                </button>
              )}
            </div>
            {r.title && <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--ink-1)', marginBottom: 2 }}>{r.title}</div>}
            {r.path && <div style={{ fontSize: 10, color: 'var(--ink-4)', marginBottom: 2 }}>{r.path}</div>}
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-2)', lineHeight: 1.5 }}>
              {r.snippet.substring(0, 200)}{r.snippet.length > 200 ? '...' : ''}
            </div>
            {r.url && (
              <button
                onClick={() => window.darkscribe.shell.openUrl(r.url!)}
                style={{ marginTop: 4, padding: 0, background: 'none', border: 'none', color: 'var(--primary)', fontSize: 10, cursor: 'pointer', textDecoration: 'underline' }}
              >
                Open source
              </button>
            )}
          </div>
        ))}

        {!searching && searchedVault && results.filter(r => r.source === 'vault').length === 0 && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-4)', padding: 'var(--sp-2)', textAlign: 'center' }}>
            No vault results.
          </div>
        )}
      </div>

      {/* Web search — Tavily → OpenAI fallback */}
      {searchedVault && !searching && (
        <button onClick={searchWeb} style={{
          marginTop: 'var(--sp-2)', padding: '6px 0', background: 'none',
          border: '1px dashed var(--border-1)', borderRadius: 'var(--radius-sm)',
          fontSize: 'var(--text-xs)', color: 'var(--ink-3)', cursor: 'pointer'
        }}>
          Search Web
        </button>
      )}
    </div>
  )
}
