import { readFile } from 'node:fs/promises'

import { prerender } from 'react-dom/static'

import { AppRoot } from './components/App.js'
import { TAB_OUT_FAVICON_URL } from './extension/tab-out-url.js'

const APP_MARKUP_SLOT = '<!-- TAB_OUT_PRERENDERED_APP -->'
const INDEX_HTML_TEMPLATE_URL = new URL('./index-html.template.html', import.meta.url)

function injectAppMarkup(indexHtmlTemplate: string, appMarkup: string): string {
  const templateParts = indexHtmlTemplate.split(APP_MARKUP_SLOT)
  if (templateParts.length !== 2) {
    throw new Error('Dashboard HTML template must contain exactly one prerendered-app slot')
  }
  return `${templateParts[0]}${appMarkup}${templateParts[1]}`
}

/**
 * Builds `extension/index.html`. `scripts/build-extension.ts` writes the
 * result during `pnpm build`, prerendering the same AppRoot that the client
 * attaches so the first-render markup has one declaration.
 */
export async function createIndexHtml(): Promise<string> {
  const [indexHtmlTemplate, { prelude }] = await Promise.all([
    readFile(INDEX_HTML_TEMPLATE_URL, 'utf8'),
    prerender(<AppRoot />),
  ])
  const appMarkup = await new Response(prelude).text()
  return injectAppMarkup(indexHtmlTemplate.replace('__TAB_OUT_FAVICON_URL__', TAB_OUT_FAVICON_URL), appMarkup)
}
