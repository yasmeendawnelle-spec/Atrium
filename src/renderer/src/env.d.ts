/// <reference types="vite/client" />
import type { AtriumApi } from '@shared/ipc.ts'

declare global {
  interface Window {
    atrium: AtriumApi
  }
}

export {}
