variable "region" {
  description = "AWS region for S3, Athena, ECR, and the SageMaker endpoint."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix applied to bucket, catalog, and endpoint names."
  type        = string
  default     = "credit-policy-studio"
}

variable "policy_bucket_name" {
  description = "Globally unique bucket for policies. Empty derives a name from the account ID."
  type        = string
  default     = ""
}

variable "data_bucket_name" {
  description = "Globally unique bucket for applicants, results, runs, and Athena output."
  type        = string
  default     = ""
}

variable "glue_database" {
  description = "Glue Data Catalog database backing the Athena tables."
  type        = string
  default     = "credit_policy"
}

variable "container_image" {
  description = "Published image URI. Empty creates only the core infrastructure."
  type        = string
  default     = ""
}

variable "deploy_endpoint" {
  description = "Create the billable SageMaker real-time endpoint. Requires container_image."
  type        = bool
  default     = false
}

variable "endpoint_instance_type" {
  # Empty means serverless inference: no idle cost, and no per-instance endpoint
  # quota to request first (that quota defaults to 0 on a new account).
  # Set an instance type for a provisioned endpoint instead. T2 and T3 are not
  # offered for hosting; ml.c6i.large is the cheapest current-generation x86.
  description = "Instance type for a provisioned endpoint. Empty uses serverless inference."
  type        = string
  default     = ""
}

variable "endpoint_serverless_memory_mb" {
  description = "Memory for the serverless endpoint. Must be at least the container's footprint."
  type        = number
  default     = 2048
}

variable "endpoint_serverless_max_concurrency" {
  description = "Concurrent invocations the serverless endpoint will serve."
  type        = number
  default     = 2
}

variable "force_destroy" {
  description = "Allow Terraform to delete non-empty buckets, the Athena workgroup's query history, and an ECR repository that still holds images. Unsafe outside a throwaway POC."
  type        = bool
  default     = false
}
