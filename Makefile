SHELL := /bin/bash
.DEFAULT_GOAL := help

# Which cloud the infrastructure targets act on. Everything below is generic;
# only the per-cloud block is provider-specific.
CLOUD ?= gcp
CLOUDS := gcp aws

VENV := .venv
PYTHON := $(VENV)/bin/python
PIP := $(VENV)/bin/pip
POC_DESTROYABLE ?= true

# --- Per-cloud configuration --------------------------------------------------
# Adding a provider means adding one block here plus image-<cloud>, seed-<cloud>,
# upload-policy-<cloud> and deploy-<cloud> recipes. Nothing else changes.

PROJECT_ID ?= $(shell gcloud config get-value project 2>/dev/null)
REGION ?= us-central1
BQ_LOCATION ?= US
IMAGE ?= $(REGION)-docker.pkg.dev/$(PROJECT_ID)/credit-policy/credit-policy-studio:dev

TF_DIR_gcp := infra
DOCKERFILE_gcp := Dockerfile
TF_VARS_gcp := -var="project_id=$(PROJECT_ID)" -var="region=$(REGION)" -var="bigquery_location=$(BQ_LOCATION)"
ifeq ($(POC_DESTROYABLE),true)
TF_VARS_gcp += -var="deletion_protection=false" -var="force_destroy_data=true"
endif

AWS_REGION ?= us-east-1
# Tagging by commit keeps releases traceable; deploy resolves the digest anyway.
AWS_IMAGE_TAG ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)

TF_DIR_aws := infra/aws
DOCKERFILE_aws := Dockerfile.aws
TF_VARS_aws := -var="region=$(AWS_REGION)"
ifeq ($(POC_DESTROYABLE),true)
TF_VARS_aws += -var="force_destroy=true"
endif

# --- Resolved for the selected cloud ------------------------------------------

TF_DIR := $(TF_DIR_$(CLOUD))
DOCKERFILE := $(DOCKERFILE_$(CLOUD))
TF_VARS := $(TF_VARS_$(CLOUD))
TF_DIRS := $(foreach c,$(CLOUDS),$(TF_DIR_$(c)))

.PHONY: help setup fmt lint test run clean docker-build tf-init plan infra image \
	seed upload-policy deploy undeploy destroy guard \
	image-gcp image-aws seed-gcp seed-aws upload-policy-gcp upload-policy-aws \
	deploy-gcp deploy-aws undeploy-gcp undeploy-aws destroy-gcp destroy-aws

help: ## Show available commands.
	@awk 'BEGIN {FS = ":.*## "; printf "\nCredit Policy Studio\n\nInfrastructure targets take CLOUD=gcp (default) or CLOUD=aws.\n\n"} /^[a-zA-Z_-]+:.*## / {printf "  %-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

guard:
	@echo "$(CLOUDS)" | grep -qw "$(CLOUD)" || { echo "CLOUD must be one of: $(CLOUDS)"; exit 1; }

# --- Local development --------------------------------------------------------

setup: ## Create a local virtual environment and install development dependencies.
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip
	$(PIP) install -e '.[dev]'

fmt: ## Format Python and Terraform files.
	$(VENV)/bin/ruff format .
	@for dir in $(TF_DIRS); do terraform -chdir=$$dir fmt -recursive; done

lint: ## Run static checks across every cloud root.
	$(VENV)/bin/ruff format --check .
	$(VENV)/bin/ruff check .
	@for dir in $(TF_DIRS); do \
		terraform -chdir=$$dir fmt -check -recursive && terraform -chdir=$$dir validate; \
	done

test: ## Run unit and API tests.
	$(VENV)/bin/pytest --cov=credit_policy_studio --cov-report=term-missing

run: ## Run the complete local demo at http://localhost:8080.
	LOCAL_POLICY_PATH=policies/credit_policy_v1.json $(VENV)/bin/uvicorn credit_policy_studio.api:app --reload --port 8080

docker-build: guard ## Build the runtime container locally for CLOUD.
	docker build -f $(DOCKERFILE) -t credit-policy-studio:local-$(CLOUD) .

clean: ## Remove local caches and build outputs only.
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf .pytest_cache .ruff_cache .coverage htmlcov dist build *.egg-info

# --- Infrastructure (generic over CLOUD) --------------------------------------

tf-init: guard ## Initialize Terraform for CLOUD.
	terraform -chdir=$(TF_DIR) init

plan: guard ## Plan infrastructure for CLOUD without changing it.
	terraform -chdir=$(TF_DIR) plan $(TF_VARS)

infra: guard ## Create the core infrastructure for CLOUD.
	terraform -chdir=$(TF_DIR) apply $(TF_VARS)

image: guard image-$(CLOUD) ## Build and publish the runtime image for CLOUD.

seed: guard seed-$(CLOUD) ## Load the synthetic applicant cohort for CLOUD.

upload-policy: guard upload-policy-$(CLOUD) ## Publish the sample policy and activate it for CLOUD.

deploy: guard deploy-$(CLOUD) ## Deploy the scoring container. Creates billable serving capacity.

undeploy: guard undeploy-$(CLOUD) ## Remove the serving capacity without destroying the rest.

destroy: guard destroy-$(CLOUD) ## Remove every resource created by this POC for CLOUD.

# --- Google Cloud recipes -----------------------------------------------------

image-gcp:
	@test -n "$(PROJECT_ID)" || { echo "PROJECT_ID is required"; exit 1; }
	policy_bucket="$$(terraform -chdir=$(TF_DIR_gcp) output -raw policy_bucket)"; \
	gcloud builds submit --project=$(PROJECT_ID) --region=$(REGION) --tag=$(IMAGE) --gcs-source-staging-dir="gs://$${policy_bucket}/cloud-build/source" .

seed-gcp:
	sed 's/$${PROJECT_ID}/$(PROJECT_ID)/g' sql/seed_applicants.sql | bq query --project_id=$(PROJECT_ID) --location=$(BQ_LOCATION) --use_legacy_sql=false

upload-policy-gcp:
	PROJECT_ID=$(PROJECT_ID) ./scripts/publish_policy.sh policies/credit_policy_v1.json

deploy-gcp:
	PROJECT_ID=$(PROJECT_ID) REGION=$(REGION) IMAGE=$(IMAGE) ./scripts/deploy_vertex_model.sh

undeploy-gcp:
	@echo "Vertex models are undeployed by 'make destroy CLOUD=gcp'."

destroy-gcp:
	PROJECT_ID=$(PROJECT_ID) REGION=$(REGION) BQ_LOCATION=$(BQ_LOCATION) CONFIRM_DESTROY=$(CONFIRM_DESTROY) ./scripts/destroy_poc.sh

# --- AWS recipes --------------------------------------------------------------

# The repository URL from Terraform is the single source of truth; the repository
# name is whatever follows the registry host, so a custom name_prefix stays
# consistent between publishing and deploying.
# With no state, `terraform output` prints a "No outputs found" warning on
# stdout and still exits 0, so the value is filtered by shape rather than by
# redirecting stderr. Anything that is not a registry URL becomes empty.
ECR = $(shell terraform -chdir=$(TF_DIR_aws) output -raw ecr_repository_url 2>/dev/null | grep -E '^[0-9]+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/' || true)
require_ecr = test -n "$(ECR)" || { echo "No ECR repository found; run 'make infra CLOUD=aws' first"; exit 1; }

image-aws:
	@$(require_ecr)
	aws ecr get-login-password --region $(AWS_REGION) | docker login --username AWS --password-stdin $(firstword $(subst /, ,$(ECR)))
	docker build -f $(DOCKERFILE_aws) -t $(ECR):$(AWS_IMAGE_TAG) .
	docker push $(ECR):$(AWS_IMAGE_TAG)
	@echo "Pushed $(ECR):$(AWS_IMAGE_TAG)"

seed-aws:
	AWS_REGION=$(AWS_REGION) DATA_BUCKET=$$(terraform -chdir=$(TF_DIR_aws) output -raw data_bucket) \
		$(PYTHON) scripts/aws_setup.py seed

upload-policy-aws:
	AWS_REGION=$(AWS_REGION) POLICY_BUCKET=$$(terraform -chdir=$(TF_DIR_aws) output -raw policy_bucket) \
		$(PYTHON) scripts/aws_setup.py publish policies/credit_policy_v1.json

# Deploy by digest, never by tag. SageMaker resolves a tag to a digest once, at
# deploy time, so re-pushing the same tag leaves the endpoint on the old image
# and leaves Terraform with no argument change to act on.
deploy-aws:
	@$(require_ecr)
	ecr="$(ECR)"; repo="$${ecr#*/}"; \
	digest=$$(aws ecr describe-images --region $(AWS_REGION) --repository-name "$${repo}" \
		--image-ids imageTag=$(AWS_IMAGE_TAG) --query 'imageDetails[0].imageDigest' --output text); \
	test -n "$${digest}" -a "$${digest}" != "None" || { echo "No image found for $${repo}:$(AWS_IMAGE_TAG); run 'make image CLOUD=aws' first"; exit 1; }; \
	echo "Deploying $(ECR)@$${digest}"; \
	terraform -chdir=$(TF_DIR_aws) apply $(TF_VARS_aws) -var="deploy_endpoint=true" -var="container_image=$(ECR)@$${digest}"

undeploy-aws:
	terraform -chdir=$(TF_DIR_aws) apply $(TF_VARS_aws) -var="deploy_endpoint=false"

# Terraform reads force_destroy from state, not from the destroy invocation, so
# the flag has to be applied before the destroy runs.
destroy-aws:
	terraform -chdir=$(TF_DIR_aws) apply -auto-approve $(TF_VARS_aws)
	terraform -chdir=$(TF_DIR_aws) destroy $(TF_VARS_aws)
