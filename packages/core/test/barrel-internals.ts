// Lo que `src/` exporta y el barrel NO publica a propósito, con el motivo. El test del
// barrel falla si aparece un valor exportado que no está ni en el barrel ni acá, y también
// si una excepción de esta lista deja de existir (para que no quede una lista vieja).
// Las rutas son relativas a `src/`.

// Archivos enteros internos: sus valores sirven a otro módulo de core, no a quien lo usa.
export const INTERNAL_FILES: Readonly<Record<string, string>> = {
  'indicators/series.ts': 'ayudantes para implementar indicadores (arrays de NaN, validación de período)',
  'signals/result.ts': 'ayudantes para construir un SignalResult; se usan sólo dentro de las señales',
  'journal/format.ts': 'formatos propios de las frases del diario; la UI formatea con @sereno/shared (y su formatR choca con el del aprendizaje)',
  'engine/desk.ts': 'pieza interna de TradingEngine',
  'engine/entries.ts': 'pieza interna de TradingEngine',
  'engine/events.ts': 'constructores de EngineEvent que emite TradingEngine; afuera se consume el tipo EngineEvent',
  'engine/exits.ts': 'reglas de salida que aplican el motor y el replay por dentro',
  'engine/portfolio.ts': 'pieza interna de TradingEngine',
  'engine/position-manager.ts': 'pieza interna de TradingEngine',
  'exchange/order-book.ts': 'pieza interna de PaperExchange',
  'exchange/position-checks.ts': 'validaciones internas de PaperExchange y del dimensionamiento',
  'exchange/triggers.ts': 'reglas de disparo internas de PaperExchange y del camino intra-vela del replay',
  'exchange/wallet.ts': 'pieza interna de PaperExchange',
  'replay/candle-player.ts': 'pieza interna de runReplay',
  'replay/clock.ts': 'reloj simulado y calendario internos de runReplay (su DAY_MS es uno de tres duplicados locales)',
  'replay/coverage.ts': 'pieza interna de runReplay',
  'replay/packed-candles.ts': 'velas en columnas internas de ReplayMarket (el bot las recibe de compactSymbol)',
  'replay/intra-candle.ts': 'pieza interna de runReplay',
  'replay/lane.ts': 'pieza interna de runReplay y tuneParams',
  'replay/level-book.ts': 'pieza interna de runReplay',
  'replay/recorder.ts': 'pieza interna de runReplay',
  'replay/report.ts': 'pieza interna de runReplay (su resultado sale en ReplayResult)',
  'replay/simulation.ts': 'bucle interno de runReplay y tuneParams',
  'replay/weekly-tuning.ts': 'ajuste semanal dentro de runReplay; el job del bot usa tuneParams',
}

// Nombres sueltos internos de archivos que, por lo demás, son públicos.
export const INTERNAL_NAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'replay/compact.ts': {
    withCandleMark: 'marca del funding que resuelven ReplayMarket y compactSymbol por dentro',
    isPrice: 'ayudante de withCandleMark',
  },
  'journal/account-phrases.ts': {
    isInitialBase: 'ayudante de las frases del blindaje y de la tarjeta de capital',
    shieldedAmount: 'ayudante de las frases del blindaje y de la tarjeta de capital',
  },
  'journal/coin-name.ts': {
    withCoinNames: 'reescritura interna de la frase de aprendizaje',
  },
  'journal/reasons.ts': {
    pickReasons: 'arma la frase de apertura por dentro de phraseOpen',
    reasonSentence: 'arma la frase de apertura por dentro de phraseOpen',
  },
  'learning/state.ts': {
    clamp: 'aritmética interna del aprendizaje (choca con el clamp de las señales)',
    clampWeight: 'aritmética interna del aprendizaje',
    tradeResult: 'aritmética interna del aprendizaje',
    bump: 'contabilidad interna del estado de aprendizaje',
    applyGlobalDelta: 'contabilidad interna del estado de aprendizaje',
    weekStartOf: 'calendario interno de los contadores semanales',
    rollWeek: 'calendario interno de los contadores semanales',
    formatWeight: 'texto interno del registro de aprendizaje',
    formatR: 'texto interno del registro de aprendizaje (choca con el formatR del diario, de otra precisión)',
    DAY_MS: 'constante de tiempo local, duplicada en tres módulos: el barrel no publica constantes genéricas de tiempo',
    WEEK_MS: 'constante de tiempo local del calendario semanal',
  },
  'signals/composite.ts': {
    compositeInputs: 'partes de computeComposite que reutiliza el puntaje precalculado del replay (perViewScorer)',
    combineComposite: 'partes de computeComposite que reutiliza el puntaje precalculado del replay (perViewScorer)',
  },
  'universe/contract-filter.ts': {
    DAY_MS: 'constante de tiempo local, duplicada en tres módulos: el barrel no publica constantes genéricas de tiempo',
  },
  'universe/select-universe.ts': {
    DAY_MS: 'reexporta el DAY_MS local de contract-filter',
  },
}
