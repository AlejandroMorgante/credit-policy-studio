provider "aws" {
  region = var.region
}

data "aws_caller_identity" "current" {}

locals {
  policy_bucket = var.policy_bucket_name != "" ? var.policy_bucket_name : "${var.name_prefix}-policies-${data.aws_caller_identity.current.account_id}"
  data_bucket   = var.data_bucket_name != "" ? var.data_bucket_name : "${var.name_prefix}-data-${data.aws_caller_identity.current.account_id}"
  athena_output = "s3://${local.data_bucket}/athena-results/"
  json_serde    = "org.openx.data.jsonserde.JsonSerDe"

  tags = {
    application = "credit-policy-studio"
    data_class  = "synthetic-poc"
  }
}


locals {
  applicants_columns = [
    { name = "user_id", type = "string" },
    { name = "score_1", type = "double" },
    { name = "score_2", type = "double" },
    { name = "score_3", type = "double" },
    { name = "variable_1", type = "double" },
    { name = "variable_2", type = "double" },
    { name = "variable_3", type = "double" },
  ]

  scoring_results_columns = [
    { name = "user_id", type = "string" },
    { name = "policy_id", type = "string" },
    { name = "policy_version", type = "string" },
    { name = "policy_sha256", type = "string" },
    { name = "decision", type = "string" },
    { name = "risk_band", type = "string" },
    { name = "credit_limit", type = "double" },
    { name = "reason_code", type = "string" },
    { name = "leaf_node_id", type = "string" },
    { name = "trace_json", type = "string" },
    { name = "evaluated_at", type = "string" },
    { name = "score_1", type = "double" },
    { name = "score_2", type = "double" },
    { name = "score_3", type = "double" },
    { name = "variable_1", type = "double" },
    { name = "variable_2", type = "double" },
    { name = "variable_3", type = "double" },
  ]

  scoring_runs_columns = [
    { name = "run_id", type = "string" },
    { name = "policy_id", type = "string" },
    { name = "policy_version", type = "string" },
    { name = "policy_sha256", type = "string" },
    { name = "processed_rows", type = "bigint" },
    { name = "persisted_rows", type = "bigint" },
    { name = "decisions_json", type = "string" },
    { name = "started_at", type = "string" },
    { name = "completed_at", type = "string" },
    { name = "duration_ms", type = "bigint" },
  ]
}

# --- Buckets -----------------------------------------------------------------

resource "aws_s3_bucket" "policies" {
  bucket        = local.policy_bucket
  force_destroy = var.force_destroy
  tags          = local.tags
}

resource "aws_s3_bucket" "data" {
  bucket        = local.data_bucket
  force_destroy = var.force_destroy
  tags          = local.tags
}

# Versioning is what makes the active pointer's version_id meaningful.
resource "aws_s3_bucket_versioning" "policies" {
  bucket = aws_s3_bucket.policies.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "policies" {
  bucket                  = aws_s3_bucket.policies.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "policies" {
  bucket = aws_s3_bucket.policies.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Mirrors the GCS lifecycle rule: keep a bounded window of superseded policies.
resource "aws_s3_bucket_lifecycle_configuration" "policies" {
  bucket = aws_s3_bucket.policies.id

  rule {
    id     = "expire-noncurrent-policy-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      newer_noncurrent_versions = 20
      noncurrent_days           = 30
    }
  }

  depends_on = [aws_s3_bucket_versioning.policies]
}

resource "aws_s3_bucket_lifecycle_configuration" "data" {
  bucket = aws_s3_bucket.data.id

  rule {
    id     = "expire-athena-results"
    status = "Enabled"

    filter {
      prefix = "athena-results/"
    }

    expiration {
      days = 14
    }
  }
}

# --- Catalog -----------------------------------------------------------------

resource "aws_glue_catalog_database" "credit_policy" {
  name        = var.glue_database
  description = "Inputs, auditable scoring outputs, and execution metadata."
}

resource "aws_glue_catalog_table" "applicants" {
  name          = "applicants"
  database_name = aws_glue_catalog_database.credit_policy.name
  table_type    = "EXTERNAL_TABLE"
  description   = "Synthetic applicant features consumed by the decision policy."

  parameters = {
    classification = "json"
    EXTERNAL       = "TRUE"
  }

  storage_descriptor {
    location      = "s3://${aws_s3_bucket.data.bucket}/applicants/"
    input_format  = "org.apache.hadoop.mapred.TextInputFormat"
    output_format = "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat"

    ser_de_info {
      serialization_library = local.json_serde
      parameters            = { "ignore.malformed.json" = "true" }
    }

    dynamic "columns" {
      for_each = local.applicants_columns
      content {
        name = columns.value.name
        type = columns.value.type
      }
    }
  }
}

# run_id is the partition key and is supplied by the S3 key. Injected projection
# needs no crawler and no MSCK REPAIR, and every dashboard query filters by run_id.
resource "aws_glue_catalog_table" "scoring_results" {
  name          = "scoring_results"
  database_name = aws_glue_catalog_database.credit_policy.name
  table_type    = "EXTERNAL_TABLE"
  description   = "One explainable decision per user and policy execution."

  parameters = {
    classification              = "json"
    EXTERNAL                    = "TRUE"
    "projection.enabled"        = "true"
    "projection.run_id.type"    = "injected"
    "storage.location.template" = "s3://${aws_s3_bucket.data.bucket}/scoring_results/run_id=$${run_id}"
  }

  partition_keys {
    name = "run_id"
    type = "string"
  }

  storage_descriptor {
    location      = "s3://${aws_s3_bucket.data.bucket}/scoring_results/"
    input_format  = "org.apache.hadoop.mapred.TextInputFormat"
    output_format = "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat"

    ser_de_info {
      serialization_library = local.json_serde
      parameters            = { "ignore.malformed.json" = "true" }
    }

    dynamic "columns" {
      for_each = local.scoring_results_columns
      content {
        name = columns.value.name
        type = columns.value.type
      }
    }
  }
}

resource "aws_glue_catalog_table" "scoring_runs" {
  name          = "scoring_runs"
  database_name = aws_glue_catalog_database.credit_policy.name
  table_type    = "EXTERNAL_TABLE"
  description   = "Execution-level audit and operational metadata."

  parameters = {
    classification = "json"
    EXTERNAL       = "TRUE"
  }

  storage_descriptor {
    location      = "s3://${aws_s3_bucket.data.bucket}/scoring_runs/"
    input_format  = "org.apache.hadoop.mapred.TextInputFormat"
    output_format = "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat"

    ser_de_info {
      serialization_library = local.json_serde
      parameters            = { "ignore.malformed.json" = "true" }
    }

    dynamic "columns" {
      for_each = local.scoring_runs_columns
      content {
        name = columns.value.name
        type = columns.value.type
      }
    }
  }
}

resource "aws_athena_workgroup" "studio" {
  name = var.name_prefix
  # Without this, destroy fails once the workgroup holds any query history.
  force_destroy = var.force_destroy
  state         = "ENABLED"
  tags          = local.tags

  configuration {
    enforce_workgroup_configuration    = true
    publish_cloudwatch_metrics_enabled = true

    result_configuration {
      output_location = local.athena_output

      encryption_configuration {
        encryption_option = "SSE_S3"
      }
    }
  }
}

# --- Registry ----------------------------------------------------------------

resource "aws_ecr_repository" "containers" {
  name                 = var.name_prefix
  image_tag_mutability = "MUTABLE"
  # Like the buckets and the Athena workgroup: without this, a repository that
  # holds any image refuses to be destroyed.
  force_delete = var.force_destroy
  tags         = local.tags

  image_scanning_configuration {
    scan_on_push = true
  }
}

# --- Runtime identity --------------------------------------------------------

data "aws_iam_policy_document" "sagemaker_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["sagemaker.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "runtime" {
  name               = "${var.name_prefix}-runtime"
  description        = "Reads applicants and policies, then writes scoring results."
  assume_role_policy = data.aws_iam_policy_document.sagemaker_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "runtime" {
  statement {
    sid = "ReadPolicies"
    actions = [
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:ListBucketVersions",
    ]
    resources = [aws_s3_bucket.policies.arn, "${aws_s3_bucket.policies.arn}/*"]
  }

  # Athena needs the full set below, not just read/write: it calls
  # GetBucketLocation to verify the workgroup's output bucket before running a
  # query, and stages results as a multipart upload.
  statement {
    sid = "ReadWriteData"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
    ]
    resources = [aws_s3_bucket.data.arn, "${aws_s3_bucket.data.arn}/*"]
  }

  statement {
    sid = "RunAthenaQueries"
    actions = [
      "athena:StartQueryExecution",
      "athena:GetQueryExecution",
      "athena:GetQueryResults",
      "athena:GetWorkGroup",
    ]
    resources = [aws_athena_workgroup.studio.arn]
  }

  statement {
    sid = "ReadCatalog"
    actions = [
      "glue:GetDatabase",
      "glue:GetDatabases",
      "glue:GetTable",
      "glue:GetTables",
      "glue:GetPartition",
      "glue:GetPartitions",
    ]
    resources = [
      "arn:aws:glue:${var.region}:${data.aws_caller_identity.current.account_id}:catalog",
      "arn:aws:glue:${var.region}:${data.aws_caller_identity.current.account_id}:database/${aws_glue_catalog_database.credit_policy.name}",
      "arn:aws:glue:${var.region}:${data.aws_caller_identity.current.account_id}:table/${aws_glue_catalog_database.credit_policy.name}/*",
    ]
  }

  statement {
    sid       = "PullImage"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = [aws_ecr_repository.containers.arn]
  }

  statement {
    sid       = "AuthenticateToEcr"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "WriteLogs"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/sagemaker/*"]
  }
}

resource "aws_iam_role_policy" "runtime" {
  name   = "${var.name_prefix}-runtime"
  role   = aws_iam_role.runtime.id
  policy = data.aws_iam_policy_document.runtime.json
}

# --- Scoring endpoint --------------------------------------------------------

locals {
  create_endpoint = var.deploy_endpoint && var.container_image != "" ? 1 : 0
}

# The model and endpoint configuration are named after the image reference, so a
# new release must change that reference. `make deploy CLOUD=aws` passes an
# immutable digest (repo@sha256:...) rather than a tag: SageMaker resolves a tag
# to a digest once, at deploy time, so re-pushing the same tag would leave both
# Terraform and the endpoint unaware that anything changed.
resource "aws_sagemaker_model" "scoring" {
  count              = local.create_endpoint
  name               = "${var.name_prefix}-${substr(sha256(var.container_image), 0, 8)}"
  execution_role_arn = aws_iam_role.runtime.arn
  tags               = local.tags

  primary_container {
    image = var.container_image

    environment = {
      APP_ENV           = "aws"
      CLOUD_PROVIDER    = "aws"
      AWS_REGION        = var.region
      POLICY_BUCKET     = aws_s3_bucket.policies.bucket
      DATA_BUCKET       = aws_s3_bucket.data.bucket
      GLUE_DATABASE     = aws_glue_catalog_database.credit_policy.name
      ATHENA_WORKGROUP  = aws_athena_workgroup.studio.name
      ATHENA_OUTPUT_URI = local.athena_output
    }
  }
}

resource "aws_sagemaker_endpoint_configuration" "scoring" {
  count = local.create_endpoint
  name  = "${var.name_prefix}-${substr(sha256(var.container_image), 0, 8)}"
  tags  = local.tags

  production_variants {
    variant_name           = "AllTraffic"
    model_name             = aws_sagemaker_model.scoring[0].name
    initial_variant_weight = 1

    # Provisioned only when an instance type is given; otherwise serverless.
    initial_instance_count = var.endpoint_instance_type != "" ? 1 : null
    instance_type          = var.endpoint_instance_type != "" ? var.endpoint_instance_type : null

    dynamic "serverless_config" {
      for_each = var.endpoint_instance_type == "" ? [1] : []
      content {
        memory_size_in_mb = var.endpoint_serverless_memory_mb
        max_concurrency   = var.endpoint_serverless_max_concurrency
      }
    }
  }
}

resource "aws_sagemaker_endpoint" "scoring" {
  count                = local.create_endpoint
  name                 = var.name_prefix
  endpoint_config_name = aws_sagemaker_endpoint_configuration.scoring[0].name
  tags                 = local.tags
}
