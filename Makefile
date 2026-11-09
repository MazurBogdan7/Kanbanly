.PHONY: up down logs test test-backend test-frontend test-e2e lint typecheck format schemas migrate

up: .env
	docker compose --profile dev --profile localdb up --build -d
	@echo "Kanbanly: http://localhost:8080   Почта: http://localhost:8025"

.env:
	cp .env.example .env

down:
	docker compose down

logs:
	docker compose logs -f

test: lint typecheck test-backend test-frontend test-e2e

test-backend:
	cd backend && uv run pytest --cov=app --cov-fail-under=85

test-postgres:
	cd backend && uv run python scripts/pg.py test

test-frontend:
	cd frontend && npm run test:coverage

test-e2e:
	cd frontend && npm run build && npx playwright test

lint:
	cd backend && uv run ruff check . && uv run ruff format --check .
	cd frontend && npm run lint

typecheck:
	cd backend && uv run mypy
	cd frontend && npm run typecheck

format:
	cd backend && uv run ruff format . && uv run ruff check --fix .
	cd frontend && npm run format

schemas:
	cd backend && PYTHONPATH=. uv run python scripts/export_schemas.py
	cd frontend && npm run generate:api

migrate:
	cd backend && uv run alembic upgrade head
