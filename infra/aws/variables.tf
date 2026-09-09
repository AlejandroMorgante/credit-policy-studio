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
  description = "Instance type backing the SageMaker endpoint."
  type        = string
  default     = "ml.t2.medium"
}

variable "force_destroy_buckets" {
  description = "Allow Terraform to delete non-empty buckets. Unsafe outside a throwaway POC."
  type        = bool
  default     = false
}
