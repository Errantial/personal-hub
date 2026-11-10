#!/usr/bin/env bash
set -euo pipefail
# Serves the shipped site block with a real Caddy over plain HTTP on loopback,
# in front of a synthetic static tree and a synthetic API, and checks what a
# browser would receive. Nothing here touches the live server or its files.
directory=$(cd -- "$(dirname -- "$0")" && pwd)
caddy=${1:-}
if [[ -z $caddy ]]; then
  caddy=$(command -v caddy || true)
  [[ -n $caddy || ! -x /opt/personal-hub/caddy ]] || caddy=/opt/personal-hub/caddy
fi
if [[ -z $caddy || ! -x $caddy ]]; then
  echo 'SKIP: no caddy binary found; pass its path to run the edge fixture.'
  exit 0
fi
command -v node >/dev/null && command -v curl >/dev/null || {
  echo 'The edge fixture needs node and curl.' >&2; exit 1;
}
work=$(mktemp -d)
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf -- "$work"
}
trap cleanup EXIT
free_port() {
  node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}
site_port=$(free_port)
api_port=$(free_port)
static="$work/dist"
mkdir -p "$static/assets" "$work/xdg"
filler=$(printf 'synthetic %.0s' {1..200})
printf '<!doctype html><title>Synthetic hub</title><p>%s</p>\n' "$filler" > "$static/index.html"
printf '// synthetic service worker %s\n' "$filler" > "$static/sw.js"
printf 'export const synthetic = "%s";\n' "$filler" > "$static/assets/app-0a1b2c3d.js"
printf 'synthetic font bytes\n' > "$static/assets/font-0a1b2c3d.woff2"

# The synthetic API echoes what the proxy told it about the client.
node -e '
const http = require("node:http");
http.createServer((request, response) => {
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Server: "synthetic-upstream",
  });
  response.end(JSON.stringify({
    path: request.url,
    forwardedFor: request.headers["x-forwarded-for"] ?? null,
    filler: "synthetic ".repeat(200),
  }));
}).listen(Number(process.argv[1]), "127.0.0.1");
' "$api_port" &
pids+=("$!")

cat > "$work/Caddyfile" <<CADDY
{
	admin off
	auto_https off
	storage file_system $work/storage
}
import $directory/Caddyfile
CADDY
export HUB_DOMAIN="http://127.0.0.1:$site_port"
export HUB_STATIC_ROOT="$static"
export HUB_API_UPSTREAM="127.0.0.1:$api_port"
export XDG_CONFIG_HOME="$work/xdg" XDG_DATA_HOME="$work/xdg"
"$caddy" validate --config "$work/Caddyfile" --adapter caddyfile >/dev/null 2>"$work/validate.log" || {
  cat "$work/validate.log" >&2; echo 'The site block is not a valid Caddyfile.' >&2; exit 1;
}
"$caddy" run --config "$work/Caddyfile" --adapter caddyfile >"$work/caddy.log" 2>&1 &
pids+=("$!")
base="http://127.0.0.1:$site_port"
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "$base/" 2>/dev/null && break
  sleep 0.2
done
curl -fsS -o /dev/null "$base/" || { cat "$work/caddy.log" >&2; echo 'Caddy did not start.' >&2; exit 1; }

failures=0
fail() { echo "FAIL: $1" >&2; failures=$((failures + 1)); }
# headers URL [curl options...] prints the status line and lower-cased headers.
headers() {
  local url=$1; shift
  curl -sS -o /dev/null -D - "$@" "$url" | tr -d '\r' | sed -E '1!s/^([^:]+):/\L\1:/'
}
has() { grep -qiF -- "$2" <<< "$1" || fail "$3: expected \"$2\""; }
lacks() { ! grep -qiF -- "$2" <<< "$1" || fail "$3: unexpected \"$2\""; }

shell=$(headers "$base/" -H 'Accept-Encoding: gzip')
has "$shell" 'HTTP/1.1 200' 'app shell'
has "$shell" 'cache-control: no-cache' 'app shell'
has "$shell" 'content-encoding: gzip' 'app shell compression'
has "$shell" 'strict-transport-security: max-age=31536000' 'app shell'
has "$shell" "content-security-policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" 'app shell policy'
has "$shell" 'x-content-type-options: nosniff' 'app shell'
has "$shell" 'x-frame-options: DENY' 'app shell'
has "$shell" 'referrer-policy: same-origin' 'app shell'
has "$shell" 'permissions-policy: camera=()' 'app shell'
has "$shell" 'cross-origin-opener-policy: same-origin' 'app shell'
has "$shell" 'cross-origin-resource-policy: same-origin' 'app shell'
lacks "$shell" 'server:' 'app shell'

deep=$(headers "$base/tasks/00000000-0000-4000-8000-000000000001")
has "$deep" 'HTTP/1.1 200' 'deep link'
has "$deep" 'content-type: text/html' 'deep link'
has "$deep" 'cache-control: no-cache' 'deep link'

worker=$(headers "$base/sw.js")
has "$worker" 'HTTP/1.1 200' 'service worker'
has "$worker" 'cache-control: no-cache' 'service worker'

asset=$(headers "$base/assets/app-0a1b2c3d.js" -H 'Accept-Encoding: zstd, gzip')
has "$asset" 'HTTP/1.1 200' 'built asset'
has "$asset" 'cache-control: public, max-age=31536000, immutable' 'built asset'
has "$asset" 'content-encoding: zstd' 'built asset compression'
has "$asset" 'x-content-type-options: nosniff' 'built asset'

font=$(headers "$base/assets/font-0a1b2c3d.woff2" -H 'Accept-Encoding: zstd, gzip')
has "$font" 'cache-control: public, max-age=31536000, immutable' 'font'
lacks "$font" 'content-encoding:' 'font is already compressed'

missing=$(headers "$base/assets/gone-ffffffff.js")
has "$missing" 'HTTP/1.1 404' 'missing asset'
lacks "$missing" 'immutable' 'missing asset'
lacks "$missing" 'content-type: text/html' 'missing asset must not be the app shell'

api=$(headers "$base/api/health" -H 'Accept-Encoding: gzip')
has "$api" 'HTTP/1.1 200' 'API'
has "$api" 'cache-control: no-store' 'API keeps its own cache rule'
lacks "$api" 'no-cache' 'API'
lacks "$api" 'immutable' 'API'
has "$api" 'content-encoding: gzip' 'API compression'
has "$api" 'x-content-type-options: nosniff' 'API'
has "$api" "content-security-policy: default-src 'none'" 'API'
lacks "$api" 'server:' 'API hides the upstream server name'

# The API believes X-Forwarded-For from loopback (TRUST_PROXY=loopback), so
# the proxy must replace whatever a client sends with the address it saw.
forwarded=$(curl -fsS -H 'X-Forwarded-For: 203.0.113.9' "$base/api/v1/echo" |
  node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>console.log(JSON.parse(s).forwardedFor))')
[[ $forwarded == 127.0.0.1 ]] || fail "client-supplied X-Forwarded-For reached the API as \"$forwarded\""

if (( failures > 0 )); then
  echo "$failures edge check(s) failed." >&2
  exit 1
fi
echo 'Edge fixtures passed: compression, security headers, immutable assets, 404 for missing assets, revalidated shell, API passthrough and forwarded-address replacement.'
