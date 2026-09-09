SHELL := /bin/bash
.DEFAULT_GOAL := help

PROJECT_ID ?= $(shell gcloud config get-value project 2>/dev/null)
REGION ?= us-central1
BQ_LOCATION ?= US
TF_DIR := infra
VENV := .venv
PYTHON := $(VENV)/bin/python
PIP := $(VENV)/bin/pip
IMAGE ?= $(REGION)-docker.pkg.dev/$(PROJECT_ID)/credit-policy/credit-policy-studio:dev

.PHONY: help setup fmt lint test run docker-build tf-init tf-plan infra-core image infra deploy-model seed upload-policy clean

help: ## Show available commands.
	@awk 'BEGIN {FS = ":.*## "; printf "\nCredit Policy Studio\n\n"} /^[a-zA-Z_-]+:.*## / {printf "  %-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## Create a local virtual environment and install development dependencies.
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip
	$(PIP) install -e '.[dev]'

fmt: ## Format Python and Terraform files.
	$(VENV)/bin/ruff format .
	terraform -chdir=$(TF_DIR) fmt -recursive

lint: ## Run static checks.
	$(VENV)/bin/ruff format --check .
	$(VENV)/bin/ruff check .
	terraform -chdir=$(TF_DIR) fmt -check -recursive
	terraform -chdir=$(TF_DIR) validate

test: ## Run unit and API tests.
	$(VENV)/bin/pytest --cov=credit_policy_studio --cov-report=term-missing

run: ## Run the complete local demo at http://localhost:8080.
	LOCAL_POLICY_PATH=policies/credit_policy_v1.json $(VENV)/bin/uvicorn credit_policy_studio.api:app --reload --port 8080

docker-build: ## Build the runtime container locally.
	docker build -t credit-policy-studio:local .

tf-init: ## Initialize Terraform.
	terraform -chdir=$(TF_DIR) init

tf-plan: ## Plan GCP infrastructure without changing it.
	test -n "$(PROJECT_ID)" || (echo "PROJECT_ID is required" && exit 1)
	terraform -chdir=$(TF_DIR) plan -var="project_id=$(PROJECT_ID)" -var="region=$(REGION)" -var="bigquery_location=$(BQ_LOCATION)"

infra-core: ## Create APIs, BigQuery, GCS, Artifact Registry, IAM, and Vertex endpoint.
	test -n "$(PROJECT_ID)" || (echo "PROJECT_ID is required" && exit 1)
	terraform -chdir=$(TF_DIR) apply -var="project_id=$(PROJECT_ID)" -var="region=$(REGION)" -var="bigquery_location=$(BQ_LOCATION)"

image: ## Build and push the image with Cloud Build.
	gcloud builds submit --project=$(PROJECT_ID) --region=$(REGION) --tag=$(IMAGE) .

infra: infra-core image ## Provision core infrastructure and publish the image.
	@echo "Core infrastructure and image are ready. Run 'make deploy-model'."

deploy-model: ## Upload and deploy the container to the Terraform-managed Vertex endpoint.
	PROJECT_ID=$(PROJECT_ID) REGION=$(REGION) IMAGE=$(IMAGE) ./scripts/deploy_vertex_model.sh

seed: ## Populate the sample applicants table.
	sed 's/$${PROJECT_ID}/$(PROJECT_ID)/g' sql/seed_applicants.sql | bq query --project_id=$(PROJECT_ID) --location=$(BQ_LOCATION) --use_legacy_sql=false

upload-policy: ## Upload the sample policy and activate it atomically.
	PROJECT_ID=$(PROJECT_ID) ./scripts/publish_policy.sh policies/credit_policy_v1.json

clean: ## Remove local caches and build outputs only.
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf .pytest_cache .ruff_cache .coverage htmlcov dist build *.egg-info
