# Форматы JSON

У каждого формата есть `$schema`, `format`, `version`. Схемы в [schemas/](schemas/) генерируются из Pydantic: `make schemas`.

| Формат | `format` | Схема |
|---|---|---|
| Шаблон доски | `kanbanly.board-template` | [board-template.schema.json](schemas/board-template.schema.json) |
| Бэкап | `kanbanly.backup` | [backup.schema.json](schemas/backup.schema.json) |
| Зашифрованный бэкап | `kanbanly.backup.encrypted` | [backup-encrypted.schema.json](schemas/backup-encrypted.schema.json) |
| Настройки доски (внутренний) | — | [board-settings.schema.json](schemas/board-settings.schema.json) |

## Шаблон доски

Только структура и оформление, без пользовательских данных. Полный живой пример, где использована каждая опция: `GET /api/v1/templates/example`, файл `backend/app/presets/example/kanbanly-template-example.json`. Тест падает, если в схему добавили опцию, а в пример — нет.

```json
{
  "$schema": "https://kanbanly.local/schemas/board-template.v1.json",
  "format": "kanbanly.board-template",
  "version": 1,
  "meta": { "name": "Название", "description": "", "author": "", "tags": [] },
  "theme": { "mode": "dark", "density": "comfortable", "tokens": { "accent": "#C9A84C" } },
  "typography": { "card_title": { "font": "Inter", "size": 13 } },
  "layout": { "header": { "widgets": [] }, "column": {}, "card": {}, "editor": {}, "board": {} },
  "columns": [{ "key": "done", "name": "Готово", "kind": "done" }],
  "dimensions": [{ "key": "epic", "name": "Эпик", "type": "select", "values": [] }],
  "fields": [],
  "rules": [],
  "views": [],
  "sample_cards": []
}
```

### Правила значений

- **Цвет:** `#RRGGBB`, `#RRGGBBAA` или ссылка на токен `{accent}`. Ссылка на неизвестный токен — ошибка.
- **Связи:** через локальные `key`, не через UUID. При импорте id создаются заново.
- **Шрифты:** только из белого списка (`FONTS` в `schemas/template.py`).
- **URL изображений:** только `https://`.
- **`_comment`:** разрешён у любого блока, игнорируется молча. Прочие неизвестные поля игнорируются с предупреждением.

### Источники значений

| Поле | Формат |
|---|---|
| `layout.card.accent.source` | `none`, `column`, `dimension:<key>`, `field:<key>` |
| `progress_by_dimension.done_rule` | `column_kind:<вид>`, `column:<key>` |
| `views[].sort.by` | `title`, `due_date`, `created_at`, `dimension:<key>`, `field:<key>` |

### Роли измерений

`accent`, `badge`, `filter_select`, `filter_chips`, `progress`, `swimlanes`, `table_group`, `legend`. Роль, указанная в `dimensions[].roles`, разворачивается в раскладку; при экспорте список вычисляется из раскладки.

### Частичный импорт и экспорт

Разделы: `theme`, `typography`, `layout`, `structure` (колонки, измерения, поля), `columns`, `dimensions`.

- Экспорт: `GET /boards/{id}/template?part=theme`. Файл остаётся валидным шаблоном: `columns` присутствуют всегда, раскладка идёт вместе со структурой, на которую ссылается.
- Импорт: `POST /boards/{id}/template/apply` с телом `{ "template": {...}, "parts": ["theme"] }`. Меняется только указанный раздел; при замене структуры ссылки раскладки на исчезнувшие измерения снимаются.

## Бэкап

```json
{
  "$schema": "https://kanbanly.local/schemas/backup.v1.json",
  "format": "kanbanly.backup",
  "version": 1,
  "exported_at": "2026-11-02T10:00:00+00:00",
  "scope": { "type": "account", "id": null },
  "data": { "boards": [], "profile": {}, "projects": [], "templates": [] },
  "checksum": "sha256:…"
}
```

`checksum` — SHA-256 от канонического JSON поля `data`: ключи по алфавиту, без пробелов, UTF-8. `source_id` — исходные идентификаторы, они нужны для сопоставления при замене и не становятся id новых записей.

Паролей, хэшей, секретов и сессий в файле нет.

### Шифрование

```json
{
  "format": "kanbanly.backup.encrypted",
  "version": 1,
  "cipher": "AES-256-GCM",
  "kdf_params": { "algorithm": "scrypt", "n": 32768, "r": 8, "p": 1 },
  "salt": "…",
  "nonce": "…",
  "ciphertext": "…"
}
```

Значения в base64. Параметры KDF входят в AAD: их подмена обнаруживается при расшифровке.

## Импорт

Общие правила для шаблонов и бэкапов:

- Лимиты: шаблон 1 МБ, бэкап 50 МБ, глубина 32 уровня; настраивается через `KANBANLY_*`.
- Ошибки — список с путём: `columns[3].color: неверный формат цвета`.
- Сначала превью (`/templates/import/preview`, `/import/backup/preview`): что будет создано, конфликты, предупреждения.
- Всё выполняется в одной транзакции.
- Режимы бэкапа: `copy` (по умолчанию) и `replace` (параметр `confirm=ЗАМЕНИТЬ`, перед заменой создаётся автоснимок).

## Новая версия формата

1. Поднять `CURRENT` в `app/migrations_json/__init__.py`.
2. Зарегистрировать мигрант `@register(формат, старая_версия)`.
3. Обновить `Literal` версии в схеме и выполнить `make schemas`.
4. Добавить файл старой версии в тесты.
