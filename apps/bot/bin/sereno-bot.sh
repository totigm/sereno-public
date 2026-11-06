#!/usr/bin/env bash
# Supervisor para correr el bot 24/7 en la Mac (spec §12). También es `pnpm bot`.
#
#   apps/bot/bin/sereno-bot.sh                     en vivo (igual que `… live`)
#   apps/bot/bin/sereno-bot.sh replay --days 90    un replay: corre una vez
#
# En vivo, si el bot sale con un código distinto de 0 lo relanza con espera exponencial
# (1 s, 2 s, 4 s… hasta 60 s; vuelve a 1 s si la corrida anterior duró 10 minutos o más).
# Si sale con 0, termina. SIGINT y SIGTERM se le pasan al bot como SIGTERM y el supervisor
# espera a que guarde lo pendiente y suelte el lease; un segundo aviso lo mata. SIGHUP (la
# terminal que se cierra) arranca el mismo apagado, pero nunca corta.
#
# Tiene que andar con el bash 3.2 de macOS: nada de `wait -n`, arrays asociativos ni
# `${var,,}`; arrays vacíos con `set -u` tampoco.
#
# Variables sólo para los tests: SERENO_BOT_COMMAND (ejecutable que reemplaza al bot),
# SERENO_ENV_FILE (otro `.env`), SERENO_RESTART_BASE_MS, SERENO_RESTART_MAX_MS y
# SERENO_RESTART_RESET_S (esperas más cortas).

set -u

BOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ROOT_DIR=$(cd "$BOT_DIR/../.." && pwd)

RESTART_BASE_MS=${SERENO_RESTART_BASE_MS:-1000}
RESTART_MAX_MS=${SERENO_RESTART_MAX_MS:-60000}
RESTART_RESET_S=${SERENO_RESTART_RESET_S:-600}

log() {
  printf '[%s] sereno · %s\n' "$(date '+%H:%M:%S')" "$*" >&2
}

# El `.env` de la raíz, con la misma regla que el bot: lo que ya está en el entorno gana.
# Se lee línea por línea en lugar de hacer `source`, así un valor con `$` o espacios no se
# ejecuta como shell y nada se imprime. Se carga en el subshell de cada arranque: un cambio
# en el `.env` vale desde el próximo relanzamiento y el supervisor no retiene valores.
ENV_LINE_RE='^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$'
DOUBLE_QUOTED_RE='^"([^"]*)"[[:space:]]*(#.*)?$'
SINGLE_QUOTED_RE="^'([^']*)'[[:space:]]*(#.*)?\$"

load_env_file() {
  local file=$1 line key value
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    [[ $line =~ $ENV_LINE_RE ]] || continue
    key=${BASH_REMATCH[2]}
    value=${BASH_REMATCH[3]}
    if [[ $value =~ $DOUBLE_QUOTED_RE ]] || [[ $value =~ $SINGLE_QUOTED_RE ]]; then
      value=${BASH_REMATCH[1]}
    else
      value=${value%%[[:space:]]#*}
      value=${value%"${value##*[![:space:]]}"}
    fi
    [ -n "${!key+set}" ] || export "$key=$value"
  done <"$file"
}

# Corre en segundo plano: `exec` reemplaza al subshell, así `$!` es el pid del bot mismo y
# las señales le llegan a él. `node --import tsx` en lugar del binario `tsx` por lo mismo: el
# CLI de tsx agrega un proceso intermedio que reenvía señales.
exec_bot() {
  load_env_file "${SERENO_ENV_FILE:-$ROOT_DIR/.env}"
  if [ -n "${SERENO_BOT_COMMAND:-}" ]; then
    exec "$SERENO_BOT_COMMAND" "$@"
  fi
  exec node --import tsx src/index.ts "$@"
}

child=''
sleeper=''
stopping=0
stopped_child=0
interrupted=0

# pnpm 12 sale con el primer Ctrl-C sin esperar a su hijo: la terminal vuelve al shell
# mientras el bot se apaga y otro Ctrl-C ya no llega acá. pnpm (como npm) exporta
# `npm_lifecycle_event` al script.
if [ -n "${npm_lifecycle_event:-}" ]; then
  cut_hint="para cortarlo ya: kill $$"
else
  cut_hint='otro Ctrl-C lo corta ya'
fi

# Siempre SIGTERM al bot: con Ctrl-C la terminal ya le mandó SIGINT a todo el grupo, y un
# segundo SIGINT lo mataría (el bot escucha cada señal una sola vez). SIGTERM lo toma el
# mismo apagado ordenado, que ignora el aviso repetido.
on_signal() {
  interrupted=1
  if [ "$stopping" -eq 1 ]; then
    log 'corto el bot sin esperar'
    [ -n "$child" ] && kill -KILL "$child" 2>/dev/null
    return
  fi
  stopping=1
  if [ -n "$child" ]; then
    stopped_child=1
    log "apagando: espero a que el bot guarde lo pendiente y suelte la sesión ($cut_hint)"
    kill -TERM "$child" 2>/dev/null
  else
    log 'apagando: no lo relanzo'
  fi
  [ -n "$sleeper" ] && kill "$sleeper" 2>/dev/null
}

# El bot no escucha SIGHUP: si la terminal se la manda a todo el grupo, el bot muere igual;
# esto evita que el supervisor muera sin avisar y apaga ordenado al bot cuando la señal le
# llega sólo al supervisor. Cerrar la terminal no es una decisión de cortar: con el apagado
# en curso, no mata al bot. `interrupted` igual, para que `wait_for_child` lo siga esperando.
on_hangup() {
  interrupted=1
  [ "$stopping" -eq 1 ] || on_signal
}

# Espera al hijo `$child` y devuelve su código. `wait` también vuelve cuando llega una
# señal atrapada; si el hijo sigue vivo, se lo vuelve a esperar.
wait_for_child() {
  local status again
  while :; do
    interrupted=0
    wait "$child"
    status=$?
    [ "$interrupted" -eq 1 ] || break
    if ! kill -0 "$child" 2>/dev/null; then
      # Terminó justo con la señal: un `wait` más trae su código si bash lo guardó.
      wait "$child" 2>/dev/null
      again=$?
      [ "$again" -ne 127 ] && status=$again
      break
    fi
  done
  child=''
  return "$status"
}

# En segundo plano + `wait` para que las señales se atiendan enseguida (bash difiere las
# trampas hasta que termina un comando en primer plano). Las trampas corren entre comandos:
# un aviso que llegó antes de `child=$!` no tuvo a quién reenviarse y se reenvía acá.
run_bot() {
  [ "$stopping" -eq 1 ] && return 0
  exec_bot "$@" &
  child=$!
  if [ "$stopping" -eq 1 ]; then
    stopped_child=1
    kill -TERM "$child" 2>/dev/null
  fi
  wait_for_child
}

format_ms() {
  local ms=$1 fraction
  if [ $((ms % 1000)) -eq 0 ]; then
    printf '%d s' $((ms / 1000))
    return
  fi
  fraction=$(printf '%03d' $((ms % 1000)))
  while [ "${fraction%0}" != "$fraction" ]; do fraction=${fraction%0}; done
  printf '%d,%s s' $((ms / 1000)) "$fraction"
}

# Interrumpible como `run_bot`; el `kill` final evita dejar un `sleep` huérfano si el aviso
# llegó antes de `sleeper=$!`.
pause_ms() {
  local ms=$1
  sleep "$((ms / 1000)).$(printf '%03d' $((ms % 1000)))" &
  sleeper=$!
  [ "$stopping" -eq 1 ] || wait "$sleeper" 2>/dev/null
  kill "$sleeper" 2>/dev/null
  sleeper=''
}

supervise() {
  local delay_ms=$RESTART_BASE_MS started status
  while :; do
    started=$SECONDS
    run_bot "$@"
    status=$?
    [ "$stopping" -eq 1 ] && return "$status"
    [ "$status" -eq 0 ] && return 0
    [ $((SECONDS - started)) -ge "$RESTART_RESET_S" ] && delay_ms=$RESTART_BASE_MS
    log "el bot salió con código $status; lo relanzo en $(format_ms "$delay_ms")"
    pause_ms "$delay_ms"
    [ "$stopping" -eq 1 ] && return 0
    delay_ms=$((delay_ms * 2))
    [ "$delay_ms" -gt "$RESTART_MAX_MS" ] && delay_ms=$RESTART_MAX_MS
  done
}

# El bot ya pide `caffeinate` mientras vive (`src/live/keep-awake.ts`), pero esa aserción
# muere con él: ésta cubre la espera entre relanzamientos, para que la Mac no se duerma
# justo cuando hay que relanzarlo. `-w $$` la ata a este supervisor. También cubre el
# apagado tras un Ctrl-C: el del bot muere con el SIGINT del grupo, pero bash arranca los
# comandos en segundo plano con SIGINT ignorado y caffeinate lo conserva.
keep_mac_awake() {
  [ "$(uname -s)" = Darwin ] || return 0
  command -v caffeinate >/dev/null 2>&1 || return 0
  caffeinate -i -s -w $$ >/dev/null 2>&1 &
}

report_stop() {
  local status=$1
  [ "$stopped_child" -eq 1 ] || return 0
  if [ "$status" -eq 0 ]; then
    log 'el bot se apagó y soltó la sesión'
  else
    log "el bot terminó con código $status durante el apagado"
  fi
}

main() {
  local status
  cd "$BOT_DIR" || exit 1
  trap on_signal INT TERM
  trap on_hangup HUP
  keep_mac_awake
  case "${1:-live}" in
    live) supervise "$@" ;;
    *) run_bot "$@" ;;
  esac
  status=$?
  report_stop "$status"
  return "$status"
}

main "$@"
