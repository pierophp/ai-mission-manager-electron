#!/bin/sh
umask 077

# Provider payloads are deliberately opaque; the state is fixed in argv.
cat >/dev/null || exit 1

run_id=${AI_MISSION_MANAGER_RUN_ID-}
[ -n "$run_id" ] || exit 0
case "$run_id" in *[!0-9]*) exit 0 ;; esac

state=${1-}
agent=${2-}
case "$state" in working|blocked|finished) ;; *) exit 0 ;; esac
case "$agent" in claude|codex) ;; *) exit 0 ;; esac
home=${HOME-}
[ -n "$home" ] || exit 0
state_file=${AI_MISSION_MANAGER_STATE_FILE-}
[ -n "$state_file" ] || exit 0
case "$state_file" in /*) ;; *) exit 1 ;; esac
[ "${state_file##*/}" = "run-$run_id.json" ] || exit 1
case "$state_file" in "$home"/.local/state/ai-mission-manager/runs/run-"$run_id".json) ;; *) exit 1 ;; esac

runs_dir=${state_file%/*}
app_dir=${runs_dir%/*}
state_base=${app_dir%/*}
mkdir -p "$state_base" || exit 1
for dir in "$app_dir" "$runs_dir"; do
    if [ ! -d "$dir" ]; then
        if mkdir "$dir" 2>/dev/null; then
            chmod 700 "$dir" || exit 1
        elif [ ! -d "$dir" ]; then
            exit 1
        fi
    fi
done

temporary="$state_file.tmp.$$"
updated_at=$(date +%s) || exit 1
previous_sequence=0
if [ -f "$state_file" ]; then
    previous_sequence=$(sed -n 's/.*"sequence"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\)[[:space:]]*[,}].*/\1/p' \
        "$state_file" 2>/dev/null | head -n 1)
    case "$previous_sequence" in
        ''|*[!0-9]*) previous_sequence=0 ;;
    esac
fi
sequence=$((previous_sequence + 1))
record=$(printf '{"agent":"%s","runId":"%s","state":"%s","updatedAt":"%s","sequence":%s}' \
    "$agent" "$run_id" "$state" "$updated_at" "$sequence") || exit 1

(umask 077; set -C; printf '%s\n' "$record" >"$temporary") || exit 1
chmod 600 "$temporary" || { rm -f "$temporary"; exit 1; }
if ! mv -f "$temporary" "$state_file"; then
    rm -f "$temporary"
    exit 1
fi

tmux_path=${AI_MISSION_MANAGER_TMUX_PATH-}
socket_name=${AI_MISSION_MANAGER_TMUX_SOCKET-}
pane_id=${AI_MISSION_MANAGER_PANE_ID-}
if [ -n "$tmux_path" ] && [ -n "$socket_name" ] && [ -n "$pane_id" ]; then
    "$tmux_path" -f /dev/null -L "$socket_name" set-option -p -t "$pane_id" \
        @ai_mission_manager_run_state "$record" >/dev/null 2>&1 || :
fi
exit 0
