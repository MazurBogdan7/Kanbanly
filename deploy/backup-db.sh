#!/usr/bin/env sh
# Ночная копия базы: sh deploy/backup-db.sh [каталог] [сколько дней хранить]
# cron (каждый день в 03:30):
#   30 3 * * * cd /path/to/Kanbanly && sh deploy/backup-db.sh >> var/backup.log 2>&1
# Работает и с базой на этом сервере, и с внешней: настройки берутся из .env.
# Копии стоит регулярно уносить с сервера: при потере диска они пропадут вместе с ним.
# Восстановление: gunzip -c файл.sql.gz | psql "адрес базы"
set -eu

TARGET="${1:-./var/db-backups}"
KEEP_DAYS="${2:-14}"
mkdir -p "$TARGET"
STAMP=$(date +%Y-%m-%d-%H%M)
RAW="$TARGET/kanbanly-$STAMP.sql"

setting() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2-; }

if setting COMPOSE_PROFILES | grep -q localdb; then
  docker compose exec -T db pg_dump -U kanbanly --no-owner --no-acl kanbanly > "$RAW"
else
  # pg_dump понимает postgresql:// и sslmode, а не драйвер asyncpg и ssl.
  URL=$(setting KANBANLY_DATABASE_URL | sed -e 's#^postgresql+asyncpg://#postgresql://#' -e 's#ssl=require#sslmode=require#')
  docker run --rm --network host postgres:16-alpine pg_dump --no-owner --no-acl "$URL" > "$RAW"
fi

# Пустой дамп — признак сбоя, а не пустой базы: схема есть всегда.
if [ ! -s "$RAW" ]; then
  rm -f "$RAW"
  echo "$(date '+%F %T') ОШИБКА: pg_dump ничего не выгрузил" >&2
  exit 1
fi
gzip "$RAW"
find "$TARGET" -name 'kanbanly-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date '+%F %T') готово: $RAW.gz ($(du -h "$RAW.gz" | cut -f1))"
