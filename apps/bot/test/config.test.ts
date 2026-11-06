import { describe, it, expect } from 'vitest'
import { loadConfig, REAL_HOSTS } from '../src/config'

const BASE = { DATABASE_URL_UNPOOLED: 'postgres://sereno_app:x@localhost:5499/sereno' }

describe('loadConfig', () => {
  it('toma los defaults verificados de Binance y el nivel de log info', () => {
    const config = loadConfig(BASE)
    expect(config).toEqual({
      logLevel: 'info',
      databaseUrl: BASE.DATABASE_URL_UNPOOLED,
      binance: {
        restUrl: 'https://fapi.binance.com',
        wsUrl: 'wss://fstream.binance.com/market/stream',
        apiKey: null,
        apiSecret: null,
        limits: { weightPerMinute: 2400, dataRequestsPer5m: 1000, fundingRequestsPer5m: 500 },
      },
      real: {
        enabled: false,
        env: 'testnet',
        apiKey: null,
        apiSecret: null,
        restUrl: 'https://demo-fapi.binance.com',
        sapiUrl: null,
        marketWsUrl: 'wss://demo-fstream.binance.com/market/stream',
        userWsUrl: 'wss://demo-fstream.binance.com/private/ws',
      },
    })
  })

  it('acepta DATABASE_URL como respaldo y las variables de Binance', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://a:b@c/d',
      LOG_LEVEL: 'debug',
      BINANCE_API_KEY: 'k',
      BINANCE_API_SECRET: 's',
      BINANCE_REST_URL: 'http://127.0.0.1:4000',
      BINANCE_WS_URL: 'ws://127.0.0.1:4000/market/stream',
    })
    expect(config.databaseUrl).toBe('postgres://a:b@c/d')
    expect(config.logLevel).toBe('debug')
    expect(config.binance).toMatchObject({ apiKey: 'k', apiSecret: 's', restUrl: 'http://127.0.0.1:4000', wsUrl: 'ws://127.0.0.1:4000/market/stream' })
  })

  it('rechaza una URL de websocket que no sea la ruta /market/', () => {
    expect(() => loadConfig({ ...BASE, BINANCE_WS_URL: 'wss://fstream.binance.com/stream' })).toThrow(/BINANCE_WS_URL/)
  })

  it('explica qué variable falta', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL_UNPOOLED/)
    expect(() => loadConfig({ ...BASE, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/)
  })

  describe('plata real', () => {
    it('sin BINANCE_ENV opera en testnet', () => {
      expect(loadConfig(BASE).real.env).toBe('testnet')
      // Copiar `.env.example` deja la variable vacía: cuenta como ausente.
      expect(loadConfig({ ...BASE, BINANCE_ENV: '' }).real.env).toBe('testnet')
    })

    it('BINANCE_ENV=mainnet usa los hosts de Binance, con /sapi', () => {
      expect(loadConfig({ ...BASE, BINANCE_ENV: 'mainnet' }).real).toMatchObject({
        env: 'mainnet',
        restUrl: 'https://fapi.binance.com',
        sapiUrl: 'https://api.binance.com',
        marketWsUrl: 'wss://fstream.binance.com/market/stream',
        userWsUrl: 'wss://fstream.binance.com/private/ws',
      })
    })

    it('BINANCE_ENV=prod corta nombrando la variable', () => {
      expect(() => loadConfig({ ...BASE, BINANCE_ENV: 'prod' })).toThrow(/BINANCE_ENV/)
    })

    it('se prende sólo con SERENO_REAL_TRADING exactamente on', () => {
      expect(loadConfig({ ...BASE, SERENO_REAL_TRADING: 'on' }).real.enabled).toBe(true)
      for (const value of ['ON', '1', 'true', 'on ', '']) {
        expect(loadConfig({ ...BASE, SERENO_REAL_TRADING: value }).real.enabled).toBe(false)
      }
    })

    it('las claves de operación van aparte de las de sólo lectura', () => {
      const config = loadConfig({ ...BASE, BINANCE_API_KEY: 'lectura', BINANCE_API_SECRET: 'x', BINANCE_TRADE_API_KEY: 'k', BINANCE_TRADE_API_SECRET: 's' })
      expect(config.real).toMatchObject({ apiKey: 'k', apiSecret: 's' })
      expect(config.binance).toMatchObject({ apiKey: 'lectura', apiSecret: 'x' })
      expect(loadConfig({ ...BASE, BINANCE_TRADE_API_KEY: '', BINANCE_TRADE_API_SECRET: '' }).real).toMatchObject({ apiKey: null, apiSecret: null })
    })

    it('el error de configuración nunca muestra el secret', () => {
      const secret = 'super-secreto-de-operacion'
      try {
        loadConfig({ BINANCE_TRADE_API_SECRET: secret, BINANCE_ENV: 'prod' })
        expect.unreachable()
      } catch (err) {
        expect(String(err)).not.toContain(secret)
      }
    })

    it('REAL_HOSTS tiene los hosts de cada entorno', () => {
      expect(Object.keys(REAL_HOSTS).sort()).toEqual(['mainnet', 'testnet'])
      expect(REAL_HOSTS.testnet.sapiUrl).toBeNull()
    })
  })
})
