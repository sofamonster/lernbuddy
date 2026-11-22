#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PI_DIR="${PI_DIR:-~/lernbuddy}"
SERVICE_NAME="${SERVICE_NAME:-lernbuddy}"
TARGET_FILE=".pi-target"

MODE="update"
INSTALL_DEPS="false"
PI_TARGET="${PI_TARGET:-}"

usage() {
  cat <<'EOF'
Nutzung:
  ./deploy-pi.sh [BENUTZER@PI-HOST] [OPTIONEN]

Beispiele:
  ./deploy-pi.sh pi@raspberrypi.local            # Code-Update (behält data/ & .env auf dem Pi)
  ./deploy-pi.sh pi@raspberrypi.local --init     # Erst-Upload inkl. lokaler .env & data/
  ./deploy-pi.sh --deps                          # Update + pip install -r requirements.txt
  ./deploy-pi.sh --backup                        # Zieht ein Backup von data/ vom Pi auf den PC

Hinweis:
  Das zuletzt genutzte Ziel wird in .pi-target gespeichert, sodass danach
  ein einfaches "./deploy-pi.sh" ohne Argumente genügt.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --init)
      MODE="init"
      INSTALL_DEPS="true"
      ;;
    --backup)
      MODE="backup"
      ;;
    --deps|--install-deps)
      INSTALL_DEPS="true"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$PI_TARGET" && "$arg" == *@* ]]; then
        PI_TARGET="$arg"
      else
        echo "Unbekanntes Argument: $arg" >&2
        usage
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$PI_TARGET" ]]; then
  if [[ -f "$TARGET_FILE" ]]; then
    PI_TARGET="$(tr -d '[:space:]' < "$TARGET_FILE")"
  else
    echo "Bitte gib beim ersten Aufruf dein Pi-Ziel an, z. B.:" >&2
    echo "  ./deploy-pi.sh pi@raspberrypi.local" >&2
    exit 1
  fi
else
  printf '%s\n' "$PI_TARGET" > "$TARGET_FILE"
fi

if [[ "$MODE" == "backup" ]]; then
  STAMP="$(date +%Y-%m-%d_%H%M)"
  DEST="./backups/data-${STAMP}"
  mkdir -p "$DEST"
  echo ">>> Ziehe Backup von ${PI_TARGET}:${PI_DIR}/data/ nach ${DEST}/ ..."
  rsync -avz "${PI_TARGET}:${PI_DIR}/data/" "${DEST}/"
  echo ">>> Backup fertig: ${DEST}"
  exit 0
fi

RSYNC_EXCLUDES=(
  --exclude '.venv'
  --exclude '__pycache__'
  --exclude '.pytest_cache'
  --exclude '.git'
  --exclude '.pi-target'
  --exclude 'backups'
)

if [[ "$MODE" == "init" ]]; then
  echo ">>> Erst-Upload (--init) nach ${PI_TARGET}:${PI_DIR} (inkl. .env und data/)..."
else
  echo ">>> Code-Update nach ${PI_TARGET}:${PI_DIR} (data/ und .env auf dem Pi bleiben unangetastet)..."
  RSYNC_EXCLUDES+=(--exclude 'data' --exclude '.env')
fi

rsync -avz --delete "${RSYNC_EXCLUDES[@]}" ./ "${PI_TARGET}:${PI_DIR}/"

if [[ "$INSTALL_DEPS" == "true" ]]; then
  echo ">>> Installiere/aktualisiere Python-Pakete auf dem Pi..."
  ssh "$PI_TARGET" "cd ${PI_DIR} && ([ -d .venv ] || python3 -m venv .venv) && .venv/bin/pip install --prefer-binary -r requirements.txt"
fi

echo ">>> Starte Dienst '${SERVICE_NAME}' auf dem Pi neu..."
ssh "$PI_TARGET" "if systemctl list-unit-files | grep -q '^${SERVICE_NAME}\.service'; then sudo systemctl restart ${SERVICE_NAME} && sleep 2 && curl -fsS http://127.0.0.1:8000/api/health && echo ''; else echo 'Hinweis: systemd-Dienst ${SERVICE_NAME} ist noch nicht eingerichtet. Starte manuell mit ./start.sh oder richte den Dienst ein.'; fi"

echo ">>> Fertig!"
