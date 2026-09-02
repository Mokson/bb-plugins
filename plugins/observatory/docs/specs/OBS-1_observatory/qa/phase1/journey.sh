#!/usr/bin/env bash
# QA journey driver. Re-installs the plugin from THIS repo path and retries
# until the panel actually renders the spend module, because sibling seats
# re-install over it continuously.
set -u
export AGENT_BROWSER_SESSION=obs-qa-phase1
PLUGIN=/Users/mokson/Projects/Personal/bb-plugins/plugins/observatory
SHOTS="$PLUGIN/docs/specs/OBS-1_observatory/qa/phase1/evidence/screenshots"
INSTALLS_FILE="$PLUGIN/docs/specs/OBS-1_observatory/qa/phase1/evidence/installs.count"
mkdir -p "$SHOTS"

reinstall() {
  ( cd "$PLUGIN" && bb plugin install "$PWD" --yes >/dev/null 2>&1 )
  echo x >>! "$INSTALLS_FILE"
}

# open a panel route and wait until the spend content is really there
load() { # $1 = route+query
  local url="http://127.0.0.1:38886/plugins/observatory/observatory/$1"
  local i
  for i in 1 2 3 4 5 6 7 8; do
    reinstall
    agent-browser open "$url" >/dev/null 2>&1
    agent-browser wait --load networkidle >/dev/null 2>&1
    local j
    for j in 1 2 3 4 5 6; do
      if agent-browser eval "document.body.innerText.includes('spend usd') && document.querySelectorAll('tbody tr').length>0" 2>/dev/null | grep -q true; then
        echo "LOADED $1 (attempt $i)"
        return 0
      fi
      sleep 1
    done
  done
  echo "LOAD-FAILED $1"
  return 1
}

txt() { agent-browser eval "(()=>{let t=document.body.innerText;const i=t.indexOf('$1');return i<0?'MISSING:$1':t.slice(i,i+${2:-600})})()" 2>&1; }
js()  { agent-browser eval "$1" 2>&1; }
shot(){ agent-browser screenshot "$SHOTS/$1" 2>&1 | tail -1; }
