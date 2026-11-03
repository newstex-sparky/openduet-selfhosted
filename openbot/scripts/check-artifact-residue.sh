#!/bin/sh
# Machine-checked residue report for the BUILT artifact, not the source tree.
#
# scripts/check-copilotkit-residue.sh reads the git tree; this reads what actually
# ships: the image's node_modules, the compiled server, and the built web app the
# browser downloads. Run it against a container from the Compose recipe:
#
#   docker compose -f docker-compose.selfhosted.yml up -d
#   scripts/check-artifact-residue.sh openduet-selfhosted-companion-1
#
# What is a FAILURE here:
#   - a directory for an @copilotkit/* package exists anywhere in the image
#   - the built web app (the browser's whole download) contains "copilotkit"
#   - executable code other than a test mentions a *.copilotkit.ai host
#
# What is REPORTED, not failed, because it is vendored third-party text:
#   - @copilotkit strings inside another package's own manifest (its peer
#     constraints) and .md documentation files under node_modules. This fork
#     cannot delete files from a published package without patching it, and it
#     installs none of them.
set -eu

container=${1:?usage: check-artifact-residue.sh <container>}
fail=0

run() { docker exec "$container" sh -c "$1"; }

echo "container: $container"
echo

echo "1. installed @copilotkit/* package directories (must be 0)"
n=$(run 'find /app -type d -path "*@copilotkit*" | wc -l')
echo "   directories: $n"
[ "$n" -eq 0 ] || fail=1

echo
echo "2. files whose NAME contains copilotkit (third-party only, reported)"
run 'find /app/node_modules -iname "*copilotkit*" | sed "s|/app/node_modules/.bun/|  |"'

echo
echo "3. @copilotkit strings in manifests and lockfiles"
echo "   first-party lockfile (the fork's own bun.lock):"
run 'grep -n "@copilotkit" /app/bun.lock | cut -c1-120 || echo "   (none)"'
echo "   inside third-party packages (their own peer constraints):"
run 'grep -rn "@copilotkit" /app/node_modules --include=package.json | sed "s|/app/node_modules/.bun/|  |" | cut -c1-140'

echo
echo "4. the built web app: /app/app/dist (must be 0 files containing copilotkit)"
files=$(run 'find /app/app/dist -type f | wc -l')
hits=$(run 'grep -ril "copilotkit" /app/app/dist | wc -l')
echo "   files=$files  containing_copilotkit=$hits"
[ "$hits" -eq 0 ] || fail=1

echo
echo "5. files containing a *.copilotkit.ai host, by extension"
run 'grep -rIl "copilotkit\.ai" /app | sed -E "s/.*\.([a-z0-9]+)$/\1/" | sort | uniq -c'

echo
echo "6. executable code (not a test) containing a *.copilotkit.ai host (must be 0)"
n=$(run 'grep -rIl --include="*.js" --include="*.mjs" --include="*.cjs" --include="*.ts" --include="*.tsx" --include="*.jsx" "copilotkit\.ai" /app | grep -v "/tests/" | wc -l')
echo "   files: $n"
[ "$n" -eq 0 ] || fail=1

echo
if [ "$fail" -ne 0 ]; then
	echo "FAIL: the built artifact carries a CopilotKit dependency."
	exit 1
fi
echo "PASS: no installed package, no browser-facing reference, no vendor host in shipped code."
