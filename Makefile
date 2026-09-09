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
AWS_IMAGE_TAG ?= dev

AWS_TF_DIR := infra/aws
AWS_REGION ?= us-east-1

.PHONY: help setup fmt lint test run docker-build tf-init tf-plan infra-core image infra deploy-model seed upload-policy clean \
	aws-tf-init aws-tf-plan aws-infra aws-image aws-deploy-endpoint aws-delete-endpoint aws-seed aws-upload-policy

help: ## Show available commands.
	@awk 'BEGIN {FS = ":.*## "; printf "\nCredit Policy Studio\n\n"} /^[a-zA-Z_-]+:.*## / {printf "  %-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## Create a local virtual environment and install development dependencies.
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip
	$(PIP) install -e '.[dev]'

fmt: ## Format Python and Terraform files.
	$(VENV)/bin/ruff format .
	terraform -chdir=$(TF_DIR) fmt -recursive
	terraform -chdir=$(AWS_TF_DIR) fmt -recursive

lint: ## Run static checks.
	$(VENV)/bin/ruff format --check .
	$(VENV)/bin/ruff check .
	terraform -chdir=$(TF_DIR) fmt -check -recursive
	terraform -chdir=$(TF_DIR) validate
	terraform -chdir=$(AWS_TF_DIR) fmt -check -recursive
	terraform -chdir=$(AWS_TF_DIR) validate

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

aws-tf-init: ## Initialize the AWS Terraform root.
	terraform -chdir=$(AWS_TF_DIR) init

aws-tf-plan: ## Plan AWS infrastructure without changing it.
	terraform -chdir=$(AWS_TF_DIR) plan -var="region=$(AWS_REGION)"

aws-infra: ## Create S3, Glue tables, Athena workgroup, ECR, and the runtime IAM role.
	terraform -chdir=$(AWS_TF_DIR) apply -var="region=$(AWS_REGION)"

aws-image: ## Build the runtime image and push it to ECR.
	$(eval ECR := $(shell terraform -chdir=$(AWS_TF_DIR) output -raw ecr_repository_url))
	aws ecr get-login-password --region $(AWS_REGION) | docker login --username AWS --password-stdin $(firstword $(subst /, ,$(ECR)))
	docker build -t $(ECR):$(AWS_IMAGE_TAG) .
	docker push $(ECR):$(AWS_IMAGE_TAG)
	@echo "Pushed $(ECR):$(AWS_IMAGE_TAG)"

aws-deploy-endpoint: ## Create or update the billable SageMaker endpoint.
	$(eval ECR := $(shell terraform -chdir=$(AWS_TF_DIR) output -raw ecr_repository_url))
	terraform -chdir=$(AWS_TF_DIR) apply -var="region=$(AWS_REGION)" -var="deploy_endpoint=true" -var="container_image=$(ECR):$(AWS_IMAGE_TAG)"

aws-delete-endpoint: ## Tear down the SageMaker endpoint and stop its hourly cost.
	terraform -chdir=$(AWS_TF_DIR) apply -var="region=$(AWS_REGION)" -var="deploy_endpoint=false"

aws-seed: ## Upload the synthetic applicant cohort to S3.
	AWS_REGION=$(AWS_REGION) DATA_BUCKET=$(shell terraform -chdir=$(AWS_TF_DIR) output -raw data_bucket) \
		$(PYTHON) scripts/aws_setup.py seed

aws-upload-policy: ## Upload the sample policy to S3 and activate it.
	AWS_REGION=$(AWS_REGION) POLICY_BUCKET=$(shell terraform -chdir=$(AWS_TF_DIR) output -raw policy_bucket) \
		$(PYTHON) scripts/aws_setup.py publish policies/credit_policy_v1.json

clean: ## Remove local caches and build outputs only.
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf .pytest_cache .ruff_cache .coverage htmlcov dist build *.egg-info
