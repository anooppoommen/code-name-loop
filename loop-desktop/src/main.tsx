import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { KeyboardStackProvider } from './hooks/KeyboardStackProvider.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <KeyboardStackProvider>
      <App />
    </KeyboardStackProvider>
  </StrictMode>,
)
