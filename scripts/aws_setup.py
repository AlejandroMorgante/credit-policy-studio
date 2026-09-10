"""Bootstrap helpers for the AWS deployment: seed the cohort, publish a policy.

Both commands reuse the application adapters so the object layout can never drift
from what the running service expects.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import boto3  # noqa: E402

from credit_policy_studio.aws import S3PolicyRepository  # noqa: E402
from credit_policy_studio.models import CreditPolicy  # noqa: E402
from credit_policy_studio.warehouse import DEMO_APPLICANTS  # noqa: E402


def require(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def seed(_: argparse.Namespace) -> None:
    bucket = require("DATA_BUCKET")
    body = "\n".join(
        json.dumps(applicant.model_dump(mode="json"), separators=(",", ":"))
        for applicant in DEMO_APPLICANTS
    )
    boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1")).put_object(
        Bucket=bucket,
        Key="applicants/applicants.json",
        Body=body.encode("utf-8"),
        ContentType="application/x-ndjson",
    )
    print(f"Seeded {len(DEMO_APPLICANTS)} applicants into s3://{bucket}/applicants/")


def publish(args: argparse.Namespace) -> None:
    bucket = require("POLICY_BUCKET")
    policy = CreditPolicy.model_validate_json(Path(args.policy).read_text(encoding="utf-8"))
    repository = S3PolicyRepository(
        bucket_name=bucket,
        active_object=os.environ.get("POLICY_ACTIVE_OBJECT", "policies/active.json"),
        region=os.environ.get("AWS_REGION", "us-east-1"),
    )
    try:
        repository.publish(policy)
    except FileExistsError:
        print(f"Version {policy.metadata.version} already exists; activating it")
    pointer = repository.activate(policy.metadata.version)
    print(f"Published {pointer['policy_id']}@{pointer['version']} ({pointer['version_id']})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(required=True)
    commands.add_parser("seed", help="Upload the synthetic cohort.").set_defaults(run=seed)
    publish_command = commands.add_parser("publish", help="Publish and activate a policy.")
    publish_command.add_argument("policy")
    publish_command.set_defaults(run=publish)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
