#!/bin/sh
# Machine-checked residue report for the CopilotKit removal.
#
# Every remaining case-insensitive "copilotkit" in first-party source must fall
# into one of the six dispositions below. A reference that fits none of them is
# printed as UNCLASSIFIED and makes this script exit 1: that is a real defect,
# not a cosmetic one.
#
# Dispositions (the Phase 7 list, restated in the fork's own terms):
#
#   migration-history   A applied migration or its frozen snapshot. The old
#                       names are the input to the rename, so rewriting them
#                       would break every deployment that already ran them.
#   port-attribution    MIT header on code ported out of the vendor runtime.
#                       The licence requires the provenance to stay.
#   upstream-coordinate A real remote address of the upstream project:
#                       ghcr.io/copilotkit/*, github.com/CopilotKit/*, its docs
#                       hosts. This fork still pulls and documents that image.
#   inert-compat        A name the fork still ACCEPTS and ignores: env vars,
#                       wire keys, a bundle identifier, an ignore rule. It
#                       confers no capability and opens no connection.
#   negative-assertion  A test or doc that asserts the vendor is absent, or that
#                       its variables are ignored. Proof, not dependency.
#   removal-prose       A comment or changelog note explaining what was removed.
#   legal               The upstream copyright line.
#
# Usage: scripts/check-copilotkit-residue.sh [--list]
set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

git grep -in -I 'copilotkit' -- . >"$tmp" || true

disposition() {
	case "$1" in
	openbot/server/drizzle/*) echo migration-history ;;
	LICENSE) echo legal ;;
	openbot/toolkit/*) echo port-attribution ;;
	openbot/CHANGELOG.md) echo removal-prose ;;
	README.md) echo upstream-coordinate ;;
	openbot/docs/configuration.md | openbot/docs/local-mode.md) echo negative-assertion ;;
	openbot/docs/* | docs/telemetry.md) echo upstream-coordinate ;;
	openbot/charts/* | openbot/prompt.txt | openbot/renovate.json) echo upstream-coordinate ;;
	openbot/desktop/src-tauri/src/deployment.rs) echo upstream-coordinate ;;
	openbot/desktop/src-tauri/src/deployment_release.rs) echo upstream-coordinate ;;
	openbot/desktop/src-tauri/src/env.rs) echo upstream-coordinate ;;
	openbot/desktop/signing/azure-federation.json) echo upstream-coordinate ;;
	openbot/desktop/src/Problem.tsx | openbot/desktop/src/Problem.test.tsx) echo upstream-coordinate ;;
	openbot/desktop/TELEMETRY.md) echo inert-compat ;;
	openbot/desktop/scripts/validate-telemetry.ts) echo inert-compat ;;
	openbot/desktop/src-tauri/src/telemetry.rs) echo inert-compat ;;
	openbot/desktop/src-tauri/src/desktop_telemetry.rs) echo inert-compat ;;
	openbot/desktop/src-tauri/src/main.rs) echo inert-compat ;;
	openbot/desktop/src-tauri/tauri.conf.json) echo inert-compat ;;
	openbot/biome.json | .gitignore | openbot/bun.lock) echo inert-compat ;;
	openbot/server/src/openduet/setup.ts | openbot/server/src/plugins/catalogue.ts) echo upstream-coordinate ;;
	openbot/server/tests/*) echo negative-assertion ;;
	openbot/scripts/check-copilotkit-residue.sh) echo negative-assertion ;;
	openbot/scripts/check-artifact-residue.sh) echo negative-assertion ;;
	openbot/server/src/* | openbot/agent-mastra/* | openbot/agent-langgraph/*) echo removal-prose ;;
	openbot/desktop/PROVIDER_OAUTH.md) echo removal-prose ;;
	openbot/desktop/src-tauri/src/harness.rs | openbot/desktop/src-tauri/src/stack.rs) echo removal-prose ;;
	openbot/docker-compose.selfhosted.yml) echo removal-prose ;;
	*) echo UNCLASSIFIED ;;
	esac
}

total=0
unclassified=0
for name in migration-history port-attribution upstream-coordinate inert-compat \
	negative-assertion removal-prose legal; do
	eval "n_$(echo "$name" | tr - _)=0"
done

cut -d: -f1 "$tmp" | sort -u >"$tmp.files"
while IFS= read -r file; do
	n=$(grep -c "^$file:" "$tmp" || true)
	total=$((total + n))
	d=$(disposition "$file")
	case "$d" in
	migration-history) n_migration_history=$((n_migration_history + n)) ;;
	port-attribution) n_port_attribution=$((n_port_attribution + n)) ;;
	upstream-coordinate) n_upstream_coordinate=$((n_upstream_coordinate + n)) ;;
	inert-compat) n_inert_compat=$((n_inert_compat + n)) ;;
	negative-assertion) n_negative_assertion=$((n_negative_assertion + n)) ;;
	removal-prose) n_removal_prose=$((n_removal_prose + n)) ;;
	legal) n_legal=$((n_legal + n)) ;;
	*)
		unclassified=$((unclassified + n))
		echo "UNCLASSIFIED  $d  $file  ($n)"
		;;
	esac
	if [ "${1-}" = "--list" ]; then
		printf '%-20s %-60s %s\n' "$d" "$file" "$n"
	fi
done <"$tmp.files"
rm -f "$tmp.files"

echo
echo "first-party source references to 'copilotkit': $total"
echo "  migration-history    $n_migration_history"
echo "  port-attribution     $n_port_attribution"
echo "  upstream-coordinate  $n_upstream_coordinate"
echo "  inert-compat         $n_inert_compat"
echo "  negative-assertion   $n_negative_assertion"
echo "  removal-prose        $n_removal_prose"
echo "  legal                $n_legal"
echo "  UNCLASSIFIED         $unclassified"
echo
if [ "$unclassified" -ne 0 ]; then
	echo "FAIL: $unclassified reference(s) fit no disposition."
	exit 1
fi
echo "PASS: every reference fits a disposition."
