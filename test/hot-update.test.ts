import path from 'node:path'
import fs from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {describe, expect, it, vi} from 'vitest'
import type {Logger, Plugin, ResolvedConfig} from 'vite'

import {vitePluginVueI18nTypes} from '../src/plugin'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '../example')
const localePath = path.resolve(root, 'src/locales/en.json')
const resolvedVirtualJsonId = '\u0000virtual:vue-i18n-types/messages'

function createLoggerMock(): Logger {
  return {
    hasErrorLogged: false,
    hasWarned: false,
    info: vi.fn(),
    infoOnce: vi.fn(),
    warn: vi.fn(),
    warnOnce: vi.fn(),
    error: vi.fn(),
    clearScreen: vi.fn(),
  } as unknown as Logger
}

function parseExportedMessages(code: string): Record<string, any> {
  const match = code.match(/export default\s*(.*)/s)
  if (!match) {
    throw new Error('Unexpected virtual JSON module output')
  }
  const jsonText = match[1].replace(/;?\s*$/, '')
  return JSON.parse(jsonText)
}

async function setupPlugin(): Promise<{plugin: Plugin; server: any; logger: Logger}> {
  const plugin = vitePluginVueI18nTypes({
    typesPath: './src/vite-env-override.d.ts',
  }) as Plugin

  const logger = createLoggerMock()
  const resolvedConfig = {
    root,
    command: 'serve',
    mode: 'development',
    isProduction: false,
    base: '/',
    build: {} as any,
    cacheDir: '',
    configFile: null,
    css: {} as any,
    customLogger: logger,
    define: {},
    env: {},
    envDir: '',
    experimental: {} as any,
    logger,
    optimizeDeps: {} as any,
    plugins: [],
    publicDir: '',
    resolve: {} as any,
    server: {} as any,
    ssr: {} as any,
    assetsInclude: () => false,
    packageCache: new Map(),
    appType: 'custom',
    preview: {} as any,
  } as unknown as ResolvedConfig

  await plugin.configResolved?.(resolvedConfig)
  await plugin.buildStart?.()

  const server = {
    config: {logger},
    middlewares: {use: vi.fn()},
    ws: {send: vi.fn()},
  }

  await plugin.configureServer?.(server as any)
  await new Promise((resolve) => setTimeout(resolve, 200))

  return {plugin, server, logger}
}

describe.sequential('hot update handling', () => {
  it('updates SSR messages and sends client updates through environment channel', async () => {
    const {plugin, server} = await setupPlugin()
    const originalContent = await fs.readFile(localePath, 'utf8')
    const timestamp = Date.now()
    const modules = [
      {
        id: 'virtual:vue-i18n-types',
        url: 'virtual:vue-i18n-types',
        type: 'js',
      },
    ] as any

    const updated = JSON.parse(originalContent)
    const newGreeting = `Hello from Vitest ${timestamp}`
    updated.Greeting.message = newGreeting
    await fs.writeFile(localePath, JSON.stringify(updated, null, 2) + '\n', 'utf8')

    const clientSend = vi.fn()
    const ssrSend = vi.fn()

    try {
      const clientResult = await plugin.hotUpdate?.call(
        {environment: {name: 'client', hot: {send: clientSend}}} as any,
        {
          server,
          timestamp,
          type: 'update',
          modules,
          file: localePath,
        } as any
      )

      expect(clientResult).toEqual([])
      expect(clientSend).toHaveBeenCalledTimes(1)
      expect(server.ws.send).not.toHaveBeenCalled()

      const payload = clientSend.mock.calls[0]?.[0]
      expect(payload?.event).toBe('i18n-update')
      expect(payload?.data?.messages?.en?.Greeting?.message).toBe(newGreeting)

      const ssrResult = await plugin.hotUpdate?.call(
        {environment: {name: 'ssr', hot: {send: ssrSend}}} as any,
        {
          server,
          timestamp,
          type: 'update',
          modules,
          file: localePath,
        } as any
      )

      expect(ssrSend).not.toHaveBeenCalled()
      expect(ssrResult).toEqual(modules)

      const loadResult = await plugin.load?.(resolvedVirtualJsonId)
      expect(loadResult).toBeDefined()
      const messages = parseExportedMessages(loadResult?.code ?? '')
      expect(messages.en.Greeting.message).toBe(newGreeting)
    } finally {
      await fs.writeFile(localePath, originalContent, 'utf8')
      const revertTimestamp = timestamp + 1
      await plugin.hotUpdate?.call(
        {environment: {name: 'client', hot: {send: vi.fn()}}} as any,
        {
          server,
          timestamp: revertTimestamp,
          type: 'update',
          modules,
          file: localePath,
        } as any
      ).catch(() => undefined)
      await plugin.hotUpdate?.call(
        {environment: {name: 'ssr', hot: {send: vi.fn()}}} as any,
        {
          server,
          timestamp: revertTimestamp,
          type: 'update',
          modules,
          file: localePath,
        } as any
      ).catch(() => undefined)
    }
  }, 20000)

  it('falls back to server.ws when environment hot channel is unavailable', async () => {
    const {plugin, server} = await setupPlugin()
    const timestamp = Date.now()
    const modules = [
      {
        id: 'virtual:vue-i18n-types',
        url: 'virtual:vue-i18n-types',
        type: 'js',
      },
    ] as any

    const result = await plugin.hotUpdate?.call(
      {environment: {name: 'client'}} as any,
      {
        server,
        timestamp,
        type: 'update',
        modules,
        file: localePath,
      } as any
    )

    expect(result).toEqual([])
    expect(server.ws.send).toHaveBeenCalledTimes(1)
    const payload = server.ws.send.mock.calls[0]?.[0]
    expect(payload?.event).toBe('i18n-update')
  }, 10000)
})
