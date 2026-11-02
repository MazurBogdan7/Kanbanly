# Kanbanly

Канбан-сервис с конструктором досок: доска собирается из блоков (колонки, измерения, поля, виджеты шапки, анатомия карточки, палитра, типографика), и любую собранную доску можно сохранить как шаблон. Пресеты — обычные JSON-файлы, в коде нет ни одной ветки под конкретный пресет.

## Запуск

```bash
make up          # Docker Compose: api, web, db, mailhog
```

Приложение: <http://localhost:8080>, почта для разработки: <http://localhost:8025>. Перед первым запуском `make up` создаёт `.env` из `.env.example`; для боевого развёртывания задайте свой `KANBANLY_SECRET_KEY` и `KANBANLY_COOKIE_SECURE=true`.

### Без Docker

Нужны `uv` и Node.js 22. Один процесс отдаёт и API, и собранный фронт, данные — во временной SQLite:

```bash
cd frontend && npm ci && npm run build
cd ../backend && uv sync && uv run python scripts/e2e_server.py
```

В Windows PowerShell 5.1 оператора `&&` нет, команды выполняются построчно:

```powershell
cd frontend
npm ci
npm run build
cd ..\backend
uv sync
uv run python scripts/e2e_server.py
```

Откройте <http://127.0.0.1:8123>. Письма со ссылкой сброса пароля в этом режиме лежат файлами во временном каталоге сервера.

## Развёртывание на сервере

Нужен Linux-сервер с Docker Compose v2, домен с A-записью на этот сервер и открытые порты 80 и 443.

```bash
git clone https://github.com/MazurBogdan7/Kanbanly.git
cd Kanbanly
cp .env.production.example .env
nano .env   # заполнить все значения; ключ и пароль: openssl rand -hex 32
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Миграции применяются при старте `api`, HTTPS-сертификат Caddy получает сам. С заглушками вместо секретов приложение в `prod` не запустится.

Обновление: `git pull`, затем та же команда `docker compose ... up -d --build`. Логи: `docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f api`.

## Тесты

| Команда | Что делает |
|---|---|
| `make test` | линтеры, типы, backend, frontend, e2e |
| `make test-backend` | pytest с покрытием (SQLite) |
| `make test-postgres` | те же тесты на встроенном PostgreSQL (без Docker) |
| `make test-frontend` | Vitest с покрытием |
| `make test-e2e` | сборка фронта и Playwright: сценарии, эталон ZIF, axe, производительность, снимки |

Без `make` команды запускаются напрямую, см. [Makefile](Makefile). Lighthouse: `npm run lighthouse` при запущенном `scripts/e2e_server.py`. Проверка миграций на чистой базе: `uv run python scripts/pg.py verify`.

После изменения Pydantic-моделей выполните `make schemas`: обновятся `docs/schemas/*.schema.json`, `frontend/openapi.json` и TS-типы.

## Структура

```
backend/app/    api, core, models, schemas, services, repositories, security, presets, migrations_json
backend/alembic миграции БД
frontend/src/   app, features/{auth,projects,boards,cards,settings,templates,backup}, components/ui, design-system, lib, i18n
docs/           ARCHITECTURE, DECISIONS, SECURITY, JSON_FORMATS, schemas, reference
```

## Документация

- [Архитектура](docs/ARCHITECTURE.md)
- [Принятые решения](docs/DECISIONS.md)
- [Безопасность и модель угроз](docs/SECURITY.md)
- [Форматы JSON](docs/JSON_FORMATS.md)
