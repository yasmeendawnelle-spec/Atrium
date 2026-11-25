import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/albert-sans'
import '@fontsource-variable/source-serif-4/opsz.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/layout.css'
import './styles/chat.css'
import './styles/forms.css'
import './styles/features.css'
import './i18n.ts'
import { App } from './App.tsx'
import { QuickEntryWindow } from './components/QuickEntryWindow.tsx'

const isQuickWindow = window.location.hash === '#quick'
if (isQuickWindow) document.documentElement.dataset.quickWindow = '1'
if (!document.documentElement.dataset.theme) {
  document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isQuickWindow ? <QuickEntryWindow /> : <App />}
  </StrictMode>,
)
