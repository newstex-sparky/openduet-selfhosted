#!/bin/sh
# Recreate one service of this stack, carrying the values its own container already runs with.
#
# Proof 2 needs a real container restart, and the 8a recipe reads OPENAI_API_KEY from the caller's
# environment at `up` time. Rather than ask an operator to paste a key into a proof run, this reads
# the values the RUNNING container has and hands the same values to Compose. Nothing is printed: the
# key lives in a shell variable for the length of one command.
#
#   sh restart_companion.sh <compose-project> <compose-file> <service>
#   sh restart_companion.sh openduet-8a docker-compose.selfhosted.yml companion
set -eu

project=${1:?compose project}
file=${2:?compose file}
service=${3:-companion}

running=$(docker ps -q \
	--filter "label=com.docker.compose.project=$project" \
	--filter "label=com.docker.compose.service=$service")
if [ -z "$running" ]; then
	echo "no running container for $service in $project" >&2
	exit 1
fi

# Every value the service was started with, one per line, read without echoing.
docker inspect "$running" --format '{{range .Config.Env}}{{println .}}{{end}}' >/tmp/phase8b-env.$$
pick() { sed -n "s/^$1=//p" /tmp/phase8b-env.$$; }

OPENAI_API_KEY=$(pick OPENAI_API_KEY)
OPENAI_BASE_URL=$(pick OPENAI_BASE_URL)
BOT_MODEL=$(pick BOT_MODEL)
OPENBOT_PORT=$(dockport=$(docker port "$running" 2>/dev/null | head -1 | sed 's/.*://'); echo "${dockport}")
rm -f /tmp/phase8b-env.$$

export OPENAI_API_KEY OPENAI_BASE_URL BOT_MODEL
[ -n "${OPENBOT_PORT:-}" ] && export OPENBOT_PORT

echo "recreating $project/$service (values carried over, none printed)"
docker compose -p "$project" -f "$file" up -d --force-recreate "$service"

echo "waiting for the service to answer"
i=0
while [ $i -lt 60 ]; do
	new=$(docker ps -q \
		--filter "label=com.docker.compose.project=$project" \
		--filter "label=com.docker.compose.service=$service")
	state=$(docker inspect -f '{{.State.Status}}' "$new" 2>/dev/null || echo missing)
	if [ "$state" = "running" ] && [ "$new" != "$running" ]; then
		echo "state: running (container replaced) after ${i}s"
		exit 0
	fi
	i=$((i + 1))
	sleep 1
done

echo "service did not reach running state" >&2
exit 1
