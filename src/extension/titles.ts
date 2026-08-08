/* ================================================================
   Domain & title cleanup helpers

   friendlyDomain — friendly display name for known hostnames; used
                    inside cleanTitleWithRemovedSuffix to strip suffix domain noise
                    from page titles.
   stripTitleNoise — removes notification counts, email addresses,
                     X/Twitter cruft.
   cleanTitleWithRemovedSuffix — drops the trailing " — Domain" /
                    " | Domain" suffix and returns what was removed so
                    the UI can keep the cleanup transparent.

   No URL-based title synthesis: the chip displays (and sorts by) the
   exact title the page reports, so the read order always matches the
   sort order. An earlier `smartTitle` rewrote GitHub PR/Issue URLs
   into "owner/repo PR #N", which hid the PR description from the
   display while the sort still ran on Chrome's real title — the two
   diverged and chip order looked random.
   ================================================================ */

const FRIENDLY_DOMAINS: Record<string, string> = {
  'github.com': 'GitHub',
  'www.github.com': 'GitHub',
  'gist.github.com': 'GitHub Gist',
  'youtube.com': 'YouTube',
  'www.youtube.com': 'YouTube',
  'music.youtube.com': 'YouTube Music',
  'x.com': 'X',
  'www.x.com': 'X',
  'twitter.com': 'X',
  'www.twitter.com': 'X',
  'reddit.com': 'Reddit',
  'www.reddit.com': 'Reddit',
  'old.reddit.com': 'Reddit',
  'substack.com': 'Substack',
  'www.substack.com': 'Substack',
  'medium.com': 'Medium',
  'www.medium.com': 'Medium',
  'linkedin.com': 'LinkedIn',
  'www.linkedin.com': 'LinkedIn',
  'stackoverflow.com': 'Stack Overflow',
  'www.stackoverflow.com': 'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com': 'Google',
  'www.google.com': 'Google',
  'mail.google.com': 'Gmail',
  'docs.google.com': 'Google Docs',
  'drive.google.com': 'Google Drive',
  'calendar.google.com': 'Google Calendar',
  'meet.google.com': 'Google Meet',
  'gemini.google.com': 'Gemini',
  'chatgpt.com': 'ChatGPT',
  'www.chatgpt.com': 'ChatGPT',
  'chat.openai.com': 'ChatGPT',
  'claude.ai': 'Claude',
  'www.claude.ai': 'Claude',
  'code.claude.com': 'Claude Code',
  'notion.so': 'Notion',
  'www.notion.so': 'Notion',
  'figma.com': 'Figma',
  'www.figma.com': 'Figma',
  'slack.com': 'Slack',
  'app.slack.com': 'Slack',
  'discord.com': 'Discord',
  'www.discord.com': 'Discord',
  'wikipedia.org': 'Wikipedia',
  'en.wikipedia.org': 'Wikipedia',
  'amazon.com': 'Amazon',
  'www.amazon.com': 'Amazon',
  'netflix.com': 'Netflix',
  'www.netflix.com': 'Netflix',
  'spotify.com': 'Spotify',
  'open.spotify.com': 'Spotify',
  'vercel.com': 'Vercel',
  'www.vercel.com': 'Vercel',
  'npmjs.com': 'npm',
  'www.npmjs.com': 'npm',
  'developer.mozilla.org': 'MDN',
  'arxiv.org': 'arXiv',
  'www.arxiv.org': 'arXiv',
  'huggingface.co': 'Hugging Face',
  'www.huggingface.co': 'Hugging Face',
  'producthunt.com': 'Product Hunt',
  'www.producthunt.com': 'Product Hunt',
  'xiaohongshu.com': 'RedNote',
  'www.xiaohongshu.com': 'RedNote',
  'local-files': 'Local Files'
}

function capitalize(str: string): string {
  if (!str) return ''
  return str.charAt(0).toUpperCase() + str.slice(1)
}

function friendlyDomain(hostname: string): string {
  if (!hostname) return ''
  const friendlyOverride = FRIENDLY_DOMAINS[hostname]
  if (typeof friendlyOverride === 'string') return friendlyOverride

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack"
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)'
  }

  const clean = hostname.replace(/^www\./, '').replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '')

  return clean
    .split('.')
    .map((part: string) => capitalize(part))
    .join(' ')
}

export function stripTitleNoise(title: string): string {
  if (!title) return ''
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '')
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ')
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[-\u2010-\u2015]\s*[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '')
  title = title.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '')
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ')
  title = title.replace(/\s*\/\s*X\s*$/, '')
  return title.trim()
}

export type CleanTitleResult = {
  title: string
  removedSuffix: string
}

const TITLE_SUFFIX_SEPARATOR_PATTERN = / (?:-|\||—|·|–) /

export function cleanTitleWithRemovedSuffix(title: string, hostname: string, extraSuffixes: string[] = []): CleanTitleResult {
  if (!title || !hostname) return { title: title || '', removedSuffix: '' }
  if (!TITLE_SUFFIX_SEPARATOR_PATTERN.test(title)) {
    return { title, removedSuffix: '' }
  }

  const friendly = friendlyDomain(hostname)
  const domain = hostname.replace(/^www\./, '')
  const seps = [' - ', ' | ', ' — ', ' · ', ' – ']
  const extraSuffixKeys = extraSuffixes.map((suffix) => suffix.trim().toLowerCase()).filter(Boolean)

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep)
    if (idx === -1) continue
    const suffix = title.slice(idx + sep.length).trim()
    const suffixLow = suffix.toLowerCase()
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow) ||
      extraSuffixKeys.includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim()
      if (cleaned.length >= 5) return { title: cleaned, removedSuffix: title.slice(idx).trim() }
    }
  }
  return { title, removedSuffix: '' }
}
