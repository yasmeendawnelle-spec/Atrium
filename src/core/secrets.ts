// Bridge to the main process, which holds the OS-encrypted key store.
// The core never sees the store itself; it only asks main for values.
import type { HostMethods } from '../shared/ipc.ts'

export type HostCall = <M extends keyof HostMethods>(method: M, ...args: Parameters<HostMethods[M]>) => Promise<Awaited<ReturnType<HostMethods[M]>>>

let hostCall: HostCall = async () => {
  throw new Error('Secrets are not available yet.')
}

export function bindSecrets(call: HostCall): void {
  hostCall = call
}

export function secretKey(scope: 'provider' | 'mcp' | 'speech' | 'account', id: string, name: string): string {
  return `${scope}:${id}:${name}`
}

export async function getSecret(key: string): Promise<string | null> {
  return hostCall('secrets.get', key)
}

export async function setSecret(key: string, value: string | null): Promise<void> {
  await hostCall('secrets.set', key, value)
}
