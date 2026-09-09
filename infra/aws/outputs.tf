output "ecr_repository_url" {
  value       = aws_ecr_repository.containers.repository_url
  description = "Base URI for tagged container images."
}

output "policy_bucket" {
  value       = aws_s3_bucket.policies.bucket
  description = "Bucket containing immutable policies and the active pointer."
}

output "data_bucket" {
  value       = aws_s3_bucket.data.bucket
  description = "Bucket containing applicants, results, runs, and Athena output."
}

output "glue_database" {
  value       = aws_glue_catalog_database.credit_policy.name
  description = "Glue database queried by Athena."
}

output "athena_workgroup" {
  value       = aws_athena_workgroup.studio.name
  description = "Athena workgroup enforcing the result location and encryption."
}

output "runtime_role_arn" {
  value       = aws_iam_role.runtime.arn
  description = "Identity used by the deployed SageMaker model."
}

output "sagemaker_endpoint_name" {
  value       = try(aws_sagemaker_endpoint.scoring[0].name, null)
  description = "SageMaker endpoint name when deploy_endpoint=true."
}
