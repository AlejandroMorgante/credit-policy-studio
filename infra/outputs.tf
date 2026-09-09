output "artifact_registry_repository" {
  value       = google_artifact_registry_repository.containers.name
  description = "Artifact Registry repository resource name."
}
output "container_image_base" {
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.containers.repository_id}/credit-policy-studio"
  description = "Base URI for tagged container images."
}

output "policy_bucket" {
  value       = google_storage_bucket.policies.name
  description = "Bucket containing immutable policies and the active pointer."
}

output "bigquery_dataset" {
  value       = google_bigquery_dataset.credit_policy.dataset_id
  description = "Dataset used by the demo."
}

output "vertex_endpoint_id" {
  value       = google_vertex_ai_endpoint.scoring.name
  description = "Vertex AI endpoint ID."
}

output "vertex_runtime_service_account" {
  value       = google_service_account.vertex_runtime.email
  description = "Identity used by the deployed Vertex model."
}

output "ui_url" {
  value       = try(google_cloud_run_v2_service.ui[0].uri, null)
  description = "Cloud Run UI URL when deploy_ui=true."
}
