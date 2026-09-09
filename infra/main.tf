provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  policy_bucket = var.policy_bucket_name != "" ? var.policy_bucket_name : "${var.project_id}-credit-policy-studio"
  services = toset(concat(
    [
      "aiplatform.googleapis.com",
      "artifactregistry.googleapis.com",
      "bigquery.googleapis.com",
      "cloudbuild.googleapis.com",
      "iam.googleapis.com",
      "storage.googleapis.com",
    ],
    var.deploy_ui ? ["run.googleapis.com"] : []
  ))
}

resource "google_project_service" "required" {
  for_each = local.services
  project  = var.project_id
  service  = each.value

  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "containers" {
  project       = var.project_id
  location      = var.region
  repository_id = "credit-policy"
  description   = "Containers for Credit Policy Studio"
  format        = "DOCKER"

  depends_on = [google_project_service.required]
}

resource "google_storage_bucket" "policies" {
  project                     = var.project_id
  name                        = local.policy_bucket
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      num_newer_versions = 20
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_bigquery_dataset" "credit_policy" {
  project                    = var.project_id
  dataset_id                 = var.dataset_id
  friendly_name              = "Credit Policy Studio"
  description                = "Inputs, auditable scoring outputs, and execution metadata."
  location                   = var.bigquery_location
  delete_contents_on_destroy = false
  max_time_travel_hours      = 168

  labels = {
    application = "credit-policy-studio"
    data_class  = "synthetic-poc"
  }

  depends_on = [google_project_service.required]
}

resource "google_bigquery_table" "applicants" {
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.credit_policy.dataset_id
  table_id            = "applicants"
  description         = "Synthetic applicant features consumed by the decision policy."
  deletion_protection = var.deletion_protection
  schema              = file("${path.module}/schemas/applicants.json")

  labels = { application = "credit-policy-studio" }
}

resource "google_bigquery_table" "scoring_results" {
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.credit_policy.dataset_id
  table_id            = "scoring_results"
  description         = "One explainable decision per user and policy execution."
  deletion_protection = var.deletion_protection
  schema              = file("${path.module}/schemas/scoring_results.json")

  time_partitioning {
    type  = "DAY"
    field = "evaluated_at"
  }

  clustering = ["policy_version", "decision", "leaf_node_id"]
  labels     = { application = "credit-policy-studio" }
}

resource "google_bigquery_table" "scoring_runs" {
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.credit_policy.dataset_id
  table_id            = "scoring_runs"
  description         = "Execution-level audit and operational metadata."
  deletion_protection = var.deletion_protection
  schema              = file("${path.module}/schemas/scoring_runs.json")

  time_partitioning {
    type  = "DAY"
    field = "started_at"
  }

  clustering = ["policy_version"]
  labels     = { application = "credit-policy-studio" }
}

resource "google_service_account" "vertex_runtime" {
  project      = var.project_id
  account_id   = "credit-policy-vertex"
  display_name = "Credit Policy Vertex runtime"
  description  = "Reads applicants and policies, then writes scoring results."

  depends_on = [google_project_service.required]
}

resource "google_service_account" "ui" {
  count        = var.deploy_ui ? 1 : 0
  project      = var.project_id
  account_id   = "credit-policy-ui"
  display_name = "Credit Policy UI"
  description  = "Invokes Vertex, reads dashboard data, and publishes policies."

  depends_on = [google_project_service.required]
}

resource "google_project_iam_member" "runtime_job_user" {
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.vertex_runtime.email}"
}

resource "google_bigquery_dataset_iam_member" "runtime_dataset_editor" {
  project    = var.project_id
  dataset_id = google_bigquery_dataset.credit_policy.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = "serviceAccount:${google_service_account.vertex_runtime.email}"
}

resource "google_storage_bucket_iam_member" "runtime_policy_reader" {
  bucket = google_storage_bucket.policies.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.vertex_runtime.email}"
}

resource "google_project_iam_member" "ui_vertex_user" {
  count   = var.deploy_ui ? 1 : 0
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.ui[0].email}"
}

resource "google_project_iam_member" "ui_job_user" {
  count   = var.deploy_ui ? 1 : 0
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.ui[0].email}"
}

resource "google_bigquery_dataset_iam_member" "ui_dataset_viewer" {
  count      = var.deploy_ui ? 1 : 0
  project    = var.project_id
  dataset_id = google_bigquery_dataset.credit_policy.dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${google_service_account.ui[0].email}"
}

resource "google_storage_bucket_iam_member" "ui_policy_publisher" {
  count  = var.deploy_ui ? 1 : 0
  bucket = google_storage_bucket.policies.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.ui[0].email}"
}

resource "google_vertex_ai_endpoint" "scoring" {
  project      = var.project_id
  region       = var.region
  location     = var.region
  name         = "credit-policy-scoring"
  display_name = "Credit Policy Scoring"
  description  = "Online trigger for versioned BigQuery credit scoring runs."

  labels = { application = "credit-policy-studio" }

  depends_on = [google_project_service.required]
}

resource "google_cloud_run_v2_service" "ui" {
  count    = var.deploy_ui && var.container_image != "" ? 1 : 0
  project  = var.project_id
  name     = "credit-policy-studio"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.ui[0].email
    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }
    containers {
      image = var.container_image
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
      env {
        name  = "APP_ENV"
        value = "gcp"
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "GCP_REGION"
        value = var.region
      }
      env {
        name  = "BIGQUERY_LOCATION"
        value = var.bigquery_location
      }
      env {
        name  = "BIGQUERY_DATASET"
        value = google_bigquery_dataset.credit_policy.dataset_id
      }
      env {
        name  = "POLICY_BUCKET"
        value = google_storage_bucket.policies.name
      }
      env {
        name  = "VERTEX_ENDPOINT_ID"
        value = google_vertex_ai_endpoint.scoring.name
      }
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_cloud_run_v2_service_iam_member" "public_ui" {
  count    = var.deploy_ui && var.container_image != "" && var.allow_unauthenticated_ui ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.ui[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
