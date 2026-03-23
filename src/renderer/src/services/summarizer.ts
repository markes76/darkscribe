import type { TranscriptSegment } from './openai-realtime'

export interface CallSummary {
  dateTime: string
  durationMinutes: number
  participants: string[]
  keyTopics: string[]
  actionItems: Array<{ item: string; owner?: string }>
  decisions: string[]
  followUps: string[]
  overview: string
}

export async function generateSummary(
  segments: TranscriptSegment[],
  apiKey: string,
  skillContent?: string
): Promise<CallSummary> {
  const transcript = segments
    .filter(s => s.isFinal && s.text.trim())
    .map(s => `[${s.speakerName ?? (s.speaker === 'mic' ? 'You' : 'Them')}] ${s.text}`)
    .join('\n')

  const firstTs = segments[0]?.timestamp ?? Date.now()
  const lastTs = segments[segments.length - 1]?.timestamp ?? Date.now()
  const durationMinutes = Math.round((lastTs - firstTs) / 60000)

  const systemPrompt = `You are a call summary assistant. Analyze the transcript and produce a structured JSON summary with these fields:
- participants: array of speaker names/labels identified
- keyTopics: 3-5 main topics discussed
- actionItems: array of {item, owner?} for tasks mentioned
- decisions: key decisions made
- followUps: things that need follow-up
- overview: 2-3 sentence summary of the call
${skillContent ? `\nIMPORTANT — Follow these learned preferences from the user's Notetaker Skill file:\n${skillContent}` : ''}
Return ONLY valid JSON matching this structure.`

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Summarize this call transcript:\n\n${transcript}` }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    })
  })

  if (!resp.ok) {
    throw new Error(`Summary API error: ${resp.status}`)
  }

  const data = await resp.json() as { choices: Array<{ message: { content: string } }> }
  const content = data.choices[0]?.message?.content
  if (!content) throw new Error('Empty summary response')

  const parsed = JSON.parse(content)

  return {
    dateTime: new Date(firstTs).toISOString(),
    durationMinutes,
    participants: parsed.participants ?? ['You', 'Them'],
    keyTopics: parsed.keyTopics ?? [],
    actionItems: parsed.actionItems ?? [],
    decisions: parsed.decisions ?? [],
    followUps: parsed.followUps ?? [],
    overview: parsed.overview ?? ''
  }
}
