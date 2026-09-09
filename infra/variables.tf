variable "project_id" {
  description = "Google Cloud project ID."
  type        = string
}
variable "region" {
  description = "Region for Vertex AI, Artifact Registry, and optional Cloud Run UI."
  type        = string
  default     = "us-central1"
}

variable "bigquery_location" {
  description = "BigQuery dataset location. Keep it compatible with the chosen Vertex region."
  type        = string
  default     = "US"
}

variable "dataset_id" {
  description = "BigQuery dataset ID."
  type        = string
  default     = "credit_policy"
}

variable "policy_bucket_name" {
  description = "Globally unique GCS bucket name. Empty derives a name from project_id."
  type        = string
  default     = ""
}

variable "container_image" {
  description = "Published container image. Empty creates only the platform/core infrastructure."
  type        = string
  default     = ""
}

variable "deploy_ui" {
  description = "Deploy the UI/API facade to Cloud Run after container_image exists."
  type        = bool
  default     = false
}

variable "allow_unauthenticated_ui" {
  description = "Public access is unsafe for policy publishing and is disabled by default."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Protect BigQuery tables from accidental Terraform deletion."
  type        = bool
  default     = true
}
