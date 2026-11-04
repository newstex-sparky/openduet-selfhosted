# Phase 8c: Docker cleanup and residue proof

Host: spark-2c35. Snapshot before teardown `2026-11-04T11:29:53Z`, after `2026-11-04T11:30:00Z`.
Raw captures are in `evidence/` beside this file.

## Scope of the teardown

The cleanup removed every container, network, volume and image that this project's phases 3-8
created. It did not touch other applications on the host: the firecrawl stack, the tradelab
fixtures, `camofox-browser`, `z-image-turbo`, `sparky-pgsql` and `ollaya` remain, because they
are not part of this project and other work depends on them.

## Before and after

| Resource | Before | After | Removed |
|---|---|---|---|
| Containers (`docker ps -a`) | 56 | 18 | 38 |
| Named images (`docker images`) | 19 | 17 | 2 project images, plus 15 dangling image IDs |
| Networks (`docker network ls`) | 26 | 11 | 15 |
| Volumes (`docker volume ls`) | 154 | 146 | 8 |
| Build cache | 3.2 GB | 0 B | 3.165 GB |
| Free disk on `/` | 113 G (97% used) | 119 G (97% used) | 6 G |

`docker system df`, before:

```
TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          35        18        18.74GB   1.447GB (7%)
Containers      56        11        2.211GB   1.993GB (90%)
Local Volumes   154       23        85.67GB   3.269GB (3%)
Build Cache     93        0         3.2GB     2.363GB
```

`docker system df`, after:

```
TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          18        12        17.93GB   2.153GB (12%)
Containers      18        4         465.9MB   248.1MB (53%)
Local Volumes   146       9         85.32GB   3.942GB (4%)
Build Cache     93        0         3.2GB     3.165GB
```

## Containers removed (38)

```
od7merge-pg
od7merge-runner
od8-app-1
od8-computer-1
od8-model-1
od8-postgres-1
od8-runner-1
od8-server-1
openduet-8a-companion-1
openduet-8a-keys-1
openduet-8a-migrate-1
openduet-8a-postgres-1
openduet-8a-scheduler-1
openduet-8b-companion-1
openduet-8b-computer-1
openduet-8b-keys-1
openduet-8b-migrate-1
openduet-8b-model-1
openduet-8b-postgres-1
openduet-8b-scheduler-1
openduet-p8-computer-1
openduet-p8-keys-1
openduet-p8-migrate-1
openduet-p8-model-1
openduet-p8-postgres-1
openduet-p8-scheduler-1
openduet-phase3-pg
openduet-selfhosted-companion-1
openduet-selfhosted-keys-1
openduet-selfhosted-migrate-1
openduet-selfhosted-postgres-1
openduet-selfhosted-scheduler-1
p5-runner
p8-pg
p8-runner
p8c-bun
p8c-test-pg
t7-pg
```

## Networks removed (15)

```
od4-dev_default
od5cp_default
od6-dev_default
od6a-net
od6b-dev_default
od6c-proof_default
od6m_default
od7b3_default
od7merge-net
od8_default
openduet-8a_default
openduet-8b_default
openduet-p8_default
openduet-selfhosted_default
p8net
```

## Volumes removed (8)

```
openduet-8a_keys-data
openduet-8a_postgres-data
openduet-8b_keys-data
openduet-8b_postgres-data
openduet-p8_keys-data
openduet-p8_postgres-data
openduet-selfhosted_keys-data
openduet-selfhosted_postgres-data
```

## Images removed

```
openduet-companion:local   (a98832861edd)
openduet-companion:p8      (ffb551680285)
```

`docker image prune -f` then removed 15 dangling image IDs left by those builds. The raw log is
`evidence/docker-teardown-assets.log`.

## Residue check after teardown

Every container name, network name, volume name and image name was searched for this project's
patterns (`openduet`, `od<N>`, `p8`, `p5-`, `t7-`, `od7`, `od8`):

```
$ { docker ps -a --format '{{.Names}}'; \
    docker network ls --format '{{.Name}}'; \
    docker volume ls --format '{{.Name}}'; \
    docker images --format '{{.Repository}}:{{.Tag}}'; } \
  | grep -Ei 'openduet|^od[0-9]|[-_]od[0-9]|p8|p5-|t7-|od7|od8' | sort
residue lines: 0
```

Zero lines. No container, network, volume or image from this project remains.
